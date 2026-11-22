package ops

// Phase 11 (D-101, ADR 0046): metrics.snapshot mở rộng (swap, inode, IO, network, mount) và metrics.cgroup theo lô.
// Tốc độ (bps, % CPU của slice) tính trong agent từ lần đọc trước; lần đầu (chưa có mốc) trả 0.

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// SimMetricsControl: file điều khiển số liệu khi chạy `itso-agent --sandbox` (e2e stack thật), chỉ sandbox đọc.
// {"disk_pct": 95, "offline": true, "uptime_down": ["a.example.vn"], "cert_days": {"b.example.vn": 5}}:
// disk_pct ghi đè % disk của metrics.snapshot; offline làm system.ping/metrics.snapshot lỗi agent_unreachable
// (panel coi như mất kết nối); uptime_down/cert_days điều khiển kết quả uptime.probe mô phỏng.
const SimMetricsControl = "/var/lib/itso-sandbox/metrics-control.json"

type simMetricsControl struct {
	DiskPct    *float64         `json:"disk_pct"`
	Offline    bool             `json:"offline"`
	UptimeDown []string         `json:"uptime_down"`
	CertDays   map[string]int64 `json:"cert_days"`
}

// metricsControl đọc file điều khiển (chỉ sandbox; máy thật luôn trả rỗng).
func (d *Deps) metricsControl() simMetricsControl {
	var c simMetricsControl
	if !d.Sandbox || d.FS == nil {
		return c
	}
	if b, err := d.FS.ReadFile(SimMetricsControl); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

// rateState giữ mốc đọc trước cho tốc độ: khóa → (giá trị, thời điểm).
type rateState struct {
	v  float64
	at time.Time
}

// rate trả tốc độ/giây của bộ đếm tăng dần `key` so với lần đọc trước; lần đầu hoặc bộ đếm quay về → 0.
func (d *Deps) rate(key string, v float64, now time.Time) float64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.rates == nil {
		d.rates = map[string]rateState{}
	}
	prev, ok := d.rates[key]
	d.rates[key] = rateState{v: v, at: now}
	dt := now.Sub(prev.at).Seconds()
	if !ok || dt <= 0 || v < prev.v {
		return 0
	}
	return round1((v - prev.v) / dt)
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }

// diskstats: tổng byte đọc/ghi của đĩa vật lý (/proc/diskstats, sector 512 byte). Bỏ phân vùng (không có
// /sys/block/<tên>), loop, ram, zram để không đếm trùng.
func (d *Deps) diskstats() (read, write float64) {
	for _, l := range strings.Split(d.hostFile("/proc/diskstats"), "\n") {
		f := strings.Fields(l)
		if len(f) < 10 {
			continue
		}
		name := f[2]
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "zram") {
			continue
		}
		if !d.host().Exists("/sys/block/" + name) {
			continue
		}
		r, _ := strconv.ParseFloat(f[5], 64)
		w, _ := strconv.ParseFloat(f[9], 64)
		read += r * 512
		write += w * 512
	}
	return read, write
}

// netdev: byte nhận/gửi theo interface (/proc/net/dev), bỏ lo và interface ảo của Docker.
func (d *Deps) netdev() map[string][2]float64 {
	out := map[string][2]float64{}
	for _, l := range strings.Split(d.hostFile("/proc/net/dev"), "\n") {
		name, rest, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 || !reIface(name) {
			continue
		}
		rx, _ := strconv.ParseFloat(f[0], 64)
		tx, _ := strconv.ParseFloat(f[8], 64)
		out[name] = [2]float64{rx, tx}
	}
	return out
}

func reIface(s string) bool {
	if s == "" || len(s) > 15 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("_.:-", c)) {
			return false
		}
	}
	return true
}

// statfs trả (MB đã dùng, MB tổng, inode đã dùng, inode tổng) của mount p (đọc qua Host).
func (d *Deps) statfs(p string) (usedMB, totalMB, iUsed, iTotal int64, ok bool) {
	rp, err := d.host().Path(p)
	if err != nil {
		return 0, 0, 0, 0, false
	}
	var st syscall.Statfs_t
	if syscall.Statfs(rp, &st) != nil {
		return 0, 0, 0, 0, false
	}
	bs := int64(st.Bsize) //nolint:unconvert // kiểu khác nhau theo arch
	totalMB = int64(st.Blocks) * bs >> 20
	usedMB = (int64(st.Blocks) - int64(st.Bfree)) * bs >> 20
	iTotal = int64(st.Files)                  //nolint:gosec // giá trị statfs dương
	iUsed = int64(st.Files) - int64(st.Ffree) //nolint:gosec
	return usedMB, totalMB, max(iUsed, 0), iTotal, true
}

// mounts: filesystem thật (ext4, xfs, btrfs) theo /proc/mounts, tối đa 32, sắp theo đường dẫn.
func (d *Deps) mounts() []contracts.MetricsSnapshotResultMountsItem {
	out := []contracts.MetricsSnapshotResultMountsItem{}
	seen := map[string]bool{}
	for _, l := range strings.Split(d.hostFile("/proc/mounts"), "\n") {
		f := strings.Fields(l)
		if len(f) < 3 || seen[f[1]] || len(f[1]) > 255 {
			continue
		}
		switch f[2] {
		case "ext4", "xfs", "btrfs":
		default:
			continue
		}
		seen[f[1]] = true
		u, t, iu, it, ok := d.statfs(f[1])
		if !ok || t == 0 {
			continue
		}
		out = append(out, contracts.MetricsSnapshotResultMountsItem{Path: f[1], DiskUsedMB: u, DiskTotalMB: t, InodeUsed: iu, InodeTotal: it})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

// fillSnapshot bổ sung các trường Phase 11 vào kết quả metrics.snapshot.
func (d *Deps) fillSnapshot(r *contracts.MetricsSnapshotResult, m map[string]int64, now time.Time) {
	r.RAMTotalMB = m["MemTotal"] / 1024
	r.SwapTotalMB = m["SwapTotal"] / 1024
	r.SwapUsedMB = max(m["SwapTotal"]-m["SwapFree"], 0) / 1024
	if f := strings.Fields(d.hostFile("/proc/loadavg")); len(f) >= 4 {
		r.Load5m, _ = strconv.ParseFloat(f[1], 64)
		r.Load15m, _ = strconv.ParseFloat(f[2], 64)
		if _, total, ok := strings.Cut(f[3], "/"); ok {
			r.Tasks, _ = strconv.ParseInt(total, 10, 64)
		}
	}
	// Inode theo filesystem chứa /home (cùng nguồn với disk_used_mb).
	for _, p := range []string{HomeBase, "/"} {
		if _, _, iu, it, ok := d.statfs(p); ok {
			r.InodeUsed, r.InodeTotal = iu, it
			break
		}
	}
	rd, wr := d.diskstats()
	r.IOReadBps, r.IOWriteBps = d.rate("io:r", rd, now), d.rate("io:w", wr, now)
	nets := d.netdev()
	names := make([]string, 0, len(nets))
	for n := range nets {
		names = append(names, n)
	}
	sort.Strings(names)
	r.Net = []contracts.MetricsSnapshotResultNetItem{}
	for _, n := range names {
		if len(r.Net) == 64 {
			break
		}
		v := nets[n]
		r.Net = append(r.Net, contracts.MetricsSnapshotResultNetItem{Iface: n,
			RxBps: d.rate("net:rx:"+n, v[0], now), TxBps: d.rate("net:tx:"+n, v[1], now)})
	}
	r.Mounts = d.mounts()
	if c := d.metricsControl(); c.DiskPct != nil && r.DiskTotalMB > 0 {
		pct := math.Min(math.Max(*c.DiskPct, 0), 100)
		r.DiskUsedMB = int64(float64(r.DiskTotalMB) * pct / 100)
	}
}

// ---------- metrics.cgroup theo lô ----------

// CgroupAcctRoot là thư mục cha của mọi slice account.
const CgroupAcctRoot = "/sys/fs/cgroup/itso.slice/itso-acct.slice"

// cgroupFS: máy thật đọc cgroup của host; sandbox đọc cây cgroup giả trong gốc sandbox (có thể tự sinh).
func (d *Deps) cgroupRead(p string) string {
	if d.Sandbox {
		b, err := d.FS.ReadFile(p)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
	return d.hostFile(p)
}

// ioStat cộng rbytes/wbytes mọi thiết bị trong io.stat của cgroup.
func ioStat(s string) (r, w int64) {
	for _, l := range strings.Split(s, "\n") {
		for _, kv := range strings.Fields(l) {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				continue
			}
			n, _ := strconv.ParseInt(v, 10, 64)
			switch k {
			case "rbytes":
				r += n
			case "wbytes":
				w += n
			}
		}
	}
	return r, w
}

// sliceUIDs liệt kê UID có slice itso-acct-<uid>.slice (bỏ tên lạ).
func (d *Deps) sliceUIDs() []int64 {
	var names []string
	if d.Sandbox {
		names, _ = d.FS.ReadDir(CgroupAcctRoot)
	} else {
		names, _ = d.host().ReadDir(CgroupAcctRoot)
	}
	var out []int64
	for _, n := range names {
		s, ok := strings.CutPrefix(n, "itso-acct-")
		if !ok {
			continue
		}
		s, ok = strings.CutSuffix(s, ".slice")
		if !ok {
			continue
		}
		if uid, err := strconv.ParseInt(s, 10, 64); err == nil && uid >= 20000 && uid <= 59999 {
			out = append(out, uid)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// passwdByUID: tên user theo UID từ /etc/passwd (gốc FS), chỉ dải UID account.
func (d *Deps) passwdByUID() map[int64]string {
	out := map[int64]string{}
	b, err := d.FS.ReadFile("/etc/passwd")
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Split(l, ":")
		if len(f) < 3 {
			continue
		}
		if uid, err := strconv.ParseInt(f[2], 10, 64); err == nil && uid >= 20000 && uid <= 59999 {
			out[uid] = f[0]
		}
	}
	return out
}

// simCgroupTick (chỉ sandbox) sinh/cập nhật cây cgroup giả cho account: bộ đếm tăng theo thời gian để
// e2e có số liệu khác 0 mà không cần cgroup v2 thật.
func (d *Deps) simCgroupTick(uid int64, now time.Time) {
	dir := CgroupDir(contracts.UID(uid))
	if _, err := d.FS.ReadFile(dir + "/cgroup.sim"); err != nil {
		if _, err := d.FS.ReadFile(dir + "/cpu.stat"); err == nil {
			return // cây cgroup do test tự đặt: không ghi đè
		}
	}
	sec := now.Unix()
	seed := uid % 97
	usage := sec*int64(20000+seed*900) + seed*1_000_000 // ≈ 2–11 % một core
	mem := (64 + seed*3 + (sec/60)%32) << 20
	rbytes := sec * (4096 + seed*512)
	wbytes := sec * (2048 + seed*256)
	files := map[string]string{
		"cgroup.sim":     "1",
		"cpu.stat":       "usage_usec " + strconv.FormatInt(usage, 10) + "\nthrottled_usec 0",
		"memory.current": strconv.FormatInt(mem, 10),
		"memory.max":     strconv.FormatInt(1024<<20, 10),
		"memory.events":  "oom_kill 0",
		"pids.current":   strconv.FormatInt(3+seed%9, 10),
		"io.stat":        "8:0 rbytes=" + strconv.FormatInt(rbytes, 10) + " wbytes=" + strconv.FormatInt(wbytes, 10),
	}
	for name, v := range files {
		_, _ = d.FS.WriteAtomic(dir+"/"+name, []byte(v+"\n"), 0o644, platform.Owner{})
	}
}

// offlineErr: sandbox giả lập mất kết nối agent (file điều khiển offline=true).
func (d *Deps) offlineErr() error {
	if d.metricsControl().Offline {
		return &registry.OpError{Code: "agent_unreachable", Message: "agent mô phỏng mất kết nối (sandbox)", Retryable: true}
	}
	return nil
}
