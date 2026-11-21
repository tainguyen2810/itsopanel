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
	"sort"
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
	// ErrDuplicate: session_uuid đang có phiên sống.
	ErrDuplicate = errors.New("term: session_uuid đã có phiên đang mở")
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
	// Mode: "account" (mặc định) hoặc "root" (Phase 7, ADR 0028).
	Mode string
	// Record: ghi asciicast vào Manager.RecDir (root luôn true; account theo policy record_user).
	Record  bool
	expires time.Time
}

// ModeOf trả mode của phiên ("account" khi để trống).
func (s *Session) ModeOf() string {
	if s.Mode == "" {
		return "account"
	}
	return s.Mode
}

// Live là phiên còn sống (đã cấp ticket chưa ATTACH, hoặc đang mở) cho pty.list.
type Live struct {
	UUID, Mode, User string
	Started          time.Time
	LastInput        time.Time
	Recording        bool
	RecordingBytes   int64
	Attached         bool
}

type live struct {
	s         *Session
	started   time.Time
	lastInput time.Time
	attached  bool
	rec       *Recorder
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
	// RecDir là thư mục bản ghi (/var/lib/itso/recordings); rỗng = không ghi được (phiên Record bị từ chối).
	RecDir string
	// RecLimit (tùy chọn, test) thay RecordLimit.
	RecLimit int64

	mu      sync.Mutex
	tickets map[string]*Session
	open    map[string]int
	lives   map[string]*live
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
	m.initLocked()
	m.purgeLocked()
	if _, dup := m.lives[s.UUID]; dup {
		return "", time.Time{}, ErrDuplicate
	}
	if m.open[s.User] >= MaxPerAccount {
		return "", time.Time{}, ErrLimit
	}
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", time.Time{}, err
	}
	t := base64.RawURLEncoding.EncodeToString(b[:])
	now := m.now()
	s.expires = now.Add(TicketTTL)
	m.tickets[t] = &s
	m.open[s.User]++
	m.lives[s.UUID] = &live{s: &s, started: now, lastInput: now}
	return t, s.expires, nil
}

func (m *Manager) initLocked() {
	if m.tickets == nil {
		m.tickets, m.open, m.lives = map[string]*Session{}, map[string]int{}, map[string]*live{}
	}
}

// Lives liệt kê phiên còn sống (chờ ATTACH hoặc đang mở), sắp theo thời điểm bắt đầu.
func (m *Manager) Lives() []Live {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.initLocked()
	m.purgeLocked()
	out := make([]Live, 0, len(m.lives))
	for _, l := range m.lives {
		v := Live{UUID: l.s.UUID, Mode: l.s.ModeOf(), User: l.s.User, Started: l.started, LastInput: l.lastInput,
			Recording: l.s.Record, Attached: l.attached}
		if l.rec != nil {
			v.RecordingBytes = l.rec.Bytes()
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Started.Before(out[j].Started) })
	return out
}

// Recording cho biết phiên uuid còn đang ghi (bản ghi chưa xong).
func (m *Manager) Recording(uuid string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.lives[uuid]
	return ok && l.s.Record
}

func (m *Manager) touch(uuid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if l, ok := m.lives[uuid]; ok {
		l.lastInput = m.now()
	}
}

func (m *Manager) attach(s *Session, rec *Recorder) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if l, ok := m.lives[s.UUID]; ok {
		l.attached, l.rec = true, rec
	}
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
		delete(m.lives, s.UUID)
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

func (m *Manager) release(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.releaseLocked(s.User)
	delete(m.lives, s.UUID)
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
			delete(m.lives, s.UUID)
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
	defer m.release(s)
	var rec *Recorder
	if s.Record {
		if m.RecDir == "" {
			_, _ = io.WriteString(conn, "ERR record_failed\n")
			return
		}
		r, err := NewRecorder(m.RecDir, s, m.RecLimit, m.Now)
		if err != nil { // phiên phải ghi mà không ghi được → không mở (ADR 0028)
			_, _ = io.WriteString(conn, "ERR record_failed\n")
			m.logf("terminal: không tạo được bản ghi", "session", s.UUID, "err", err)
			return
		}
		rec = r
		defer func() { _ = rec.Close() }()
	}
	m.attach(s, rec)
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
	m.logf("terminal: phiên mở", "session", s.UUID, "user", s.User, "mode", s.ModeOf(), "record", s.Record)
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
			if n > 0 && rec != nil {
				if rerr := rec.Output(buf[:n]); rerr != nil { // vượt giới hạn hoặc lỗi ghi → đóng phiên
					reason <- "limit"
					return
				}
			}
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
			m.touch(s.UUID)
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
