package ops

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"sync"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Truy cập file từ xa (D-73, ADR 0020): SFTP = user Linux của account (chroot), FTPS phụ = virtual user Pure-FTPd,
// SSH key do panel quản lý ở /etc/itso/ssh/authorized_keys/<user> (root 0644).

const (
	SFTPGroup       = "itso-sftp"
	SSHGroup        = "itso-ssh"
	SshdDropIn      = "/etc/ssh/sshd_config.d/50-itso.conf"
	AuthorizedKeys  = "/etc/ssh/itso_authorized_keys" // ngoài /etc/itso (0750): sshd đọc khóa bằng uid của user
	maxKeysPerAcct  = 50
	maxKeyLineBytes = 16384
)

var (
	sshdMu      sync.Mutex
	reFTPUser   = regexp.MustCompile(`^[a-z][a-z0-9_]{2,31}$`)
	reKeyCmt    = regexp.MustCompile(`^[A-Za-z0-9 ._@:+=/-]{0,200}$`)
	sshKeyTypes = map[string]bool{"ssh-ed25519": true, "ecdsa-sha2-nistp256": true, "ssh-rsa": true}
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpSshdMatchApply: d.sshdMatchApply,
			contracts.OpSFTPUserEnsure: d.sftpUserEnsure,
			contracts.OpSFTPUserRemove: d.sftpUserRemove,
			contracts.OpFTPUserEnsure:  d.ftpUserEnsure,
			contracts.OpFTPUserRemove:  d.ftpUserRemove,
			contracts.OpSSHKeysApply:   d.sshKeysApply,
		}
	})
}

// SshdConf sinh drop-in sshd cố định (ADR 0020 §2). AuthorizedKeysFile chỉ nằm trong Match; file kết thúc bằng
// "Match all" để không Match nào lan sang file cấu hình nạp sau.
func SshdConf(passwordAuth bool) string {
	pa := "no"
	if passwordAuth {
		pa = "yes"
	}
	return "# Sinh bởi itso-agent (sshd.match.apply). Không sửa tay.\n" +
		"DenyGroups " + SuspendedGroup + "\n\n" +
		"Match Group " + SFTPGroup + "\n" +
		"\tChrootDirectory %h\n\tForceCommand internal-sftp -d /\n\tAllowTcpForwarding no\n\tX11Forwarding no\n" +
		"\tPermitTunnel no\n\tAllowAgentForwarding no\n\n" +
		"Match Group " + SSHGroup + "\n" +
		"\tAllowTcpForwarding no\n\tX11Forwarding no\n\tPermitTunnel no\n\n" +
		"Match Group " + SFTPGroup + "," + SSHGroup + "\n" +
		"\tAuthorizedKeysFile " + AuthorizedKeys + "/%u\n\tPasswordAuthentication " + pa + "\n\n" +
		"Match all\n"
}

func (d *Deps) sshdMatchApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SshdMatchApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	conf := []byte(SshdConf(p.PasswordAuthentication))
	sshdMu.Lock()
	defer sshdMu.Unlock()
	old, rerr := d.FS.ReadFile(SshdDropIn)
	existed := rerr == nil
	if rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		return nil, opErr(rerr)
	}
	if existed && bytes.Equal(old, conf) {
		return toData(contracts.SshdMatchApplyResult{SshdTest: "ok", Reloaded: false, Changed: false})
	}
	if err := d.mkdirs(AuthorizedKeys); err != nil {
		return nil, err
	}
	if err := d.mkdirs("/etc/ssh/sshd_config.d"); err != nil {
		return nil, err
	}
	if _, err := d.FS.WriteAtomic(SshdDropIn, conf, 0o644, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	res, err := d.run(ctx, "sshd", "-t")
	if err == nil && res.ExitCode != 0 {
		err = cmdFailed("config_test_failed", "sshd -t", res)
	}
	if err != nil {
		var rb error
		if existed {
			_, rb = d.FS.WriteAtomic(SshdDropIn, old, 0o644, platform.Owner{})
		} else {
			_, rb = d.FS.Remove(SshdDropIn)
		}
		if rb != nil {
			return nil, &registry.OpError{Code: "internal", Message: "sshd -t lỗi và hoàn tác thất bại: " + rb.Error()}
		}
		return nil, err
	}
	if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "try-reload-or-restart", "ssh.service"); err != nil {
		return nil, err
	}
	return toData(contracts.SshdMatchApplyResult{SshdTest: "ok", Reloaded: true, Changed: true})
}

// optPassword đọc trường password (chuỗi hoặc null) và kiểm bộ ký tự.
func optPassword(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var pw string
	if err := json.Unmarshal(raw, &pw); err != nil {
		return "", invalid("password phải là chuỗi hoặc null (tham chiếu bí mật chưa được thay?)")
	}
	return pw, CheckPassword(pw)
}

func (d *Deps) setGroup(ctx context.Context, user, group string, member bool) (bool, error) {
	g, err := d.groupByName(group)
	if err != nil {
		return false, opErr(err)
	}
	if g == nil {
		if !member {
			return false, nil
		}
		if _, err := d.must(ctx, "internal", "groupadd", "-r", group); err != nil {
			return false, err
		}
	}
	in := g != nil && contains(g.Members, user)
	if in == member {
		return false, nil
	}
	flag := "-d"
	if member {
		flag = "-a"
	}
	if _, err := d.must(ctx, "internal", "gpasswd", flag, user, group); err != nil {
		return false, err
	}
	return true, nil
}

func (d *Deps) sftpUserEnsure(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SFTPUserEnsureParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	pw, err := optPassword(p.Password)
	if err != nil {
		return nil, err
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	want, other := SFTPGroup, SSHGroup
	if p.SSHAccess {
		want, other = SSHGroup, SFTPGroup
	}
	c1, err := d.setGroup(ctx, u.Name, want, true)
	if err != nil {
		return nil, err
	}
	c2, err := d.setGroup(ctx, u.Name, other, false)
	if err != nil {
		return nil, err
	}
	if pw != "" {
		res, err := d.Run.Run(ctx, platform.Cmd{Bin: "chpasswd", Stdin: []byte(u.Name + ":" + pw + "\n")})
		if err != nil {
			return nil, opErr(err)
		}
		if res.ExitCode != 0 {
			return nil, &registry.OpError{Code: "internal", Message: fmt.Sprintf("chpasswd thoát mã %d", res.ExitCode)}
		}
	}
	return toData(contracts.SFTPUserEnsureResult{Group: want, Changed: c1 || c2 || pw != ""})
}

func (d *Deps) sftpUserRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SFTPUserRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	removed := false
	for _, g := range []string{SFTPGroup, SSHGroup} {
		c, err := d.setGroup(ctx, u.Name, g, false)
		if err != nil {
			return nil, err
		}
		removed = removed || c
	}
	pwField, _, _, err := d.shadow(u.Name)
	if err != nil {
		return nil, opErr(err)
	}
	if !strings.HasPrefix(pwField, "!") {
		if _, err := d.must(ctx, "internal", "usermod", "-L", u.Name); err != nil {
			return nil, err
		}
		removed = true
	}
	return toData(contracts.SFTPUserRemoveResult{Removed: removed})
}

// ---------- SSH key ----------

// ParseSSHKey kiểm một dòng public key: chỉ "<type> <base64> [comment]", không option; blob phải mở đầu bằng đúng type.
// Trả dòng chuẩn hóa và fingerprint SHA256 (hex) để phát hiện trùng.
func ParseSSHKey(line string) (string, error) {
	if len(line) > maxKeyLineBytes || strings.ContainsAny(line, "\x00\r\n") {
		return "", invalid("khóa SSH quá dài hoặc có ký tự cấm")
	}
	f := strings.Fields(line)
	if len(f) < 2 {
		return "", invalid("khóa SSH phải có dạng <type> <base64> [comment]")
	}
	if !sshKeyTypes[f[0]] {
		return "", invalid("loại khóa không hỗ trợ: %q", f[0])
	}
	blob, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil || len(blob) < 4 {
		return "", invalid("phần base64 của khóa không hợp lệ")
	}
	n := binary.BigEndian.Uint32(blob[:4])
	if int(n) != len(f[0]) || len(blob) < 4+int(n) || string(blob[4:4+n]) != f[0] {
		return "", invalid("nội dung khóa không khớp loại %s", f[0])
	}
	if f[0] == "ssh-rsa" && len(blob) < 256 {
		return "", invalid("khóa RSA quá ngắn")
	}
	out := f[0] + " " + f[1]
	if len(f) > 2 {
		c := strings.Join(f[2:], " ")
		if !reKeyCmt.MatchString(c) {
			return "", invalid("comment của khóa có ký tự không cho phép")
		}
		out += " " + c
	}
	return out, nil
}

func (d *Deps) sshKeysApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SSHKeysApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	if len(p.Keys) > maxKeysPerAcct {
		return nil, invalid("tối đa %d khóa", maxKeysPerAcct)
	}
	seen := map[string]bool{}
	var b strings.Builder
	b.WriteString("# Sinh bởi itso-agent (ssh.keys.apply). Không sửa tay.\n")
	for _, k := range p.Keys {
		line, err := ParseSSHKey(k)
		if err != nil {
			return nil, err
		}
		blob := strings.Fields(line)[1]
		if seen[blob] {
			return nil, &registry.OpError{Code: "already_exists", Message: "khóa SSH bị trùng"}
		}
		seen[blob] = true
		b.WriteString(line + "\n")
	}
	path := AuthorizedKeys + "/" + u.Name
	if len(p.Keys) == 0 {
		if _, err := d.FS.Remove(path); err != nil {
			return nil, opErr(err)
		}
		return toData(contracts.SSHKeysApplyResult{Count: 0})
	}
	if err := d.mkdirs(AuthorizedKeys); err != nil {
		return nil, err
	}
	if _, err := d.FS.WriteAtomic(path, []byte(b.String()), 0o644, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	return toData(contracts.SSHKeysApplyResult{Count: int64(len(p.Keys))})
}

// ---------- FTPS phụ (Pure-FTPd) ----------

// CheckFTPUser kiểm username virtual user: regex + tiền tố `<username>_`.
func CheckFTPUser(a contracts.Account, name string) error {
	if !reFTPUser.MatchString(name) || !strings.HasPrefix(name, string(a.Username)+"_") || len(name) == len(a.Username)+1 {
		return invalid("username FTP %q phải có dạng %s_<tên>", name, a.Username)
	}
	return nil
}

type pureUser struct{ UID, GID, Dir string }

// pureShow đọc `pure-pw show`: không có user → nil.
func (d *Deps) pureShow(ctx context.Context, name string) (*pureUser, error) {
	res, err := d.run(ctx, "pure-pw", "show", name)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, nil
	}
	u := &pureUser{}
	for _, l := range strings.Split(string(res.Stdout), "\n") {
		k, v, okKV := strings.Cut(l, ":")
		if !okKV {
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "UID":
			u.UID = strings.Fields(v + " ")[0]
		case "GID":
			u.GID = strings.Fields(v + " ")[0]
		case "Directory":
			u.Dir = strings.TrimSuffix(strings.TrimSuffix(v, "/./"), "/")
		}
	}
	return u, nil
}

func randomSecret() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (d *Deps) purePw(ctx context.Context, pw string, args ...string) error {
	res, err := d.Run.Run(ctx, platform.Cmd{Bin: "pure-pw", Args: args, Stdin: []byte(pw + "\n" + pw + "\n")})
	if err != nil {
		return opErr(err)
	}
	if res.ExitCode != 0 {
		return cmdFailed("internal", "pure-pw "+args[0], res)
	}
	return nil
}

func (d *Deps) ftpUserEnsure(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FTPUserEnsureParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	name := string(p.Username)
	if err := CheckFTPUser(p.Account, name); err != nil {
		return nil, err
	}
	pw, err := optPassword(p.Password)
	if err != nil {
		return nil, err
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	root := string(p.RootPath)
	dir := homeOf(p.Account.Username)
	if root != "." {
		if err := fsx.CheckPath(root); err != nil {
			return nil, &registry.OpError{Code: fsx.Code(err), Message: err.Error()}
		}
		// Thư mục gốc phải có sẵn và là thư mục thật (helper kiểm dưới uid account, không theo symlink ra ngoài).
		var st contracts.FsStatResult
		if _, err := d.fsOp(ctx, p.Account, "stat", map[string]any{"path": root}, []string{root}, &st); err != nil {
			return nil, err
		}
		if !st.Exists || string(st.Type) != `"dir"` {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "root_path không phải thư mục có sẵn trong home"}
		}
		dir += "/" + root
	}
	uid, gid := fmt.Sprint(u.UID), fmt.Sprint(u.GID)
	cur, err := d.pureShow(ctx, name)
	if err != nil {
		return nil, err
	}
	setPw := pw
	if !p.Enabled {
		setPw = randomSecret() // khóa: mật khẩu ngẫu nhiên không ai biết, panel giữ mật khẩu thật
	}
	if cur == nil {
		if setPw == "" {
			return nil, invalid("tạo user FTP mới cần password")
		}
		if err := d.purePw(ctx, setPw, "useradd", name, "-u", uid, "-g", gid, "-d", dir, "-m"); err != nil {
			return nil, err
		}
		return toData(contracts.FTPUserEnsureResult{Created: true, Changed: true})
	}
	changed := false
	if cur.UID != uid || cur.GID != gid || cur.Dir != dir {
		if _, err := d.must(ctx, "internal", "pure-pw", "usermod", name, "-u", uid, "-g", gid, "-d", dir, "-m"); err != nil {
			return nil, err
		}
		changed = true
	}
	if setPw != "" {
		if err := d.purePw(ctx, setPw, "passwd", name, "-m"); err != nil {
			return nil, err
		}
		changed = true
	}
	return toData(contracts.FTPUserEnsureResult{Created: false, Changed: changed})
}

func (d *Deps) ftpUserRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FTPUserRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	name := string(p.Username)
	if err := CheckFTPUser(p.Account, name); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	cur, err := d.pureShow(ctx, name)
	if err != nil {
		return nil, err
	}
	if cur == nil {
		return toData(contracts.FTPUserRemoveResult{Removed: false})
	}
	if cur.UID != fmt.Sprint(p.Account.UID) {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "user FTP không thuộc account " + string(p.Account.Username)}
	}
	if _, err := d.must(ctx, "internal", "pure-pw", "userdel", name, "-m"); err != nil {
		return nil, err
	}
	return toData(contracts.FTPUserRemoveResult{Removed: true})
}
