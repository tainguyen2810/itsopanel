// Package gateway là itso-gateway (D-75): WebSocket /gateway/terminal?ticket=… ↔ socket stream của agent.
// Gateway không đọc DB và không quyết định quyền: ticket do agent cấp (qua panel, sau step-up), agent kiểm khi ATTACH.
package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"itso.local/agent/internal/term"
)

// Mã đóng WebSocket (4xxx: ứng dụng) để UI hiện lý do.
const (
	CloseTicketInvalid websocket.StatusCode = 4403
	CloseTicketExpired websocket.StatusCode = 4410
	CloseIdle          websocket.StatusCode = 4408
)

// Config của gateway.
type Config struct {
	// Dial mở kết nối tới socket stream của agent.
	Dial func(ctx context.Context) (net.Conn, error)
	// OriginPatterns: Origin được phép ngoài Origin trùng Host (vd. "localhost:5173" khi dev qua Vite).
	OriginPatterns []string
	Log            *slog.Logger
}

// Handler trả mux: GET /gateway/terminal, GET /gateway/healthz.
func Handler(c Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /gateway/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /gateway/terminal", c.terminal)
	return mux
}

func (c Config) logf(msg string, args ...any) {
	if c.Log != nil {
		c.Log.Info(msg, args...)
	}
}

type closeMsg struct {
	code   websocket.StatusCode
	reason string
}

func (c Config) terminal(w http.ResponseWriter, r *http.Request) {
	ticket := r.URL.Query().Get("ticket")
	if !term.ValidTicket(ticket) {
		http.Error(w, "ticket không hợp lệ", http.StatusBadRequest)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: c.OriginPatterns})
	if err != nil {
		return // Accept đã trả lỗi HTTP (Origin sai, không phải upgrade)
	}
	ws.SetReadLimit(term.MaxFrame)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	agent, err := c.Dial(dctx)
	dcancel()
	if err != nil {
		c.logf("gateway: không nối được agent", "err", err)
		_ = ws.Close(websocket.StatusInternalError, "agent_unavailable")
		return
	}
	defer agent.Close()
	_ = agent.SetDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReader(agent)
	err = term.WriteAttach(agent, ticket)
	if err == nil {
		err = term.ReadAttachReply(br)
	}
	if err != nil {
		var ae *term.AttachError
		switch {
		case errors.As(err, &ae) && ae.Code == "ticket_expired":
			_ = ws.Close(CloseTicketExpired, ae.Code)
		case errors.As(err, &ae) && (ae.Code == "ticket_invalid" || ae.Code == "bad_request"):
			_ = ws.Close(CloseTicketInvalid, ae.Code)
		default:
			_ = ws.Close(websocket.StatusInternalError, "attach_failed")
		}
		return
	}
	_ = agent.SetDeadline(time.Time{})

	errc := make(chan error, 2)
	exitc := make(chan closeMsg, 1)
	go func() { // trình duyệt → agent
		for {
			typ, b, err := ws.Read(ctx)
			if err != nil {
				errc <- err
				return
			}
			switch typ {
			case websocket.MessageBinary:
				err = term.WriteFrame(agent, term.FrameData, b)
			case websocket.MessageText:
				var rs term.Resize
				if json.Unmarshal(b, &rs) == nil && rs.Type == "resize" && rs.Valid() {
					p, _ := json.Marshal(term.Resize{Cols: rs.Cols, Rows: rs.Rows})
					err = term.WriteFrame(agent, term.FrameResize, p)
				}
			}
			if err != nil {
				errc <- err
				return
			}
		}
	}()
	go func() { // agent → trình duyệt
		for {
			typ, b, err := term.ReadFrame(br)
			if err != nil {
				errc <- err
				return
			}
			switch typ {
			case term.FrameData:
				if err := ws.Write(ctx, websocket.MessageBinary, b); err != nil {
					errc <- err
					return
				}
			case term.FrameExit:
				var ex term.Exit
				_ = json.Unmarshal(b, &ex)
				code := websocket.StatusNormalClosure
				if ex.Reason == "idle" {
					code = CloseIdle
				}
				exitc <- closeMsg{code, ex.Reason}
				return
			}
		}
	}()
	// Chỉ một lần Close: hai khung close (vd. exit của shell trùng lúc trình duyệt đóng) làm Chrome báo 1006
	// "Close received after close" thay vì lý do thật.
	m := closeMsg{websocket.StatusNormalClosure, "closed"}
	select {
	case m = <-exitc:
	case <-errc:
	}
	_ = ws.Close(m.code, m.reason)
}
