package ops

// cis.audit (Phase 12, D-109, ADR 0054): kiểm CIS Ubuntu 24.04 Level 1 phần liên quan máy chủ hosting. CHỈ ĐỌC:
// đọc /proc, /sys, file cấu hình và quyền/chủ file; không đọc nội dung file nhạy cảm (/etc/shadow, key), không sửa gì.
// Lệnh chạy được đều là lệnh đọc đã có trong bảng Bins (dpkg-query, apt-get -s).

import (
	"context"
	"fmt"
	"io/fs"
	"path"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{contracts.OpCisAudit: d.cisAudit}
	})
}

const (
	CisProfile     = "ubuntu24.04-l1-hosting"
	cisEvidenceMax = 500
)

type cisItem = contracts.CisAuditResultItemsItem

type cisCtx struct {
	d      *Deps
	ctx    context.Context
	mounts map[string][2]string // mount point → fstype, options
	sshd   map[string]string
	pkgs   map[string]bool
	err    error
}

func (d *Deps) cisAudit(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CisAuditParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if p.Profile != CisProfile {
		return nil, invalidOp("profile: chỉ " + CisProfile)
	}
	c := &cisCtx{d: d, ctx: ctx, pkgs: map[string]bool{}}
	c.mounts = c.readMounts()
	c.sshd = c.readSshd()
	items := []cisItem{}
	add := func(id, group, title, status, evidence string) {
		if len(evidence) > cisEvidenceMax {
			evidence = evidence[:cisEvidenceMax]
		}
		items = append(items, cisItem{ID: id, Group: group, Title: title, Status: status, Evidence: evidence})
	}
	for _, chk := range cisChecks {
		st, ev := chk.fn(c)
		if c.err != nil {
			return nil, c.err
		}
		add(chk.id, chk.group, chk.title, st, ev)
	}
	return toData(contracts.CisAuditResult{Profile: CisProfile, Items: items})
}

type cisCheck struct {
	id, group, title string
	fn               func(c *cisCtx) (string, string)
}

func passIf(ok bool, ev string) (string, string) {
	if ok {
		return "pass", ev
	}
	return "fail", ev
}

func (c *cisCtx) readMounts() map[string][2]string {
	out := map[string][2]string{}
	b, err := c.d.host().ReadFile("/proc/mounts")
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) >= 4 {
			out[f[1]] = [2]string{f[2], f[3]}
		}
	}
	return out
}

// readSshd: giá trị đầu tiên thắng (như sshd), drop-in sshd_config.d/*.conf đọc trước file chính.
func (c *cisCtx) readSshd() map[string]string {
	out := map[string]string{}
	files := []string{}
	if names, err := c.d.FS.ReadDir("/etc/ssh/sshd_config.d"); err == nil {
		slices.Sort(names)
		for _, n := range names {
			if strings.HasSuffix(n, ".conf") {
				files = append(files, "/etc/ssh/sshd_config.d/"+n)
			}
		}
	}
	files = append(files, "/etc/ssh/sshd_config")
	for _, f := range files {
		b, err := c.d.FS.ReadFile(f)
		if err != nil || len(b) > 1<<20 {
			continue
		}
		for _, l := range strings.Split(string(b), "\n") {
			l = strings.TrimSpace(l)
			if l == "" || l[0] == '#' {
				continue
			}
			k, v, ok := strings.Cut(l, " ")
			if !ok {
				k, v, ok = strings.Cut(l, "\t")
			}
			if !ok {
				continue
			}
			k = strings.ToLower(k)
			if k == "match" {
				break // khối Match chỉ áp cho một số kết nối: không tính là mặc định
			}
			if _, seen := out[k]; !seen {
				out[k] = strings.TrimSpace(v)
			}
		}
	}
	return out
}

func (c *cisCtx) sysctl(key string) string {
	return c.d.hostFile("/proc/sys/" + strings.ReplaceAll(key, ".", "/"))
}

func (c *cisCtx) pkg(name string) bool {
	if v, ok := c.pkgs[name]; ok {
		return v
	}
	v, err := c.d.pkgVersion(c.ctx, name)
	if err != nil && c.err == nil {
		c.err = err
	}
	c.pkgs[name] = v != nil
	return v != nil
}

// perm trả quyền, uid, gid (không theo symlink); ok=false nếu không có.
func (c *cisCtx) perm(p string) (fs.FileMode, uint32, uint32, bool) {
	fi, err := c.d.FS.Lstat(p)
	if err != nil {
		return 0, 0, 0, false
	}
	var uid, gid uint32
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		uid, gid = st.Uid, st.Gid
	}
	if o, ok := c.d.FS.OwnerOf(p); ok { // sandbox/test (NoChown): chủ mong muốn
		uid, gid = uint32(o.UID), uint32(o.GID)
	}
	return fi.Mode().Perm(), uid, gid, true
}

func (c *cisCtx) groupName(gid uint32) string {
	if gs, err := c.d.groups(); err == nil {
		for _, g := range gs {
			if g.GID == int64(gid) {
				return g.Name
			}
		}
	}
	return strconv.FormatUint(uint64(gid), 10)
}

func (c *cisCtx) userName(uid uint32) string {
	if us, err := c.d.users(); err == nil {
		for _, u := range us {
			if u.UID == int64(uid) {
				return u.Name
			}
		}
	}
	return strconv.FormatUint(uint64(uid), 10)
}

func (c *cisCtx) permCheck(p string, maxPerm fs.FileMode, groups ...string) (string, string) {
	m, uid, gid, ok := c.perm(p)
	if !ok {
		return "na", p + " không có"
	}
	ev := fmt.Sprintf("%s %03o %s:%s", p, m, c.userName(uid), c.groupName(gid))
	okGroup := gid == 0 || slices.Contains(groups, c.groupName(gid))
	return passIf(uid == 0 && okGroup && m&^maxPerm == 0, ev)
}

func (c *cisCtx) mountOpt(mp, opt string) (string, string) {
	m, ok := c.mounts[mp]
	if !ok {
		return "fail", mp + " không phải phân vùng riêng"
	}
	ev := m[0] + " " + mp + " " + m[1]
	return passIf(slices.Contains(strings.Split(m[1], ","), opt), ev)
}

func (c *cisCtx) sysctlEq(key, want string) (string, string) {
	v := c.sysctl(key)
	if v == "" {
		return "na", key + " không có trên kernel này"
	}
	return passIf(v == want, key+" = "+v)
}

func (c *cisCtx) notInstalled(pkgs ...string) (string, string) {
	var on []string
	for _, p := range pkgs {
		if c.pkg(p) {
			on = append(on, p)
		}
	}
	if len(on) == 0 {
		return "pass", strings.Join(pkgs, ", ") + " không cài"
	}
	return "fail", strings.Join(on, ", ") + " đang cài"
}

func (c *cisCtx) sshdIs(key string, ok func(v string) bool, def string) (string, string) {
	v, set := c.sshd[strings.ToLower(key)]
	if !set {
		v = def
	}
	ev := key + " " + v
	if !set {
		ev += " (mặc định)"
	}
	return passIf(ok(v), ev)
}

func atoiOr(s string, def int) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return def
	}
	return n
}

var cisChecks = []cisCheck{
	{"1.1.2.1", "filesystem", "/tmp là phân vùng riêng", func(c *cisCtx) (string, string) {
		m, ok := c.mounts["/tmp"]
		if !ok {
			return "fail", "/tmp nằm trên /"
		}
		return "pass", m[0] + " on /tmp"
	}},
	{"1.1.2.3", "filesystem", "/tmp có nosuid", func(c *cisCtx) (string, string) { return c.mountOpt("/tmp", "nosuid") }},
	{"1.1.2.4", "filesystem", "/tmp có noexec", func(c *cisCtx) (string, string) { return c.mountOpt("/tmp", "noexec") }},
	{"1.1.3.1", "filesystem", "/var là phân vùng riêng", func(c *cisCtx) (string, string) {
		if m, ok := c.mounts["/var"]; ok {
			return "pass", m[0] + " on /var"
		}
		return "fail", "/var nằm trên /"
	}},
	{"1.3.1.2", "access", "AppArmor bật khi khởi động", func(c *cisCtx) (string, string) {
		v := c.d.hostFile("/sys/module/apparmor/parameters/enabled")
		if v == "" {
			return "fail", "không có module AppArmor"
		}
		return passIf(v == "Y", "apparmor enabled = "+v)
	}},
	{"1.3.1.3", "access", "Mọi profile AppArmor ở enforce hoặc complain", func(c *cisCtx) (string, string) {
		b, err := c.d.host().ReadFile("/sys/kernel/security/apparmor/profiles")
		if err != nil {
			return "na", "không đọc được danh sách profile (cần securityfs)"
		}
		n, bad := 0, 0
		for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			if l == "" {
				continue
			}
			n++
			if !strings.HasSuffix(l, "(enforce)") && !strings.HasSuffix(l, "(complain)") {
				bad++
			}
		}
		return passIf(n > 0 && bad == 0, fmt.Sprintf("%d profile, %d unconfined/kill", n, bad))
	}},
	{"1.5.1", "access", "ASLR bật (kernel.randomize_va_space = 2)", func(c *cisCtx) (string, string) {
		return c.sysctlEq("kernel.randomize_va_space", "2")
	}},
	{"1.5.3", "access", "Tắt core dump cho chương trình setuid", func(c *cisCtx) (string, string) {
		return c.sysctlEq("fs.suid_dumpable", "0")
	}},
	{"2.1.1", "services", "Không chạy autofs", func(c *cisCtx) (string, string) { return c.notInstalled("autofs") }},
	{"2.1.6", "services", "Không chạy dịch vụ NFS", func(c *cisCtx) (string, string) { return c.notInstalled("nfs-kernel-server") }},
	{"2.1.12", "services", "Không chạy rpcbind", func(c *cisCtx) (string, string) { return c.notInstalled("rpcbind") }},
	{"2.1.16", "services", "Không chạy SNMP", func(c *cisCtx) (string, string) { return c.notInstalled("snmpd") }},
	{"2.1.21", "services", "MTA chỉ nghe trên loopback", func(c *cisCtx) (string, string) {
		if !c.pkg("postfix") {
			return "na", "postfix không cài"
		}
		b, _ := c.d.FS.ReadFile("/etc/postfix/main.cf")
		for _, l := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(l, "=")
			if ok && strings.TrimSpace(k) == "inet_interfaces" {
				v = strings.TrimSpace(v)
				return passIf(v == "loopback-only" || v == "localhost" || v == "127.0.0.1", "postfix inet_interfaces = "+v)
			}
		}
		return "fail", "postfix inet_interfaces = all (mặc định)"
	}},
	{"2.4.1.2", "access", "Quyền /etc/crontab 600 root:root", func(c *cisCtx) (string, string) { return c.permCheck("/etc/crontab", 0o600) }},
	{"3.3.1", "network", "Tắt IP forwarding", func(c *cisCtx) (string, string) {
		if c.d.FS.Exists("/var/lib/docker") || c.pkg("docker-ce") || c.pkg("docker.io") {
			return "na", "Docker đang cài trên máy (cần forwarding)"
		}
		return c.sysctlEq("net.ipv4.ip_forward", "0")
	}},
	{"3.3.2", "network", "Không gửi ICMP redirect", func(c *cisCtx) (string, string) {
		return c.sysctlEq("net.ipv4.conf.all.send_redirects", "0")
	}},
	{"3.3.5", "network", "Bỏ qua ICMP redirect", func(c *cisCtx) (string, string) {
		return c.sysctlEq("net.ipv4.conf.all.accept_redirects", "0")
	}},
	{"3.3.8", "network", "Bật TCP SYN cookies", func(c *cisCtx) (string, string) { return c.sysctlEq("net.ipv4.tcp_syncookies", "1") }},
	{"3.3.9", "network", "Bỏ qua IPv6 router advertisement", func(c *cisCtx) (string, string) {
		return c.sysctlEq("net.ipv6.conf.all.accept_ra", "0")
	}},
	{"4.1.1", "network", "Có tường lửa với policy mặc định chặn", func(c *cisCtx) (string, string) {
		if c.d.FS.Exists(FirewallDir + "/state.json") {
			return "pass", "table inet " + FirewallTable + ", policy drop (ITSO)"
		}
		b, _ := c.d.FS.ReadFile("/etc/nftables.conf")
		if strings.Contains(string(b), "policy drop") {
			return "pass", "/etc/nftables.conf có policy drop"
		}
		return "fail", "chưa áp tường lửa ITSO, /etc/nftables.conf không có policy drop"
	}},
	{"5.1.4", "access", "SSH: giới hạn người dùng được đăng nhập", func(c *cisCtx) (string, string) {
		for _, k := range []string{"allowgroups", "allowusers", "denygroups", "denyusers"} {
			if v, ok := c.sshd[k]; ok {
				return "pass", k + " " + v
			}
		}
		return "fail", "không có AllowGroups/AllowUsers"
	}},
	{"5.1.7", "access", "SSH: ClientAliveInterval ≤ 300", func(c *cisCtx) (string, string) {
		return c.sshdIs("ClientAliveInterval", func(v string) bool { n := atoiOr(v, 0); return n > 0 && n <= 300 }, "0")
	}},
	{"5.1.12", "access", "SSH: MaxAuthTries ≤ 4", func(c *cisCtx) (string, string) {
		return c.sshdIs("MaxAuthTries", func(v string) bool { return atoiOr(v, 99) <= 4 }, "6")
	}},
	{"5.1.20", "access", "SSH: PermitRootLogin no", func(c *cisCtx) (string, string) {
		return c.sshdIs("PermitRootLogin", func(v string) bool { return strings.EqualFold(v, "no") }, "prohibit-password")
	}},
	{"5.1.21", "access", "SSH: PasswordAuthentication no", func(c *cisCtx) (string, string) {
		return c.sshdIs("PasswordAuthentication", func(v string) bool { return strings.EqualFold(v, "no") }, "yes")
	}},
	{"5.3.3.2.1", "accounts", "Mật khẩu tối thiểu 14 ký tự (pam_pwquality)", func(c *cisCtx) (string, string) {
		b, _ := c.d.FS.ReadFile("/etc/security/pwquality.conf")
		for _, l := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(l, "=")
			if ok && strings.TrimSpace(k) == "minlen" {
				return passIf(atoiOr(v, 0) >= 14, "minlen = "+strings.TrimSpace(v))
			}
		}
		return "fail", "minlen chưa đặt"
	}},
	{"5.4.2.1", "accounts", "Chỉ root có UID 0", func(c *cisCtx) (string, string) {
		us, err := c.d.users()
		if err != nil {
			return "fail", "không đọc được /etc/passwd"
		}
		var z []string
		for _, u := range us {
			if u.UID == 0 {
				z = append(z, u.Name)
			}
		}
		return passIf(len(z) == 1 && z[0] == "root", strings.Join(z, ", "))
	}},
	{"5.4.2.4", "accounts", "Không có tài khoản mật khẩu rỗng", func(c *cisCtx) (string, string) {
		// Chỉ xét trường mật khẩu trong /etc/passwd (không đọc /etc/shadow theo ADR 0054).
		lines, err := c.d.readLines("/etc/passwd")
		if err != nil {
			return "fail", "không đọc được /etc/passwd"
		}
		n := 0
		for _, l := range lines {
			if f := strings.Split(l, ":"); len(f) == 7 && f[1] == "" {
				n++
			}
		}
		return passIf(n == 0, fmt.Sprintf("%d tài khoản không dùng shadow và mật khẩu rỗng (/etc/shadow không đọc)", n))
	}},
	{"6.1.1", "logging", "auditd đã cài và chạy", func(c *cisCtx) (string, string) {
		if !c.pkg("auditd") {
			return "fail", "auditd không cài"
		}
		return passIf(c.d.FS.Exists("/etc/systemd/system/multi-user.target.wants/auditd.service"), "auditd cài, enabled theo multi-user.target")
	}},
	{"6.2.1.1", "logging", "journald lưu bền vững", func(c *cisCtx) (string, string) {
		v := "auto"
		files := []string{"/etc/systemd/journald.conf"}
		if names, err := c.d.FS.ReadDir("/etc/systemd/journald.conf.d"); err == nil {
			slices.Sort(names)
			for _, n := range names {
				files = append(files, "/etc/systemd/journald.conf.d/"+n)
			}
		}
		for _, f := range files { // file sau ghi đè file trước
			b, _ := c.d.FS.ReadFile(f)
			for _, l := range strings.Split(string(b), "\n") {
				if k, x, ok := strings.Cut(strings.TrimSpace(l), "="); ok && k == "Storage" {
					v = strings.TrimSpace(x)
				}
			}
		}
		if v == "auto" && c.d.FS.Exists("/var/log/journal") {
			return "pass", "Storage=auto, có /var/log/journal"
		}
		return passIf(v == "persistent", "Storage="+v)
	}},
	{"6.2.2.1", "logging", "Quyền file log hợp lệ", func(c *cisCtx) (string, string) {
		bad := c.worldWritable("/var/log", 3, false)
		return passIf(len(bad) == 0, fmt.Sprintf("/var/log: %d file ghi được bởi other %s", len(bad), short(bad)))
	}},
	{"7.1.1", "filesystem", "Quyền /etc/passwd 644", func(c *cisCtx) (string, string) { return c.permCheck("/etc/passwd", 0o644) }},
	{"7.1.5", "filesystem", "Quyền /etc/shadow 640", func(c *cisCtx) (string, string) {
		return c.permCheck("/etc/shadow", 0o640, "shadow")
	}},
	{"7.1.11", "filesystem", "Không có file ghi được bởi mọi người ngoài /tmp", func(c *cisCtx) (string, string) {
		var bad []string
		for _, d := range []string{"/etc", "/usr/local/bin", "/usr/local/sbin", "/opt/itso", "/var/lib/itso"} {
			bad = append(bad, c.worldWritable(d, 4, true)...)
		}
		return passIf(len(bad) == 0, fmt.Sprintf("%d file %s", len(bad), short(bad)))
	}},
	{"8.1.1", "updates", "unattended-upgrades bật cho bản vá bảo mật", func(c *cisCtx) (string, string) {
		b, _ := c.d.FS.ReadFile("/etc/apt/apt.conf.d/20auto-upgrades")
		return passIf(strings.Contains(string(b), `APT::Periodic::Unattended-Upgrade "1"`), "20auto-upgrades: Unattended-Upgrade "+
			map[bool]string{true: "1", false: "0"}[strings.Contains(string(b), `Unattended-Upgrade "1"`)])
	}},
	{"8.1.2", "updates", "Không còn bản vá bảo mật chờ cài", func(c *cisCtx) (string, string) {
		r, err := c.d.run(c.ctx, "apt-get", "-s", "-q", "dist-upgrade")
		if err != nil || r.ExitCode != 0 {
			return "na", "không mô phỏng được apt-get dist-upgrade"
		}
		n := countSecurityUpgrades(string(r.Stdout))
		return passIf(n == 0, fmt.Sprintf("%d gói bảo mật chờ cài", n))
	}},
}

// worldWritable tìm file thường (và thư mục nếu dirs, trừ thư mục sticky) có bit ghi cho other, độ sâu tối đa depth.
func (c *cisCtx) worldWritable(root string, depth int, dirs bool) []string {
	var out []string
	var walk func(p string, lvl int)
	walk = func(p string, lvl int) {
		if lvl > depth || len(out) >= 50 {
			return
		}
		names, err := c.d.FS.ReadDir(p)
		if err != nil {
			return
		}
		for _, n := range names {
			q := path.Join(p, n)
			fi, err := c.d.FS.Lstat(q)
			if err != nil || fi.Mode()&fs.ModeSymlink != 0 {
				continue
			}
			ww := fi.Mode().Perm()&0o002 != 0
			switch {
			case fi.IsDir():
				if dirs && ww && fi.Mode()&fs.ModeSticky == 0 {
					out = append(out, q)
				}
				walk(q, lvl+1)
			case fi.Mode().IsRegular() && ww:
				out = append(out, q)
			}
		}
	}
	walk(root, 1)
	return out
}

func short(list []string) string {
	if len(list) == 0 {
		return ""
	}
	if len(list) > 3 {
		return "(" + strings.Join(list[:3], ", ") + ", …)"
	}
	return "(" + strings.Join(list, ", ") + ")"
}
