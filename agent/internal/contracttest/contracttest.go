// Package contracttest là bộ test contract dùng chung cho mock agent và agent thật (Prompt 4.3):
// cùng envelope, cùng kiểm schema kết quả, cùng hành vi nghiệp vụ (idempotent, mã lỗi).
package contracttest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/registry"
)

// Now là đồng hồ cố định của bộ test.
var Now = time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC)

// Harness gửi envelope tới registry và kiểm kết quả theo schema.
type Harness struct {
	T   testing.TB
	Reg *registry.Registry
	n   int
}

// New tạo harness; registry phải dùng đồng hồ Now (SetClock).
func New(t testing.TB, r *registry.Registry) *Harness {
	r.SetClock(func() time.Time { return Now })
	return &Harness{T: t, Reg: r}
}

// Raw tạo envelope hợp lệ (op_id, nonce mới) để gửi thẳng vào Registry.Handle (test chạy song song).
func (h *Harness) Raw(op string, params map[string]any) (raw []byte, opID string) {
	h.n++
	opID = fmt.Sprintf("0193a000-0000-7000-8000-%012d:1:1", h.n)
	raw, _ = json.Marshal(map[string]any{
		"v": 1, "op": op, "op_id": opID, "params": params,
		"deadline": Now.Add(time.Minute).Format(time.RFC3339), "ts": Now.Unix(),
		"nonce": fmt.Sprintf("nonce-%016d", h.n), "requested_by": map[string]any{"user_uuid": nil, "role": "SYSTEM"},
	})
	return raw, opID
}

// Check kiểm Result theo schema chung + schema kết quả của op.
func (h *Harness) Check(op string, res registry.Result) {
	h.T.Helper()
	s, err := contracts.Load()
	if err != nil {
		h.T.Fatal(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(registry.MarshalResult(res)))
	if err != nil {
		h.T.Fatal(err)
	}
	if err := s.Result.Validate(doc); err != nil {
		h.T.Fatalf("%s: result sai schema: %v", op, err)
	}
	if res.OK {
		sch, err := s.OpResult(op)
		if err != nil {
			h.T.Fatal(err)
		}
		if err := sch.Validate(doc.(map[string]any)["data"]); err != nil {
			h.T.Fatalf("data của %s sai schema: %v", op, err)
		}
	}
}

// Call gửi envelope hợp lệ (op_id, nonce mới) và kiểm result theo schema chung + schema kết quả của op.
func (h *Harness) Call(op string, params map[string]any) registry.Result {
	h.T.Helper()
	raw, _ := h.Raw(op, params)
	res := h.Reg.Handle(context.Background(), raw)
	h.Check(op, res)
	return res
}

// OK gọi op và đòi thành công.
func (h *Harness) OK(op string, params map[string]any) map[string]any {
	h.T.Helper()
	res := h.Call(op, params)
	if !res.OK {
		h.T.Fatalf("%s lỗi: %+v", op, res.Error)
	}
	return res.Data
}

// Fail gọi op và đòi lỗi với mã code.
func (h *Harness) Fail(op string, params map[string]any, code string) registry.Result {
	h.T.Helper()
	res := h.Call(op, params)
	if res.OK || res.Error.Code != code {
		h.T.Fatalf("%s: muốn lỗi %s, nhận %+v", op, code, res)
	}
	return res
}

// Limits mẫu (gói 10 GB, 1 core, 1 GB RAM).
func Limits() map[string]any {
	return map[string]any{"disk_mb": 10240, "inode_limit": 200000, "cpu_percent": 100, "ram_mb": 1024,
		"tasks_max": 256, "io_weight": 100, "io_read_bps": nil, "io_write_bps": nil}
}

// Acct tạo tham số account.
func Acct(user string, uid int) map[string]any { return map[string]any{"username": user, "uid": uid} }

// EnsureParams là tham số account.ensure chuẩn.
func EnsureParams(user string, uid int) map[string]any {
	return map[string]any{"account": Acct(user, uid), "home_path": "/home/" + user, "shell": "/usr/sbin/nologin", "limits": Limits()}
}

// AccountLifecycle: ensure (idempotent, xung đột) → suspend/unsuspend → quota.apply/report.
// Trả usage của quota.report để test riêng kiểm thêm.
func AccountLifecycle(t *testing.T, h *Harness) map[string]any {
	t.Helper()
	if d := h.OK(contracts.OpAccountEnsure, EnsureParams("lehoa", 20001)); d["created"] != true {
		t.Fatalf("lần đầu phải created=true: %v", d)
	}
	if d := h.OK(contracts.OpAccountEnsure, EnsureParams("lehoa", 20001)); d["created"] != false {
		t.Fatalf("ensure lặp lại phải idempotent (created=false): %v", d)
	}
	h.Fail(contracts.OpAccountEnsure, EnsureParams("lehoa", 20002), "already_exists")
	h.Fail(contracts.OpAccountEnsure, EnsureParams("khac", 20001), "already_exists")

	for i := 0; i < 2; i++ { // lặp lại vẫn đúng
		if d := h.OK(contracts.OpAccountSuspend, map[string]any{"account": Acct("lehoa", 20001), "reason": "quá hạn"}); d["suspended"] != true {
			t.Fatal(d)
		}
	}
	for i := 0; i < 2; i++ {
		if d := h.OK(contracts.OpAccountUnsuspend, map[string]any{"account": Acct("lehoa", 20001)}); d["suspended"] != false {
			t.Fatal(d)
		}
	}
	h.Fail(contracts.OpAccountSuspend, map[string]any{"account": Acct("lehoa", 29999), "reason": "x"}, "precondition_failed")
	h.Fail(contracts.OpAccountSuspend, map[string]any{"account": Acct("khongco", 20009), "reason": "x"}, "not_found")

	small := Limits()
	small["disk_mb"] = 2048
	h.OK(contracts.OpQuotaApply, map[string]any{"account": Acct("lehoa", 20001), "limits": small})
	h.Fail(contracts.OpQuotaApply, map[string]any{"account": Acct("khongco", 20009), "limits": small}, "not_found")
	rep := h.OK(contracts.OpQuotaReport, map[string]any{"accounts": []any{Acct("lehoa", 20001), Acct("khongco", 20009)}})
	usage := rep["usage"].([]any)
	if len(usage) != 1 || usage[0].(map[string]any)["username"] != "lehoa" {
		t.Fatalf("report chỉ gồm account có thật: %v", usage)
	}
	u := usage[0].(map[string]any)
	if disk := u["disk_mb"].(float64); disk < 0 || disk > 2048 {
		t.Fatalf("disk_mb phải trong hạn mức mới: %v", disk)
	}
	return u
}

// AccountParamsValidated: tham số xấu bị từ chối với mã lỗi đúng (schema hoặc kiểm lại ở agent).
func AccountParamsValidated(t *testing.T, h *Harness) {
	t.Helper()
	h.Fail(contracts.OpAccountEnsure, EnsureParams("root", 20001), "invalid_params") // tên dành riêng
	h.Fail(contracts.OpAccountEnsure, EnsureParams("lehoa", 1000), "invalid_params") // uid ngoài dải
	bad := EnsureParams("lehoa", 20001)
	bad["home_path"] = "/etc/passwd"
	h.Fail(contracts.OpAccountEnsure, bad, "invalid_params")
	bad = EnsureParams("lehoa", 20001)
	bad["home_path"] = "/home/khac"
	h.Fail(contracts.OpAccountEnsure, bad, "path_outside_home")
	bad = EnsureParams("lehoa", 20001)
	bad["shell"] = "/usr/bin/zsh" // ngoài enum
	h.Fail(contracts.OpAccountEnsure, bad, "invalid_params")
	h.Fail(contracts.OpQuotaApply, map[string]any{"account": Acct("lehoa", 20001), "limits": map[string]any{"disk_mb": 1}}, "invalid_params")
}
