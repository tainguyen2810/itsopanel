package ops_test

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

const wafSite = "01938a06-0002-7000-8000-000006000002"

func wafParams(mode string, excl ...int) map[string]any {
	ex := []any{}
	for _, x := range excl {
		ex = append(ex, x)
	}
	return map[string]any{"website_uuid": wafSite, "account": acct(), "mode": mode, "paranoia_level": 2, "rule_exclusions": ex}
}

func installCRS(t *testing.T, e *env) {
	root := mustPath(t, e.fs, "/")
	write(t, root, ops.CrsSetup, "# crs-setup\n")
	write(t, root, ops.CrsRules+"/REQUEST-942-APPLICATION-ATTACK-SQLI.conf", "# rules\n")
	write(t, root, ops.ModsecModule, "load_module modules/ngx_http_modsecurity_module.so;\n")
}

// ---------- WAF ----------

func TestWafApply(t *testing.T) {
	e := dataEnv(t)
	// Chưa cài gói ModSecurity/CRS → available=false, không ghi gì.
	d := e.h.OK(contracts.OpWAFApply, wafParams("DetectionOnly"))
	if d["available"] != false || d["nginx_test"] != "skipped" || e.fs.Exists(ops.WafIncludePath(wafSite)) {
		t.Fatal(d)
	}
	installCRS(t, e)
	d = e.step("waf.apply", contracts.OpWAFApply, wafParams("DetectionOnly", 942100, 920350), true)
	if d["available"] != true || d["changed"] != true || d["nginx_test"] != "ok" {
		t.Fatal(d)
	}
	golden(t, "waf-rules.conf", e.file(ops.WafRulesPath(wafSite)))
	golden(t, "waf-include.nginx", e.file(ops.WafIncludePath(wafSite)))
	// Chỉ đổi rule (include giữ nguyên) → vẫn nginx -t + reload.
	e.fake.Reset()
	e.h.OK(contracts.OpWAFApply, wafParams("On", 942100))
	if !strings.Contains(e.file(ops.WafRulesPath(wafSite)), "SecRuleEngine On\n") || !contains(e.fake.Lines(), "systemctl reload nginx.service") {
		t.Fatal("phải đổi mode và reload:", e.fake.Lines())
	}
	// nginx -t lỗi → khôi phục rule cũ.
	before := e.file(ops.WafRulesPath(wafSite))
	e.fail["nginx -t"] = platform.Result{ExitCode: 1, Stderr: []byte("modsecurity: rules error")}
	e.h.Fail(contracts.OpWAFApply, wafParams("On", 942100, 941100), "config_test_failed")
	if e.file(ops.WafRulesPath(wafSite)) != before {
		t.Fatal("phải khôi phục rule cũ khi nginx -t lỗi")
	}
	delete(e.fail, "nginx -t")
	// Off → gỡ include + rule.
	d = e.h.OK(contracts.OpWAFApply, wafParams("Off"))
	if d["changed"] != true || e.fs.Exists(ops.WafIncludePath(wafSite)) || e.fs.Exists(ops.WafRulesPath(wafSite)) {
		t.Fatal("Off phải gỡ WAF:", d)
	}
	// Vector: rule id trùng, paranoia ngoài miền (schema chặn chuỗi; handler chặn trùng).
	e.h.Fail(contracts.OpWAFApply, wafParams("On", 942100, 942100), "invalid_params")
	p := wafParams("On")
	p["paranoia_level"] = 5
	e.h.Fail(contracts.OpWAFApply, p, "invalid_params")
	p = wafParams("On")
	p["rule_exclusions"] = []any{"942100\nSecRuleEngine Off"}
	e.h.Fail(contracts.OpWAFApply, p, "invalid_params")
}

const wafLine = `{"transaction":{"client_ip":"198.51.100.23","time_stamp":"Fri Nov 20 08:15:00 2026","server_id":"x","client_port":51234,` +
	`"host_ip":"10.0.0.1","host_port":443,"unique_id":"1","request":{"method":"GET","http_version":1.1,"uri":"/search?q=1' OR 1=1--",` +
	`"headers":{"Host":"anphat.vn:443","User-Agent":"curl"}},"response":{"http_code":403,"headers":{}},"producer":{},` +
	`"messages":[{"message":"Inbound Anomaly Score Exceeded","details":{"ruleId":"949110","severity":"2"}},` +
	`{"message":"SQL Injection Attack Detected via libinjection","details":{"ruleId":"942100","severity":"2"}},` +
	`{"message":"Restricted SQL Character Anomaly","details":{"ruleId":"942430","severity":"4"}}]}}`

func TestWafEvents(t *testing.T) {
	e := dataEnv(t)
	root := mustPath(t, e.fs, "/")
	write(t, root, ops.VhostPath(wafSite), "# website "+wafSite+"\nserver {\n    server_name anphat.vn www.anphat.vn;\n}\n")
	// Chưa có log.
	if d := e.h.OK(contracts.OpWAFEvents, map[string]any{"cursor": nil, "limit": 100}); d["next_cursor"] != "0:0" {
		t.Fatal(d)
	}
	other := strings.Replace(wafLine, "anphat.vn:443", "unknown.example", 1)
	detected := strings.Replace(strings.Replace(wafLine, `"http_code":403`, `"http_code":200`, 1), "anphat.vn:443", "www.anphat.vn", 1)
	write(t, root, ops.WafAuditLog, wafLine+"\nrác không phải JSON\n"+other+"\n"+detected+"\n{\"transaction\":{\"client_ip\":\"1.2.3.4\"")
	d := e.h.OK(contracts.OpWAFEvents, map[string]any{"cursor": nil, "limit": 100})
	evs := d["events"].([]any)
	if len(evs) != 2 {
		t.Fatalf("muốn 2 sự kiện: %v", d)
	}
	ev := evs[0].(map[string]any)
	if ev["website_uuid"] != wafSite || ev["rule_id"].(float64) != 942100 || ev["severity"] != "critical" || ev["action"] != "blocked" ||
		ev["client_ip"] != "198.51.100.23" || ev["method"] != "GET" {
		t.Fatal(ev)
	}
	if evs[1].(map[string]any)["action"] != "detected" {
		t.Fatal(evs[1])
	}
	cur := d["next_cursor"].(string)
	// Dòng cuối chưa ghi xong: con trỏ dừng trước nó; đọc lại từ con trỏ → không có gì mới.
	if d2 := e.h.OK(contracts.OpWAFEvents, map[string]any{"cursor": cur, "limit": 100}); len(d2["events"].([]any)) != 0 || d2["next_cursor"] != cur {
		t.Fatal(d2)
	}
	// limit 1 → con trỏ sau sự kiện đầu.
	d1 := e.h.OK(contracts.OpWAFEvents, map[string]any{"cursor": nil, "limit": 1})
	if len(d1["events"].([]any)) != 1 || d1["next_cursor"] == cur {
		t.Fatal(d1)
	}
	// Log xoay vòng (inode khác) → đọc lại từ đầu file mới.
	full := filepath.Join(root, ops.WafAuditLog)
	if err := os.Remove(full); err != nil {
		t.Fatal(err)
	}
	write(t, root, ops.WafAuditLog, wafLine+"\n")
	if d3 := e.h.OK(contracts.OpWAFEvents, map[string]any{"cursor": cur, "limit": 100}); len(d3["events"].([]any)) != 1 {
		t.Fatal("sau xoay vòng phải đọc từ đầu:", d3)
	}
	e.h.Fail(contracts.OpWAFEvents, map[string]any{"cursor": "1:2:3", "limit": 10}, "invalid_params")
}

// ---------- Malware ----------

func sum(b string) string {
	s := sha256.Sum256([]byte(b))
	return hex.EncodeToString(s[:])
}

func TestMalwareScanQuarantineRestore(t *testing.T) {
	e := dataEnv(t)
	root := mustPath(t, e.fs, "/")
	pub := "/home/anphat/sites/anphat.vn/public"
	eicar := ops.EicarSignature + "\n"
	shell := "<?php eval(base64_decode('ZWNobyAxOw==')); ?>\n"
	write(t, root, pub+"/eicar.com", eicar)
	write(t, root, pub+"/wp-content/uploads/x.php", shell)
	write(t, root, pub+"/index.php", "<?php echo 'ok';\n")
	// Symlink tới file hệ thống: engine giả không theo; helper cũng không mở.
	write(t, root, "/etc/shadow-test", ops.EicarSignature)
	if err := os.Symlink(filepath.Join(root, "/etc/shadow-test"), filepath.Join(root, pub, "link.txt")); err != nil {
		t.Fatal(err)
	}
	scan := map[string]any{"account": acct(), "scan_uuid": "01938a20-0001-7000-8000-000020000001", "target": "sites/anphat.vn/public",
		"engines": []string{"clamav", "yara"}, "max_file_mb": 64}
	e.fake.Reset()
	d := e.h.OK(contracts.OpMalwareScan, scan)
	fs := d["findings"].([]any)
	if len(fs) != 2 || d["files_scanned"].(float64) != 3 {
		t.Fatalf("muốn 2 phát hiện / 3 file: %v", d)
	}
	f0, f1 := fs[0].(map[string]any), fs[1].(map[string]any)
	if f0["path"] != "sites/anphat.vn/public/eicar.com" || f0["engine"] != "clamav" || f0["sha256"] != sum(eicar) ||
		f1["path"] != "sites/anphat.vn/public/wp-content/uploads/x.php" || f1["engine"] != "yara" || f1["signature"] != "ITSO_PHP_Eval_Base64" {
		t.Fatal(fs)
	}
	lines := strings.Join(e.fake.Lines(), "\n")
	for _, want := range []string{
		"systemd-run --wait --pipe --collect --quiet --unit=itso-scan-01938a20-0001-7000-8000-000020000001-clamav --uid=20001 --gid=20001 " +
			"--slice=itso-acct-20001.slice --working-directory=/home/anphat -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=50%",
		ops.ClamdscanBin + " --fdpass --infected /home/anphat/sites/anphat.vn/public",
		ops.YaraBin + " -r -w -N -z 67108864 " + ops.YaraRules + " /home/anphat/sites/anphat.vn/public",
	} {
		if !strings.Contains(lines, want) {
			t.Fatalf("thiếu %q:\n%s", want, lines)
		}
	}
	// Đường dẫn quét traversal bị từ chối.
	bad := map[string]any{}
	for k, v := range scan {
		bad[k] = v
	}
	bad["target"] = "sites/../../root"
	e.h.Fail(contracts.OpMalwareScan, bad, "invalid_params")

	item := "01938a1f-0001-7000-8000-00001f000001"
	q := map[string]any{"account": acct(), "item_uuid": item, "path": "sites/anphat.vn/public/wp-content/uploads/x.php", "expected_sha256": sum(shell)}
	// sha256 lệch (file đổi sau khi quét) → precondition_failed, file giữ nguyên.
	wrong := map[string]any{"account": acct(), "item_uuid": item, "path": q["path"], "expected_sha256": sum("khác")}
	e.h.Fail(contracts.OpMalwareQuarantine, wrong, "precondition_failed")
	if !e.fs.Exists(pub + "/wp-content/uploads/x.php") {
		t.Fatal("không được xóa file khi sha256 lệch")
	}
	// Symlink không được cách ly (helper mở O_NOFOLLOW).
	if res := e.h.Call(contracts.OpMalwareQuarantine, map[string]any{"account": acct(), "item_uuid": "01938a1f-0009-7000-8000-00001f000009",
		"path": "sites/anphat.vn/public/link.txt", "expected_sha256": sum(ops.EicarSignature)}); res.OK || res.Error.Code != "path_outside_home" {
		t.Fatalf("symlink phải bị từ chối: %+v", res.Error)
	}
	d = e.h.OK(contracts.OpMalwareQuarantine, q)
	if d["quarantined"] != true || d["sha256"] != sum(shell) || e.fs.Exists(pub+"/wp-content/uploads/x.php") {
		t.Fatal("cách ly phải chép rồi xóa bản gốc:", d)
	}
	if got := e.file(ops.QuarantineDir + "/" + item + ".bin"); got != shell {
		t.Fatal("bản sao cách ly sai")
	}
	if fi, _ := e.fs.Lstat(ops.QuarantineDir + "/" + item + ".bin"); fi.Mode().Perm() != 0o600 {
		t.Fatal("bản sao cách ly phải 0600:", fi.Mode())
	}
	// Lặp lại: idempotent.
	e.h.OK(contracts.OpMalwareQuarantine, q)
	// Khôi phục khi đã có file cùng tên → không ghi đè.
	write(t, root, pub+"/wp-content/uploads/x.php", "mới\n")
	r := map[string]any{"account": acct(), "item_uuid": item, "original_path": q["path"], "sha256": sum(shell), "overwrite": false}
	e.h.Fail(contracts.OpMalwareRestore, r, "already_exists")
	if e.file(pub+"/wp-content/uploads/x.php") != "mới\n" {
		t.Fatal("không được ghi đè khi overwrite=false")
	}
	// Account khác không lấy được bản cách ly.
	e.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("lehoa", 20002))
	other := map[string]any{"account": ct.Acct("lehoa", 20002), "item_uuid": item, "original_path": "x.php", "sha256": sum(shell), "overwrite": true}
	e.h.Fail(contracts.OpMalwareRestore, other, "precondition_failed")
	r["overwrite"] = true
	if d := e.h.OK(contracts.OpMalwareRestore, r); d["restored"] != true || e.file(pub+"/wp-content/uploads/x.php") != shell {
		t.Fatal("khôi phục overwrite phải trả nội dung gốc:", d)
	}
	if e.fs.Exists(ops.QuarantineDir + "/" + item + ".bin") {
		t.Fatal("khôi phục xong phải xóa bản cách ly")
	}
	e.h.Fail(contracts.OpMalwareRestore, r, "not_found")
	// Xóa (Portal): sha256 phải khớp.
	e.h.Fail(contracts.OpMalwareDelete, map[string]any{"account": acct(), "path": "sites/anphat.vn/public/eicar.com", "expected_sha256": sum("x")}, "precondition_failed")
	if d := e.h.OK(contracts.OpMalwareDelete, map[string]any{"account": acct(), "path": "sites/anphat.vn/public/eicar.com", "expected_sha256": sum(eicar)}); d["deleted"] != true {
		t.Fatal(d)
	}
}

func TestParseScannerOutput(t *testing.T) {
	f, n := ops.ParseClamdscan("/home/a/x.php: Php.Webshell-1 FOUND\n/home/a/b c.txt: Eicar-Test-Signature FOUND\nrác\n\n" +
		"----------- SCAN SUMMARY -----------\nScanned files: 42\nInfected files: 2\n")
	if len(f) != 2 || n != 42 || f[1].Abs != "/home/a/b c.txt" || f[1].Signature != "Eicar-Test-Signature" {
		t.Fatalf("%+v %d", f, n)
	}
	y := ops.ParseYara("ITSO_PHP_Request_Exec /home/a/s.php\nerror scanning /x: could not open file\nRule relative\n")
	if len(y) != 1 || y[0].Signature != "ITSO_PHP_Request_Exec" {
		t.Fatalf("%+v", y)
	}
}

// ---------- FIM + audit ----------

func TestFimBaselineCheck(t *testing.T) {
	e := newEnv(t)
	root := mustPath(t, e.fs, "/")
	write(t, root, "/etc/ssh/sshd_config", "Port 22\n")
	write(t, root, "/etc/sudoers", "root ALL=(ALL) ALL\n")
	write(t, root, "/etc/systemd/system/itso-agent.service", "[Service]\n")
	write(t, root, "/etc/systemd/system/other.service", "[Service]\n")
	write(t, root, "/usr/local/bin/tool", "#!/bin/true\n")
	write(t, root, "/etc/itso/certs/x/fullchain.pem", "cert\n") // bị bỏ qua (agent tự đổi)
	// Chưa có baseline.
	if d := e.h.OK(contracts.OpFimCheck, map[string]any{}); d["baseline_at"] != nil || len(d["changes"].([]any)) != 0 {
		t.Fatal(d)
	}
	b := e.h.OK(contracts.OpFimBaseline, map[string]any{})
	if b["files"].(float64) < 6 {
		t.Fatal(b)
	}
	if fi, _ := e.fs.Lstat(ops.FimBaseline); fi.Mode().Perm() != 0o600 {
		t.Fatal("baseline phải 0600")
	}
	if strings.Contains(e.file(ops.FimBaseline), "other.service") || strings.Contains(e.file(ops.FimBaseline), "fullchain.pem") {
		t.Fatal("chỉ theo dõi itso* trong systemd và bỏ qua thư mục chứng chỉ")
	}
	write(t, root, "/etc/ssh/sshd_config", "Port 2222\n")                  // sửa
	write(t, root, "/usr/local/bin/backdoor", "#!/bin/true\n")             // thêm
	if err := os.Remove(filepath.Join(root, "/etc/sudoers")); err != nil { // xóa
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "/usr/local/bin/tool"), 0o4755); err != nil { // chmod (setuid)
		t.Fatal(err)
	}
	write(t, root, "/etc/itso/certs/x/fullchain.pem", "cert mới\n")
	d := e.h.OK(contracts.OpFimCheck, map[string]any{})
	got := map[string]string{}
	for _, c := range d["changes"].([]any) {
		m := c.(map[string]any)
		got[m["path"].(string)] = m["change"].(string)
	}
	want := map[string]string{"/etc/ssh/sshd_config": "modified", "/usr/local/bin/backdoor": "added", "/etc/sudoers": "removed",
		"/usr/local/bin/tool": "metadata", "/usr/local/bin": "modified"}
	for p, c := range want {
		if p == "/usr/local/bin" {
			continue // mtime thư mục không tính; thư mục chỉ so quyền/chủ
		}
		if got[p] != c {
			t.Fatalf("%s: muốn %s, nhận %q (%v)", p, c, got[p], got)
		}
	}
	if _, has := got["/etc/itso/certs/x/fullchain.pem"]; has {
		t.Fatal("thư mục chứng chỉ phải bị bỏ qua")
	}
	if d["baseline_at"] != ct.Now.UTC().Format(time.RFC3339) {
		t.Fatal(d["baseline_at"])
	}
}

func TestSecurityAudit(t *testing.T) {
	e, _ := secEnv(t)
	root := mustPath(t, e.fs, "/")
	e.fail["sshd -T"] = platform.Result{Stdout: []byte("port 22\npermitrootlogin no\npasswordauthentication no\nmaxauthtries 3\n")}
	write(t, root, "/etc/apt/apt.conf.d/20auto-upgrades", "APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n")
	write(t, root, "/run/reboot-required", "")
	e.fail["apt-get -s"] = platform.Result{Stdout: []byte("Inst libssl3t64 [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-security [amd64])\n" +
		"Inst vim [2:9.1] (2:9.1.1 Ubuntu:24.04/noble-updates [amd64])\n")}
	d := e.h.OK(contracts.OpSecurityAudit, map[string]any{})
	sshd := d["sshd"].(map[string]any)
	if sshd["password_authentication"] != false || sshd["permit_root_login"] != "no" || sshd["max_auth_tries"].(float64) != 3 {
		t.Fatal(sshd)
	}
	up := d["updates"].(map[string]any)
	if up["unattended_upgrades"] != true || up["reboot_required"] != true || up["pending_security"].(float64) != 1 {
		t.Fatal(up)
	}
	if d["firewall"].(map[string]any)["table_present"] != false || d["fim"].(map[string]any)["baseline_present"] != false {
		t.Fatal(d)
	}
	// Sau khi áp dụng tường lửa + baseline.
	e.h.OK(contracts.OpFirewallApply, fwParams(applyA, demoRules()...))
	e.h.OK(contracts.OpFimBaseline, map[string]any{})
	d = e.h.OK(contracts.OpSecurityAudit, map[string]any{})
	fw := d["firewall"].(map[string]any)
	if fw["table_present"] != true || fw["input_policy"] != "drop" || fw["rules"].(float64) < 7 || d["fim"].(map[string]any)["baseline_present"] != true {
		t.Fatal(d)
	}
}
