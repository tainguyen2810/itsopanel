package envelope

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC)

func valid(mut func(m map[string]any)) []byte {
	m := map[string]any{
		"v": 1, "op": "system.ping", "op_id": "01938a0f-0002-7000-8000-00000f000002:1:1",
		"params": map[string]any{}, "deadline": now.Add(time.Minute).Format(time.RFC3339), "ts": now.Unix(),
		"nonce": "n0nce_7Hk2pQ9xVb3mN6tR", "requested_by": map[string]any{"user_uuid": nil, "role": "SYSTEM"},
	}
	if mut != nil {
		mut(m)
	}
	b, _ := json.Marshal(m)
	return b
}

func code(t *testing.T, raw []byte) string {
	t.Helper()
	_, err := Parse(raw, now)
	if err == nil {
		return ""
	}
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("lỗi không phải *Error: %v", err)
	}
	return e.Code
}

func TestParse(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
		want string
	}{
		{"hợp lệ", valid(nil), ""},
		{"op lạ", valid(func(m map[string]any) { m["op"] = "shell.exec" }), "unknown_op"},
		{"op không phải chuỗi", valid(func(m map[string]any) { m["op"] = 5 }), "invalid_envelope"},
		{"thiếu nonce", valid(func(m map[string]any) { delete(m, "nonce") }), "invalid_envelope"},
		{"trường lạ", valid(func(m map[string]any) { m["cmd"] = "id" }), "invalid_envelope"},
		{"v sai", valid(func(m map[string]any) { m["v"] = 2 }), "invalid_envelope"},
		{"op_id sai mẫu", valid(func(m map[string]any) { m["op_id"] = "x" }), "invalid_envelope"},
		{"params thừa trường", valid(func(m map[string]any) { m["params"] = map[string]any{"cmd": "id"} }), "invalid_params"},
		{"deadline sai format", valid(func(m map[string]any) { m["deadline"] = "mai" }), "invalid_envelope"},
		{"ts quá cũ", valid(func(m map[string]any) { m["ts"] = now.Add(-2 * time.Minute).Unix() }), "replay_rejected"},
		{"ts tương lai", valid(func(m map[string]any) { m["ts"] = now.Add(2 * time.Minute).Unix() }), "replay_rejected"},
		{"deadline đã qua", valid(func(m map[string]any) { m["deadline"] = now.Add(-time.Second).Format(time.RFC3339) }), "deadline_exceeded"},
		{"không phải object", []byte(`[1,2]`), "invalid_envelope"},
		{"JSON hỏng", []byte(`{"v":1,`), "invalid_envelope"},
		{"dữ liệu thừa", append(valid(nil), []byte(` {}`)...), "invalid_envelope"},
		{"quá lớn", []byte(`{"pad":"` + strings.Repeat("a", MaxBytes) + `"}`), "invalid_envelope"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := code(t, c.raw); got != c.want {
				t.Fatalf("code = %q, muốn %q", got, c.want)
			}
		})
	}
}

func TestParseKeepsOpIDOnError(t *testing.T) {
	_, err := Parse(valid(func(m map[string]any) { m["params"] = map[string]any{"x": 1} }), now)
	var e *Error
	if !errors.As(err, &e) || e.OpID != "01938a0f-0002-7000-8000-00000f000002:1:1" {
		t.Fatalf("muốn giữ op_id, có %#v", err)
	}
}

func FuzzParse(f *testing.F) {
	f.Add(valid(nil))
	f.Add(valid(func(m map[string]any) { m["op"] = "system.info" }))
	f.Add(valid(func(m map[string]any) { m["params"] = map[string]any{"a": []any{1, "b"}} }))
	f.Add([]byte(`{"v":1,"op":"fs.read","params":{"path":"../../etc/shadow"}}`))
	f.Add([]byte(`null`))
	f.Add([]byte(`{"op":"\u0000"}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		env, err := Parse(raw, now)
		if err != nil {
			var e *Error
			if !errors.As(err, &e) || e.Code == "" {
				t.Fatalf("lỗi không có mã: %v", err)
			}
			return
		}
		if env.V != 1 || env.Op == "" || env.OpID == "" || len(env.Params) == 0 {
			t.Fatalf("envelope hợp lệ nhưng thiếu trường: %+v", env)
		}
	})
}
