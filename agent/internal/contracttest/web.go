package contracttest

import (
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
)

// FailDomainPrefix: domain làm nginx -t (mô phỏng) thất bại — mock và Sim của agent thật dùng chung.
const FailDomainPrefix = "nginx-test-fail."

const (
	webWS   = "01938a06-0002-7000-8000-000006000002"
	webCert = "01938a0c-0001-7000-8000-00000c000001"
)

// WebsiteLifecycle (Prompt 5.2): PHP → bố cục site → pool → vhost (idempotent, rollback nginx -t) → chứng chỉ →
// vhost TLS → xóa theo thứ tự ngược. Chạy chung cho mock và agent thật.
func WebsiteLifecycle(t *testing.T, h *Harness) {
	t.Helper()
	acct := Acct("lehoa", 20001)
	h.OK(contracts.OpAccountEnsure, EnsureParams("lehoa", 20001))
	h.OK(contracts.OpPHPVersionInstall, map[string]any{"version": "8.3", "extensions": []any{"intl"}})
	h.Fail(contracts.OpPHPVersionInstall, map[string]any{"version": "7.4", "extensions": []any{}}, "precondition_failed")
	if d := h.OK(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": acct, "site_dir": "lehoa.vn"}); d["path"] != "/home/lehoa/sites/lehoa.vn" {
		t.Fatal(d)
	}
	h.Fail(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": Acct("khac", 20002), "site_dir": "khac.vn"}, "not_found")
	pool := map[string]any{"account": acct, "website_uuid": webWS, "site_dir": "lehoa.vn", "version": "8.3", "pm_max_children": 4,
		"memory_limit": "128m", "max_execution_time": 30, "upload_max_filesize": "16m", "disable_functions": []any{"exec"}}
	if d := h.OK(contracts.OpPHPPoolApply, pool); d["socket"] != "/run/itso/php/lehoa-01938a06.sock" || d["unit"] != "itso-php@8.3-lehoa.service" {
		t.Fatal(d)
	}
	if d := h.OK(contracts.OpPHPPoolApply, pool); d["changed"] != false {
		t.Fatalf("pool lặp lại phải changed=false: %v", d)
	}
	vh := map[string]any{"account": acct, "website_uuid": webWS, "site_dir": "lehoa.vn", "type": "php",
		"server_names": []any{"lehoa.vn"}, "redirect_names": []any{"www.lehoa.vn"}, "document_root": "public"}
	if d := h.OK(contracts.OpNginxVhostApply, vh); d["changed"] != true || d["nginx_test"] != "ok" {
		t.Fatal(d)
	}
	if d := h.OK(contracts.OpNginxVhostApply, vh); d["changed"] != false || d["reloaded"] != false {
		t.Fatalf("vhost lặp lại phải changed=false: %v", d)
	}
	ins := h.OK(contracts.OpNginxVhostInspect, map[string]any{"website_uuid": webWS})
	if ins["exists"] != true || !strings.Contains(ins["config"].(string), "server_name lehoa.vn;") {
		t.Fatal(ins)
	}
	// nginx -t lỗi → config_test_failed, bản cũ giữ nguyên.
	bad := map[string]any{}
	for k, v := range vh {
		bad[k] = v
	}
	bad["server_names"] = []any{"lehoa.vn", FailDomainPrefix + "lehoa.vn"}
	h.Fail(contracts.OpNginxVhostApply, bad, "config_test_failed")
	if again := h.OK(contracts.OpNginxVhostInspect, map[string]any{"website_uuid": webWS}); again["sha256"] != ins["sha256"] {
		t.Fatal("vhost phải được khôi phục bản cũ")
	}
	// Chứng chỉ → vhost TLS; chứng chỉ đang dùng không xóa được.
	issue := map[string]any{"account": acct, "website_uuid": webWS, "cert_uuid": webCert, "site_dir": "lehoa.vn",
		"domains": []any{"lehoa.vn", "www.lehoa.vn"}, "challenge": "http-01", "email": "it@lehoa.vn", "directory": "letsencrypt-staging", "renew": false}
	if c := h.OK(contracts.OpCertIssue, issue); c["cert_uuid"] != webCert || len(c["domains"].([]any)) != 2 {
		t.Fatal(c)
	}
	h.Fail(contracts.OpCertIssue, func() map[string]any { issue["directory"] = "pebble"; return issue }(), "precondition_failed")
	vh["tls"] = map[string]any{"cert_uuid": webCert, "hsts": true, "force_https": true}
	h.OK(contracts.OpNginxVhostApply, vh)
	if c := h.OK(contracts.OpCertInspect, map[string]any{"cert_uuid": webCert}); c["exists"] != true {
		t.Fatal(c)
	}
	h.Fail(contracts.OpCertRemove, map[string]any{"account": acct, "cert_uuid": webCert}, "precondition_failed")
	if d := h.OK(contracts.OpLogTail, map[string]any{"account": acct, "site_dir": "lehoa.vn", "kind": "error", "lines": 50}); d["lines"] == nil {
		t.Fatal(d)
	}
	// Xóa: vhost → pool → chứng chỉ; lần 2 không còn gì.
	if d := h.OK(contracts.OpNginxVhostRemove, map[string]any{"account": acct, "website_uuid": webWS}); d["removed"] != true {
		t.Fatal(d)
	}
	if d := h.OK(contracts.OpNginxVhostRemove, map[string]any{"account": acct, "website_uuid": webWS}); d["removed"] != false {
		t.Fatal(d)
	}
	if d := h.OK(contracts.OpPHPPoolRemove, map[string]any{"account": acct, "website_uuid": webWS}); d["removed"] != true {
		t.Fatal(d)
	}
	if d := h.OK(contracts.OpCertRemove, map[string]any{"account": acct, "cert_uuid": webCert}); d["removed"] != true {
		t.Fatal(d)
	}
	if d := h.OK(contracts.OpNginxVhostInspect, map[string]any{"website_uuid": webWS}); d["exists"] != false {
		t.Fatal(d)
	}
}
