// Package ops là handler THẬT của agent cho các op Phase 4. Mọi lệnh hệ thống đi qua platform.Runner,
// mọi file hệ thống qua platform.FS (D-63); tham số được kiểm lại bằng internal/validate.
package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"itso.local/agent/internal/audit"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// Version là phiên bản agent thật (ghi đè bằng -ldflags khi build release).
var Version = "0.4.0-dev"

// Deps là phụ thuộc của handler.
type Deps struct {
	Run       platform.Runner
	FS        *platform.FS
	AuditPath string
	Sandbox   bool
	// HomeMount là mount point chứa /home (cho quota); rỗng = tự phát hiện.
	HomeMount string
}

// Register đăng ký các op đã hiện thực.
func Register(r *registry.Registry, d *Deps) error {
	handlers := map[string]registry.Handler{
		contracts.OpSystemPing: d.ping,
		contracts.OpAuditTail:  d.auditTail,
	}
	for op, h := range extraHandlers(d) {
		handlers[op] = h
	}
	for op, h := range handlers {
		if err := r.Register(op, h); err != nil {
			return err
		}
	}
	return nil
}

// extraHandlers được các file khác của package bổ sung (op Phase 4.3).
var extraRegistrations []func(d *Deps) map[string]registry.Handler

func extraHandlers(d *Deps) map[string]registry.Handler {
	out := map[string]registry.Handler{}
	for _, f := range extraRegistrations {
		for k, v := range f(d) {
			out[k] = v
		}
	}
	return out
}

func (d *Deps) ping(context.Context, *envelope.Envelope) (map[string]any, error) {
	mode := "real"
	if d.Sandbox {
		mode = "sandbox"
	}
	return toData(contracts.SystemPingResult{Pong: true, AgentVersion: Version, Mode: mode})
}

func (d *Deps) auditTail(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.AuditTailParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	entries, v, err := audit.Tail(d.AuditPath, p.AfterSeq, int(p.Limit))
	if err != nil {
		return nil, &registry.OpError{Code: "internal", Message: "đọc audit cục bộ lỗi", Retryable: true}
	}
	out := contracts.AuditTailResult{ChainOK: v.OK, LastSeq: v.LastSeq, Entries: []contracts.AuditTailResultEntriesItem{}}
	for _, e := range entries {
		out.Entries = append(out.Entries, contracts.AuditTailResultEntriesItem{Seq: e.Seq, Ts: e.TS, Op: e.Op, OpID: e.OpID,
			CallerUID: int64(e.CallerUID), Result: e.Result, ErrorCode: e.ErrorCode, ParamsHash: contracts.SHA256(e.ParamsHash),
			PrevHash: contracts.SHA256(e.PrevHash), Hash: contracts.SHA256(e.Hash)})
	}
	return toData(out)
}

// decode đọc params (đã qua schema) vào struct, không nhận trường lạ.
func decode(env *envelope.Envelope, v any) error {
	dec := json.NewDecoder(bytes.NewReader(env.Params))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return &registry.OpError{Code: "invalid_params", Message: err.Error()}
	}
	return nil
}

// opErr đổi lỗi validate thành OpError.
func opErr(err error) error {
	var ve *validate.Error
	if errors.As(err, &ve) {
		return &registry.OpError{Code: ve.Code, Message: ve.Field + ": " + ve.Msg}
	}
	var oe *registry.OpError
	if errors.As(err, &oe) {
		return oe
	}
	return &registry.OpError{Code: "internal", Message: err.Error(), Retryable: true}
}

func toData(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	return m, json.Unmarshal(b, &m)
}
