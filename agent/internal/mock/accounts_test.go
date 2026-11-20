package mock_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/mock"
	"itso.local/agent/internal/registry"
)

var now = time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC)

type harness struct {
	t   *testing.T
	reg *registry.Registry
	n   int
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	r := registry.New(mock.Version)
	r.SetClock(func() time.Time { return now })
	if err := mock.Register(r, now); err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, reg: r}
}

// call gửi envelope hợp lệ (op_id, nonce mới) và kiểm result theo schema chung + schema kết quả của op.
func (h *harness) call(op string, params map[string]any) registry.Result {
	h.t.Helper()
	h.n++
	b, _ := json.Marshal(map[string]any{
		"v": 1, "op": op, "op_id": fmt.Sprintf("0193a000-0000-7000-8000-%012d:1:1", h.n), "params": params,
		"deadline": now.Add(time.Minute).Format(time.RFC3339), "ts": now.Unix(),
		"nonce": fmt.Sprintf("nonce-%016d", h.n), "requested_by": map[string]any{"user_uuid": nil, "role": "SYSTEM"},
	})
	res := h.reg.Handle(context.Background(), b)
	s, err := contracts.Load()
	if err != nil {
		h.t.Fatal(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(registry.MarshalResult(res)))
	if err != nil {
		h.t.Fatal(err)
	}
	if err := s.Result.Validate(doc); err != nil {
		h.t.Fatalf("%s: result sai schema: %v", op, err)
	}
	if res.OK {
		sch, err := s.OpResult(op)
		if err != nil {
			h.t.Fatal(err)
		}
		if err := sch.Validate(doc.(map[string]any)["data"]); err != nil {
			h.t.Fatalf("data của %s sai schema: %v", op, err)
		}
	}
	return res
}

func (h *harness) mustOK(op string, params map[string]any) map[string]any {
	h.t.Helper()
	res := h.call(op, params)
	if !res.OK {
		h.t.Fatalf("%s lỗi: %+v", op, res.Error)
	}
	return res.Data
}

func (h *harness) mustFail(op string, params map[string]any, code string) {
	h.t.Helper()
	res := h.call(op, params)
	if res.OK || res.Error.Code != code {
		h.t.Fatalf("%s: muốn lỗi %s, nhận %+v", op, code, res)
	}
}

var limits = map[string]any{"disk_mb": 10240, "inode_limit": 200000, "cpu_percent": 100, "ram_mb": 1024,
	"tasks_max": 256, "io_weight": 100, "io_read_bps": nil, "io_write_bps": nil}

func acct(user string, uid int) map[string]any { return map[string]any{"username": user, "uid": uid} }

func ensureParams(user string, uid int) map[string]any {
	return map[string]any{"account": acct(user, uid), "home_path": "/home/" + user, "shell": "/usr/sbin/nologin", "limits": limits}
}

func TestAccountLifecycle(t *testing.T) {
	h := newHarness(t)
	if d := h.mustOK(contracts.OpAccountEnsure, ensureParams("lehoa", 20001)); d["created"] != true {
		t.Fatalf("lần đầu phải created=true: %v", d)
	}
	if d := h.mustOK(contracts.OpAccountEnsure, ensureParams("lehoa", 20001)); d["created"] != false {
		t.Fatalf("ensure lặp lại phải idempotent (created=false): %v", d)
	}
	h.mustFail(contracts.OpAccountEnsure, ensureParams("lehoa", 20002), "already_exists")
	h.mustFail(contracts.OpAccountEnsure, ensureParams("khac", 20001), "already_exists")

	if d := h.mustOK(contracts.OpAccountSuspend, map[string]any{"account": acct("lehoa", 20001), "reason": "quá hạn"}); d["suspended"] != true {
		t.Fatal(d)
	}
	if d := h.mustOK(contracts.OpAccountUnsuspend, map[string]any{"account": acct("lehoa", 20001)}); d["suspended"] != false {
		t.Fatal(d)
	}
	h.mustFail(contracts.OpAccountSuspend, map[string]any{"account": acct("lehoa", 29999), "reason": "x"}, "precondition_failed")
	h.mustFail(contracts.OpAccountSuspend, map[string]any{"account": acct("khongco", 20009), "reason": "x"}, "not_found")

	small := map[string]any{}
	for k, v := range limits {
		small[k] = v
	}
	small["disk_mb"] = 2048
	h.mustOK(contracts.OpQuotaApply, map[string]any{"account": acct("lehoa", 20001), "limits": small})
	rep := h.mustOK(contracts.OpQuotaReport, map[string]any{"accounts": []any{acct("lehoa", 20001), acct("khongco", 20009)}})
	usage := rep["usage"].([]any)
	if len(usage) != 1 {
		t.Fatalf("report chỉ gồm account có thật: %v", usage)
	}
	if disk := usage[0].(map[string]any)["disk_mb"].(float64); disk <= 0 || disk > 2048 {
		t.Fatalf("disk_mb phải trong hạn mức mới: %v", disk)
	}

	rm := map[string]any{"account": acct("lehoa", 20001), "purge_uuid": "0193a000-0000-7000-8000-000000000001",
		"final_snapshot_id": "abcdef12", "confirm_username": "khac"}
	h.mustFail(contracts.OpAccountRemove, rm, "precondition_failed")
	rm["confirm_username"] = "lehoa"
	d := h.mustOK(contracts.OpAccountRemove, rm)
	if len(d["removed_objects"].([]any)) != 3 {
		t.Fatal(d)
	}
	h.mustFail(contracts.OpAccountUnsuspend, map[string]any{"account": acct("lehoa", 20001)}, "not_found")
}

func TestAccountParamsValidatedBySchema(t *testing.T) {
	h := newHarness(t)
	h.mustFail(contracts.OpAccountEnsure, ensureParams("root", 20001), "invalid_params") // tên dành riêng
	h.mustFail(contracts.OpAccountEnsure, ensureParams("lehoa", 1000), "invalid_params") // uid ngoài dải
	bad := ensureParams("lehoa", 20001)
	bad["home_path"] = "/etc/passwd"
	h.mustFail(contracts.OpAccountEnsure, bad, "invalid_params")
	bad = ensureParams("lehoa", 20001)
	bad["home_path"] = "/home/khac"
	h.mustFail(contracts.OpAccountEnsure, bad, "path_outside_home")
	bad = ensureParams("lehoa", 20001)
	bad["shell"] = "/usr/bin/zsh" // ngoài enum
	h.mustFail(contracts.OpAccountEnsure, bad, "invalid_params")
	h.mustFail(contracts.OpQuotaApply, map[string]any{"account": acct("lehoa", 20001), "limits": map[string]any{"disk_mb": 1}}, "invalid_params")
}
