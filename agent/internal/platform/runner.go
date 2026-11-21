// Package platform là lớp nền tảng của agent (D-63, ADR 0013): mọi lệnh hệ thống đi qua Runner
// (argv cố định, binary tuyệt đối từ bảng cố định, không shell) và mọi file hệ thống đi qua FS
// (gốc cấu hình được, ghi atomic). Chỉ package này được import os/exec trong agent.
package platform

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

// Bins là bảng tên logic → đường dẫn tuyệt đối trên Ubuntu 24.04. Không có shell, env, sudo, su.
var Bins = map[string]string{
	"useradd":     "/usr/sbin/useradd",
	"usermod":     "/usr/sbin/usermod",
	"userdel":     "/usr/sbin/userdel",
	"groupadd":    "/usr/sbin/groupadd",
	"gpasswd":     "/usr/bin/gpasswd",
	"setfacl":     "/usr/bin/setfacl",
	"getfacl":     "/usr/bin/getfacl",
	"setquota":    "/usr/sbin/setquota",
	"repquota":    "/usr/sbin/repquota",
	"quotaon":     "/usr/sbin/quotaon",
	"quotacheck":  "/usr/sbin/quotacheck",
	"systemctl":   "/usr/bin/systemctl",
	"hostnamectl": "/usr/bin/hostnamectl",
	"apt-get":     "/usr/bin/apt-get",
	"dpkg-query":  "/usr/bin/dpkg-query",
	"shutdown":    "/usr/sbin/shutdown",
	"findmnt":     "/usr/bin/findmnt",
	// Installer / CLI itso (Prompt 4.4).
	"ss":               "/usr/bin/ss",
	"journalctl":       "/usr/bin/journalctl",
	"pg_createcluster": "/usr/bin/pg_createcluster",
	"pg_dropcluster":   "/usr/bin/pg_dropcluster",
	"pg_dump":          "/usr/bin/pg_dump",
	"psql":             "/usr/bin/psql",
	"frankenphp":       "/opt/itso/current/bin/frankenphp",
}

// forbidden là tên không bao giờ được thêm vào Bins (kiểm trong test).
var forbidden = []string{"sh", "bash", "dash", "zsh", "env", "sudo", "su", "busybox", "python3", "perl"}

// Cmd là một lệnh có argv cố định.
type Cmd struct {
	Bin   string   // tên logic trong Bins
	Args  []string // argv (không gồm argv[0])
	Stdin []byte
	// As (tùy chọn): chạy dưới uid/gid này (setresuid trong tiến trình con), không qua su/sudo.
	As *Cred
}

// Cred là uid/gid để hạ quyền tiến trình con.
type Cred struct{ UID, GID uint32 }

func (c Cmd) String() string {
	s := strings.Join(append([]string{c.Bin}, c.Args...), " ")
	if c.As != nil {
		s = fmt.Sprintf("[uid=%d] %s", c.As.UID, s)
	}
	return s
}

// Result là kết quả chạy lệnh.
type Result struct {
	ExitCode int
	Stdout   []byte
	Stderr   []byte
}

// ErrBinNotAllowed khi tên lệnh không có trong bảng.
var ErrBinNotAllowed = errors.New("platform: lệnh không có trong bảng cho phép")

// Runner chạy lệnh hệ thống.
type Runner interface {
	Run(ctx context.Context, c Cmd) (Result, error)
}

// Check kiểm Cmd trước khi chạy: bin trong bảng, argv không có NUL/xuống dòng.
func Check(c Cmd) (string, error) {
	path, ok := Bins[c.Bin]
	if !ok {
		return "", fmt.Errorf("%w: %q", ErrBinNotAllowed, c.Bin)
	}
	for _, a := range c.Args {
		if strings.ContainsAny(a, "\x00\n\r") {
			return "", fmt.Errorf("platform: argv chứa ký tự cấm: %q", a)
		}
	}
	return path, nil
}

const maxOutput = 1 << 20

type capped struct{ bytes.Buffer }

func (c *capped) Write(p []byte) (int, error) {
	if room := maxOutput - c.Len(); room > 0 {
		if len(p) > room {
			_, _ = c.Buffer.Write(p[:room])
		} else {
			_, _ = c.Buffer.Write(p)
		}
	}
	return len(p), nil
}

// ExecRunner chạy lệnh thật (máy Ubuntu 24.04).
type ExecRunner struct{}

// Run chạy argv trực tiếp (không shell), env tối giản, output tối đa 1 MiB mỗi luồng.
func (ExecRunner) Run(ctx context.Context, c Cmd) (Result, error) {
	path, err := Check(c)
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	cmd := exec.CommandContext(ctx, path, c.Args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "DEBIAN_FRONTEND=noninteractive"}
	cmd.Dir = "/"
	if c.As != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: c.As.UID, Gid: c.As.GID, NoSetGroups: true}}
	}
	var out, errb capped
	cmd.Stdout, cmd.Stderr = &out, &errb
	if c.Stdin != nil {
		cmd.Stdin = bytes.NewReader(c.Stdin)
	}
	err = cmd.Run()
	res := Result{Stdout: out.Bytes(), Stderr: errb.Bytes()}
	var ee *exec.ExitError
	switch {
	case err == nil:
		return res, nil
	case errors.As(err, &ee):
		res.ExitCode = ee.ExitCode()
		return res, nil // exit code ≠ 0 không phải lỗi Go; handler quyết định
	default:
		res.ExitCode = -1
		return res, err
	}
}
