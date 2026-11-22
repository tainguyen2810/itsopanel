// Package ops là handler THẬT của agent cho các op Phase 4. Mọi lệnh hệ thống đi qua platform.Runner,
// mọi file hệ thống qua platform.FS (D-63); tham số được kiểm lại bằng internal/validate.
package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"itso.local/agent/internal/audit"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/term"
	"itso.local/agent/internal/validate"
)

// Version là phiên bản agent thật (ghi đè bằng -ldflags khi build release).
var Version = "0.1.0-alpha"

// Deps là phụ thuộc của handler.
type Deps struct {
	Run platform.Runner
	// FS: file hệ thống được GHI (/etc, /home…). Sandbox/test: thư mục tạm.
	FS *platform.FS
	// Host: chỉ ĐỌC /proc, /sys (số liệu máy). Nil = dùng FS.
	Host      *platform.FS
	AuditPath string
	Sandbox   bool
	// HomeMount là mount point chứa /home (cho quota); rỗng = tự phát hiện bằng findmnt.
	HomeMount string
	// Now (tùy chọn) cho test; CPUSample là khoảng lấy mẫu /proc/stat của metrics.snapshot.
	Now       func() time.Time
	CPUSample time.Duration
	// AcmePebble: policy cục bộ cho phép directory ACME "pebble" (D-69).
	AcmePebble bool
	// Term: phiên terminal USER (pty.open cấp ticket, socket stream ATTACH). Nil = chưa bật.
	Term *term.Manager
	// RootTerminal / RecordUser: policy cục bộ (agent-policy.yaml root_terminal, record_user; ADR 0028).
	// Handler pty.open.root kiểm lại RootTerminal dù registry đã chặn op khi policy tắt.
	RootTerminal bool
	RecordUser   bool
	// NodeMode: agent chạy trên node (Phase 9, D-88): nhận op qua relay, chặn pki.sign_csr.
	NodeMode bool
	// HTTPAddrs (tùy chọn, test): địa chỉ http.check gọi theo scheme; mặc định 127.0.0.1:80 / 127.0.0.1:443.
	HTTPAddrs map[string]string
	// Fetch (tùy chọn, test): tải tệp HTTPS có hash ghim (wp-cli). Nil = net/http.
	Fetch func(ctx context.Context, url string, limit int64) ([]byte, error)
	// Docker: client Engine API (máy thật: unix socket; sandbox/test: docker.Fake). Nil = docker chưa cấu hình.
	Docker docker.Engine
	// DockerPoll: chu kỳ kiểm health khi cập nhật image (mặc định 2s; test đặt nhỏ).
	DockerPoll time.Duration

	mu       sync.Mutex
	inflight map[string]context.CancelFunc
	// rates: mốc bộ đếm cho tốc độ IO/network/CPU slice (Phase 11), khóa bởi mu.
	rates map[string]rateState
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *Deps) host() *platform.FS {
	if d.Host != nil {
		return d.Host
	}
	return d.FS
}

// Register đăng ký các op đã hiện thực. Mọi handler (trừ op.cancel) được bọc để op.cancel hủy được.
func Register(r *registry.Registry, d *Deps) error {
	handlers := map[string]registry.Handler{
		contracts.OpSystemPing: d.ping,
		contracts.OpAuditTail:  d.auditTail,
	}
	for op, h := range extraHandlers(d) {
		handlers[op] = d.cancellable(h)
	}
	handlers[contracts.OpOpCancel] = d.opCancel
	for op, h := range handlers {
		if err := r.Register(op, h); err != nil {
			return err
		}
	}
	return nil
}

// cancellable ghi nhận op đang chạy theo op_id; op bị op.cancel hủy trả lỗi cancelled.
func (d *Deps) cancellable(h registry.Handler) registry.Handler {
	return func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
		ctx, cancel := context.WithCancelCause(ctx)
		d.mu.Lock()
		if d.inflight == nil {
			d.inflight = map[string]context.CancelFunc{}
		}
		d.inflight[env.OpID] = func() { cancel(errCancelled) }
		d.mu.Unlock()
		defer func() {
			d.mu.Lock()
			delete(d.inflight, env.OpID)
			d.mu.Unlock()
			cancel(nil)
		}()
		data, err := h(ctx, env)
		if errors.Is(context.Cause(ctx), errCancelled) {
			return nil, &registry.OpError{Code: "cancelled", Message: "op bị hủy bởi op.cancel"}
		}
		return data, err
	}
}

var errCancelled = errors.New("cancelled by op.cancel")

func (d *Deps) opCancel(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.OpCancelParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	d.mu.Lock()
	c, ok := d.inflight[p.OpID]
	d.mu.Unlock()
	if ok {
		c()
	}
	return toData(contracts.OpCancelResult{Cancelled: ok})
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
	if err := d.offlineErr(); err != nil {
		return nil, err
	}
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

// Phase6Ops là các op dữ liệu hosting (D-71…D-74) — mock agent dùng lại đúng handler thật trên sandbox.
func Phase6Ops(d *Deps) map[string]registry.Handler {
	out := map[string]registry.Handler{}
	for k, v := range extraHandlers(d) {
		for _, p := range []string{"fs.", "db.", "sshd.", "sftp.", "ftp.", "ssh.keys.", "cron.", "pty."} {
			if strings.HasPrefix(k, p) && k != contracts.OpFsSiteLayoutEnsure {
				out[k] = v
			}
		}
	}
	return out
}
