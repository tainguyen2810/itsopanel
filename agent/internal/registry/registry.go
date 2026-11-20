// Package registry ánh xạ op → handler có kiểu. Không có handler nào chạy lệnh
// hệ thống tùy ý; op không đăng ký bị từ chối.
package registry

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
)

// Handler xử lý params đã qua kiểm schema và trả về data (object) hoặc *OpError.
type Handler func(ctx context.Context, env *envelope.Envelope) (map[string]any, error)

// OpError là lỗi nghiệp vụ có mã trong errors.json.
type OpError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *OpError) Error() string { return e.Code + ": " + e.Message }

// ErrorBody là phần error của result.
type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// Result khớp contracts/agent-ops/result.schema.json.
type Result struct {
	V            int            `json:"v"`
	OpID         string         `json:"op_id"`
	OK           bool           `json:"ok"`
	Data         map[string]any `json:"data"`
	Error        *ErrorBody     `json:"error"`
	DurationMS   int64          `json:"duration_ms"`
	AgentVersion string         `json:"agent_version"`
	Cached       bool           `json:"cached,omitempty"`
}

var retryable = map[string]bool{"deadline_exceeded": true, "busy": true, "dependency_unavailable": true}

// Registry giữ handler và cache kết quả theo op_id (idempotent) + nonce đã dùng.
type Registry struct {
	version  string
	handlers map[string]Handler
	now      func() time.Time

	mu     sync.Mutex
	cache  map[string]Result
	nonces map[string]time.Time
}

// New tạo registry rỗng.
func New(version string) *Registry {
	return &Registry{version: version, handlers: map[string]Handler{}, now: time.Now,
		cache: map[string]Result{}, nonces: map[string]time.Time{}}
}

// SetClock thay đồng hồ (test).
func (r *Registry) SetClock(now func() time.Time) { r.now = now }

// Register đăng ký handler; op phải có trong catalog của contracts.
func (r *Registry) Register(op string, h Handler) error {
	s, err := contracts.Load()
	if err != nil {
		return err
	}
	if !s.InCatalog(op) {
		return errors.New("registry: op không có trong catalog: " + op)
	}
	if _, dup := r.handlers[op]; dup {
		return errors.New("registry: op đăng ký trùng: " + op)
	}
	r.handlers[op] = h
	return nil
}

// Ops trả về danh sách op đã đăng ký.
func (r *Registry) Ops() []string {
	out := make([]string, 0, len(r.handlers))
	for op := range r.handlers {
		out = append(out, op)
	}
	return out
}

// Handle phân tích envelope thô và thực thi op. Luôn trả về Result hợp lệ theo schema.
func (r *Registry) Handle(ctx context.Context, raw []byte) Result {
	start := r.now()
	env, err := envelope.Parse(raw, start)
	if err != nil {
		var pe *envelope.Error
		if errors.As(err, &pe) {
			return r.failed(pe.OpID, pe.Code, pe.Message, start)
		}
		return r.failed("", "internal", err.Error(), start)
	}
	h, ok := r.handlers[env.Op]
	if !ok {
		return r.failed(env.OpID, "op_disabled", "agent này không hỗ trợ op "+env.Op, start)
	}

	r.mu.Lock()
	if res, hit := r.cache[env.OpID]; hit {
		r.mu.Unlock()
		res.Cached = true
		return res
	}
	r.gcNonces(start)
	if _, used := r.nonces[env.Nonce]; used {
		r.mu.Unlock()
		return r.failed(env.OpID, "replay_rejected", "nonce đã được dùng", start)
	}
	r.nonces[env.Nonce] = start
	r.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, env.Deadline.Sub(start))
	defer cancel()
	data, err := h(ctx, env)
	var res Result
	switch {
	case err != nil:
		var oe *OpError
		if !errors.As(err, &oe) {
			oe = &OpError{Code: "internal", Message: err.Error()}
		}
		res = r.failed(env.OpID, oe.Code, oe.Message, start)
	case ctx.Err() != nil:
		res = r.failed(env.OpID, "deadline_exceeded", "hết deadline", start)
	default:
		if data == nil {
			data = map[string]any{}
		}
		res = Result{V: 1, OpID: env.OpID, OK: true, Data: data, AgentVersion: r.version, DurationMS: r.since(start)}
	}
	if res.OK || !res.Error.Retryable { // lỗi tạm thời không cache để worker thử lại
		r.mu.Lock()
		r.cache[env.OpID] = res
		r.mu.Unlock()
	}
	return res
}

func (r *Registry) failed(opID, code, msg string, start time.Time) Result {
	return Result{V: 1, OpID: opID, OK: false, Error: &ErrorBody{Code: code, Message: msg, Retryable: retryable[code]},
		AgentVersion: r.version, DurationMS: r.since(start)}
}

func (r *Registry) since(start time.Time) int64 {
	d := r.now().Sub(start).Milliseconds()
	if d < 0 {
		return 0
	}
	return d
}

// gcNonces bỏ nonce cũ hơn 2×MaxSkew (ngoài cửa sổ đó ts đã bị từ chối). Gọi khi giữ mu.
func (r *Registry) gcNonces(now time.Time) {
	for n, t := range r.nonces {
		if now.Sub(t) > 2*envelope.MaxSkew {
			delete(r.nonces, n)
		}
	}
}

// MarshalResult tiện cho server.
func MarshalResult(res Result) []byte {
	b, err := json.Marshal(res)
	if err != nil {
		return []byte(`{"v":1,"op_id":"","ok":false,"error":{"code":"internal","message":"marshal","retryable":false},"duration_ms":0,"agent_version":"unknown"}`)
	}
	return b
}
