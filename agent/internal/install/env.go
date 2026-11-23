// Package install là logic của CLI `itso` (Prompt 4.4, 10-INSTALLER): preflight, các bước cài có
// checkpoint, update/rollback, repair, uninstall, status/doctor. Mọi lệnh qua platform.Runner,
// mọi file qua platform.FS (gốc thay được → test trên gốc giả với runner giả).
package install

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/platform"
)

// Đường dẫn cố định trên máy cài (10 §4).
const (
	OptDir      = "/opt/itso"
	ReleasesDir = "/opt/itso/releases"
	CurrentLink = "/opt/itso/current"
	EtcDir      = "/etc/itso"
	VarDir      = "/var/lib/itso"
	LogDir      = "/var/log/itso"
	BackupDir   = "/var/backups/itso"
	StateFile   = "/var/lib/itso/install-state.json"
	SetupFile   = "/var/lib/itso/setup-code.json"
	PanelFile   = "/etc/itso/panel.json"
	EnvFile     = "/etc/itso/itso.env"
	AgentKey    = "/etc/itso/agent.key"
	PolicyFile  = "/etc/itso/agent-policy.yaml"
	RedisConf   = "/etc/itso/redis.conf"
	TLSCert     = "/etc/itso/tls/panel.crt"
	TLSKey      = "/etc/itso/tls/panel.key"
	UnitDir     = "/etc/systemd/system"
	AgentSocket = "/run/itso/agent.sock"
	PGPort      = 5433
	KeepRelease = 3
)

// Env là phụ thuộc của mọi lệnh CLI.
type Env struct {
	Run platform.Runner
	// FS: hệ thống file được ghi (máy thật "/", test: thư mục tạm).
	FS *platform.FS
	// Host: chỉ đọc /proc, /sys, /etc/os-release (preflight).
	Host *platform.FS
	Out  io.Writer
	Now  func() time.Time
	Rand io.Reader
	// PubKey là khóa công khai Ed25519 kiểm chữ ký manifest release.
	PubKey ed25519.PublicKey
	// Arch (test) thay runtime.GOARCH.
	Arch string
	// HealthWait: số lần kiểm sức khỏe sau update (mỗi lần cách HealthDelay).
	HealthTries int
	HealthDelay time.Duration
	// HTTP (test) dựng client HTTPS cho join node; mặc định http.Client thường với cấu hình TLS cho trước.
	HTTP func(*tls.Config) *http.Client
	// AfterStep (test) được gọi sau mỗi bước journal cập nhật; trả lỗi = giả lập tiến trình chết ngay sau bước đó.
	AfterStep func(step string) error
	// IP trả địa chỉ in trong URL (mặc định: IPv4 đầu tiên không phải loopback).
	IP func() string
}

func (e *Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Env) rand() io.Reader {
	if e.Rand != nil {
		return e.Rand
	}
	return rand.Reader
}

func (e *Env) arch() string {
	if e.Arch != "" {
		return e.Arch
	}
	return runtime.GOARCH
}

func (e *Env) host() *platform.FS {
	if e.Host != nil {
		return e.Host
	}
	return e.FS
}

func (e *Env) printf(format string, a ...any) {
	if e.Out != nil {
		fmt.Fprintf(e.Out, format, a...)
	}
}

// run chạy lệnh; exit ≠ 0 → lỗi có stderr.
func (e *Env) run(ctx context.Context, c platform.Cmd) (platform.Result, error) {
	res, err := e.Run.Run(ctx, c)
	if err != nil {
		return res, fmt.Errorf("%s: %w", c.Bin, err)
	}
	if res.ExitCode != 0 {
		msg := strings.TrimSpace(string(res.Stderr))
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return res, fmt.Errorf("%s thoát mã %d: %s", c.String(), res.ExitCode, msg)
	}
	return res, nil
}

func (e *Env) cmd(ctx context.Context, bin string, args ...string) (platform.Result, error) {
	return e.run(ctx, platform.Cmd{Bin: bin, Args: args})
}

// try chạy lệnh và chỉ trả kết quả (exit ≠ 0 không phải lỗi).
func (e *Env) try(ctx context.Context, bin string, args ...string) platform.Result {
	res, err := e.Run.Run(ctx, platform.Cmd{Bin: bin, Args: args})
	if err != nil {
		return platform.Result{ExitCode: -1, Stderr: []byte(err.Error())}
	}
	return res
}

func (e *Env) readFile(p string) string {
	b, err := e.FS.ReadFile(p)
	if err != nil {
		return ""
	}
	return string(b)
}

func (e *Env) readJSON(p string, v any) (bool, error) {
	b, err := e.FS.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(b, v)
}

func (e *Env) writeJSON(p string, v any, mode fs.FileMode, owner platform.Owner) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := e.FS.MkdirAll(dirOf(p)); err != nil {
		return err
	}
	_, err = e.FS.WriteAtomic(p, append(b, '\n'), mode, owner)
	return err
}

func dirOf(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "/"
	}
	return p[:i]
}

// lookupID trả uid (passwd) hoặc gid (group) theo tên từ FS.
func (e *Env) lookupID(file, name string) (int, bool) {
	for _, l := range strings.Split(e.readFile(file), "\n") {
		f := strings.Split(l, ":")
		if len(f) >= 4 && f[0] == name {
			n, err := strconv.Atoi(f[2])
			return n, err == nil
		}
	}
	return 0, false
}

func (e *Env) uid(name string) (int, bool) { return e.lookupID("/etc/passwd", name) }
func (e *Env) gid(name string) (int, bool) { return e.lookupID("/etc/group", name) }

// owner trả Owner root:<group> (group chưa có → root:root).
func (e *Env) rootGroup(group string) platform.Owner {
	g, _ := e.gid(group)
	return platform.Owner{UID: 0, GID: g}
}

// userOwner trả uid:gid của user hệ thống name (không có → root).
func (e *Env) userOwner(name string) platform.Owner {
	u, _ := e.uid(name)
	g, _ := e.gid(name)
	return platform.Owner{UID: u, GID: g}
}

// as trả Cred chạy dưới user hệ thống name.
func (e *Env) as(name string) (*platform.Cred, error) {
	u, ok := e.uid(name)
	if !ok {
		return nil, fmt.Errorf("không có user %s", name)
	}
	g, _ := e.gid(name)
	if g == 0 {
		g = u
	}
	return &platform.Cred{UID: uint32(u), GID: uint32(g)}, nil //nolint:gosec // uid hệ thống < 2^31
}
