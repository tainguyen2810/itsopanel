package term

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"
)

// TicketTTL là hạn của ticket (dùng một lần).
const TicketTTL = 30 * time.Second

// MaxLife là thời gian sống tối đa của một phiên (kể cả khi còn gõ phím); panel dọn bản ghi theo mốc này.
const MaxLife = 12 * time.Hour

// MaxPerAccount là số phiên (đang chờ + đang mở) tối đa mỗi account.
const MaxPerAccount = 2

var (
	// ErrTicket: ticket không tồn tại, sai định dạng hoặc đã dùng.
	ErrTicket = errors.New("term: ticket không hợp lệ hoặc đã dùng")
	// ErrExpired: ticket quá 30 giây.
	ErrExpired = errors.New("term: ticket đã hết hạn")
	// ErrLimit: account đã có đủ phiên.
	ErrLimit = errors.New("term: account đã mở tối đa 2 phiên terminal")
)

var ticketRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// ValidTicket kiểm định dạng ticket (32 byte base64url, không padding).
func ValidTicket(t string) bool { return ticketRe.MatchString(t) }

// Session là phiên được cấp bởi pty.open.
type Session struct {
	UUID     string
	User     string
	UID, GID int
	Home     string
	Cols     int
	Rows     int
	Idle     time.Duration
	expires  time.Time
}

// Proc là tiến trình shell gắn với phiên: đọc = output, ghi = input.
type Proc interface {
	io.ReadWriteCloser
	Resize(cols, rows int) error
	Done() <-chan struct{}
}

// Spawner khởi chạy shell cho phiên (thật: systemd-run --pty trong jail; sandbox: shell giả).
type Spawner func(ctx context.Context, s *Session) (Proc, error)

// Manager giữ ticket và đếm phiên theo account.
type Manager struct {
	Spawn Spawner
	// Stop (tùy chọn) dọn tài nguyên hệ thống khi phiên đóng (systemctl stop unit).
	Stop func(s *Session)
	Now  func() time.Time
	Log  *slog.Logger
	// Life (tùy chọn, test) thay MaxLife.
	Life time.Duration

	mu      sync.Mutex
	tickets map[string]*Session
	open    map[string]int
}

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// Issue cấp ticket ngẫu nhiên 32 byte cho phiên; quá MaxPerAccount → ErrLimit.
func (m *Manager) Issue(s Session) (string, time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.tickets == nil {
		m.tickets, m.open = map[string]*Session{}, map[string]int{}
	}
	m.purgeLocked()
	if m.open[s.User] >= MaxPerAccount {
		return "", time.Time{}, ErrLimit
	}
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", time.Time{}, err
	}
	t := base64.RawURLEncoding.EncodeToString(b[:])
	s.expires = m.now().Add(TicketTTL)
	m.tickets[t] = &s
	m.open[s.User]++
	return t, s.expires, nil
}

// Claim đổi ticket lấy phiên và xóa ticket ngay (dùng một lần).
func (m *Manager) Claim(ticket string) (*Session, error) {
	if !ValidTicket(ticket) {
		return nil, ErrTicket
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.tickets[ticket]
	if !ok {
		return nil, ErrTicket
	}
	delete(m.tickets, ticket)
	if m.now().After(s.expires) {
		m.releaseLocked(s.User)
		return nil, ErrExpired
	}
	return s, nil
}

// Open trả số phiên (chờ + mở) của user.
func (m *Manager) Open(user string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeLocked()
	return m.open[user]
}

func (m *Manager) release(user string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.releaseLocked(user)
}

func (m *Manager) releaseLocked(user string) {
	if m.open[user] > 1 {
		m.open[user]--
	} else {
		delete(m.open, user)
	}
}

func (m *Manager) purgeLocked() {
	now := m.now()
	for t, s := range m.tickets {
		if now.After(s.expires) {
			delete(m.tickets, t)
			m.releaseLocked(s.User)
		}
	}
}

func (m *Manager) logf(msg string, args ...any) {
	if m.Log != nil {
		m.Log.Info(msg, args...)
	}
}

// Serve xử lý một kết nối stream: ATTACH → shell → chuyển khung hai chiều; nhàn rỗi quá hạn → đóng.
func (m *Manager) Serve(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := readLine(br)
	if err != nil {
		return
	}
	ticket, ok := strings.CutPrefix(line, "ATTACH ")
	if !ok {
		_, _ = io.WriteString(conn, "ERR bad_request\n")
		return
	}
	s, err := m.Claim(ticket)
	switch {
	case errors.Is(err, ErrExpired):
		_, _ = io.WriteString(conn, "ERR ticket_expired\n")
		return
	case err != nil:
		_, _ = io.WriteString(conn, "ERR ticket_invalid\n")
		return
	}
	defer m.release(s.User)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	p, err := m.Spawn(ctx, s)
	if err != nil {
		_, _ = io.WriteString(conn, "ERR spawn_failed\n")
		m.logf("terminal: không mở được shell", "session", s.UUID, "err", err)
		return
	}
	defer func() {
		_ = p.Close()
		if m.Stop != nil {
			m.Stop(s)
		}
	}()
	_ = conn.SetReadDeadline(time.Time{})
	if _, err := io.WriteString(conn, "OK\n"); err != nil {
		return
	}
	m.logf("terminal: phiên mở", "session", s.UUID, "user", s.User)
	var wmu sync.Mutex
	send := func(typ byte, b []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		return WriteFrame(conn, typ, b)
	}
	reason := make(chan string, 3)
	activity := make(chan struct{}, 1)
	go func() { // shell → client
		buf := make([]byte, 16<<10)
		for {
			n, err := p.Read(buf)
			if n > 0 && send(FrameData, buf[:n]) != nil {
				reason <- "closed"
				return
			}
			if err != nil {
				reason <- "exited"
				return
			}
		}
	}()
	go func() { // client → shell
		for {
			typ, b, err := ReadFrame(br)
			if err != nil {
				reason <- "closed"
				return
			}
			switch typ {
			case FrameData:
				select {
				case activity <- struct{}{}:
				default:
				}
				if _, err := p.Write(b); err != nil {
					reason <- "exited"
					return
				}
			case FrameResize:
				var r Resize
				if json.Unmarshal(b, &r) == nil && r.Valid() {
					_ = p.Resize(r.Cols, r.Rows)
				}
			default:
				reason <- "closed"
				return
			}
		}
	}()
	idle := s.Idle
	if idle <= 0 {
		idle = 15 * time.Minute
	}
	timer := time.NewTimer(idle)
	defer timer.Stop()
	life := m.Life
	if life <= 0 {
		life = MaxLife
	}
	lifeT := time.NewTimer(life)
	defer lifeT.Stop()
	why := ""
	for why == "" {
		select {
		case <-activity:
			if !timer.Stop() {
				<-timer.C
			}
			timer.Reset(idle)
		case <-timer.C:
			why = "idle"
		case <-lifeT.C:
			why = "expired"
		case <-p.Done():
			why = "exited"
		case r := <-reason:
			why = r
		case <-ctx.Done():
			why = "closed"
		}
	}
	_ = send(FrameExit, ExitFrame(why))
	m.logf("terminal: phiên đóng", "session", s.UUID, "reason", why)
}
