package mock_test

import (
	"testing"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/mock"
	"itso.local/agent/internal/registry"
)

func newHarness(t *testing.T) *ct.Harness {
	t.Helper()
	r := registry.New(mock.Version)
	if err := mock.Register(r, ct.Now); err != nil {
		t.Fatal(err)
	}
	return ct.New(t, r)
}

// Bộ test contract dùng chung với agent thật (internal/ops), thêm phần riêng của mock (account.remove Phase 8).
func TestAccountLifecycle(t *testing.T) {
	h := newHarness(t)
	u := ct.AccountLifecycle(t, h)
	if u["disk_mb"].(float64) <= 0 {
		t.Fatalf("mock trả mức dùng giả > 0: %v", u)
	}

	rm := map[string]any{"account": ct.Acct("lehoa", 20001), "purge_uuid": "0193a000-0000-7000-8000-000000000001",
		"final_snapshot_id": "abcdef12", "confirm_username": "khac"}
	h.Fail(contracts.OpAccountRemove, rm, "precondition_failed")
	rm["confirm_username"] = "lehoa"
	d := h.OK(contracts.OpAccountRemove, rm)
	if len(d["removed_objects"].([]any)) != 3 {
		t.Fatal(d)
	}
	h.Fail(contracts.OpAccountUnsuspend, map[string]any{"account": ct.Acct("lehoa", 20001)}, "not_found")
}

func TestAccountParamsValidatedBySchema(t *testing.T) {
	ct.AccountParamsValidated(t, newHarness(t))
}

func TestWebsiteLifecycleSharedWithAgent(t *testing.T) {
	ct.WebsiteLifecycle(t, newHarness(t))
}
