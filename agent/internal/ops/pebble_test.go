//go:build pebble

package ops_test

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// TestPebbleIssueReal chạy cert.issue/renew/inspect/remove THẬT: lego (gói Ubuntu) ↔ Pebble, ghi /etc/itso trên máy.
// Chỉ chạy trên runner CI / VM dùng một lần, dưới root: tests/vm/pebble/run.sh (build tag `pebble`).
func TestPebbleIssueReal(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Fatal("cần root (chạy qua tests/vm/pebble/run.sh)")
	}
	user := os.Getenv("ITSO_PEBBLE_USER")
	uid, err := strconv.Atoi(os.Getenv("ITSO_PEBBLE_UID"))
	if user == "" || err != nil {
		t.Fatal("thiếu ITSO_PEBBLE_USER / ITSO_PEBBLE_UID")
	}
	d := &ops.Deps{Run: platform.ExecRunner{}, FS: platform.NewFS("/", false), AuditPath: t.TempDir() + "/audit.jsonl", AcmePebble: true}
	r := registry.New(ops.Version)
	if err := ops.Register(r, d); err != nil {
		t.Fatal(err)
	}
	h := ct.New(t, r)
	const certID = "01938a0c-0099-7000-8000-00000c000099"
	acct := ct.Acct(user, uid)
	p := map[string]any{"account": acct, "website_uuid": "01938a06-0099-7000-8000-000006000099", "cert_uuid": certID,
		"site_dir": "pebble.itso.test", "domains": []any{"pebble.itso.test", "www.pebble.itso.test"}, "challenge": "http-01",
		"email": "ci@itso.test", "directory": "pebble", "renew": false}

	got := h.OK(contracts.OpCertIssue, p)
	if got["cert_uuid"] != certID || !strings.Contains(got["issuer"].(string), "Pebble") {
		t.Fatalf("issuer phải là Pebble: %v", got)
	}
	st, err := os.Stat("/etc/itso/certs/" + certID + "/privkey.pem")
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("privkey.pem: %v %v", st, err)
	}
	// Gia hạn khi còn > 30 ngày: lego renew không cấp lại, op vẫn thành công và giữ chứng chỉ.
	p["renew"] = true
	again := h.OK(contracts.OpCertIssue, p)
	if again["not_after"] != got["not_after"] {
		t.Fatalf("renew sớm không được đổi chứng chỉ: %v → %v", got, again)
	}
	if ins := h.OK(contracts.OpCertInspect, map[string]any{"cert_uuid": certID}); ins["exists"] != true {
		t.Fatal(ins)
	}
	// Directory ngoài allowlist vẫn bị chặn trước khi chạy lego.
	p["directory"] = "https://evil.example/dir"
	h.Fail(contracts.OpCertIssue, p, "invalid_params")
	if rm := h.OK(contracts.OpCertRemove, map[string]any{"account": acct, "cert_uuid": certID}); rm["removed"] != true {
		t.Fatal(rm)
	}
	t.Logf("Pebble cấp: %v", got)
}
