package contracts

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Mọi op đã đặc tả trong catalog phải có struct Params/Result sinh ra (make codegen).
func TestGeneratedTypesCoverCatalog(t *testing.T) {
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for op, e := range s.catalog {
		if e.Status != "specified" {
			continue
		}
		if NewParams(op) == nil {
			t.Errorf("%s: thiếu struct Params — chạy: make codegen", op)
		}
		if NewResult(op) == nil {
			t.Errorf("%s: thiếu struct Result — chạy: make codegen", op)
		}
	}
	if NewParams("khong.ton.tai") != nil || NewResult("khong.ton.tai") != nil {
		t.Error("op lạ phải trả nil")
	}
}

// Envelope mẫu hợp lệ trong contracts phải decode chặt (không trường lạ) vào struct sinh ra,
// và mã hóa lại từ struct vẫn hợp lệ theo envelope.schema.json (omitempty/con trỏ không làm sai dữ liệu).
func TestGeneratedTypesRoundTripExamples(t *testing.T) {
	path := filepath.Join("..", "..", "..", "contracts", "agent-ops", "examples", "envelopes.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skip("không có contracts/ cạnh agent/ (build ngoài monorepo)")
	}
	var file struct {
		Valid []json.RawMessage `json:"valid"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Valid) == 0 {
		t.Fatal("envelopes.json không có mẫu valid")
	}
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for i, raw := range file.Valid {
		var env Envelope
		if err := strictDecode(raw, &env); err != nil {
			t.Errorf("mẫu %d: decode Envelope: %v", i, err)
			continue
		}
		p := NewParams(env.Op)
		if p == nil {
			t.Errorf("mẫu %d (%s): không có struct Params", i, env.Op)
			continue
		}
		pr, _ := json.Marshal(env.Params)
		if err := strictDecode(pr, p); err != nil {
			t.Errorf("mẫu %d (%s): decode Params: %v", i, env.Op, err)
			continue
		}
		// Mã hóa lại params từ struct có type, gắn vào envelope và validate theo schema.
		typed, _ := json.Marshal(p)
		var m map[string]any
		_ = json.Unmarshal(typed, &m)
		env.Params = m
		out, _ := json.Marshal(env)
		v, err := jsonschema.UnmarshalJSON(bytes.NewReader(out))
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Envelope.Validate(v); err != nil {
			t.Errorf("mẫu %d (%s): envelope mã hóa lại không hợp lệ: %v", i, env.Op, err)
		}
	}
}

// Kết quả có type của system.ping phải hợp lệ theo schema kết quả của op.
func TestGeneratedResultValidates(t *testing.T) {
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	sch, err := s.OpResult(OpSystemPing)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(SystemPingResult{Pong: true, AgentVersion: "0.1.0-mock", Mode: "mock"})
	v, _ := jsonschema.UnmarshalJSON(bytes.NewReader(b))
	if err := sch.Validate(v); err != nil {
		t.Fatal(err)
	}
}

func strictDecode(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(v)
}
