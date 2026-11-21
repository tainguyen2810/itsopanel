package term

import (
	"io"
	"strings"
	"sync"
)

// FakeShell là shell giả trong tiến trình cho agent --sandbox (e2e không cần systemd): prompt user@itso:~$,
// lệnh whoami, pwd, echo, clear, exit. Có echo ký tự như terminal thật.
type FakeShell struct {
	user string
	pr   *io.PipeReader
	pw   *io.PipeWriter
	mu   sync.Mutex
	line []byte
	out  chan string
	done chan struct{}
	once sync.Once
	Cols int
	Rows int
}

// NewFakeShell tạo shell giả cho user.
func NewFakeShell(s *Session) *FakeShell {
	pr, pw := io.Pipe()
	f := &FakeShell{user: s.User, pr: pr, pw: pw, out: make(chan string, 256), done: make(chan struct{}), Cols: s.Cols, Rows: s.Rows}
	go func() { // một goroutine ghi để giữ thứ tự output
		for s := range f.out {
			if _, err := io.WriteString(pw, s); err != nil {
				break
			}
		}
		_ = pw.Close()
	}()
	f.emit("ITSO sandbox: shell giả (không chạy lệnh thật)\r\n" + f.prompt())
	return f
}

func (f *FakeShell) prompt() string {
	if f.user == "root" {
		return "root@itso:~# "
	}
	return f.user + "@itso:~$ "
}

func (f *FakeShell) home() string {
	if f.user == "root" {
		return "/root"
	}
	return "/home/" + f.user
}

// Read trả output.
func (f *FakeShell) Read(b []byte) (int, error) { return f.pr.Read(b) }

// Write nhận input (byte bàn phím).
func (f *FakeShell) Write(b []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.done:
		return 0, io.ErrClosedPipe
	default:
	}
	var out strings.Builder
	for _, c := range b {
		switch {
		case c == '\r' || c == '\n':
			out.WriteString("\r\n")
			res, exit := f.exec(strings.TrimSpace(string(f.line)))
			f.line = f.line[:0]
			out.WriteString(res)
			if exit {
				f.emit(out.String())
				f.closeLocked()
				return len(b), nil
			}
			out.WriteString(f.prompt())
		case c == 0x7f || c == 0x08:
			if len(f.line) > 0 {
				f.line = f.line[:len(f.line)-1]
				out.WriteString("\b \b")
			}
		case c == 0x03:
			f.line = f.line[:0]
			out.WriteString("^C\r\n" + f.prompt())
		case c == 0x04:
			f.emit(out.String())
			f.closeLocked()
			return len(b), nil
		case c >= 0x20 && len(f.line) < 1024:
			f.line = append(f.line, c)
			out.WriteByte(c)
		}
	}
	f.emit(out.String())
	return len(b), nil
}

func (f *FakeShell) exec(cmd string) (string, bool) {
	name, arg, _ := strings.Cut(cmd, " ")
	switch name {
	case "":
		return "", false
	case "whoami":
		return f.user + "\r\n", false
	case "pwd":
		return f.home() + "\r\n", false
	case "echo":
		return arg + "\r\n", false
	case "clear":
		return "\x1b[H\x1b[2J", false
	case "exit", "logout":
		return "logout\r\n", true
	default:
		return name + ": lệnh không có trong shell giả (sandbox)\r\n", false
	}
}

// Resize ghi nhận kích thước.
func (f *FakeShell) Resize(cols, rows int) error {
	f.mu.Lock()
	f.Cols, f.Rows = cols, rows
	f.mu.Unlock()
	return nil
}

// Done đóng khi shell thoát.
func (f *FakeShell) Done() <-chan struct{} { return f.done }

// emit đưa output vào hàng đợi (gọi khi giữ mu hoặc lúc khởi tạo); hàng đầy thì bỏ bớt như terminal bị nghẽn.
func (f *FakeShell) emit(s string) {
	if s == "" {
		return
	}
	select {
	case <-f.done:
		return
	default:
	}
	select {
	case f.out <- s:
	default:
	}
}

func (f *FakeShell) closeLocked() {
	f.once.Do(func() { close(f.done); close(f.out) })
}

// Close kết thúc shell.
func (f *FakeShell) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeLocked()
	_ = f.pr.Close()
	return nil
}
