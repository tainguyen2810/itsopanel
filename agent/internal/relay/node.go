package relay

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"itso.local/agent/internal/auth"
)

// Node là phía agent trên máy node: quay số ra relay bằng mTLS, nhận envelope đã ký và phục vụ bằng
// đúng handler POST /v1/ops của agent (HMAC, policy, schema, idempotent op_id, audit cục bộ).
type Node struct {
	RelayURL string       // https://panel:28444
	CertFile string       // chứng chỉ node (đọc lại mỗi lần quay số để hỗ trợ xoay vòng)
	KeyFile  string       // khóa riêng node (0600)
	CAFile   string       // CA nội bộ đã ghim khi join
	Handler  http.Handler // server.Secure(...)
	Log      *slog.Logger
	// MinBackoff/MaxBackoff: mặc định 1s → 60s (có jitter).
	MinBackoff, MaxBackoff time.Duration
	// OnConnected (tùy chọn): gọi mỗi lần kết nối thành công (test).
	OnConnected func()
}

// Run quay số tới relay và giữ kết nối tới khi ctx kết thúc; mất kết nối thì thử lại với backoff.
func (n *Node) Run(ctx context.Context) error {
	minB, maxB := n.MinBackoff, n.MaxBackoff
	if minB <= 0 {
		minB = time.Second
	}
	if maxB <= 0 {
		maxB = 60 * time.Second
	}
	backoff := minB
	for {
		start := time.Now()
		err := n.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Since(start) > 30*time.Second {
			backoff = minB // phiên đã chạy ổn định một lúc → bắt đầu lại từ backoff nhỏ
		}
		wait := backoff/2 + time.Duration(rand.Int64N(int64(backoff/2)+1))
		n.logWarn("mất kết nối relay, thử lại", "err", err, "sau", wait.Round(time.Millisecond))
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return ctx.Err()
		}
		backoff = min(backoff*2, maxB)
	}
}

// TLSConfig dựng cấu hình mTLS: chỉ tin CA đã ghim, TLS 1.3, chứng chỉ client đọc từ đĩa.
func (n *Node) TLSConfig() (*tls.Config, error) {
	caPEM, err := os.ReadFile(n.CAFile)
	if err != nil {
		return nil, fmt.Errorf("CA đã ghim: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("CA đã ghim không hợp lệ")
	}
	cert, err := tls.LoadX509KeyPair(n.CertFile, n.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("chứng chỉ node: %w", err)
	}
	return &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, Certificates: []tls.Certificate{cert}}, nil
}

func (n *Node) session(ctx context.Context) error {
	tc, err := n.TLSConfig()
	if err != nil {
		return err
	}
	u := strings.TrimRight(n.RelayURL, "/") + AgentPath
	hc := &http.Client{Transport: &http.Transport{TLSClientConfig: tc, ForceAttemptHTTP2: false}}
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	c, resp, err := websocket.Dial(dctx, u, &websocket.DialOptions{HTTPClient: hc})
	cancel()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return err
	}
	c.SetReadLimit(MaxEnvelope + 4096)
	sctx, stop := context.WithCancel(ctx)
	defer stop()
	defer c.Close(websocket.StatusNormalClosure, "")
	n.logInfo("đã kết nối relay", "url", u)
	if n.OnConnected != nil {
		n.OnConnected()
	}
	var writeMu sync.Mutex
	write := func(f Frame) error {
		b, _ := f.marshal()
		writeMu.Lock()
		defer writeMu.Unlock()
		wctx, cancel := context.WithTimeout(sctx, 30*time.Second)
		defer cancel()
		return c.Write(wctx, websocket.MessageText, b)
	}
	go func() {
		t := time.NewTicker(HeartbeatSecs * time.Second)
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
				if write(Frame{T: "hb"}) != nil {
					stop()
					return
				}
			}
		}
	}()
	sem := make(chan struct{}, MaxInflight)
	for {
		typ, b, err := c.Read(sctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		var f Frame
		if json.Unmarshal(b, &f) != nil || f.T != "req" || f.ID == "" {
			continue
		}
		sem <- struct{}{}
		go func(f Frame) {
			defer func() { <-sem }()
			out := n.serve(sctx, f)
			_ = write(Frame{T: "res", ID: f.ID, Body: out})
		}(f)
	}
}

// serve dựng request POST /v1/ops trong bộ nhớ với header chữ ký từ panel và chạy qua handler của agent.
func (n *Node) serve(ctx context.Context, f Frame) []byte {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "/v1/ops", bytes.NewReader(f.Body))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderSignature, f.Sig)
	req.Header.Set(auth.HeaderTimestamp, f.TS)
	req.Header.Set(auth.HeaderNonce, f.Nonce)
	rec := httptest.NewRecorder()
	n.Handler.ServeHTTP(rec, req)
	out := rec.Body.Bytes()
	if len(out) > MaxResult {
		out = []byte(`{"v":1,"ok":false,"error":{"code":"internal","message":"kết quả vượt 8 MiB"}}`)
	}
	return out
}

func (n *Node) logInfo(msg string, kv ...any) {
	if n.Log != nil {
		n.Log.Info(msg, kv...)
	}
}

func (n *Node) logWarn(msg string, kv ...any) {
	if n.Log != nil {
		n.Log.Warn(msg, kv...)
	}
}
