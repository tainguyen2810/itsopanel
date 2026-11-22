package ops_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
)

func appendFile(t *testing.T, root, p, content string) {
	t.Helper()
	f, err := os.OpenFile(filepath.Join(root, p), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

// clock cho phép test đẩy thời gian để agent tính tốc độ (bps, % CPU) giữa hai lần đọc.
func clock(e *env) func(time.Duration) {
	now := ct.Now
	e.d.Now = func() time.Time { return now }
	return func(d time.Duration) { now = now.Add(d) }
}

func procIO(t *testing.T, e *env, sdaRead, sdaWrite, ethRx, ethTx int64) {
	t.Helper()
	write(t, e.host, "/proc/diskstats", fmt.Sprintf(
		"   8       0 sda 100 0 %d 50 200 0 %d 80 0 0 0\n"+
			"   8       1 sda1 90 0 999999 40 150 0 999999 70 0 0 0\n"+
			"   7       0 loop0 1 0 888888 1 0 0 888888 0 0 0 0\n", sdaRead/512, sdaWrite/512))
	write(t, e.host, "/proc/net/dev", fmt.Sprintf("Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n"+
		"    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0\n"+
		"  eth0: %d 100 0 0 0 0 0 0 %d 90 0 0 0 0 0 0\n"+
		"veth12ab: 777 1 0 0 0 0 0 0 777 1 0 0 0 0 0 0\n"+
		"docker0: 777 1 0 0 0 0 0 0 777 1 0 0 0 0 0 0\n", ethRx, ethTx))
}

func TestMetricsSnapshotExtended(t *testing.T) {
	e := newEnv(t)
	tick := clock(e)
	write(t, e.host, "/proc/meminfo", "MemTotal:        8048576 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n")
	write(t, e.host, "/proc/loadavg", "0.42 0.30 0.20 3/412 12345\n")
	write(t, e.host, "/sys/block/sda/size", "1000\n") // sda là đĩa; sda1 (phân vùng) và loop0 không tính
	write(t, e.host, "/proc/mounts", "/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n")
	procIO(t, e, 1<<20, 2<<20, 10_000, 20_000)

	s := e.h.OK(contracts.OpMetricsSnapshot, map[string]any{})
	if s["ram_total_mb"] != float64(7859) || s["swap_total_mb"] != float64(2048) || s["swap_used_mb"] != float64(1024) ||
		s["load_5m"] != 0.3 || s["load_15m"] != 0.2 || s["tasks"] != float64(412) {
		t.Fatal(s)
	}
	if s["io_read_bps"] != float64(0) || s["inode_total"].(float64) <= 0 || s["disk_total_mb"].(float64) <= 0 {
		t.Fatal("lần đọc đầu: bps = 0, inode/disk tổng có giá trị", s)
	}
	net := s["net"].([]any)
	if len(net) != 1 || net[0].(map[string]any)["iface"] != "eth0" {
		t.Fatal("chỉ interface thật, bỏ lo/veth/docker", net)
	}
	mounts := s["mounts"].([]any)
	if len(mounts) != 1 || mounts[0].(map[string]any)["path"] != "/" {
		t.Fatal("chỉ filesystem thật, không trùng", mounts)
	}

	tick(10 * time.Second)
	procIO(t, e, 1<<20+512_000, 2<<20+1_024_000, 10_000+50_000, 20_000+5_000)
	s = e.h.OK(contracts.OpMetricsSnapshot, map[string]any{})
	if s["io_read_bps"] != float64(51200) || s["io_write_bps"] != float64(102400) {
		t.Fatal("bps = Δbyte / Δt, chỉ đĩa vật lý", s)
	}
	n := s["net"].([]any)[0].(map[string]any)
	if n["rx_bps"] != float64(5000) || n["tx_bps"] != float64(500) {
		t.Fatal(n)
	}
	// Bộ đếm quay về (reboot, đổi đĩa) → 0, không âm.
	tick(10 * time.Second)
	procIO(t, e, 0, 0, 0, 0)
	s = e.h.OK(contracts.OpMetricsSnapshot, map[string]any{})
	if s["io_read_bps"] != float64(0) || s["net"].([]any)[0].(map[string]any)["rx_bps"] != float64(0) {
		t.Fatal(s)
	}
}

func cgTree(t *testing.T, e *env, uid int, usageUsec, rbytes, wbytes int64) {
	t.Helper()
	dir := ops.CgroupDir(contracts.UID(uid))
	write(t, e.host, dir+"/cpu.stat", fmt.Sprintf("usage_usec %d\nthrottled_usec 0\n", usageUsec))
	write(t, e.host, dir+"/memory.current", fmt.Sprintf("%d\n", int64(uid-20000)*64<<20))
	write(t, e.host, dir+"/memory.max", "max\n")
	write(t, e.host, dir+"/memory.events", "oom_kill 0\n")
	write(t, e.host, dir+"/pids.current", "4\n")
	write(t, e.host, dir+"/io.stat", fmt.Sprintf("8:0 rbytes=%d wbytes=%d rios=1 wios=1\n253:0 rbytes=%d wbytes=0\n", rbytes, wbytes, rbytes))
}

func TestMetricsCgroupBatch(t *testing.T) {
	e := newEnv(t)
	tick := clock(e)
	var pw strings.Builder
	for uid := 20001; uid <= 20040; uid++ {
		pw.WriteString(fmt.Sprintf("acct%d:x:%d:%d::/home/acct%d:/bin/bash\n", uid, uid, uid, uid))
		if uid != 20007 { // 20007 chưa có slice (chưa chạy tiến trình nào)
			cgTree(t, e, uid, 1_000_000, 1000, 2000)
		}
	}
	appendFile(t, e.fs.Root, "/etc/passwd", pw.String())
	cgTree(t, e, 20099, 5, 5, 5)                                                                     // slice không có user trong passwd: bỏ qua
	write(t, e.host, "/sys/fs/cgroup/itso.slice/itso-acct.slice/itso-acct-abc.slice/cpu.stat", "x")  // tên lạ: bỏ qua
	write(t, e.host, "/sys/fs/cgroup/itso.slice/itso-acct.slice/itso-acct-1000.slice/cpu.stat", "x") // ngoài dải UID account

	r := e.h.OK(contracts.OpMetricsCgroup, map[string]any{})
	a := r["accounts"].([]any)
	if len(a) != 39 || r["sampled_at"] != ct.Now.UTC().Format(time.RFC3339) {
		t.Fatalf("mọi slice có user, bỏ 20007/20099/tên lạ: %d", len(a))
	}
	first := a[0].(map[string]any)
	if first["username"] != "acct20001" || first["io_read_bytes"] != float64(2000) || first["io_write_bytes"] != float64(2000) ||
		first["cpu_pct"] != float64(0) || first["memory_max_mb"] != nil {
		t.Fatal(first)
	}
	// Lần 2 sau 60 giây: CPU 30 giây/60 giây = 50 %; IO theo giây.
	tick(60 * time.Second)
	cgTree(t, e, 20001, 31_000_000, 1000+60_000, 2000+120_000)
	r = e.h.OK(contracts.OpMetricsCgroup, map[string]any{})
	first = r["accounts"].([]any)[0].(map[string]any)
	if first["cpu_pct"] != float64(50) || first["io_read_bps"] != float64(2000) || first["io_write_bps"] != float64(2000) {
		t.Fatal(first)
	}
	// Truyền accounts cụ thể: giữ hành vi cũ (account chưa có slice vẫn trả số 0).
	r = e.h.OK(contracts.OpMetricsCgroup, map[string]any{"accounts": []any{ct.Acct("acct20007", 20007)}})
	if len(r["accounts"].([]any)) != 1 {
		t.Fatal(r)
	}
	e.h.Fail(contracts.OpMetricsCgroup, map[string]any{"accounts": []any{ct.Acct("root", 0)}}, "invalid_params")
}

func TestSandboxMetricsControl(t *testing.T) {
	e := newEnv(t)
	e.d.Sandbox = true
	tick := clock(e)
	appendFile(t, e.fs.Root, "/etc/passwd", "anphat:x:20001:20001::/home/anphat:/bin/bash\nlehoa:x:20002:20002::/home/lehoa:/bin/bash\n")

	// Sandbox tự sinh cây cgroup giả trong gốc sandbox (không đụng /sys thật), số liệu tăng theo thời gian.
	e.h.OK(contracts.OpMetricsCgroup, map[string]any{})
	tick(5 * time.Minute)
	r := e.h.OK(contracts.OpMetricsCgroup, map[string]any{})
	a := r["accounts"].([]any)
	if len(a) != 2 {
		t.Fatal(a)
	}
	for _, x := range a {
		m := x.(map[string]any)
		if m["cpu_pct"].(float64) <= 0 || m["io_read_bps"].(float64) <= 0 || m["memory_current_mb"].(float64) <= 0 {
			t.Fatal("sandbox phải có số liệu khác 0", m)
		}
	}
	if !e.fs.Exists(ops.CgroupDir(20001) + "/cgroup.sim") {
		t.Fatal("cây cgroup giả phải nằm trong gốc sandbox")
	}

	write(t, e.fs.Root, ops.SimMetricsControl, `{"disk_pct": 95}`)
	s := e.h.OK(contracts.OpMetricsSnapshot, map[string]any{})
	if pct := s["disk_used_mb"].(float64) / s["disk_total_mb"].(float64); pct < 0.94 || pct > 0.96 {
		t.Fatal("disk_pct ghi đè % disk", s)
	}
	write(t, e.fs.Root, ops.SimMetricsControl, `{"offline": true}`)
	if r := e.h.Fail(contracts.OpSystemPing, map[string]any{}, "agent_unreachable"); !r.Error.Retryable {
		t.Fatal("agent_unreachable phải retryable")
	}
	e.h.Fail(contracts.OpMetricsSnapshot, map[string]any{}, "agent_unreachable")
	write(t, e.fs.Root, ops.SimMetricsControl, `{}`)
	e.h.OK(contracts.OpSystemPing, map[string]any{})

	// Máy thật bỏ qua file điều khiển.
	e.d.Sandbox = false
	write(t, e.fs.Root, ops.SimMetricsControl, `{"offline": true}`)
	e.h.OK(contracts.OpSystemPing, map[string]any{})
}
