package registry_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/mock"
	"itso.local/agent/internal/registry"
)

var now = time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC)

func env(op, opID, nonce string, params map[string]any) []byte {
	b, _ := json.Marshal(map[string]any{
		"v": 1, "op": op, "op_id": opID, "params": params,
		"deadline": now.Add(time.Minute).Format(time.RFC3339), "ts": now.Unix(), "nonce": nonce,
		"requested_by": map[string]any{"user_uuid": nil, "role": "SYSTEM"},
	})
	return b
}

func newReg(t *testing.T) *registry.Registry {
	t.Helper()
	r := registry.New(mock.Version)
	r.SetClock(func() time.Time { return now })
	if err := mock.Register(r, now); err != nil {
		t.Fatal(err)
	}
	return r
}

// checkResult kiểm result theo result.schema.json và, nếu ok, theo schema kết quả của op.
func checkResult(t *testing.T, op string, res registry.Result) {
	t.Helper()
	s, err := contracts.Load()
	if err != nil {
		t.Fatal(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(registry.MarshalResult(res)))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Result.Validate(doc); err != nil {
		t.Fatalf("result sai schema: %v", err)
	}
	if res.OK {
		sch, err := s.OpResult(op)
		if err != nil {
			t.Fatal(err)
		}
		if err := sch.Validate(doc.(map[string]any)["data"]); err != nil {
			t.Fatalf("data của %s sai schema: %v", op, err)
		}
	}
}

func TestMockOps(t *testing.T) {
	r := newReg(t)
	for i, op := range []string{"system.ping", "system.info"} {
		res := r.Handle(context.Background(), env(op, "01938a0f-0001-7000-8000-00000f000001:1:"+string(rune('1'+i)), "nonce_aaaaaaaaaaaaaaa"+string(rune('a'+i)), map[string]any{}))
		if !res.OK {
			t.Fatalf("%s: %+v", op, res.Error)
		}
		checkResult(t, op, res)
	}
}

func TestRejects(t *testing.T) {
	cases := []struct {
		name, op, want string
		params         map[string]any
		raw            []byte
	}{
		{name: "op ngoài catalog", op: "shell.exec", want: "unknown_op", params: map[string]any{}},
		{name: "op trong catalog nhưng mock không hỗ trợ", op: "system.reboot", want: "op_disabled", params: map[string]any{"delay_sec": 0, "reason": "test"}},
		{name: "params sai", op: "system.ping", want: "invalid_params", params: map[string]any{"cmd": "rm -rf /"}},
		{name: "envelope sai", want: "invalid_envelope", raw: []byte(`{"v":1,"op":"system.ping"}`)},
		{name: "rác", want: "invalid_envelope", raw: []byte("\x00\xff")},
	}
	r := newReg(t)
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw := c.raw
			if raw == nil {
				raw = env(c.op, "01938a0f-0003-7000-8000-00000f000003:1:"+string(rune('1'+i)), "nonce_bbbbbbbbbbbbbbb"+string(rune('a'+i)), c.params)
			}
			res := r.Handle(context.Background(), raw)
			if res.OK || res.Error == nil || res.Error.Code != c.want {
				t.Fatalf("muốn lỗi %s, có %+v / %+v", c.want, res, res.Error)
			}
			checkResult(t, c.op, res)
		})
	}
}

func TestIdempotentAndReplay(t *testing.T) {
	r := newReg(t)
	id := "01938a0f-0004-7000-8000-00000f000004:1:1"
	first := r.Handle(context.Background(), env("system.ping", id, "nonce_cccccccccccccccc", map[string]any{}))
	again := r.Handle(context.Background(), env("system.ping", id, "nonce_dddddddddddddddd", map[string]any{}))
	if !first.OK || !again.OK || !again.Cached || first.Cached {
		t.Fatalf("muốn cache theo op_id: %+v %+v", first, again)
	}
	replay := r.Handle(context.Background(), env("system.ping", "01938a0f-0004-7000-8000-00000f000004:2:1", "nonce_cccccccccccccccc", map[string]any{}))
	if replay.OK || replay.Error.Code != "replay_rejected" {
		t.Fatalf("muốn replay_rejected: %+v", replay.Error)
	}
}

func TestRegisterRejectsUnknownAndDuplicate(t *testing.T) {
	r := registry.New("test")
	if err := r.Register("shell.exec", nil); err == nil {
		t.Fatal("muốn từ chối op ngoài catalog")
	}
	if err := r.Register("system.ping", nil); err != nil {
		t.Fatal(err)
	}
	if err := r.Register("system.ping", nil); err == nil {
		t.Fatal("muốn từ chối đăng ký trùng")
	}
}
