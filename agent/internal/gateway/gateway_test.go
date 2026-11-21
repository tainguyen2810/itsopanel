package gateway_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"itso.local/agent/internal/auth"
	"itso.local/agent/internal/gateway"
	"itso.local/agent/internal/server"
	"itso.local/agent/internal/term"
)

type rig struct {
	m   *term.Manager
	srv *httptest.Server
	now time.Time
}

// newRig: agent giả (Manager + shell giả) trên socket unix thật, peercred cho đúng uid tiến trình test; gateway httptest.
func newRig(t *testing.T, allow auth.UIDAllow) *rig {
	t.Helper()
	r := &rig{now: time.Now()}
	r.m = &term.Manager{Now: func() time.Time { return r.now },
		Spawn: func(_ context.Context, s *term.Session) (term.Proc, error) { return term.NewFakeShell(s), nil }}
	sock := filepath.Join(t.TempDir(), "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = server.ServeStream(ctx, ln, allow, nil, r.m.Serve) }()
	var d net.Dialer
	r.srv = httptest.NewServer(gateway.Handler(gateway.Config{
		Dial: func(ctx context.Context) (net.Conn, error) { return d.DialContext(ctx, "unix", sock) }}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *rig) ticket(t *testing.T) string {
	t.Helper()
	tk, _, err := r.m.Issue(term.Session{UUID: "01938a25-0001-7000-8000-0000000000aa", User: "anphat", UID: 20001, GID: 20001,
		Cols: 80, Rows: 24, Idle: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

func (r *rig) dial(t *testing.T, ticket string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.srv.URL, "http")+"/gateway/terminal?ticket="+ticket, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func readUntil(t *testing.T, c *websocket.Conn, want string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var got strings.Builder
	for !strings.Contains(got.String(), want) {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("đọc: %v (đã nhận %q)", err, got.String())
		}
		got.Write(b)
	}
	return got.String()
}

func closeStatus(t *testing.T, c *websocket.Conn) (websocket.StatusCode, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			var ce websocket.CloseError
			if ok := asClose(err, &ce); ok {
				return ce.Code, ce.Reason
			}
			return websocket.StatusCode(-1), err.Error()
		}
	}
}

func asClose(err error, ce *websocket.CloseError) bool {
	return errors.As(err, ce)
}

func TestGatewayBridgesBothWays(t *testing.T) {
	r := newRig(t, auth.UIDAllow{os.Getuid(): true})
	c := r.dial(t, r.ticket(t))
	readUntil(t, c, "anphat@itso:~$ ")
	ctx := context.Background()
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":132,"rows":40}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, []byte("echo xin chao\r")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, c, "xin chao\r\nanphat@itso:~$ ")
	_ = c.Write(ctx, websocket.MessageBinary, []byte("exit\r"))
	if code, reason := closeStatus(t, c); code != websocket.StatusNormalClosure || reason != "exited" {
		t.Fatal(code, reason)
	}
}

func TestGatewayRejectsReuseExpiredBadOrigin(t *testing.T) {
	r := newRig(t, auth.UIDAllow{os.Getuid(): true})
	tk := r.ticket(t)
	c := r.dial(t, tk)
	readUntil(t, c, "$ ")
	// Dùng lại ticket → 4403.
	c2 := r.dial(t, tk)
	if code, reason := closeStatus(t, c2); code != gateway.CloseTicketInvalid {
		t.Fatal("ticket dùng lại", code, reason)
	}
	_ = c.Close(websocket.StatusNormalClosure, "")
	// Hết hạn → 4410.
	tk2 := r.ticket(t)
	r.now = r.now.Add(time.Minute)
	if code, _ := closeStatus(t, r.dial(t, tk2)); code != gateway.CloseTicketExpired {
		t.Fatal("ticket hết hạn", code)
	}
	// Ticket sai định dạng → 400 trước khi nâng cấp; Origin lạ → 403.
	res, err := http.Get(r.srv.URL + "/gateway/terminal?ticket=abc")
	if err != nil || res.StatusCode != http.StatusBadRequest {
		t.Fatal(res, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{"Origin": []string{"https://evil.example"}}
	if _, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.srv.URL, "http")+"/gateway/terminal?ticket="+r.ticket(t),
		&websocket.DialOptions{HTTPHeader: h}); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatal("Origin lạ phải bị chặn", err)
	}
}

func TestStreamPeercredRejectsOthers(t *testing.T) {
	// Allowlist không có uid của test → agent đóng kết nối, gateway báo attach_failed.
	r := newRig(t, auth.UIDAllow{999999: true})
	if code, reason := closeStatus(t, r.dial(t, r.ticket(t))); code != websocket.StatusInternalError {
		t.Fatal("caller ngoài allowlist phải bị từ chối", code, reason)
	}
}
