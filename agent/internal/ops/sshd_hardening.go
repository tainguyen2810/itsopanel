package ops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// SSH hardening (D-77, ADR 0024): /etc/ssh/sshd_config.d/10-itso-hardening.conf từ tập khóa cố định,
// sshd -t → reload → safe-apply (xác nhận bằng token, timer hoàn tác) như tường lửa.

const (
	SshdHardening = "/etc/ssh/sshd_config.d/10-itso-hardening.conf"
	SshdDir       = "/var/lib/itso/sshd"
	absentMarker  = "# itso: file chưa tồn tại trước lần áp dụng\n"
)

var (
	sshdKind     = safeKind{name: "sshd", dir: SshdDir, unit: "itso-sshd-rollback", restore: restoreSshd}
	reSysGroup   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	reAdminUser  = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	sshKeyPrefix = []string{"ssh-ed25519 ", "ecdsa-sha2-nistp256 ", "ecdsa-sha2-nistp384 ", "ecdsa-sha2-nistp521 ",
		"ssh-rsa ", "sk-ssh-ed25519@openssh.com ", "sk-ecdsa-sha2-nistp256@openssh.com "}
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpSshdConfigApply:   d.sshdConfigApply,
			contracts.OpSshdConfigConfirm: d.sshdConfigConfirm,
		}
	})
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// SshdHardeningConf sinh file hardening từ tham số đã kiểm. Không có ô cấu hình tự do.
func SshdHardeningConf(p contracts.SshdConfigApplyParams) string {
	var b strings.Builder
	b.WriteString("# Sinh bởi itso-agent (sshd.config.apply). Không sửa tay.\n")
	fmt.Fprintf(&b, "Port %d\n", p.Port)
	fmt.Fprintf(&b, "PermitRootLogin %s\n", p.PermitRootLogin)
	fmt.Fprintf(&b, "PasswordAuthentication %s\n", yesNo(p.PasswordAuthentication))
	b.WriteString("KbdInteractiveAuthentication no\n")
	fmt.Fprintf(&b, "MaxAuthTries %d\n", p.MaxAuthTries)
	fmt.Fprintf(&b, "LoginGraceTime %d\n", p.LoginGraceSec)
	fmt.Fprintf(&b, "X11Forwarding %s\n", yesNo(p.X11Forwarding))
	fmt.Fprintf(&b, "AllowAgentForwarding %s\n", yesNo(p.AgentForwarding))
	if len(p.AllowGroups) > 0 {
		fmt.Fprintf(&b, "AllowGroups %s\n", strings.Join(p.AllowGroups, " "))
	}
	return b.String()
}

func checkSshdParams(p contracts.SshdConfigApplyParams) error {
	switch {
	case !reApplyID.MatchString(string(p.ApplyID)):
		return fwInvalid("apply_id không hợp lệ")
	case p.Port < 1 || p.Port > 65535:
		return fwInvalid("port ngoài 1–65535")
	case p.PermitRootLogin != "no" && p.PermitRootLogin != "prohibit-password":
		return fwInvalid("permit_root_login không hợp lệ")
	case p.MaxAuthTries < 1 || p.MaxAuthTries > 10:
		return fwInvalid("max_auth_tries ngoài 1–10")
	case p.LoginGraceSec < 10 || p.LoginGraceSec > 300:
		return fwInvalid("login_grace_sec ngoài 10–300")
	case p.ConfirmWithinSec < 30 || p.ConfirmWithinSec > 600:
		return fwInvalid("confirm_within_sec ngoài 30–600")
	case !reAdminUser.MatchString(p.AdminUser):
		return fwInvalid("admin_user không hợp lệ")
	case len(p.AllowGroups) > 20:
		return fwInvalid("allow_groups quá 20")
	}
	seen := map[string]bool{}
	for _, g := range p.AllowGroups {
		if !reSysGroup.MatchString(g) || seen[g] {
			return fwInvalid("allow_groups: %q không hợp lệ hoặc trùng", g)
		}
		seen[g] = true
	}
	return nil
}

// adminKeys đếm khóa SSH hợp lệ của user quản trị (~/.ssh/authorized_keys và khóa do panel quản lý).
func (d *Deps) adminKeys(user string) (int64, error) {
	users, err := d.users()
	if err != nil {
		return 0, err
	}
	home := ""
	for _, u := range users {
		if u.Name == user {
			home = u.Home
		}
	}
	if home == "" {
		return 0, &registry.OpError{Code: "not_found", Message: "không có user quản trị " + user}
	}
	var n int64
	for _, p := range []string{strings.TrimRight(home, "/") + "/.ssh/authorized_keys", AuthorizedKeys + "/" + user} {
		b, err := d.FS.ReadFile(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return 0, opErr(err)
		}
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			for _, k := range sshKeyPrefix {
				if strings.Contains(line, k) && !strings.HasPrefix(line, "#") {
					n++
					break
				}
			}
		}
	}
	return n, nil
}

// sshdWriteTest ghi nội dung (hoặc xóa khi là marker "chưa tồn tại"), chạy sshd -t; lỗi → ghi lại bản cũ.
func (d *Deps) sshdWriteTest(ctx context.Context, conf, old []byte) error {
	write := func(b []byte) error {
		if bytes.Equal(b, []byte(absentMarker)) {
			_, err := d.FS.Remove(SshdHardening)
			return err
		}
		_, err := d.FS.WriteAtomic(SshdHardening, b, 0o644, platform.Owner{})
		return err
	}
	if err := write(conf); err != nil {
		return opErr(err)
	}
	res, err := d.run(ctx, "sshd", "-t")
	if err == nil && res.ExitCode != 0 {
		err = cmdFailed("config_test_failed", "sshd -t", res)
	}
	if err != nil {
		if rb := write(old); rb != nil {
			return &registry.OpError{Code: "internal", Message: "sshd -t lỗi và hoàn tác thất bại: " + rb.Error()}
		}
		return err
	}
	_, err = d.must(ctx, "dependency_unavailable", "systemctl", "try-reload-or-restart", "ssh.service")
	return err
}

func restoreSshd(ctx context.Context, d *Deps, k safeKind, applyID string) error {
	prev, err := d.FS.ReadFile(k.prevPath(applyID))
	if err != nil {
		return &registry.OpError{Code: "internal", Message: "thiếu cấu hình sshd cũ để hoàn tác " + applyID}
	}
	cur, err := d.FS.ReadFile(SshdHardening)
	if errors.Is(err, fs.ErrNotExist) {
		cur, err = []byte(absentMarker), nil
	}
	if err != nil {
		return opErr(err)
	}
	return d.sshdWriteTest(ctx, prev, cur)
}

func (d *Deps) sshdConfigApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SshdConfigApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkSshdParams(p); err != nil {
		return nil, err
	}
	keys, err := d.adminKeys(p.AdminUser)
	if err != nil {
		return nil, err
	}
	if !p.PasswordAuthentication && keys == 0 {
		return nil, &registry.OpError{Code: "would_lock_out",
			Message: "tắt đăng nhập mật khẩu khi " + p.AdminUser + " chưa có khóa SSH nào sẽ khóa quản trị viên"}
	}
	conf := []byte(SshdHardeningConf(p))
	id := string(p.ApplyID)
	safeMu.Lock()
	defer safeMu.Unlock()
	sshdMu.Lock()
	defer sshdMu.Unlock()
	if err := d.safeBegin(ctx, sshdKind); err != nil {
		return nil, err
	}
	old, rerr := d.FS.ReadFile(SshdHardening)
	if errors.Is(rerr, fs.ErrNotExist) {
		old, rerr = []byte(absentMarker), nil
	}
	if rerr != nil {
		return nil, opErr(rerr)
	}
	if err := d.mkdirs("/etc/ssh/sshd_config.d"); err != nil {
		return nil, err
	}
	if _, err := d.FS.WriteAtomic(sshdKind.prevPath(id), old, 0o600, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	if err := d.sshdWriteTest(ctx, conf, old); err != nil {
		_, _ = d.FS.Remove(sshdKind.prevPath(id))
		return nil, err
	}
	token, at, err := d.safeArm(ctx, sshdKind, id, p.ConfirmWithinSec)
	if err != nil {
		return nil, err
	}
	return toData(contracts.SshdConfigApplyResult{Token: contracts.ConfirmToken(token), RollbackAt: at.Format("2006-01-02T15:04:05Z07:00"),
		SshdTest: "ok", Changed: !bytes.Equal(old, conf), AdminKeys: keys})
}

func (d *Deps) sshdConfigConfirm(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SshdConfigConfirmParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !reApplyID.MatchString(string(p.ApplyID)) {
		return nil, fwInvalid("apply_id không hợp lệ")
	}
	ok, rb, err := d.safeConfirm(ctx, sshdKind, string(p.ApplyID), string(p.Token))
	if err != nil {
		return nil, err
	}
	return toData(contracts.SshdConfigConfirmResult{Confirmed: ok, RolledBack: rb})
}
