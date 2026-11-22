package ops_test

import (
	"context"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

const (
	applyA = "01938a0f-0007-7000-8000-00000f000007"
	applyB = "01938a0f-0008-7000-8000-00000f000008"
)

// secEnv: agent thật + Sim, đồng hồ giả chỉnh được (hết hạn safe-apply).
func secEnv(t *testing.T) (*env, *time.Time) {
	e := newEnv(t)
	clock := ct.Now
	e.d.Now = func() time.Time { return clock }
	return e, &clock
}

func fwRule(prio int, action, ports, src, comment string) map[string]any {
	var p any = ports
	if ports == "" {
		p = nil
	}
	return map[string]any{"priority": prio, "action": action, "direction": "in", "protocol": "tcp", "ports": p,
		"source": src, "comment": comment}
}

func fwParams(id string, rules ...map[string]any) map[string]any {
	if rules == nil {
		rules = []map[string]any{}
	}
	return map[string]any{"apply_id": id, "rules": rules, "confirm_within_sec": 120,
		"anti_lockout": map[string]any{"ssh_port": 22, "panel_port": 8443, "client_ip": "10.10.5.20"}}
}

func demoRules() []map[string]any {
	return []map[string]any{
		fwRule(20, "accept", "80,443", "0.0.0.0/0", "Web"),
		fwRule(10, "accept", "22", "10.10.0.0/16", "SSH chỉ từ mạng nội bộ"),
		fwRule(30, "accept", "8443", "10.10.0.0/16", "Admin Panel"),
		fwRule(40, "drop", "3306", "0.0.0.0/0", "Chặn MySQL"),
		{"priority": 50, "action": "accept", "direction": "in", "protocol": "udp", "ports": "51820", "source": "2001:db8::/32", "comment": ""},
		{"priority": 60, "action": "reject", "direction": "out", "protocol": "any", "ports": "25", "source": "0.0.0.0/0", "comment": "Chặn SMTP ra"},
		{"priority": 70, "action": "accept", "direction": "in", "protocol": "icmp", "ports": nil, "source": "10.0.0.0/8", "comment": ""},
	}
}

func TestFirewallSafeApplyConfirm(t *testing.T) {
	e, _ := secEnv(t)
	e.fake.Reset()
	d := e.h.OK(contracts.OpFirewallApply, fwParams(applyA, demoRules()...))
	token, _ := d["token"].(string)
	if len(token) < 32 || d["rules_active"].(float64) != 7 || d["changed"] != true {
		t.Fatalf("kết quả sai: %v", d)
	}
	if d["rollback_at"] != ct.Now.Add(120*time.Second).UTC().Format(time.RFC3339) {
		t.Fatal("rollback_at sai:", d["rollback_at"])
	}
	// Ruleset đang áp dụng (trong Sim) = golden; thứ tự lệnh: list → -c → -f → hẹn timer.
	golden(t, "firewall.nft", e.sim.NftTable())
	lines := strings.Join(e.fake.Lines(), "\n")
	for _, want := range []string{"nft list table inet itso", "nft -c -f ", "nft -f ",
		"systemd-run --quiet --collect --on-active=120s --unit=itso-fw-rollback --timer-property=AccuracySec=1s " +
			"--description=ITSO safe-apply rollback (firewall) " + ops.AgentBin + " safe-rollback firewall " + applyA} {
		if !strings.Contains(lines, want) {
			t.Fatalf("thiếu lệnh %q trong:\n%s", want, lines)
		}
	}
	if strings.Index(lines, "nft -c -f") > strings.Index(lines, "nft -f ") {
		t.Fatal("phải kiểm cú pháp trước khi áp dụng")
	}
	// Token không lưu thô trên đĩa.
	if strings.Contains(e.file(ops.FirewallDir+"/pending.json"), token) {
		t.Fatal("pending.json không được chứa token thô")
	}
	st := e.h.OK(contracts.OpFirewallStatus, map[string]any{})
	if st["state"] != "pending_confirm" || st["apply_id"] != applyA || st["table_present"] != true {
		t.Fatalf("status sai: %v", st)
	}
	// Lần áp dụng thứ hai khi còn chờ → busy.
	e.h.Fail(contracts.OpFirewallApply, fwParams(applyB), "busy")
	// Token sai → precondition_failed; token đúng → dừng timer.
	e.h.Fail(contracts.OpFirewallConfirm, map[string]any{"apply_id": applyA, "token": strings.Repeat("A", 43)}, "precondition_failed")
	e.fake.Reset()
	c := e.h.OK(contracts.OpFirewallConfirm, map[string]any{"apply_id": applyA, "token": token})
	if c["confirmed"] != true || c["rolled_back"] != false {
		t.Fatal(c)
	}
	if !contains(e.fake.Lines(), "systemctl stop itso-fw-rollback.timer") {
		t.Fatal("confirm phải dừng timer:", e.fake.Lines())
	}
	// Xác nhận lặp lại: idempotent.
	if c := e.h.OK(contracts.OpFirewallConfirm, map[string]any{"apply_id": applyA, "token": token}); c["confirmed"] != true {
		t.Fatal(c)
	}
	st = e.h.OK(contracts.OpFirewallStatus, map[string]any{})
	if st["state"] != "confirmed" || st["rollback_at"] != nil {
		t.Fatal(st)
	}
	// Sau khi xác nhận có thể áp dụng tiếp; ruleset cũ được lưu để hoàn tác.
	e.h.OK(contracts.OpFirewallApply, fwParams(applyB, fwRule(10, "accept", "80", "0.0.0.0/0", "")))
	if prev := e.file(ops.FirewallDir + "/" + applyB + ".prev"); !strings.Contains(prev, "SSH chỉ từ mạng nội bộ") {
		t.Fatal("phải lưu ruleset cũ:", prev)
	}
}

func TestFirewallExpiryRollsBack(t *testing.T) {
	e, clock := secEnv(t)
	d := e.h.OK(contracts.OpFirewallApply, fwParams(applyA, demoRules()...))
	first := e.sim.NftTable()
	e.h.OK(contracts.OpFirewallConfirm, map[string]any{"apply_id": applyA, "token": d["token"]})
	d = e.h.OK(contracts.OpFirewallApply, fwParams(applyB, fwRule(10, "accept", "80", "0.0.0.0/0", "chỉ web")))
	if e.sim.NftTable() == first {
		t.Fatal("ruleset mới chưa được áp dụng")
	}
	// Quá hạn: đọc status (đồng hồ giả) → hoàn tác về ruleset đã xác nhận trước đó.
	*clock = clock.Add(121 * time.Second)
	st := e.h.OK(contracts.OpFirewallStatus, map[string]any{})
	if st["state"] != "rolled_back" || e.sim.NftTable() != first {
		t.Fatalf("phải hoàn tác: %v\n%s", st, e.sim.NftTable())
	}
	// Xác nhận muộn → báo đã hoàn tác.
	c := e.h.OK(contracts.OpFirewallConfirm, map[string]any{"apply_id": applyB, "token": d["token"]})
	if c["confirmed"] != false || c["rolled_back"] != true {
		t.Fatal(c)
	}
}

func TestFirewallFirstApplyRollbackRemovesTable(t *testing.T) {
	e, _ := secEnv(t)
	e.h.OK(contracts.OpFirewallApply, fwParams(applyA))
	if e.sim.NftTable() == "" {
		t.Fatal("bảng phải được tạo")
	}
	// Timer systemd gọi `itso-agent safe-rollback` (agent có thể đã chết) → bảng bị xóa (trạng thái trước đó).
	if err := ops.SafeRollback(context.Background(), e.d, "firewall", applyA); err != nil {
		t.Fatal(err)
	}
	if e.sim.NftTable() != "" {
		t.Fatal("lần đầu áp dụng bị hoàn tác phải xóa bảng itso:", e.sim.NftTable())
	}
	// Timer chạy lại (muộn) không làm gì; tham số lạ bị từ chối.
	if err := ops.SafeRollback(context.Background(), e.d, "firewall", applyA); err != nil {
		t.Fatal(err)
	}
	if ops.SafeRollback(context.Background(), e.d, "nginx", applyA) == nil || ops.SafeRollback(context.Background(), e.d, "firewall", "../x") == nil {
		t.Fatal("phải từ chối loại/apply_id lạ")
	}
}

func TestFirewallRecoverAfterAgentRestart(t *testing.T) {
	e, clock := secEnv(t)
	e.h.OK(contracts.OpFirewallApply, fwParams(applyA, demoRules()...))
	// Agent khởi động lại sau khi hết hạn (timer không chạy) → RecoverSafeApply hoàn tác.
	*clock = clock.Add(10 * time.Minute)
	d2 := &ops.Deps{Run: e.fake, FS: e.fs, Now: e.d.Now}
	if err := ops.RecoverSafeApply(context.Background(), d2); err != nil {
		t.Fatal(err)
	}
	if e.sim.NftTable() != "" || e.fs.Exists(ops.FirewallDir+"/pending.json") {
		t.Fatal("phải hoàn tác khi khởi động lại")
	}
	// Agent chết ngay sau `nft -f` (pending đã ghi trước khi áp dụng, chưa có token) → vẫn hoàn tác được.
	*clock = ct.Now
	e.fail["systemd-run"] = platform.Result{ExitCode: 1, Stderr: []byte("Failed to start transient timer unit")}
	e.h.Fail(contracts.OpFirewallApply, fwParams(applyB, demoRules()...), "dependency_unavailable")
	if e.sim.NftTable() != "" || e.fs.Exists(ops.FirewallDir+"/pending.json") {
		t.Fatal("không hẹn được timer thì phải hoàn tác ngay")
	}
}

func TestFirewallSyntaxErrorNoChange(t *testing.T) {
	e, _ := secEnv(t)
	e.fail["nft -c -f"] = platform.Result{ExitCode: 1, Stderr: []byte("Error: syntax error")}
	e.fake.Reset()
	e.h.Fail(contracts.OpFirewallApply, fwParams(applyA, demoRules()...), "config_test_failed")
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "nft -f") || strings.HasPrefix(l, "systemd-run") {
			t.Fatal("không được áp dụng/hẹn timer khi nft -c lỗi:", l)
		}
	}
	if e.fs.Exists(ops.FirewallDir + "/pending.json") {
		t.Fatal("không được để lại lần chờ")
	}
}

// Vector chống tự khóa và vector độc (contracts/test-vectors/evil-inputs.json, Laravel dùng cùng bộ ở 7.4).
func TestFirewallRejectsLockoutAndEvil(t *testing.T) {
	e, _ := secEnv(t)
	cases := []struct {
		name string
		rule map[string]any
		code string
	}{
		{"chặn SSH từ IP hiện tại", fwRule(10, "drop", "22", "10.10.5.20/32", ""), "would_lock_out"},
		{"reject panel từ dải chứa IP hiện tại", fwRule(10, "reject", "8000-9000", "10.10.0.0/16", ""), "would_lock_out"},
		{"chặn mọi cổng từ 0.0.0.0/0", fwRule(10, "drop", "1-65535", "0.0.0.0/0", ""), "would_lock_out"},
		{"chặn mọi cổng (ports null)", fwRule(10, "drop", "", "0.0.0.0/0", ""), "would_lock_out"},
		{"chặn SSH từ IP hiện tại không prefix", fwRule(10, "drop", "22", "10.10.5.20", ""), "would_lock_out"},
		{"octet > 255", fwRule(10, "accept", "80", "999.1.1.1/8", ""), "invalid_params"},
		{"bit host", fwRule(10, "accept", "80", "10.0.0.1/8", ""), "invalid_params"},
		{"port > 65535", fwRule(10, "accept", "99999", "0.0.0.0/0", ""), "invalid_params"},
		{"khoảng ngược", fwRule(10, "accept", "90-80", "0.0.0.0/0", ""), "invalid_params"},
		{"chèn lệnh vào ports", fwRule(10, "accept", "80; flush ruleset", "0.0.0.0/0", ""), "invalid_params"},
		{"chèn dòng qua comment", fwRule(10, "accept", "80", "0.0.0.0/0", "x\"\nadd rule inet filter input accept"), "invalid_params"},
		{"action lạ", map[string]any{"priority": 1, "action": "jump", "direction": "in", "protocol": "tcp", "ports": "80", "source": "0.0.0.0/0", "comment": ""}, "invalid_params"},
		{"icmp có cổng", map[string]any{"priority": 1, "action": "accept", "direction": "in", "protocol": "icmp", "ports": "80", "source": "0.0.0.0/0", "comment": ""}, "invalid_params"},
	}
	for _, c := range cases {
		e.h.Fail(contracts.OpFirewallApply, fwParams(applyA, c.rule), c.code)
		if e.sim.NftTable() != "" {
			t.Fatalf("%s: không được áp dụng", c.name)
		}
	}
	// Chặn SSH từ dải KHÔNG chứa IP hiện tại, drop chiều ra: hợp lệ.
	e.h.OK(contracts.OpFirewallApply, fwParams(applyA, fwRule(10, "drop", "22", "198.51.100.0/24", ""),
		map[string]any{"priority": 2, "action": "drop", "direction": "out", "protocol": "tcp", "ports": "22", "source": "0.0.0.0/0", "comment": ""}))
	// anti_lockout sai.
	bad := fwParams(applyB)
	bad["anti_lockout"] = map[string]any{"ssh_port": 22, "panel_port": 8443, "client_ip": "300.1.1.1"}
	e.h.Fail(contracts.OpFirewallApply, bad, "invalid_params")
}

func TestFirewallEvilVectorsFromContracts(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "test-vectors", "evil-inputs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Categories map[string]struct {
			Vectors []struct {
				Input  json.RawMessage `json:"input"`
				Expect string          `json:"expect"`
				Layer  string          `json:"layer"`
				Note   string          `json:"note"`
			} `json:"vectors"`
		} `json:"categories"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	al := ops.AntiLockout{SSHPort: 22, PanelPort: 8443, ClientIP: netip.MustParseAddr("10.10.5.20")}
	n := 0
	for _, x := range v.Categories["firewall_rule"].Vectors {
		var r contracts.FirewallRule
		if err := json.Unmarshal(x.Input, &r); err != nil {
			t.Fatal(err)
		}
		_, err := ops.NormalizeFirewall([]contracts.FirewallRule{r}, al)
		// Tầng agent từ chối mọi vector "semantic" và mọi vector reject; chỉ chấp nhận vector accept tầng schema.
		wantOK := x.Expect == "accept" && x.Layer == "schema"
		if (err == nil) != wantOK {
			t.Fatalf("vector %q: muốn ok=%v, lỗi=%v", x.Note, wantOK, err)
		}
		n++
	}
	for _, x := range v.Categories["cidr"].Vectors {
		var s string
		_ = json.Unmarshal(x.Input, &s)
		_, err := ops.ParseSource(s)
		wantOK := x.Expect == "accept" && x.Layer == "schema"
		if (err == nil) != wantOK {
			t.Fatalf("cidr %q: muốn ok=%v, lỗi=%v", s, wantOK, err)
		}
		n++
	}
	if n < 10 {
		t.Fatal("thiếu vector:", n)
	}
}

func FuzzFirewallRule(f *testing.F) {
	f.Add("80,443", "0.0.0.0/0", "web", "tcp", "accept")
	f.Add("22", "10.10.5.20/32", "", "tcp", "drop")
	f.Add("1-65535", "::/0", "x", "any", "reject")
	f.Add("0", "10.0.0.1/8", "\"", "icmp", "jump")
	al := ops.AntiLockout{SSHPort: 22, PanelPort: 8443, ClientIP: netip.MustParseAddr("10.10.5.20")}
	f.Fuzz(func(t *testing.T, ports, src, comment, proto, action string) {
		p := &ports
		if ports == "" {
			p = nil
		}
		rules, err := ops.NormalizeFirewall([]contracts.FirewallRule{{Priority: 10, Action: action, Direction: "in",
			Protocol: proto, Ports: p, Source: contracts.CIDR(src), Comment: comment}}, al)
		if err != nil {
			return
		}
		script := ops.RenderNft(rules, al)
		// Bất biến: không ký tự điều khiển lạ; luôn có dòng chống tự khóa đứng trước rule người dùng.
		// Đếm ";" ngoài chuỗi trích dẫn: comment hợp lệ được chứa ";" (nằm trong "…", nft không tách lệnh ở đó).
		bare := regexp.MustCompile(`"[^"]*"`).ReplaceAllString(script, `""`)
		if strings.ContainsAny(script, "\r\x00") || strings.Count(bare, ";") != 4 {
			t.Fatalf("ruleset có ký tự/dòng lạ:\n%s", script)
		}
		anti := strings.Index(script, "itso: chống tự khóa")
		if anti < 0 {
			t.Fatal("thiếu rule chống tự khóa")
		}
		if strings.Count(script, "table inet itso {") != 1 {
			t.Fatal("chỉ được một bảng")
		}
	})
}

// ---------- SSH hardening ----------

func sshdParams(id string, pass bool) map[string]any {
	return map[string]any{"apply_id": id, "port": 22, "password_authentication": pass, "permit_root_login": "no",
		"max_auth_tries": 3, "login_grace_sec": 30, "x11_forwarding": false, "agent_forwarding": false,
		"allow_groups": []string{"itso-ssh", "sudo"}, "admin_user": "ubuntu", "client_ip": "10.10.5.20", "confirm_within_sec": 60}
}

func TestSshdHardeningSafeApply(t *testing.T) {
	e, clock := secEnv(t)
	// Chưa có khóa nào cho user quản trị → tắt mật khẩu bị từ chối.
	e.h.Fail(contracts.OpSshdConfigApply, sshdParams(applyA, false), "would_lock_out")
	if e.fs.Exists(ops.SshdHardening) {
		t.Fatal("không được ghi cấu hình")
	}
	write(t, mustPath(t, e.fs, "/"), "/home/ubuntu/.ssh/authorized_keys", "# khóa quản trị\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@laptop\n")
	e.fake.Reset()
	d := e.h.OK(contracts.OpSshdConfigApply, sshdParams(applyA, false))
	if d["admin_keys"].(float64) != 1 || d["sshd_test"] != "ok" || d["changed"] != true {
		t.Fatal(d)
	}
	golden(t, "10-itso-hardening.conf", e.file(ops.SshdHardening))
	lines := strings.Join(e.fake.Lines(), "\n")
	if !strings.Contains(lines, "sshd -t\nsystemctl try-reload-or-restart ssh.service\nsystemd-run --quiet --collect --on-active=60s --unit=itso-sshd-rollback") {
		t.Fatal("thứ tự sshd -t → reload → timer sai:\n", lines)
	}
	// Hết hạn không xác nhận → file trở về trạng thái trước (chưa tồn tại).
	*clock = clock.Add(61 * time.Second)
	if err := ops.RecoverSafeApply(context.Background(), e.d); err != nil {
		t.Fatal(err)
	}
	if e.fs.Exists(ops.SshdHardening) {
		t.Fatal("hoàn tác phải xóa file hardening (trước đó chưa có)")
	}
	// Áp dụng + xác nhận.
	*clock = ct.Now
	d = e.h.OK(contracts.OpSshdConfigApply, sshdParams(applyB, false))
	e.h.Fail(contracts.OpSshdConfigConfirm, map[string]any{"apply_id": applyB, "token": strings.Repeat("x", 43)}, "precondition_failed")
	c := e.h.OK(contracts.OpSshdConfigConfirm, map[string]any{"apply_id": applyB, "token": d["token"]})
	if c["confirmed"] != true {
		t.Fatal(c)
	}
	conf := e.file(ops.SshdHardening)
	// sshd -t lỗi → khôi phục bản đã xác nhận, không reload, không hẹn timer.
	e.fail["sshd -t"] = platform.Result{ExitCode: 255, Stderr: []byte("Bad configuration option")}
	e.fake.Reset()
	p := sshdParams("01938a0f-0009-7000-8000-00000f000009", true)
	p["port"] = 2222
	e.h.Fail(contracts.OpSshdConfigApply, p, "config_test_failed")
	if e.file(ops.SshdHardening) != conf {
		t.Fatal("phải khôi phục cấu hình cũ")
	}
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "systemctl") || strings.HasPrefix(l, "systemd-run") {
			t.Fatal("không được reload/hẹn timer khi sshd -t lỗi:", l)
		}
	}
	// Tham số lạ: group sai, admin_user lạ.
	bad := sshdParams(applyA, true)
	bad["allow_groups"] = []string{"sudo", "sudo"}
	e.h.Fail(contracts.OpSshdConfigApply, bad, "invalid_params")
	bad = sshdParams(applyA, true)
	bad["admin_user"] = "nobody2"
	e.h.Fail(contracts.OpSshdConfigApply, bad, "not_found")
}

func mustPath(t *testing.T, fs *platform.FS, p string) string {
	t.Helper()
	r, err := fs.Path(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// ---------- Fail2ban ----------

func TestFail2ban(t *testing.T) {
	e, _ := secEnv(t)
	params := map[string]any{"enabled": true, "ignoreip": []string{"10.10.0.0/16", "10.20.0.0/16"}, "jails": []map[string]any{
		{"name": "sshd", "enabled": true, "bantime_sec": 3600, "findtime_sec": 600, "maxretry": 5},
		{"name": "itso-panel", "enabled": true, "bantime_sec": 1800, "findtime_sec": 300, "maxretry": 10},
		{"name": "pure-ftpd", "enabled": false, "bantime_sec": 3600, "findtime_sec": 600, "maxretry": 5},
	}}
	d := e.step("fail2ban.apply", contracts.OpFail2banApply, params, true)
	if d["jails_active"].(float64) != 2 || d["reloaded"] != true {
		t.Fatal(d)
	}
	golden(t, "fail2ban-itso.conf", e.file(ops.Fail2banJailConf))
	golden(t, "fail2ban-itso-panel.conf", e.file(ops.Fail2banPanelFilter))
	st := e.h.OK(contracts.OpFail2banStatus, map[string]any{})
	jails := st["jails"].([]any)
	if st["running"] != true || len(jails) != 3 {
		t.Fatal(st)
	}
	sshd := jails[0].(map[string]any)
	if sshd["enabled"] != true || sshd["total_banned"].(float64) != 12 || len(sshd["banned"].([]any)) != 2 {
		t.Fatal(sshd)
	}
	if jails[2].(map[string]any)["enabled"] != false {
		t.Fatal("pure-ftpd phải tắt")
	}
	e.fake.Reset()
	if u := e.h.OK(contracts.OpFail2banUnban, map[string]any{"jail": "sshd", "ip": "203.0.113.45"}); u["unbanned"] != true {
		t.Fatal(u)
	}
	if !contains(e.fake.Lines(), "fail2ban-client set sshd unbanip 203.0.113.45") {
		t.Fatal(e.fake.Lines())
	}
	e.h.Fail(contracts.OpFail2banUnban, map[string]any{"jail": "sshd", "ip": "300.0.0.1"}, "invalid_params")
	e.h.Fail(contracts.OpFail2banUnban, map[string]any{"jail": "recidive", "ip": "203.0.113.45"}, "invalid_params")
	bad := map[string]any{"enabled": true, "ignoreip": []string{"10.0.0.1/8"}, "jails": []map[string]any{}}
	e.h.Fail(contracts.OpFail2banApply, bad, "invalid_params")
	// fail2ban-client -t lỗi → config_test_failed, không reload.
	e.fail["fail2ban-client -t"] = platform.Result{ExitCode: 255, Stderr: []byte("ERROR")}
	params["ignoreip"] = []string{"10.30.0.0/16"}
	e.h.Fail(contracts.OpFail2banApply, params, "config_test_failed")
}

func TestParseBanList(t *testing.T) {
	got := ops.ParseBanList("203.0.113.45 \t2026-11-20 08:15:00 + 3600 = 2026-11-20 09:15:00\n"+
		"rác\n2001:db8::1 \t2026-11-20 07:00:00 + -1 = 9999-12-31 23:59:59\n300.1.1.1 \t2026-11-20 07:00:00\n", time.UTC)
	if len(got) != 2 || got[0].IP != "203.0.113.45" || got[0].ExpiresAt == nil || *got[0].ExpiresAt != "2026-11-20T09:15:00Z" ||
		got[1].ExpiresAt != nil {
		t.Fatalf("%+v", got)
	}
}
