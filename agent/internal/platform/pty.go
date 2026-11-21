package platform

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// TTY là tiến trình chạy trên slave của một pseudo-terminal (terminal USER, D-75). Agent đọc/ghi qua Master.
type TTY struct {
	Master *os.File
	cmd    *exec.Cmd
	done   chan struct{}
	once   sync.Once
}

// PTYStarter cấp pty và chạy Cmd với stdio là slave (session leader, controlling tty).
type PTYStarter interface {
	StartPTY(c Cmd, cols, rows int) (*TTY, error)
}

// StartPTY chạy lệnh thật trong pty mới: bin trong bảng (Check), env tối giản, không shell.
func (ExecRunner) StartPTY(c Cmd, cols, rows int) (*TTY, error) {
	path, err := Check(c)
	if err != nil {
		return nil, err
	}
	master, slave, err := openPTY()
	if err != nil {
		return nil, err
	}
	defer slave.Close()
	if err := setWinsize(master, cols, rows); err != nil {
		master.Close()
		return nil, err
	}
	cmd := exec.Command(path, c.Args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "TERM=xterm-256color"}
	cmd.Dir = "/"
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		master.Close()
		return nil, err
	}
	t := &TTY{Master: master, cmd: cmd, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(t.done) }()
	return t, nil
}

// Resize đặt kích thước cửa sổ (kernel gửi SIGWINCH cho nhóm tiến trình tiền cảnh).
func (t *TTY) Resize(cols, rows int) error { return setWinsize(t.Master, cols, rows) }

// Done đóng khi tiến trình kết thúc.
func (t *TTY) Done() <-chan struct{} { return t.done }

// Close giết tiến trình (nếu còn) và đóng master.
func (t *TTY) Close() error {
	t.once.Do(func() {
		if t.cmd != nil && t.cmd.Process != nil {
			select {
			case <-t.done:
			default:
				_ = t.cmd.Process.Signal(syscall.SIGHUP)
				_ = t.cmd.Process.Kill()
			}
		}
		_ = t.Master.Close()
	})
	return nil
}

func openPTY() (*os.File, *os.File, error) {
	fd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("pty: mở /dev/ptmx: %w", err)
	}
	master := os.NewFile(uintptr(fd), "/dev/ptmx")
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("pty: unlockpt: %w", err)
	}
	n, err := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("pty: ptsname: %w", err)
	}
	sfd, err := unix.Open("/dev/pts/"+strconv.Itoa(n), unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("pty: mở slave: %w", err)
	}
	return master, os.NewFile(uintptr(sfd), "/dev/pts/"+strconv.Itoa(n)), nil
}

// ErrWinsize khi kích thước ngoài miền cho phép.
var ErrWinsize = errors.New("pty: kích thước cửa sổ không hợp lệ")

func setWinsize(f *os.File, cols, rows int) error {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return ErrWinsize
	}
	return unix.IoctlSetWinsize(int(f.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
}
