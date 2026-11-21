package ops

import (
	"context"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpSystemInfo:        d.systemInfo,
			contracts.OpSystemHostnameSet: d.hostnameSet,
			contracts.OpSystemReboot:      d.reboot,
			contracts.OpServiceStatus:     d.serviceStatus,
			contracts.OpServiceControl:    d.serviceControl,
			contracts.OpMetricsSnapshot:   d.metricsSnapshot,
		}
	})
}

// servicePackages: gói apt để đọc phiên bản dịch vụ (itso-gateway không phải gói apt).
var servicePackages = map[string]string{"nginx": "nginx", "mariadb": "mariadb-server", "postgresql": "postgresql",
	"redis-server": "redis-server", "fail2ban": "fail2ban", "cron": "cron", "ssh": "openssh-server",
	"php8.1-fpm": "php8.1-fpm", "php8.2-fpm": "php8.2-fpm", "php8.3-fpm": "php8.3-fpm", "php8.4-fpm": "php8.4-fpm"}

func (d *Deps) hostFile(p string) string {
	b, err := d.host().ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// meminfo trả giá trị (kB) của các khóa /proc/meminfo.
func (d *Deps) meminfo() map[string]int64 {
	out := map[string]int64{}
	for _, l := range strings.Split(d.hostFile("/proc/meminfo"), "\n") {
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) > 0 {
			n, _ := strconv.ParseInt(f[0], 10, 64)
			out[k] = n
		}
	}
	return out
}

// diskMB trả (tổng, còn trống) MB của filesystem chứa /home (không có thì /).
func (d *Deps) diskMB() (total, free int64) {
	for _, p := range []string{HomeBase, "/"} {
		rp, err := d.host().Path(p)
		if err != nil {
			continue
		}
		var st syscall.Statfs_t
		if syscall.Statfs(rp, &st) == nil {
			bs := int64(st.Bsize) //nolint:unconvert // kiểu khác nhau theo arch
			return int64(st.Blocks) * bs >> 20, int64(st.Bavail) * bs >> 20
		}
	}
	return 0, 0
}

func osName(osRelease string) string {
	for _, l := range strings.Split(osRelease, "\n") {
		if v, ok := strings.CutPrefix(l, "PRETTY_NAME="); ok {
			return strings.Trim(v, `"`)
		}
	}
	return "Linux"
}

func (d *Deps) systemInfo(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SystemInfoParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	h := d.host()
	up := 0.0
	if f := strings.Fields(d.hostFile("/proc/uptime")); len(f) > 0 {
		up, _ = strconv.ParseFloat(f[0], 64)
	}
	cores := int64(strings.Count(d.hostFile("/proc/cpuinfo"), "\nprocessor"))
	if strings.HasPrefix(d.hostFile("/proc/cpuinfo"), "processor") {
		cores++
	}
	if cores == 0 {
		cores = int64(runtime.NumCPU())
	}
	total, free := d.diskMB()
	mode, _, err := d.quotaMode(ctx)
	if err != nil {
		return nil, err
	}
	hostname := d.hostFile("/proc/sys/kernel/hostname")
	if hostname == "" {
		hostname = d.hostFile("/etc/hostname")
	}
	return toData(contracts.SystemInfoResult{
		OS: osName(d.hostFile("/etc/os-release")), Kernel: d.hostFile("/proc/sys/kernel/osrelease"),
		Hostname: hostname, UptimeSec: int64(up), CPUCores: cores, RAMMB: d.meminfo()["MemTotal"] / 1024,
		DiskTotalMB: total, DiskFreeMB: free,
		CgroupV2: h.Exists("/sys/fs/cgroup/cgroup.controllers"), Systemd: h.Exists("/run/systemd/system"),
		QuotaMode: contracts.QuotaMode(mode), Arch: runtime.GOARCH,
	})
}

func (d *Deps) hostnameSet(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SystemHostnameSetParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.Hostname(string(p.Hostname)); err != nil {
		return nil, opErr(err)
	}
	cur, _ := d.FS.ReadFile("/etc/hostname")
	if strings.TrimSpace(string(cur)) == string(p.Hostname) {
		return toData(contracts.SystemHostnameSetResult{Hostname: p.Hostname, Changed: false})
	}
	if _, err := d.must(ctx, "internal", "hostnamectl", "set-hostname", string(p.Hostname)); err != nil {
		return nil, err
	}
	return toData(contracts.SystemHostnameSetResult{Hostname: p.Hostname, Changed: true})
}

// reboot hẹn khởi động lại (shutdown -r +phút). Bật/tắt bằng policy cục bộ (ops.system.reboot).
func (d *Deps) reboot(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SystemRebootParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if p.DelaySec < 0 || p.DelaySec > 86400 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "delay_sec ngoài khoảng 0–86400"}
	}
	reason := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, p.Reason)
	if len(reason) > 200 {
		reason = reason[:200]
	}
	mins := (p.DelaySec + 59) / 60
	if mins == 0 {
		mins = 1 // luôn chừa ≥ 1 phút để panel nhận kết quả và người dùng kịp hủy
	}
	if _, err := d.must(ctx, "internal", "shutdown", "-r", "+"+strconv.FormatInt(mins, 10), "ITSO Panel: "+reason); err != nil {
		return nil, err
	}
	at := d.now().Add(time.Duration(mins) * time.Minute).UTC().Format(time.RFC3339)
	return toData(contracts.SystemRebootResult{ScheduledAt: at})
}

func (d *Deps) unitState(ctx context.Context, unit string) (active, enabled bool, err error) {
	a, err := d.run(ctx, "systemctl", "is-active", unit)
	if err != nil {
		return false, false, err
	}
	e, err := d.run(ctx, "systemctl", "is-enabled", unit)
	if err != nil {
		return false, false, err
	}
	return strings.TrimSpace(string(a.Stdout)) == "active", strings.TrimSpace(string(e.Stdout)) == "enabled", nil
}

// pkgVersion trả phiên bản gói apt đã cài (nil nếu chưa cài).
func (d *Deps) pkgVersion(ctx context.Context, pkg string) (*string, error) {
	res, err := d.run(ctx, "dpkg-query", "-W", "-f=${Status}\t${Version}", pkg)
	if err != nil {
		return nil, err
	}
	status, ver, _ := strings.Cut(strings.TrimSpace(string(res.Stdout)), "\t")
	if res.ExitCode != 0 || status != "install ok installed" || ver == "" {
		return nil, nil
	}
	return &ver, nil
}

func (d *Deps) serviceStatus(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ServiceStatusParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	for _, n := range p.Names {
		if err := validate.Service(string(n)); err != nil {
			return nil, opErr(err)
		}
	}
	out := contracts.ServiceStatusResult{Services: []contracts.ServiceStatusResultServicesItem{}}
	for _, n := range p.Names {
		active, enabled, err := d.unitState(ctx, string(n)+".service")
		if err != nil {
			return nil, err
		}
		var ver *string
		if pkg, ok := servicePackages[string(n)]; ok {
			if ver, err = d.pkgVersion(ctx, pkg); err != nil {
				return nil, err
			}
		}
		out.Services = append(out.Services, contracts.ServiceStatusResultServicesItem{Name: string(n), Active: active, Enabled: enabled, Version: ver})
	}
	return toData(out)
}

var serviceActions = map[string]bool{"start": true, "stop": true, "restart": true, "reload": true}

func (d *Deps) serviceControl(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ServiceControlParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.Service(string(p.Name)); err != nil {
		return nil, opErr(err)
	}
	if !serviceActions[p.Action] {
		return nil, &registry.OpError{Code: "invalid_params", Message: "action không hợp lệ"}
	}
	unit := string(p.Name) + ".service"
	active, _, err := d.unitState(ctx, unit)
	if err != nil {
		return nil, err
	}
	// start khi đang chạy / stop khi đã dừng: không làm gì (idempotent). restart/reload luôn chạy.
	if (p.Action == "start" && active) || (p.Action == "stop" && !active) {
		return toData(contracts.ServiceControlResult{Active: active})
	}
	if _, err := d.must(ctx, "precondition_failed", "systemctl", p.Action, unit); err != nil {
		return nil, err
	}
	active, _, err = d.unitState(ctx, unit)
	if err != nil {
		return nil, err
	}
	return toData(contracts.ServiceControlResult{Active: active})
}

// cpuTimes đọc dòng "cpu" của /proc/stat: (tổng, nhàn rỗi) jiffies.
func (d *Deps) cpuTimes() (total, idle uint64) {
	line, _, _ := strings.Cut(d.hostFile("/proc/stat"), "\n")
	f := strings.Fields(line)
	if len(f) < 5 || f[0] != "cpu" {
		return 0, 0
	}
	for i, s := range f[1:] {
		v, _ := strconv.ParseUint(s, 10, 64)
		total += v
		if i == 3 || i == 4 { // idle + iowait
			idle += v
		}
	}
	return total, idle
}

func (d *Deps) metricsSnapshot(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.MetricsSnapshotParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	t1, i1 := d.cpuTimes()
	if d.CPUSample > 0 {
		select {
		case <-time.After(d.CPUSample):
		case <-ctx.Done():
			return nil, &registry.OpError{Code: "deadline_exceeded", Message: "hết deadline", Retryable: true}
		}
	}
	t2, i2 := d.cpuTimes()
	cpu := 0.0
	if t2 > t1 {
		cpu = float64((t2-t1)-(i2-i1)) / float64(t2-t1) * 100
		cpu = float64(int(cpu*10)) / 10
	}
	m := d.meminfo()
	load := 0.0
	if f := strings.Fields(d.hostFile("/proc/loadavg")); len(f) > 0 {
		load, _ = strconv.ParseFloat(f[0], 64)
	}
	total, free := d.diskMB()
	used := m["MemTotal"] - m["MemAvailable"]
	if used < 0 {
		used = 0
	}
	return toData(contracts.MetricsSnapshotResult{CPUPct: cpu, RAMUsedMB: used / 1024, DiskUsedMB: total - free, Load1m: load})
}
