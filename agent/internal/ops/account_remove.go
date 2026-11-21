package ops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"strings"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// account.remove (Phase 9, ADR 0038 §2 "dọn nguồn", D-46 purge): xóa hẳn account khỏi máy theo thứ tự
// vhost → pool PHP → cron → SFTP/SSH/FTP → DB + user DB → home → user/group Linux.
// Chỉ đụng đối tượng mang dấu account (dòng đầu "· account <u> ·", tiền tố "<u>_", uid khớp); home xóa bằng
// os.RemoveAll (không theo symlink); user Linux phải là user ITSO (GECOS "ITSO hosting <u>").
// Idempotent: chạy lại sau khi đã xóa trả removed_objects rỗng.

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{contracts.OpAccountRemove: d.accountRemove}
	})
}

type removed = contracts.AccountRemoveResultRemovedObjectsItem

func sumOf(b []byte) *string {
	s := sha256.Sum256(b)
	h := hex.EncodeToString(s[:])
	return &h
}

func (d *Deps) accountRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.AccountRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	if !p.Confirm || p.ConfirmUsername != p.Account.Username {
		return nil, &registry.OpError{Code: "invalid_params", Message: "confirm_username phải trùng username và confirm=true"}
	}
	if err := validate.UUID(string(p.RefUUID)); err != nil {
		return nil, opErr(err)
	}
	if p.Reason != "purge" && p.Reason != "migrated" {
		return nil, &registry.OpError{Code: "invalid_params", Message: "reason phải là purge hoặc migrated"}
	}
	u := string(p.Account.Username)
	usr, err := d.lookupAccount(p.Account)
	var oe *registry.OpError
	switch {
	case err == nil:
		if !strings.HasPrefix(usr.Gecos, "ITSO hosting") || usr.Home != homeOf(p.Account.Username) {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "user " + u + " không phải account ITSO (GECOS/home khác)"}
		}
	case errors.As(err, &oe) && oe.Code == "not_found":
		usr = nil // đã xóa user (chạy lại): vẫn dọn phần còn sót
		us, uerr := d.users()
		if uerr != nil {
			return nil, opErr(uerr)
		}
		for _, x := range us {
			if x.UID == int64(p.Account.UID) {
				return nil, &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("uid %d thuộc user %s", p.Account.UID, x.Name)}
			}
		}
	default:
		return nil, err
	}

	out := []removed{}
	steps := []func(context.Context, contracts.Account, *[]removed) error{
		d.removeVhosts, d.removePools, d.removeCron, d.removeAccess, d.removeDatabases, d.removeHome,
	}
	for _, step := range steps {
		if err := step(ctx, p.Account, &out); err != nil {
			return nil, err
		}
	}
	if usr != nil {
		if _, err := d.must(ctx, "internal", "userdel", u); err != nil {
			return nil, err
		}
		out = append(out, removed{Kind: "linux_user", Name: u})
	}
	if g, err := d.groupByName(u); err != nil {
		return nil, opErr(err)
	} else if g != nil && g.GID == int64(p.Account.UID) {
		if _, err := d.must(ctx, "internal", "groupdel", u); err != nil {
			return nil, err
		}
		out = append(out, removed{Kind: "linux_group", Name: u})
	}
	return toData(contracts.AccountRemoveResult{RemovedObjects: out})
}

// accountVhosts trả (đường dẫn, nội dung) các vhost mang dấu account.
func (d *Deps) accountVhosts(u string) (map[string][]byte, error) {
	names, err := d.FS.ReadDir(VhostDir)
	if err != nil {
		return nil, opErr(err)
	}
	out := map[string][]byte{}
	for _, n := range names {
		if !strings.HasPrefix(n, "itso-") || !strings.HasSuffix(n, ".conf") {
			continue
		}
		b, err := d.FS.ReadFile(VhostDir + "/" + n)
		if err != nil {
			return nil, opErr(err)
		}
		if bytes.Contains(firstLines(b, 2), []byte("· account "+u+" ·")) {
			out[VhostDir+"/"+n] = b
		}
	}
	return out, nil
}

func firstLines(b []byte, n int) []byte {
	idx := 0
	for i := 0; i < n; i++ {
		j := bytes.IndexByte(b[idx:], '\n')
		if j < 0 {
			return b
		}
		idx += j + 1
	}
	return b[:idx]
}

func (d *Deps) removeVhosts(ctx context.Context, a contracts.Account, out *[]removed) error {
	nginxMu.Lock()
	defer nginxMu.Unlock()
	vh, err := d.accountVhosts(string(a.Username))
	if err != nil {
		return err
	}
	if len(vh) == 0 {
		return nil
	}
	for _, path := range sortedKeys(vh) {
		if _, err := d.FS.Remove(path); err != nil {
			return opErr(err)
		}
		*out = append(*out, removed{Kind: "nginx_vhost", Name: path, SHA256: sumOf(vh[path])})
		if id := strings.TrimSuffix(strings.TrimPrefix(path, VhostDir+"/itso-"), ".conf"); validate.UUID(id) == nil {
			_, _ = d.FS.Remove(WafIncludePath(id) + migratingSuffix)
		}
	}
	if err := d.nginxTest(ctx); err != nil {
		return err
	}
	_, err = d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service")
	return err
}

func (d *Deps) removePools(ctx context.Context, a contracts.Account, out *[]removed) error {
	phpMu.Lock()
	defer phpMu.Unlock()
	vers, err := d.FS.ReadDir(phpConfBase)
	if err != nil {
		return opErr(err)
	}
	changed := false
	for _, ver := range vers {
		if validate.PHPVersion(ver, false) != nil || !d.FS.Exists(phpAcctDir(ver, a.Username)) {
			continue
		}
		unit := PHPUnit(ver, a.Username)
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "disable", "--now", unit); err != nil {
			return err
		}
		if err := d.FS.RemoveAll(phpAcctDir(ver, a.Username)); err != nil {
			return opErr(err)
		}
		if err := d.FS.RemoveAll(strings.TrimSuffix(phpDropIn(ver, a.Username), "/10-itso.conf")); err != nil {
			return opErr(err)
		}
		_ = d.FS.RemoveAll(phpRunDir + "/" + ver + "-" + string(a.Username))
		*out = append(*out, removed{Kind: "php_pool", Name: unit})
		changed = true
	}
	if changed {
		_, err = d.must(ctx, "dependency_unavailable", "systemctl", "daemon-reload")
	}
	return err
}

// accountCronUnits trả tên timer (không đuôi) các job cron mang dấu account.
func (d *Deps) accountCronUnits(u string) ([]string, error) {
	names, err := d.FS.ReadDir(UnitDir)
	if err != nil {
		return nil, opErr(err)
	}
	var out []string
	for _, n := range names {
		if !strings.HasPrefix(n, cronPrefix) || !strings.HasSuffix(n, ".timer") {
			continue
		}
		b, err := d.FS.ReadFile(UnitDir + "/" + n)
		if err != nil {
			return nil, opErr(err)
		}
		if bytes.Contains(firstLines(b, 1), []byte("· account "+u+" ·")) {
			out = append(out, strings.TrimSuffix(n, ".timer"))
		}
	}
	return out, nil
}

func (d *Deps) removeCron(ctx context.Context, a contracts.Account, out *[]removed) error {
	cronMu.Lock()
	defer cronMu.Unlock()
	units, err := d.accountCronUnits(string(a.Username))
	if err != nil {
		return err
	}
	for _, unit := range units {
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "disable", "--now", unit+".timer"); err != nil {
			return err
		}
		for _, f := range []string{UnitDir + "/" + unit + ".timer", UnitDir + "/" + unit + ".service"} {
			if _, err := d.FS.Remove(f); err != nil {
				return opErr(err)
			}
		}
		*out = append(*out, removed{Kind: "cron_job", Name: unit})
	}
	if d.FS.Exists(CronDir + "/" + string(a.Username)) {
		if err := d.FS.RemoveAll(CronDir + "/" + string(a.Username)); err != nil {
			return opErr(err)
		}
	}
	if len(units) > 0 {
		_, err = d.must(ctx, "dependency_unavailable", "systemctl", "daemon-reload")
	}
	return err
}

func (d *Deps) removeAccess(ctx context.Context, a contracts.Account, out *[]removed) error {
	u := string(a.Username)
	for _, g := range []string{SFTPGroup, SSHGroup, SuspendedGroup} {
		c, err := d.setGroup(ctx, u, g, false)
		if err != nil {
			return err
		}
		if c {
			*out = append(*out, removed{Kind: "group_member", Name: g})
		}
	}
	if b, err := d.FS.ReadFile(AuthorizedKeys + "/" + u); err == nil {
		if _, err := d.FS.Remove(AuthorizedKeys + "/" + u); err != nil {
			return opErr(err)
		}
		*out = append(*out, removed{Kind: "ssh_keys", Name: AuthorizedKeys + "/" + u, SHA256: sumOf(b)})
	} else if !errors.Is(err, fs.ErrNotExist) {
		return opErr(err)
	}
	// FTP ảo (pure-ftpd): chỉ user dạng <u>_<tên> có uid account.
	res, err := d.run(ctx, "pure-pw", "list")
	if err != nil || res.ExitCode != 0 {
		return nil // chưa cài pure-ftpd: không có user FTP
	}
	for _, l := range strings.Split(string(res.Stdout), "\n") {
		f := strings.Fields(l)
		if len(f) == 0 || CheckFTPUser(a, f[0]) != nil {
			continue
		}
		name := f[0]
		if name == "" {
			continue
		}
		cur, err := d.pureShow(ctx, name)
		if err != nil {
			return err
		}
		if cur == nil || cur.UID != fmt.Sprint(a.UID) {
			continue
		}
		if _, err := d.must(ctx, "internal", "pure-pw", "userdel", name, "-m"); err != nil {
			return err
		}
		*out = append(*out, removed{Kind: "ftp_user", Name: name})
	}
	return nil
}

func skipEngine(err error) bool {
	var oe *registry.OpError
	return errors.As(err, &oe) && (oe.Code == "dependency_unavailable" || oe.Code == "not_found")
}

func (d *Deps) removeDatabases(ctx context.Context, a contracts.Account, out *[]removed) error {
	u := string(a.Username)
	for _, e := range []engine{engMy, engPG} {
		dbs, err := d.accountDBs(ctx, e, u)
		if skipEngine(err) {
			continue
		}
		if err != nil {
			return err
		}
		kind := map[engine]string{engMy: "mysql", engPG: "postgresql"}[e]
		for _, db := range dbs {
			stmt := fmt.Sprintf("DROP DATABASE IF EXISTS %s;\n", myIdent(db))
			if e == engPG {
				stmt = fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE);\n", pgIdent(db))
			}
			if _, err := d.sql(ctx, e, stmt); err != nil {
				return err
			}
			*out = append(*out, removed{Kind: kind + "_database", Name: db})
		}
		q := fmt.Sprintf("SELECT DISTINCT User FROM mysql.user WHERE User LIKE %s;\n", myLike(u))
		if e == engPG {
			q = fmt.Sprintf("SELECT rolname FROM pg_roles WHERE rolname LIKE %s;\n", pgLike(u))
		}
		res, err := d.sql(ctx, e, q)
		if err != nil {
			return err
		}
		users := []string{}
		for _, n := range lines(res) {
			if reDBName.MatchString(n) && strings.HasPrefix(n, u+"_") {
				users = append(users, n)
			}
		}
		users = append(users, u) // danh tính chủ (ADR 0018 §5)
		for _, n := range users {
			if e == engMy {
				hs, err := d.myHosts(ctx, n)
				if err != nil {
					return err
				}
				if len(hs) == 0 {
					continue
				}
				var b strings.Builder
				for _, h := range hs {
					fmt.Fprintf(&b, "DROP USER IF EXISTS %s@%s;\n", lit(n), lit(h))
				}
				if _, err := d.sql(ctx, e, b.String()); err != nil {
					return err
				}
			} else {
				exists, err := d.pgRoleExists(ctx, n)
				if err != nil {
					return err
				}
				if !exists {
					continue
				}
				if _, err := d.sql(ctx, e, fmt.Sprintf("DROP ROLE IF EXISTS %s;\n", pgIdent(n))); err != nil {
					return err
				}
			}
			*out = append(*out, removed{Kind: kind + "_user", Name: n})
		}
	}
	return nil
}

func (d *Deps) removeHome(_ context.Context, a contracts.Account, out *[]removed) error {
	home := homeOf(a.Username)
	fi, err := d.FS.Lstat(home)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return opErr(err)
	case !fi.IsDir():
		return &registry.OpError{Code: "precondition_failed", Message: home + " không phải thư mục (symlink?): không xóa"}
	default:
		if err := d.FS.RemoveAll(home); err != nil {
			return opErr(err)
		}
		*out = append(*out, removed{Kind: "home", Name: home})
	}
	logs := SiteLogBase + "/" + string(a.Username)
	if d.FS.Exists(logs) {
		if err := d.FS.RemoveAll(logs); err != nil {
			return opErr(err)
		}
		*out = append(*out, removed{Kind: "site_logs", Name: logs})
	}
	slice, err := validate.SliceName(int64(a.UID))
	if err != nil {
		return opErr(err)
	}
	for _, f := range []string{UnitDir + "/" + slice + ".d", fmt.Sprintf("%s/user-%d.slice.d", UnitDir, a.UID)} {
		if d.FS.Exists(f) {
			if err := d.FS.RemoveAll(f); err != nil {
				return opErr(err)
			}
		}
	}
	return nil
}
