package ops

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// SuspendedGroup chặn SSH/SFTP qua DenyGroups (sshd, Phase 7) và đánh dấu account bị khóa.
const SuspendedGroup = "itso-suspended"

// WebUser là user của Nginx: chỉ được --x trên home để đi qua tới public/ (07 §5).
const WebUser = "www-data"

var shells = map[string]bool{"/usr/sbin/nologin": true, "/bin/bash": true}

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpAccountEnsure:      d.accountEnsure,
			contracts.OpAccountLimitsApply: d.accountLimitsApply,
			contracts.OpAccountSuspend:     d.accountSuspend,
			contracts.OpAccountUnsuspend:   d.accountUnsuspend,
		}
	})
}

func (d *Deps) accountEnsure(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.AccountEnsureParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	if err := validate.Limits(p.Limits).Check(); err != nil {
		return nil, opErr(err)
	}
	if !shells[p.Shell] {
		return nil, &registry.OpError{Code: "invalid_params", Message: "shell ngoài danh sách cho phép"}
	}
	name, uid := string(p.Account.Username), int64(p.Account.UID)
	home := homeOf(p.Account.Username)
	if p.HomePath != home {
		return nil, &registry.OpError{Code: "path_outside_home", Message: "home_path phải là " + home}
	}

	// 1. Group riêng, GID = UID.
	gs, err := d.groups()
	if err != nil {
		return nil, opErr(err)
	}
	var grp *groupEntry
	for i := range gs {
		switch {
		case gs[i].Name == name:
			grp = &gs[i]
		case gs[i].GID == uid:
			return nil, &registry.OpError{Code: "already_exists", Message: fmt.Sprintf("gid %d đã thuộc group %s", uid, gs[i].Name)}
		}
	}
	if grp != nil && grp.GID != uid {
		return nil, &registry.OpError{Code: "already_exists", Message: fmt.Sprintf("group %s đã có gid %d", name, grp.GID)}
	}

	// 2. User: kiểm xung đột trước khi ghi bất cứ gì.
	us, err := d.users()
	if err != nil {
		return nil, opErr(err)
	}
	var usr *passwdEntry
	for i := range us {
		switch {
		case us[i].Name == name:
			usr = &us[i]
		case us[i].UID == uid:
			return nil, &registry.OpError{Code: "already_exists", Message: fmt.Sprintf("uid %d đã thuộc user %s", uid, us[i].Name)}
		}
	}
	if usr != nil && (usr.UID != uid || usr.GID != uid) {
		return nil, &registry.OpError{Code: "already_exists", Message: fmt.Sprintf("user %s đã có uid %d", name, usr.UID)}
	}
	if usr != nil && usr.Home != home {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "user đã có home khác: " + usr.Home}
	}

	ids := strconv.FormatInt(uid, 10)
	if grp == nil {
		if _, err := d.must(ctx, "internal", "groupadd", "-g", ids, name); err != nil {
			return nil, err
		}
	}
	created := false
	if usr == nil {
		// -M: home do agent tạo với chủ root (yêu cầu ChrootDirectory của SFTP); -N: dùng group vừa tạo.
		if _, err := d.must(ctx, "internal", "useradd", "-u", ids, "-g", ids, "-d", home, "-s", p.Shell, "-M", "-N",
			"-c", "ITSO hosting "+name, name); err != nil {
			return nil, err
		}
		created = true
	} else if usr.Shell != p.Shell {
		if _, err := d.must(ctx, "internal", "usermod", "-s", p.Shell, name); err != nil {
			return nil, err
		}
	}

	// 3. Bố cục home (07 §5).
	acct := platform.Owner{UID: int(uid), GID: int(uid)}
	root := platform.Owner{UID: 0, GID: 0}
	dirs := []struct {
		path  string
		mode  uint32
		owner platform.Owner
	}{
		{home, 0o750, platform.Owner{UID: 0, GID: int(uid)}},
		{home + "/sites", 0o750, acct},
		{home + "/backups", 0o700, acct},
		{home + "/.ssh", 0o700, acct},
		{home + "/.itso", 0o755, root},
	}
	if err := d.FS.MkdirAll(HomeBase); err != nil {
		return nil, opErr(err)
	}
	for _, x := range dirs {
		if _, err := d.FS.EnsureDir(x.path, modeOf(x.mode), x.owner); err != nil {
			return nil, opErr(err)
		}
	}
	// ACL: www-data chỉ đi qua (--x) home và sites/; quyền đọc public/ do nginx.vhost.apply (Phase 5) cấp.
	for _, p := range []string{home, home + "/sites"} {
		if err := d.ensureACL(ctx, p, "u:"+WebUser+":--x"); err != nil {
			return nil, err
		}
	}

	// 4. Slice + giới hạn (D-64).
	if _, err := d.applySlices(ctx, p.Account, p.Limits); err != nil {
		return nil, err
	}
	return toData(contracts.AccountEnsureResult{Created: created, UID: p.Account.UID})
}

// ensureACL thêm một mục ACL nếu getfacl chưa có (idempotent).
func (d *Deps) ensureACL(ctx context.Context, path, entry string) error {
	res, err := d.must(ctx, "dependency_unavailable", "getfacl", "--omit-header", "--absolute-names", path)
	if err != nil {
		return err
	}
	// "u:www-data:--x" ↔ dòng "user:www-data:--x"; "d:u:…" ↔ "default:user:…" của getfacl.
	want := "user:" + strings.TrimPrefix(strings.TrimPrefix(entry, "d:"), "u:")
	if strings.HasPrefix(entry, "d:") {
		want = "default:" + want
	}
	for _, l := range strings.Split(string(res.Stdout), "\n") {
		if strings.TrimSpace(strings.SplitN(l, "#", 2)[0]) == want {
			return nil
		}
	}
	_, err = d.must(ctx, "dependency_unavailable", "setfacl", "-m", entry, path)
	return err
}

func (d *Deps) accountLimitsApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.AccountLimitsApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.Limits(p.Limits).Check(); err != nil {
		return nil, opErr(err)
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	slice, err := d.applySlices(ctx, p.Account, p.Limits)
	if err != nil {
		return nil, err
	}
	return toData(contracts.AccountLimitsApplyResult{Applied: true, Slice: slice})
}

// SliceDropIn sinh drop-in cho itso-acct-<uid>.slice (scale=100) hoặc user-<uid>.slice (scale=50, ADR 0011).
// Slice cha là itso-acct.slice (systemd suy ra từ tên: itso.slice → itso-acct.slice → itso-acct-<uid>.slice).
func SliceDropIn(a contracts.Account, l contracts.Limits, scale int64, purpose string) string {
	pct := func(v, min int64) int64 {
		v = v * scale / 100
		if v < min {
			return min
		}
		return v
	}
	ram := pct(l.RAMMB, 32)
	var b strings.Builder
	fmt.Fprintf(&b, "# Sinh bởi itso-agent (account.limits.apply). Không sửa tay: sẽ bị ghi đè.\n")
	fmt.Fprintf(&b, "[Unit]\nDescription=ITSO %s %s (uid %d)\n\n[Slice]\n", purpose, a.Username, a.UID)
	fmt.Fprintf(&b, "CPUAccounting=yes\nMemoryAccounting=yes\nTasksAccounting=yes\nIOAccounting=yes\n")
	fmt.Fprintf(&b, "CPUQuota=%d%%\n", pct(l.CPUPercent, 1))
	fmt.Fprintf(&b, "MemoryMax=%dM\nMemoryHigh=%dM\nMemorySwapMax=0\n", ram, ram*9/10)
	fmt.Fprintf(&b, "TasksMax=%d\n", pct(l.TasksMax, 8))
	fmt.Fprintf(&b, "IOWeight=%d\n", l.IOWeight)
	if l.IOReadBps != nil {
		fmt.Fprintf(&b, "IOReadBandwidthMax=%s %d\n", HomeBase, pct(*l.IOReadBps, 1))
	}
	if l.IOWriteBps != nil {
		fmt.Fprintf(&b, "IOWriteBandwidthMax=%s %d\n", HomeBase, pct(*l.IOWriteBps, 1))
	}
	return b.String()
}

// applySlices ghi drop-in cho slice account và slice phiên SSH; chỉ daemon-reload khi có file đổi.
func (d *Deps) applySlices(ctx context.Context, a contracts.Account, l contracts.Limits) (string, error) {
	slice, err := validate.SliceName(int64(a.UID))
	if err != nil {
		return "", opErr(err)
	}
	root := platform.Owner{UID: 0, GID: 0}
	files := map[string]string{
		"/etc/systemd/system/" + slice + ".d/50-itso.conf":                     SliceDropIn(a, l, 100, "hosting account"),
		fmt.Sprintf("/etc/systemd/system/user-%d.slice.d/50-itso.conf", a.UID): SliceDropIn(a, l, 50, "SSH/SFTP session"),
	}
	changed := false
	for _, p := range sortedKeys(files) {
		c, err := d.FS.WriteAtomic(p, []byte(files[p]), 0o644, root)
		if err != nil {
			return "", opErr(err)
		}
		changed = changed || c
	}
	if changed {
		if _, err := d.must(ctx, "internal", "systemctl", "daemon-reload"); err != nil {
			return "", err
		}
	}
	return slice, nil
}

func (d *Deps) accountSuspend(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.AccountSuspendParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if strings.ContainsAny(p.Reason, "\n\r\x00") {
		return nil, &registry.OpError{Code: "invalid_params", Message: "reason phải một dòng"}
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	g, err := d.groupByName(SuspendedGroup)
	if err != nil {
		return nil, opErr(err)
	}
	if g == nil {
		if _, err := d.must(ctx, "internal", "groupadd", "-r", SuspendedGroup); err != nil {
			return nil, err
		}
	}
	if g == nil || !contains(g.Members, u.Name) {
		if _, err := d.must(ctx, "internal", "gpasswd", "-a", u.Name, SuspendedGroup); err != nil {
			return nil, err
		}
	}
	// Khóa mật khẩu (-L) và cho hết hạn tài khoản (-e 1): PAM chặn cả đăng nhập bằng khóa SSH.
	pw, exp, _, err := d.shadow(u.Name)
	if err != nil {
		return nil, opErr(err)
	}
	var args []string
	if !strings.HasPrefix(pw, "!") {
		args = append(args, "-L")
	}
	if exp != "1" {
		args = append(args, "-e", "1")
	}
	if len(args) > 0 {
		if _, err := d.must(ctx, "internal", "usermod", append(args, u.Name)...); err != nil {
			return nil, err
		}
	}
	// Dừng mọi tiến trình của account: slice dịch vụ và phiên SSH/SFTP.
	slice, _ := validate.SliceName(int64(p.Account.UID))
	for _, unit := range []string{slice, fmt.Sprintf("user-%d.slice", p.Account.UID)} {
		if err := d.stopIfActive(ctx, unit); err != nil {
			return nil, err
		}
	}
	return toData(contracts.AccountSuspendResult{Suspended: true})
}

func (d *Deps) accountUnsuspend(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.AccountUnsuspendParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	g, err := d.groupByName(SuspendedGroup)
	if err != nil {
		return nil, opErr(err)
	}
	if g != nil && contains(g.Members, u.Name) {
		if _, err := d.must(ctx, "internal", "gpasswd", "-d", u.Name, SuspendedGroup); err != nil {
			return nil, err
		}
	}
	pw, exp, _, err := d.shadow(u.Name)
	if err != nil {
		return nil, opErr(err)
	}
	var args []string
	// Chỉ -U khi sau "!" còn hash: account mới tạo có "!" (chưa đặt mật khẩu) giữ nguyên.
	if strings.HasPrefix(pw, "!") && len(pw) > 1 && !strings.HasPrefix(pw, "!*") && pw != "!!" {
		args = append(args, "-U")
	}
	if exp != "" {
		args = append(args, "-e", "")
	}
	if len(args) > 0 {
		if _, err := d.must(ctx, "internal", "usermod", append(args, u.Name)...); err != nil {
			return nil, err
		}
	}
	// Dịch vụ của account (PHP-FPM, cron… từ Phase 5) được reconcile khởi động lại.
	return toData(contracts.AccountUnsuspendResult{Suspended: false})
}

func (d *Deps) stopIfActive(ctx context.Context, unit string) error {
	res, err := d.run(ctx, "systemctl", "is-active", unit)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(res.Stdout)) == "inactive" || res.ExitCode != 0 && strings.TrimSpace(string(res.Stdout)) != "active" {
		return nil
	}
	_, err = d.must(ctx, "internal", "systemctl", "stop", unit)
	return err
}
