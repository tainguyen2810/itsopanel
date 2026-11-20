// Package envelope phân tích và kiểm tra request gửi tới agent theo
// contracts/agent-ops/envelope.schema.json.
package envelope

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"

	"itso.local/agent/internal/contracts"
)

// MaxBytes là kích thước tối đa của một envelope.
const MaxBytes = 1 << 20

// MaxSkew là độ lệch tối đa giữa ts của envelope và đồng hồ agent.
const MaxSkew = 60 * time.Second

// Envelope là request đã qua kiểm tra schema.
type Envelope struct {
	V           int             `json:"v"`
	Op          string          `json:"op"`
	OpID        string          `json:"op_id"`
	Params      json.RawMessage `json:"params"`
	Deadline    time.Time       `json:"deadline"`
	TS          int64           `json:"ts"`
	Nonce       string          `json:"nonce"`
	DryRun      bool            `json:"dry_run,omitempty"`
	RequestedBy RequestedBy     `json:"requested_by"`
}

// RequestedBy chỉ dùng cho audit.
type RequestedBy struct {
	UserUUID *string `json:"user_uuid"`
	Role     string  `json:"role"`
}

// Error là lỗi phân tích mang mã lỗi trong contracts/agent-ops/errors.json.
type Error struct {
	Code    string
	Message string
	OpID    string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func fail(code, opID, format string, a ...any) *Error {
	return &Error{Code: code, OpID: opID, Message: fmt.Sprintf(format, a...)}
}

// Parse đọc đúng một object JSON, kiểm schema, rồi kiểm ts/deadline theo now.
// Lỗi trả về luôn là *Error.
func Parse(raw []byte, now time.Time) (*Envelope, error) {
	s, err := contracts.Load()
	if err != nil {
		return nil, fail("internal", "", "schema: %v", err)
	}
	if len(raw) > MaxBytes {
		return nil, fail("invalid_envelope", "", "envelope vượt %d byte", MaxBytes)
	}
	doc, err := decodeOne(raw)
	if err != nil {
		return nil, fail("invalid_envelope", "", "JSON không hợp lệ: %v", err)
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return nil, fail("invalid_envelope", "", "envelope phải là object")
	}
	opID, _ := obj["op_id"].(string)
	if len(opID) > 64 {
		opID = ""
	}
	if op, ok := obj["op"].(string); ok && !s.InCatalog(op) {
		return nil, fail("unknown_op", opID, "op %q không có trong catalog", truncate(op, 64))
	}
	if err := s.Envelope.Validate(doc); err != nil {
		code := "invalid_envelope"
		var ve *jsonschema.ValidationError
		if errors.As(err, &ve) && onlyParams(ve) {
			code = "invalid_params"
		}
		return nil, fail(code, opID, "%s", firstLeaf(err))
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fail("invalid_envelope", opID, "%v", err)
	}
	skew := now.Sub(time.Unix(env.TS, 0))
	if skew > MaxSkew || skew < -MaxSkew {
		return nil, fail("replay_rejected", env.OpID, "ts lệch %s so với đồng hồ agent", skew.Round(time.Second))
	}
	if !env.Deadline.After(now) {
		return nil, fail("deadline_exceeded", env.OpID, "deadline %s đã qua", env.Deadline.Format(time.RFC3339))
	}
	return &env, nil
}

func decodeOne(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("dữ liệu thừa sau object")
	}
	// jsonschema cần số dạng json.Number hoặc float64; UnmarshalJSON của thư viện
	// xử lý chuẩn hơn nên dùng lại cho tài liệu đã biết hợp lệ.
	return jsonschema.UnmarshalJSON(bytes.NewReader(raw))
}

// onlyParams: mọi lỗi lá đều nằm dưới /params.
func onlyParams(ve *jsonschema.ValidationError) bool {
	leaves := leafErrors(ve)
	if len(leaves) == 0 {
		return false
	}
	for _, l := range leaves {
		if len(l.InstanceLocation) == 0 || l.InstanceLocation[0] != "params" {
			return false
		}
	}
	return true
}

func leafErrors(ve *jsonschema.ValidationError) []*jsonschema.ValidationError {
	if len(ve.Causes) == 0 {
		return []*jsonschema.ValidationError{ve}
	}
	var out []*jsonschema.ValidationError
	for _, c := range ve.Causes {
		out = append(out, leafErrors(c)...)
	}
	return out
}

func firstLeaf(err error) string {
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		return err.Error()
	}
	l := leafErrors(ve)[0]
	return "/" + strings.Join(l.InstanceLocation, "/") + ": " + l.ErrorKind.LocalizedString(message.NewPrinter(language.English))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
