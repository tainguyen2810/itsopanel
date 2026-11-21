package ops_test

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

var update = flag.Bool("update", false, "ghi lại file golden")

// env là agent thật với runner giả (Sim) trên gốc FS tạm và /proc, /sys giả.
type env struct {
	t    *testing.T
	h    *ct.Harness
	fake *platform.FakeRunner
	sim  *ops.Sim
	fs   *platform.FS
	host string
	d    *ops.Deps
	// fail: lệnh (tiền tố) → kết quả lỗi, chèn trước Sim.
	fail map[string]platform.Result
}

func write(t *testing.T, root, p, content string) {
	t.Helper()
	full := filepath.Join(root, p)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newEnv(t *testing.T) *env {
	t.Helper()
	root, host := t.TempDir(), t.TempDir()
	write(t, root, "/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash\n")
	write(t, root, "/etc/group", "root:x:0:\nwww-data:x:33:\nubuntu:x:1000:\n")
	write(t, root, "/etc/shadow", "root:*:20000:0:99999:7:::\nwww-data:*:20000:0:99999:7:::\nubuntu:!:20000:0:99999:7:::\n")
	write(t, root, "/etc/hostname", "srv-old\n")

	write(t, host, "/etc/os-release", "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n")
	write(t, host, "/proc/sys/kernel/osrelease", "6.8.0-45-generic\n")
	write(t, host, "/proc/sys/kernel/hostname", "srv-hn-01\n")
	write(t, host, "/proc/uptime", "86400.52 170000.10\n")
	write(t, host, "/proc/cpuinfo", "processor\t: 0\nmodel name\t: X\n\nprocessor\t: 1\nmodel name\t: X\n\nprocessor\t: 2\n\nprocessor\t: 3\n")
	write(t, host, "/proc/meminfo", "MemTotal:        8048576 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\n")
	write(t, host, "/proc/loadavg", "0.42 0.30 0.20 1/300 12345\n")
	write(t, host, "/proc/stat", "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1\n")
	write(t, host, "/sys/fs/cgroup/cgroup.controllers", "cpu io memory pids\n")
	write(t, host, "/run/systemd/system/.keep", "")
	cg := ops.CgroupDir(20001)
	write(t, host, cg+"/cpu.stat", "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\nnr_periods 10\nnr_throttled 3\nthrottled_usec 250000\n")
	write(t, host, cg+"/memory.current", "268435456\n")
	write(t, host, cg+"/memory.max", "1073741824\n")
	write(t, host, cg+"/memory.events", "low 0\nhigh 2\nmax 1\noom 1\noom_kill 1\n")
	write(t, host, cg+"/pids.current", "17\n")

	e := &env{t: t, fs: platform.NewFS(root, true), host: host, fail: map[string]platform.Result{}}
	e.sim = ops.NewSim(e.fs)
	e.fake = platform.NewFake()
	e.fake.Hook = func(c platform.Cmd) (platform.Result, bool) {
		s := c.String()
		for k, r := range e.fail {
			if strings.HasPrefix(s, k) {
				return r, true
			}
		}
		return e.sim.Handle(c)
	}
	e.d = &ops.Deps{Run: e.fake, FS: e.fs, Host: platform.NewFS(host, true), AuditPath: filepath.Join(root, "audit.jsonl"),
		Now: func() time.Time { return ct.Now }}
	r := registry.New(ops.Version)
	if err := ops.Register(r, e.d); err != nil {
		t.Fatal(err)
	}
	e.h = ct.New(t, r)
	return e
}

// reads là lệnh chỉ đọc; còn lại là lệnh ghi (test idempotent: lần 2 không có lệnh ghi).
func isRead(line string) bool {
	for _, p := range []string{"getfacl ", "systemctl is-active ", "systemctl is-enabled ", "dpkg-query ", "findmnt ", "repquota "} {
		if strings.HasPrefix(line, p) {
			return true
		}
	}
	return false
}

func (e *env) writes() []string {
	var out []string
	for _, l := range e.fake.Lines() {
		if !isRead(l) {
			out = append(out, l)
		}
	}
	return out
}

// golden so sánh nội dung với testdata/golden/<name>; -update để ghi lại.
func golden(t *testing.T, name, got string) {
	t.Helper()
	p := filepath.Join("testdata", "golden", name)
	if *update {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("thiếu golden %s (chạy go test -update): %v", p, err)
	}
	if string(want) != got {
		t.Fatalf("golden %s khác:\n--- muốn\n%s\n--- nhận\n%s", name, want, got)
	}
}

// step chạy op, so argv với golden, rồi chạy lại và đòi không có lệnh ghi (idempotent).
func (e *env) step(name, op string, params map[string]any, idempotent bool) map[string]any {
	e.t.Helper()
	e.fake.Reset()
	d := e.h.OK(op, params)
	golden(e.t, name+".argv", strings.Join(e.fake.Lines(), "\n")+"\n")
	if idempotent {
		e.fake.Reset()
		e.h.OK(op, params)
		if w := e.writes(); len(w) != 0 {
			e.t.Fatalf("%s lần 2 không được ghi gì, nhận: %v", op, w)
		}
	}
	return d
}

func (e *env) file(p string) string {
	e.t.Helper()
	b, err := e.fs.ReadFile(p)
	if err != nil {
		e.t.Fatal(err)
	}
	return string(b)
}

func TestContractSuiteSharedWithMock(t *testing.T) {
	ct.AccountLifecycle(t, newEnv(t).h)
	ct.AccountParamsValidated(t, newEnv(t).h)
}

func TestAccountEnsureGolden(t *testing.T) {
	e := newEnv(t)
	d := e.step("account.ensure", contracts.OpAccountEnsure, ct.EnsureParams("lehoa", 20001), true)
	if d["created"] != true || d["uid"] != float64(20001) {
		t.Fatal(d)
	}
	if !strings.Contains(e.file("/etc/passwd"), "lehoa:x:20001:20001:ITSO hosting lehoa:/home/lehoa:/usr/sbin/nologin") {
		t.Fatal(e.file("/etc/passwd"))
	}
	// Bố cục home 07 §5: quyền + chủ mong muốn (NoChown ghi vào Owners).
	want := map[string]struct {
		mode os.FileMode
		uid  int
		gid  int
	}{
		"/home/lehoa": {0o750, 0, 20001}, "/home/lehoa/sites": {0o750, 20001, 20001}, "/home/lehoa/backups": {0o700, 20001, 20001},
		"/home/lehoa/.ssh": {0o700, 20001, 20001}, "/home/lehoa/.itso": {0o755, 0, 0},
	}
	for p, w := range want {
		rp, _ := e.fs.Path(p)
		fi, err := os.Lstat(rp)
		if err != nil || !fi.IsDir() || fi.Mode().Perm() != w.mode {
			t.Fatalf("%s: %v %v", p, fi, err)
		}
		if o, ok := e.fs.OwnerOf(p); !ok || o.UID != w.uid || o.GID != w.gid {
			t.Fatalf("%s: chủ %+v", p, o)
		}
	}
	golden(t, "itso-acct-20001.slice.conf", e.file("/etc/systemd/system/itso-acct-20001.slice.d/50-itso.conf"))
	golden(t, "user-20001.slice.conf", e.file("/etc/systemd/system/user-20001.slice.d/50-itso.conf"))

	// Đổi shell → chỉ usermod -s.
	p := ct.EnsureParams("lehoa", 20001)
	p["shell"] = "/bin/bash"
	e.fake.Reset()
	e.h.OK(contracts.OpAccountEnsure, p)
	if w := e.writes(); len(w) != 1 || w[0] != "usermod -s /bin/bash lehoa" {
		t.Fatal(w)
	}
	// Xung đột UID với user hệ thống có sẵn: từ chối trước khi chạy lệnh ghi.
	write(t, e.fs.Root, "/etc/passwd", e.file("/etc/passwd")+"legacy:x:20002:20002::/home/legacy:/bin/bash\n")
	e.fake.Reset()
	e.h.Fail(contracts.OpAccountEnsure, ct.EnsureParams("mktitso", 20002), "already_exists")
	if len(e.writes()) != 0 {
		t.Fatal(e.writes())
	}
}

func TestLimitsSuspendGolden(t *testing.T) {
	e := newEnv(t)
	e.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("lehoa", 20001))
	l := ct.Limits()
	l["cpu_percent"], l["ram_mb"], l["tasks_max"], l["io_read_bps"] = 200, 2048, 512, 10485760
	d := e.step("account.limits.apply", contracts.OpAccountLimitsApply, map[string]any{"account": ct.Acct("lehoa", 20001), "limits": l}, true)
	if d["slice"] != "itso-acct-20001.slice" || d["applied"] != true {
		t.Fatal(d)
	}
	golden(t, "itso-acct-20001.slice.limits.conf", e.file("/etc/systemd/system/itso-acct-20001.slice.d/50-itso.conf"))
	e.h.Fail(contracts.OpAccountLimitsApply, map[string]any{"account": ct.Acct("khongco", 20009), "limits": l}, "not_found")

	// Slice đang chạy → suspend dừng slice.
	e.sim.Handle(platform.Cmd{Bin: "systemctl", Args: []string{"start", "itso-acct-20001.slice"}})
	e.step("account.suspend", contracts.OpAccountSuspend, map[string]any{"account": ct.Acct("lehoa", 20001), "reason": "quá hạn"}, true)
	if !strings.Contains(e.file("/etc/group"), "itso-suspended:x:999:lehoa") || !strings.Contains(e.file("/etc/shadow"), "lehoa:!:20000:0:99999:7::1:") {
		t.Fatal(e.file("/etc/group"), e.file("/etc/shadow"))
	}
	e.step("account.unsuspend", contracts.OpAccountUnsuspend, map[string]any{"account": ct.Acct("lehoa", 20001)}, true)
	if !strings.Contains(e.file("/etc/group"), "itso-suspended:x:999:\n") || !strings.Contains(e.file("/etc/shadow"), "lehoa:!:20000:0:99999:7:::") {
		t.Fatal(e.file("/etc/group"), e.file("/etc/shadow"))
	}
	// reason nhiều dòng bị từ chối (schema hoặc agent).
	res := e.h.Call(contracts.OpAccountSuspend, map[string]any{"account": ct.Acct("lehoa", 20001), "reason": "a\nb"})
	if res.OK || res.Error.Code != "invalid_params" {
		t.Fatal(res)
	}
}

func TestQuotaGolden(t *testing.T) {
	e := newEnv(t)
	e.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("lehoa", 20001))
	d := e.step("quota.apply", contracts.OpQuotaApply, map[string]any{"account": ct.Acct("lehoa", 20001), "limits": ct.Limits()}, true)
	if d["applied"] != true || d["mode"] != "kernel" {
		t.Fatal(d)
	}
	rep := e.step("quota.report", contracts.OpQuotaReport, map[string]any{"accounts": []any{ct.Acct("lehoa", 20001)}}, false)
	u := rep["usage"].([]any)[0].(map[string]any)
	if u["inodes"] != float64(1) || u["ram_mb"] != float64(256) {
		t.Fatal(u)
	}

	// Không có user quota trên /home → chế độ soft: không setquota, đo cây thư mục.
	e.sim.Mount = "/ ext4 rw,relatime"
	e.fake.Reset()
	d = e.h.OK(contracts.OpQuotaApply, map[string]any{"account": ct.Acct("lehoa", 20001), "limits": ct.Limits()})
	if d["applied"] != false || d["mode"] != "soft" || len(e.writes()) != 0 {
		t.Fatal(d, e.writes())
	}
	rp, _ := e.fs.Path("/home/lehoa/sites/big.bin")
	if err := os.WriteFile(rp, make([]byte, 3<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	rep = e.h.OK(contracts.OpQuotaReport, map[string]any{"accounts": []any{ct.Acct("lehoa", 20001)}})
	u = rep["usage"].([]any)[0].(map[string]any)
	if u["disk_mb"].(float64) < 3 || u["inodes"].(float64) < 6 {
		t.Fatalf("soft mode phải đo được file 3 MB: %v", u)
	}
}

func TestSystemOpsGolden(t *testing.T) {
	e := newEnv(t)
	info := e.step("system.info", contracts.OpSystemInfo, map[string]any{}, false)
	for k, v := range map[string]any{"os": "Ubuntu 24.04.1 LTS", "kernel": "6.8.0-45-generic", "hostname": "srv-hn-01",
		"uptime_sec": float64(86400), "cpu_cores": float64(4), "ram_mb": float64(7859), "cgroup_v2": true, "systemd": true,
		"quota_mode": "kernel"} {
		if info[k] != v {
			t.Errorf("system.info %s = %v, muốn %v", k, info[k], v)
		}
	}
	if d := e.step("system.hostname.set", contracts.OpSystemHostnameSet, map[string]any{"hostname": "srv-hn-02"}, true); d["changed"] != true {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpSystemHostnameSet, map[string]any{"hostname": "srv-hn-02"}); d["changed"] != false {
		t.Fatal(d)
	}
	d := e.step("system.reboot", contracts.OpSystemReboot, map[string]any{"delay_sec": 90, "reason": "Bảo trì kernel"}, false)
	if d["scheduled_at"] != ct.Now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatal(d)
	}
	snap := e.step("metrics.snapshot", contracts.OpMetricsSnapshot, map[string]any{}, false)
	if snap["ram_used_mb"] != float64(2000) || snap["load_1m"] != 0.42 {
		t.Fatal(snap)
	}
	cg := e.step("metrics.cgroup", contracts.OpMetricsCgroup, map[string]any{"accounts": []any{ct.Acct("lehoa", 20001), ct.Acct("khac", 20002)}}, false)
	a := cg["accounts"].([]any)
	first, second := a[0].(map[string]any), a[1].(map[string]any)
	if first["cpu_throttled_usec"] != float64(250000) || first["memory_max_mb"] != float64(1024) || first["oom_kills"] != float64(1) ||
		first["pids_current"] != float64(17) || second["memory_max_mb"] != nil {
		t.Fatal(a)
	}
}

func TestServiceAndSoftwareGolden(t *testing.T) {
	e := newEnv(t)
	e.sim.Handle(platform.Cmd{Bin: "apt-get", Args: []string{"install", "nginx"}})
	st := e.step("service.status", contracts.OpServiceStatus, map[string]any{"names": []any{"nginx", "mariadb"}}, false)
	svcs := st["services"].([]any)
	if svcs[0].(map[string]any)["version"] != "1.0-sandbox" || svcs[1].(map[string]any)["version"] != nil {
		t.Fatal(svcs)
	}
	// start khi đang chạy: không ghi; stop rồi stop lần 2: idempotent.
	e.fake.Reset()
	e.h.OK(contracts.OpServiceControl, map[string]any{"name": "nginx", "action": "start"})
	if len(e.writes()) != 0 {
		t.Fatal(e.writes())
	}
	if d := e.step("service.control.stop", contracts.OpServiceControl, map[string]any{"name": "nginx", "action": "stop"}, true); d["active"] != false {
		t.Fatal(d)
	}
	if d := e.step("software.install", contracts.OpSoftwareInstall, map[string]any{"recipe": "restic"}, true); d["changed"] != true || d["version"] != "1.0-sandbox" {
		t.Fatal(d)
	}
	e.h.Fail(contracts.OpSoftwareRemove, map[string]any{"recipe": "quota"}, "precondition_failed")
	e.step("software.remove", contracts.OpSoftwareRemove, map[string]any{"recipe": "restic"}, true)
}

// Lệnh hệ thống lỗi → mã lỗi đúng, không panic, lỗi tạm thời có retryable.
func TestCommandFailureCodes(t *testing.T) {
	e := newEnv(t)
	e.fail["useradd "] = platform.Result{ExitCode: 9, Stderr: []byte("useradd: user 'lehoa' already exists")}
	r := e.h.Fail(contracts.OpAccountEnsure, ct.EnsureParams("lehoa", 20001), "internal")
	if !strings.Contains(r.Error.Message, "useradd thoát mã 9") {
		t.Fatal(r.Error)
	}
	e.fail["apt-get "] = platform.Result{ExitCode: 100, Stderr: []byte("E: Unable to locate package")}
	r = e.h.Fail(contracts.OpSoftwareInstall, map[string]any{"recipe": "stress-ng"}, "dependency_unavailable")
	if !r.Error.Retryable {
		t.Fatal("dependency_unavailable phải retryable")
	}
	e.fail["systemctl stop "] = platform.Result{ExitCode: 1, Stderr: []byte("Job failed")}
	e.h.Fail(contracts.OpServiceControl, map[string]any{"name": "nginx", "action": "stop"}, "precondition_failed")
}

func TestOpCancel(t *testing.T) {
	e := newEnv(t)
	e.d.CPUSample = time.Minute
	raw, id := e.h.Raw(contracts.OpMetricsSnapshot, map[string]any{})
	done := make(chan registry.Result, 1)
	go func() { done <- e.h.Reg.Handle(context.Background(), raw) }()
	for i := 0; ; i++ {
		d := e.h.OK(contracts.OpOpCancel, map[string]any{"op_id": id})
		if d["cancelled"] == true {
			break
		}
		if i > 200 {
			t.Fatal("op không vào trạng thái đang chạy")
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case res := <-done:
		if res.OK || res.Error.Code != "cancelled" {
			t.Fatal(res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("op bị hủy không kết thúc")
	}
	if d := e.h.OK(contracts.OpOpCancel, map[string]any{"op_id": id}); d["cancelled"] != false {
		t.Fatal(d)
	}
}

// Ví dụ envelope trong contracts/agent-ops/examples (op agent thật hỗ trợ) chạy được qua agent thật.
func TestContractExamples(t *testing.T) {
	files, _ := filepath.Glob("../../../contracts/agent-ops/examples/valid-*.json")
	ran := 0
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		e := newEnv(t)
		var head struct {
			Op string `json:"op"`
			TS int64  `json:"ts"`
		}
		if err := jsonUnmarshal(raw, &head); err != nil {
			t.Fatal(err)
		}
		if !contains(e.h.Reg.Ops(), head.Op) {
			continue
		}
		e.h.Reg.SetClock(func() time.Time { return time.Unix(head.TS, 0) })
		res := e.h.Reg.Handle(context.Background(), raw)
		e.h.Check(head.Op, res)
		if !res.OK {
			t.Fatalf("%s: %+v", filepath.Base(f), res.Error)
		}
		ran++
	}
	if ran == 0 {
		t.Fatal("không có ví dụ nào cho op agent thật")
	}
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
