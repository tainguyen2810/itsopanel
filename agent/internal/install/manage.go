package install

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/policy"
)

// SetupCode là /var/lib/itso/setup-code.json: chỉ lưu băm, Laravel (Wizard bước 0) đối chiếu và đánh dấu đã dùng.
type SetupCode struct {
	SHA256    string `json:"sha256"`
	ExpiresAt string `json:"expires_at"`
	CreatedAt string `json:"created_at"`
}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // bỏ I, O, 0, 1 dễ nhầm

// NewSetupCode sinh mã thiết lập một lần (60 phút), ghi băm SHA-256; trả mã dạng XXXX-XXXX-XXXX.
func (e *Env) NewSetupCode() (string, error) {
	raw, err := e.randomString(12, codeAlphabet)
	if err != nil {
		return "", err
	}
	code := raw[0:4] + "-" + raw[4:8] + "-" + raw[8:12]
	sum := sha256.Sum256([]byte(raw))
	now := e.now().UTC()
	sc := SetupCode{SHA256: hex.EncodeToString(sum[:]), CreatedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339)}
	return code, e.writeJSON(SetupFile, sc, 0o640, e.rootGroup("itso"))
}

func defaultIP() string {
	addrs, err := net.InterfaceAddrs()
	if err == nil {
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
				return n.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

// URL trả địa chỉ panel từ panel.json.
func (e *Env) URL() string {
	var p Panel
	if ok, _ := e.readJSON(PanelFile, &p); !ok {
		return "(chưa cài)"
	}
	host := p.Domain
	if host == "" {
		if e.IP != nil {
			host = e.IP()
		} else {
			host = defaultIP()
		}
	}
	return fmt.Sprintf("https://%s:%d/%s/", host, p.Port, p.Entrance)
}

// Status in phiên bản, trạng thái unit, URL.
func (e *Env) Status(ctx context.Context) error {
	cur := e.CurrentVersion()
	if cur == "" {
		e.printf("ITSO Panel: chưa cài\n")
		return errors.New("chưa cài")
	}
	e.printf("ITSO Panel %s\nURL: %s\n", cur, e.URL())
	down := false
	for _, u := range panelUnits {
		st := strings.TrimSpace(string(e.try(ctx, "systemctl", "is-active", u).Stdout))
		if st == "" {
			st = "unknown"
		}
		down = down || st != "active"
		e.printf("  %-24s %s\n", u, st)
	}
	if down {
		return errors.New("có dịch vụ không chạy (xem itso doctor, itso logs)")
	}
	return nil
}

// Doctor kiểm tra sâu (10 §6); lỗi nếu có mục FAIL.
func (e *Env) Doctor(ctx context.Context) []Check {
	var cs []Check
	add := func(name string, st Status, format string, a ...any) {
		cs = append(cs, Check{Name: name, Status: st, Detail: fmt.Sprintf(format, a...)})
	}
	if v := e.CurrentVersion(); v == "" {
		add("release", Fail, "chưa cài (không có %s)", CurrentLink)
	} else {
		add("release", Pass, "%s", v)
	}
	for _, u := range panelUnits {
		if st := strings.TrimSpace(string(e.try(ctx, "systemctl", "is-active", u).Stdout)); st == "active" {
			add(u, Pass, "active")
		} else {
			add(u, Fail, "%s (xem: itso logs %s)", st, strings.TrimSuffix(strings.TrimPrefix(u, "itso-"), ".service"))
		}
	}
	if e.FS.Exists(AgentSocket) {
		add("agent_socket", Pass, "%s", AgentSocket)
	} else {
		add("agent_socket", Fail, "không có %s", AgentSocket)
	}
	for _, f := range []string{AgentKey, EnvFile, TLSKey} {
		rp, _ := e.FS.Path(f)
		fi, err := os.Lstat(rp)
		switch {
		case err != nil:
			add("perm "+f, Fail, "không có file")
		case fi.Mode().Perm()&0o007 != 0 || fi.Mode()&os.ModeSymlink != 0:
			add("perm "+f, Fail, "quyền %v: others không được đọc", fi.Mode().Perm())
		default:
			add("perm "+f, Pass, "%v", fi.Mode().Perm())
		}
	}
	if c, err := e.cert(); err != nil {
		add("tls", Fail, "%v", err)
	} else if left := c.NotAfter.Sub(e.now()); left < 14*24*time.Hour {
		add("tls", Warn, "chứng chỉ panel hết hạn sau %d ngày", int(left.Hours()/24))
	} else {
		add("tls", Pass, "hết hạn %s", c.NotAfter.Format("2006-01-02"))
	}
	if rp, err := e.host().Path("/"); err == nil {
		var st syscall.Statfs_t
		if syscall.Statfs(rp, &st) == nil {
			free := int64(st.Bavail) * int64(st.Bsize) >> 30 //nolint:unconvert,gosec
			if free < 5 {
				add("disk", Fail, "còn %d GB", free)
			} else {
				add("disk", Pass, "còn %d GB", free)
			}
		}
	}
	if e.quotaMode(ctx) == "kernel" {
		add("quota", Pass, "kernel")
	} else {
		add("quota", Warn, "soft: disk quota không do kernel thực thi")
	}
	if e.host().Exists("/sys/fs/cgroup/cgroup.controllers") {
		add("cgroup_v2", Pass, "có")
	} else {
		add("cgroup_v2", Fail, "không có cgroup v2")
	}
	return cs
}

// UninstallOptions của itso uninstall.
type UninstallOptions struct {
	PurgePanelData  bool
	ConfirmHostname string
}

// Uninstall gỡ panel; KHÔNG đụng /home, DB hosting, cấu hình site đang chạy (10 §9).
func (e *Env) Uninstall(ctx context.Context, o UninstallOptions) error {
	host := strings.TrimSpace(e.hostText("/proc/sys/kernel/hostname"))
	if o.PurgePanelData && o.ConfirmHostname != host {
		return fmt.Errorf("--purge-panel-data cần --confirm-hostname %s", host)
	}
	_ = e.try(ctx, "systemctl", "disable", "--now", "itso.target")
	units, _ := e.releaseUnits()
	for n := range units {
		if _, err := e.FS.Remove(UnitDir + "/" + n); err != nil {
			return err
		}
	}
	_ = e.try(ctx, "systemctl", "daemon-reload")
	if e.FS.Exists(OptDir) {
		if err := e.FS.RemoveTree(OptDir, OptDir); err != nil {
			return err
		}
	}
	ts := e.now().UTC().Format("20060102T150405Z")
	for _, d := range []string{EtcDir, VarDir} {
		if !e.FS.Exists(d) {
			continue
		}
		dst := d + ".removed-" + ts
		if err := e.FS.Rename(d, dst); err != nil {
			return err
		}
		e.printf("Giữ %s → %s\n", d, dst)
		if o.PurgePanelData {
			if err := e.FS.RemoveTree(dst, dst); err != nil {
				return err
			}
		}
	}
	if o.PurgePanelData && e.FS.Exists("/etc/postgresql/16/itso") {
		if _, err := e.cmd(ctx, "pg_dropcluster", "--stop", "16", "itso"); err != nil {
			return err
		}
	}
	e.printf("Đã gỡ ITSO Panel. Dữ liệu hosting giữ nguyên: /home, cơ sở dữ liệu hosting, cấu hình Nginx/PHP đang phục vụ site.\n")
	if !o.PurgePanelData {
		e.printf("Cluster PostgreSQL 16/itso (dữ liệu panel) vẫn giữ; cài lại sẽ đề nghị khôi phục.\n")
	}
	return nil
}

// Repair kiểm file release (checksums.txt), unit systemd, quyền file khóa; fix=true thì sửa.
func (e *Env) Repair(ctx context.Context, fix bool) ([]Check, error) {
	var cs []Check
	add := func(name string, st Status, format string, a ...any) {
		cs = append(cs, Check{Name: name, Status: st, Detail: fmt.Sprintf(format, a...)})
	}
	if e.CurrentVersion() == "" {
		return nil, errors.New("chưa cài")
	}
	bad := 0
	for _, l := range strings.Split(e.readFile(CurrentLink+"/checksums.txt"), "\n") {
		f := strings.Fields(l)
		if len(f) != 2 || strings.Contains(f[1], "..") {
			continue
		}
		b, err := e.FS.ReadFile(CurrentLink + "/" + strings.TrimPrefix(f[1], "./"))
		sum := sha256.Sum256(b)
		if err != nil || hex.EncodeToString(sum[:]) != f[0] {
			bad++
			if bad <= 10 {
				add("file", Fail, "%s bị sửa hoặc mất", f[1])
			}
		}
	}
	if bad == 0 {
		add("release_files", Pass, "checksum khớp")
	} else {
		add("release_files", Fail, "%d file sai: cài lại bản này bằng itso update/rollback hoặc giải nén lại", bad)
	}
	units, err := e.releaseUnits()
	if err != nil {
		return nil, err
	}
	diff := 0
	for n, b := range units {
		if e.readFile(UnitDir+"/"+n) != string(b) {
			diff++
		}
	}
	if diff == 0 {
		add("units", Pass, "%d unit khớp release", len(units))
	} else if fix {
		if err := e.installUnits(ctx); err != nil {
			return nil, err
		}
		add("units", Pass, "đã ghi lại %d unit", diff)
	} else {
		add("units", Fail, "%d unit khác release (chạy itso repair --fix)", diff)
	}
	for _, f := range []string{AgentKey, EnvFile, TLSKey} {
		rp, _ := e.FS.Path(f)
		fi, err := os.Lstat(rp)
		if err != nil || fi.Mode()&os.ModeSymlink != 0 {
			add("perm "+f, Fail, "không có file hoặc là symlink")
			continue
		}
		if fi.Mode().Perm() != 0o640 {
			if fix {
				if err := os.Chmod(rp, 0o640); err != nil {
					return nil, err
				}
				add("perm "+f, Pass, "đã sửa %v → 0640", fi.Mode().Perm())
			} else {
				add("perm "+f, Fail, "quyền %v, cần 0640", fi.Mode().Perm())
			}
		} else {
			add("perm "+f, Pass, "0640")
		}
	}
	add("reapply_all", Warn, "--reapply-all (áp lại desired state mọi account/site) có từ Phase 5")
	return cs, nil
}

// PolicyGet in giá trị policy cục bộ của agent.
func (e *Env) PolicyGet(key string) error {
	rp, err := e.FS.Path(PolicyFile)
	if err != nil {
		return err
	}
	p, err := policy.Load(rp, e.FS.Root == "/")
	if err != nil {
		return err
	}
	for _, kv := range p.Keys() {
		if key == "" || strings.HasPrefix(kv, policy.Canon(key)+"=") {
			e.printf("%s\n", kv)
		}
	}
	return nil
}

// PolicySet đổi một khóa policy rồi khởi động lại agent (agent đọc policy lúc khởi động).
func (e *Env) PolicySet(ctx context.Context, key, value string) error {
	v, err := strconv.ParseBool(value)
	switch value {
	case "on":
		v, err = true, nil
	case "off":
		v, err = false, nil
	}
	if err != nil {
		return fmt.Errorf("giá trị phải là on/off hoặc true/false: %q", value)
	}
	rp, err := e.FS.Path(PolicyFile)
	if err != nil {
		return err
	}
	p, err := policy.Load(rp, e.FS.Root == "/")
	if err != nil {
		return err
	}
	if err := p.Set(key, v); err != nil {
		return err
	}
	if err := e.FS.MkdirAll(EtcDir); err != nil {
		return err
	}
	if err := p.Save(rp); err != nil {
		return err
	}
	e.printf("%s=%v (đã lưu %s)\n", key, v, PolicyFile)
	_, err = e.cmd(ctx, "systemctl", "try-restart", "itso-agent.service")
	return err
}

var logServices = map[string]string{"agent": "itso-agent.service", "gateway": "itso-gateway.service", "web": "itso-web.service", "worker": "itso-worker@*",
	"scheduler": "itso-scheduler.service", "redis": "itso-redis.service"}

// Logs in journal của một dịch vụ panel (allowlist).
func (e *Env) Logs(ctx context.Context, svc string, lines int) error {
	unit, ok := logServices[svc]
	if !ok {
		return fmt.Errorf("dịch vụ không hợp lệ %q (agent, web, worker, scheduler, redis)", svc)
	}
	if lines < 1 || lines > 10000 {
		lines = 200
	}
	r, err := e.cmd(ctx, "journalctl", "-u", unit, "-n", strconv.Itoa(lines), "--no-pager", "-o", "short-iso")
	if err != nil {
		return err
	}
	e.printf("%s", r.Stdout)
	return nil
}

var reEmail = regexp.MustCompile(`^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$`)

// AdminReset gọi artisan itso:admin-reset-password|mfa với email đã kiểm (argv cố định).
// AllowlistReset xóa IP allowlist Admin (cứu hộ khi tự khóa mình, ADR 0028); chỉ chạy được trên máy chủ (root).
func (e *Env) AllowlistReset(ctx context.Context) error {
	r, err := e.artisan(ctx, "itso:allowlist-reset", "--no-interaction")
	e.printf("%s", r.Stdout)
	return err
}

func (e *Env) AdminReset(ctx context.Context, what, email string) error {
	if !reEmail.MatchString(email) {
		return fmt.Errorf("email không hợp lệ: %q", email)
	}
	cmd := map[string]string{"reset-password": "itso:admin-reset-password", "reset-mfa": "itso:admin-reset-mfa"}[what]
	if cmd == "" {
		return fmt.Errorf("lệnh admin không hợp lệ: %q", what)
	}
	r, err := e.artisan(ctx, cmd, "--email="+email, "--no-interaction")
	e.printf("%s", r.Stdout)
	return err
}
