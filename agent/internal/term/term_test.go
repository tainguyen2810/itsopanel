package term_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"itso.local/agent/internal/term"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func manager(c *clock) *term.Manager {
	return &term.Manager{Now: c.now, Spawn: func(_ context.Context, s *term.Session) (term.Proc, error) { return term.NewFakeShell(s), nil }}
}

func session(user string) term.Session {
	return term.Session{UUID: "01938a25-0001-7000-8000-0000000000aa", User: user, UID: 20001, GID: 20001, Cols: 80, Rows: 24, Idle: time.Minute}
}

func TestTicketOnceExpiryLimit(t *testing.T) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	m := manager(c)
	t1, exp, err := m.Issue(session("anphat"))
	if err != nil || !term.ValidTicket(t1) || !exp.Equal(c.now().Add(30*time.Second)) {
		t.Fatal(t1, exp, err)
	}
	if _, err := m.Claim(t1); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Claim(t1); !errors.Is(err, term.ErrTicket) {
		t.Fatal("ticket dùng lại phải bị từ chối", err)
	}
	t2, _, _ := m.Issue(session("anphat"))
	if _, _, err := m.Issue(session("anphat")); !errors.Is(err, term.ErrLimit) {
		t.Fatal("phiên thứ 3 phải bị từ chối", err)
	}
	if _, _, err := m.Issue(session("khac")); err != nil {
		t.Fatal("giới hạn tính theo account", err)
	}
	c.add(31 * time.Second)
	if _, err := m.Claim(t2); !errors.Is(err, term.ErrExpired) {
		t.Fatal("ticket quá 30 giây phải hết hạn", err)
	}
	for _, bad := range []string{"", "abc", strings.Repeat("a", 42), strings.Repeat("a", 42) + "/", strings.Repeat("a", 44)} {
		if _, err := m.Claim(bad); !errors.Is(err, term.ErrTicket) {
			t.Fatal(bad, err)
		}
	}
}

func attach(t *testing.T, m *term.Manager, ticket string) (net.Conn, *bufio.Reader, error) {
	t.Helper()
	a, b := net.Pipe()
	go m.Serve(context.Background(), b)
	if err := term.WriteAttach(a, ticket); err != nil {
		return nil, nil, err
	}
	br := bufio.NewReader(a)
	return a, br, term.ReadAttachReply(br)
}

// readUntil gom khung dữ liệu tới khi thấy chuỗi; trả lý do nếu gặp khung Exit.
func readUntil(t *testing.T, br *bufio.Reader, want string) (string, string) {
	t.Helper()
	var got bytes.Buffer
	for !strings.Contains(got.String(), want) {
		typ, b, err := term.ReadFrame(br)
		if err != nil {
			t.Fatalf("đọc khung: %v (đã nhận %q)", err, got.String())
		}
		if typ == term.FrameExit {
			var ex term.Exit
			_ = json.Unmarshal(b, &ex)
			return got.String(), ex.Reason
		}
		got.Write(b)
	}
	return got.String(), ""
}

func TestServeShellRoundTrip(t *testing.T) {
	c := &clock{t: time.Now()}
	m := manager(c)
	tk, _, _ := m.Issue(session("anphat"))
	conn, br, err := attach(t, m, tk)
	if err != nil {
		t.Fatal(err)
	}
	readUntil(t, br, "anphat@itso:~$ ")
	if err := term.WriteFrame(conn, term.FrameData, []byte("whoami\r")); err != nil {
		t.Fatal(err)
	}
	out, _ := readUntil(t, br, "anphat\r\nanphat@itso:~$ ")
	if !strings.Contains(out, "whoami") {
		t.Fatalf("thiếu echo ký tự: %q", out)
	}
	rs, _ := json.Marshal(term.Resize{Cols: 200, Rows: 50})
	_ = term.WriteFrame(conn, term.FrameResize, rs)
	_ = term.WriteFrame(conn, term.FrameData, []byte("exit\r"))
	if _, reason := readUntil(t, br, "\x00never"); reason != "exited" {
		t.Fatal(reason)
	}
	// Ticket đã dùng: ATTACH lần 2 bị từ chối; phiên đã đóng giải phóng chỗ.
	if _, _, err := attach(t, m, tk); err == nil || !strings.Contains(err.Error(), "ticket_invalid") {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if n := m.Open("anphat"); n != 0 {
		t.Fatalf("còn %d phiên sau khi đóng", n)
	}
}

func TestServeIdleAndExpired(t *testing.T) {
	c := &clock{t: time.Now()}
	m := manager(c)
	s := session("anphat")
	s.Idle = 80 * time.Millisecond
	tk, _, _ := m.Issue(s)
	_, br, err := attach(t, m, tk)
	if err != nil {
		t.Fatal(err)
	}
	if _, reason := readUntil(t, br, "\x00never"); reason != "idle" {
		t.Fatal("phải đóng do nhàn rỗi", reason)
	}
	m.Life = 60 * time.Millisecond
	tkl, _, _ := m.Issue(session("anphat"))
	conn, brl, err := attach(t, m, tkl)
	if err != nil {
		t.Fatal(err)
	}
	go func() { // gõ liên tục: vẫn đóng khi hết thời gian sống tối đa
		for i := 0; i < 50; i++ {
			if term.WriteFrame(conn, term.FrameData, []byte("x")) != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	if _, reason := readUntil(t, brl, "\x00never"); reason != "expired" {
		t.Fatal("phải đóng khi quá thời gian sống", reason)
	}
	tk2, _, _ := m.Issue(session("anphat"))
	c.add(time.Minute)
	if _, _, err := attach(t, m, tk2); err == nil || !strings.Contains(err.Error(), "ticket_expired") {
		t.Fatal(err)
	}
}

func TestFrameLimits(t *testing.T) {
	var b bytes.Buffer
	if err := term.WriteFrame(&b, term.FrameData, make([]byte, term.MaxFrame+1)); !errors.Is(err, term.ErrFrame) {
		t.Fatal(err)
	}
	if _, _, err := term.ReadFrame(bytes.NewReader([]byte{9, 0, 0, 0, 0})); !errors.Is(err, term.ErrFrame) {
		t.Fatal("loại khung lạ", err)
	}
	if _, _, err := term.ReadFrame(bytes.NewReader([]byte{0, 0xff, 0xff, 0xff, 0xff})); !errors.Is(err, term.ErrFrame) {
		t.Fatal("khung quá lớn", err)
	}
	if (term.Resize{Cols: 10, Rows: 5}).Valid() || (term.Resize{Cols: 80, Rows: 500}).Valid() {
		t.Fatal("kích thước ngoài miền")
	}
}
