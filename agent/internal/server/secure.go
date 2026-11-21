package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"itso.local/agent/internal/audit"
	"itso.local/agent/internal/auth"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

// Config cấu hình handler có xác thực của agent thật.
type Config struct {
	Registry *registry.Registry
	Verifier *auth.Verifier // nil = không kiểm HMAC (chỉ mock/dev)
	Allow    auth.UIDAllow  // rỗng = không kiểm peercred (chỉ dev)
	Audit    *audit.Log     // nil = không ghi audit
	Log      *slog.Logger
	Version  string
}

type head struct {
	Op          string          `json:"op"`
	OpID        string          `json:"op_id"`
	Params      json.RawMessage `json:"params"`
	RequestedBy json.RawMessage `json:"requested_by"`
}

// Secure trả handler POST /v1/ops: peercred → HMAC → registry (policy, schema, idempotent) → audit cục bộ.
// Lỗi xác thực trả HTTP 200 với result ok=false mã unauthorized_caller (không thử lại) để panel ghi lỗi rõ ràng.
func Secure(c Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ops", func(w http.ResponseWriter, req *http.Request) {
		peer := auth.PeerFromContext(req.Context())
		if ct := req.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			http.Error(w, "Content-Type phải là application/json", http.StatusUnsupportedMediaType)
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, envelope.MaxBytes+1))
		if err != nil {
			http.Error(w, "đọc body lỗi", http.StatusBadRequest)
			return
		}
		var h head
		_ = json.Unmarshal(body, &h)
		var res registry.Result
		rejected := false
		switch {
		case !c.Allow.Allowed(peer):
			res, rejected = c.reject(h.OpID, "caller không thuộc allowlist uid"), true
		case c.Verifier != nil:
			if err := c.Verifier.Verify(req, body); err != nil {
				res, rejected = c.reject(h.OpID, "chữ ký HMAC không hợp lệ"), true
				if c.Log != nil {
					c.Log.Warn("từ chối request", "uid", peer.UID, "err", err)
				}
				break
			}
			res = c.Registry.Handle(req.Context(), body)
		default:
			res = c.Registry.Handle(req.Context(), body)
		}
		if c.Audit != nil {
			c.record(h, peer, res, rejected, body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(registry.MarshalResult(res))
	})
	return mux
}

func (c Config) reject(opID, msg string) registry.Result {
	return registry.Result{V: 1, OpID: opID, OK: false, AgentVersion: c.Version,
		Error: &registry.ErrorBody{Code: "unauthorized_caller", Message: msg}}
}

func (c Config) record(h head, peer auth.Peer, res registry.Result, rejected bool, raw []byte) {
	op := h.Op
	if len(op) > 100 {
		op = op[:100]
	}
	result := "ok"
	var code *string
	switch {
	case rejected:
		result = "rejected"
	case !res.OK:
		result = "error"
	}
	if res.Error != nil {
		code = &res.Error.Code
	}
	params := h.Params
	if params == nil {
		params = raw
	}
	var rb json.RawMessage
	if json.Valid(h.RequestedBy) && len(h.RequestedBy) < 512 {
		rb = h.RequestedBy
	}
	uid := -1
	if peer.Known {
		uid = peer.UID
	}
	if res.Cached {
		return // kết quả lấy từ cache theo op_id: đã ghi ở lần chạy đầu
	}
	if _, err := c.Audit.Append(audit.Entry{Op: op, OpID: res.OpID, CallerUID: max(uid, 0), RequestedBy: rb,
		ParamsHash: audit.HashParams(params), Result: result, ErrorCode: code}); err != nil && c.Log != nil {
		c.Log.Error("ghi audit cục bộ lỗi", "err", err)
	}
}
