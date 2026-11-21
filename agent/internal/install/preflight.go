package install

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"syscall"
)

// Status của một kiểm tra preflight.
type Status string

// Kết quả kiểm tra.
const (
	Pass Status = "PASS"
	Warn Status = "WARN"
	Fail Status = "FAIL"
)

// Check là một dòng preflight / doctor.
type Check struct {
	Name   string `json:"name"`
	Status Status `json:"status"`
	Detail string `json:"detail"`
}

// Options của itso install.
type Options struct {
	ReleaseDir string
	Port       int
	NoFirewall bool
	DryRun     bool
	Yes        bool
}

// otherPanels: dấu hiệu panel khác đã cài (10 §3).
var otherPanels = map[string]string{"/www/server/panel": "aaPanel", "/usr/local/CyberCP": "CyberPanel",
	"/usr/local/cpanel": "cPanel", "/usr/local/hestia": "HestiaCP", "/usr/local/vesta": "VestaCP"}

func (e *Env) hostText(p string) string {
	b, err := e.host().ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func osRelease(s string) map[string]string {
	out := map[string]string{}
	for _, l := range strings.Split(s, "\n") {
		if k, v, ok := strings.Cut(l, "="); ok {
			out[k] = strings.Trim(v, `"`)
		}
	}
	return out
}

// Preflight chạy các kiểm tra 10 §3. Không ghi gì.
func (e *Env) Preflight(ctx context.Context, o Options) []Check {
	var cs []Check
	add := func(name string, st Status, format string, a ...any) {
		cs = append(cs, Check{Name: name, Status: st, Detail: fmt.Sprintf(format, a...)})
	}
	// /etc/os-release thường là symlink tới /usr/lib/os-release (FS không theo symlink).
	osText := e.hostText("/etc/os-release")
	if osText == "" {
		osText = e.hostText("/usr/lib/os-release")
	}
	osr := osRelease(osText)
	if osr["ID"] == "ubuntu" && osr["VERSION_ID"] == "24.04" {
		add("os", Pass, "%s", osr["PRETTY_NAME"])
	} else {
		add("os", Fail, "cần Ubuntu 24.04, đang là %q", osr["PRETTY_NAME"])
	}
	switch e.arch() {
	case "amd64":
		add("arch", Pass, "amd64")
	case "arm64":
		add("arch", Warn, "arm64: ít được kiểm thử hơn amd64")
	default:
		add("arch", Fail, "kiến trúc %s không hỗ trợ", e.arch())
	}
	if e.host().Exists("/sys/fs/cgroup/cgroup.controllers") {
		add("cgroup_v2", Pass, "cgroup v2 unified")
	} else {
		add("cgroup_v2", Fail, "không có cgroup v2 unified: không thực thi được giới hạn CPU/RAM")
	}
	if e.host().Exists("/run/systemd/system") && e.hostText("/proc/1/comm") == "systemd" {
		add("systemd", Pass, "systemd là PID 1")
	} else {
		add("systemd", Fail, "systemd không phải PID 1 (container?): không quản lý được dịch vụ, slice")
	}
	cores := strings.Count("\n"+e.hostText("/proc/cpuinfo"), "\nprocessor")
	ramMB := 0
	for _, l := range strings.Split(e.hostText("/proc/meminfo"), "\n") {
		if v, ok := strings.CutPrefix(l, "MemTotal:"); ok {
			if f := strings.Fields(v); len(f) > 0 {
				kb, _ := strconv.Atoi(f[0])
				ramMB = kb / 1024
			}
		}
	}
	switch {
	case cores < 1 || ramMB < 900:
		add("resources", Fail, "%d vCPU, %d MB RAM: cần ≥ 1 vCPU, 1 GB", cores, ramMB)
	case cores < 2 || ramMB < 1900:
		add("resources", Warn, "%d vCPU, %d MB RAM: khuyến nghị ≥ 2 vCPU, 2 GB", cores, ramMB)
	default:
		add("resources", Pass, "%d vCPU, %d MB RAM", cores, ramMB)
	}
	freeGB := int64(-1)
	if rp, err := e.host().Path("/"); err == nil {
		var st syscall.Statfs_t
		if syscall.Statfs(rp, &st) == nil {
			freeGB = int64(st.Bavail) * int64(st.Bsize) >> 30 //nolint:unconvert,gosec // kiểu theo arch
		}
	}
	switch {
	case freeGB < 10:
		add("disk", Fail, "còn %d GB trống: cần ≥ 10 GB", freeGB)
	case freeGB < 20:
		add("disk", Warn, "còn %d GB trống: khuyến nghị ≥ 20 GB", freeGB)
	default:
		add("disk", Pass, "còn %d GB trống", freeGB)
	}
	cs = append(cs, e.portsCheck(ctx, o.Port))
	found := []string{}
	for p, name := range otherPanels {
		if e.host().Exists(p) {
			found = append(found, name)
		}
	}
	if len(found) > 0 {
		add("other_panel", Fail, "phát hiện panel khác: %s", strings.Join(found, ", "))
	} else {
		add("other_panel", Pass, "không có panel khác")
	}
	if e.host().Exists("/etc/nginx/sites-enabled/default") || e.host().Exists("/etc/apache2/sites-enabled/000-default.conf") {
		add("web_server", Warn, "đã có Nginx/Apache với site: kiểm tra trước khi để panel quản lý")
	} else {
		add("web_server", Pass, "chưa có web server")
	}
	if mode := e.quotaMode(ctx); mode == "kernel" {
		add("quota", Pass, "/home có user quota")
	} else {
		add("quota", Warn, "/home chưa bật user quota: disk quota chạy chế độ soft (xem hướng dẫn ở Wizard bước 6)")
	}
	if _, err := e.loadRelease(o.ReleaseDir); err != nil {
		add("release", Fail, "%v", err)
	} else {
		add("release", Pass, "manifest hợp lệ, chữ ký đúng (%s)", o.ReleaseDir)
	}
	if strings.Contains(e.hostText("/proc/sys/kernel/hostname"), ".") {
		add("hostname", Pass, "%s", e.hostText("/proc/sys/kernel/hostname"))
	} else {
		add("hostname", Warn, "hostname %q không phải FQDN", e.hostText("/proc/sys/kernel/hostname"))
	}
	return cs
}

// portsCheck: 80, 443 và port panel không bị chương trình lạ chiếm (itso/frankenphp được phép khi cài lại).
func (e *Env) portsCheck(ctx context.Context, panel int) Check {
	c := func(st Status, format string, a ...any) Check {
		return Check{Name: "ports", Status: st, Detail: fmt.Sprintf(format, a...)}
	}
	res := e.try(ctx, "ss", "-H", "-ltnp")
	if res.ExitCode != 0 {
		return c(Warn, "không đọc được socket đang nghe (ss): %s", strings.TrimSpace(string(res.Stderr)))
	}
	want := map[string]bool{"80": true, "443": true, strconv.Itoa(panel): true}
	busy := []string{}
	for _, l := range strings.Split(string(res.Stdout), "\n") {
		f := strings.Fields(l)
		if len(f) < 4 {
			continue
		}
		addr := f[3]
		port := addr[strings.LastIndex(addr, ":")+1:]
		if want[port] && !strings.Contains(l, "frankenphp") && !strings.Contains(l, "itso") {
			proc := ""
			if len(f) > 5 {
				proc = " " + strings.Join(f[5:], " ")
			}
			busy = append(busy, port+proc)
		}
	}
	if len(busy) > 0 {
		return c(Fail, "port đang bị chiếm: %s", strings.Join(busy, ", "))
	}
	return c(Pass, "80, 443, %d trống", panel)
}

// quotaMode như agent (ADR 0012): mount chứa /home có usrquota/usrjquota → kernel.
func (e *Env) quotaMode(ctx context.Context) string {
	res := e.try(ctx, "findmnt", "-n", "-o", "TARGET,FSTYPE,OPTIONS", "--target", "/home")
	f := strings.Fields(string(res.Stdout))
	if res.ExitCode != 0 || len(f) < 3 {
		return "soft"
	}
	for _, o := range strings.Split(f[2], ",") {
		k, _, _ := strings.Cut(o, "=")
		if k == "usrquota" || k == "usrjquota" || k == "uquota" || k == "quota" {
			return "kernel"
		}
	}
	return "soft"
}

// Failed cho biết có kiểm tra FAIL.
func Failed(cs []Check) bool {
	for _, c := range cs {
		if c.Status == Fail {
			return true
		}
	}
	return false
}

// PrintChecks in bảng kiểm tra.
func (e *Env) PrintChecks(cs []Check) {
	for _, c := range cs {
		e.printf("  [%s] %-12s %s\n", c.Status, c.Name, c.Detail)
	}
}
