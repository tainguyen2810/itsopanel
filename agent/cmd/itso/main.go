// Command itso là CLI quản trị ITSO Panel trên máy chủ (10-INSTALLER §6): install, status, doctor,
// update/rollback, repair, uninstall, policy, logs… Logic ở internal/install; lệnh hệ thống chỉ qua
// platform.Runner (argv cố định, không shell).
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/install"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

// Ghi đè khi build release: -ldflags "-X main.version=… -X main.releasePubKey=<base64 32 byte>".
var (
	version       = "0.4.0-dev"
	releasePubKey = ""
)

const usage = `itso — quản trị ITSO Panel

Dùng: itso [--root DIR --sandbox] <lệnh> [tùy chọn]

  install [--release-dir D] [--port N] [--no-firewall] [--yes] [--dry-run]
  preflight [--release-dir D] [--port N]
  status | doctor | url | setup-code | version
  admin reset-password|reset-mfa <email>
  policy get [khóa] | policy set <khóa> <true|false>
  update --release-dir D | rollback
  repair [--fix]
  uninstall [--purge-panel-data --confirm-hostname <hostname>]
  logs <agent|web|worker|scheduler|redis> [-n 200]
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

// readOnly là lệnh không cần root.
var readOnly = map[string]bool{"preflight": true, "status": true, "url": true, "version": true, "help": true, "doctor": true}

func run(ctx context.Context, args []string, out, errw io.Writer) int {
	g := flag.NewFlagSet("itso", flag.ContinueOnError)
	g.SetOutput(errw)
	root := g.String("root", "/", "gốc hệ thống file (chỉ với --sandbox)")
	sandbox := g.Bool("sandbox", false, "runner giả, không chạy lệnh hệ thống (dev/test)")
	g.Usage = func() { fmt.Fprint(errw, usage) }
	if err := g.Parse(args); err != nil {
		return 2
	}
	rest := g.Args()
	if len(rest) == 0 {
		fmt.Fprint(errw, usage)
		return 2
	}
	cmd, rest := rest[0], rest[1:]
	if *sandbox == (*root == "/") {
		fmt.Fprintln(errw, "itso: --sandbox cần --root là thư mục riêng; --root chỉ dùng với --sandbox")
		return 2
	}
	dry := cmd == "install" && contains(rest, "--dry-run")
	if !*sandbox && !readOnly[cmd] && !dry && os.Geteuid() != 0 {
		fmt.Fprintf(errw, "itso %s cần quyền root (sudo itso %s)\n", cmd, cmd)
		return 1
	}
	e := &install.Env{Run: platform.ExecRunner{}, FS: platform.NewFS(*root, false), Host: platform.NewFS("/", true), Out: out,
		HealthTries: 12, HealthDelay: 5 * time.Second}
	if *sandbox {
		e.FS = platform.NewFS(*root, os.Geteuid() != 0)
		e.Host = e.FS
		e.Run = ops.SandboxRunner(&ops.Deps{FS: e.FS})
		e.HealthTries, e.HealthDelay = 1, 0
	}
	if k, err := base64.StdEncoding.DecodeString(releasePubKey); err == nil && len(k) == ed25519.PublicKeySize {
		e.PubKey = k
	}
	if err := dispatch(ctx, e, cmd, rest); err != nil {
		fmt.Fprintln(errw, "itso:", err)
		if errors.Is(err, errUsage) {
			fmt.Fprint(errw, usage)
			return 2
		}
		return 1
	}
	return 0
}

var errUsage = errors.New("sai cú pháp")

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// defaultReleaseDir: thư mục chứa binary itso (install.sh tải manifest + tarball cạnh binary).
func defaultReleaseDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

func installFlags(name string, args []string) (install.Options, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	var o install.Options
	fs.StringVar(&o.ReleaseDir, "release-dir", defaultReleaseDir(), "thư mục có manifest.json, manifest.sig, tarball")
	fs.IntVar(&o.Port, "port", 28443, "cổng HTTPS của panel")
	fs.BoolVar(&o.NoFirewall, "no-firewall", false, "không đụng tường lửa")
	fs.BoolVar(&o.Yes, "yes", false, "chấp nhận cảnh báo preflight")
	fs.BoolVar(&o.DryRun, "dry-run", false, "chỉ preflight + liệt kê bước")
	if err := fs.Parse(args); err != nil {
		return o, errUsage
	}
	if o.Port < 1024 || o.Port > 65535 {
		return o, fmt.Errorf("--port phải trong 1024–65535")
	}
	return o, nil
}

func dispatch(ctx context.Context, e *install.Env, cmd string, args []string) error {
	switch cmd {
	case "install", "preflight":
		o, err := installFlags(cmd, args)
		if err != nil {
			return err
		}
		if cmd == "preflight" {
			cs := e.Preflight(ctx, o)
			e.PrintChecks(cs)
			if install.Failed(cs) {
				return errors.New("preflight có mục FAIL")
			}
			return nil
		}
		return e.Install(ctx, o)
	case "status":
		return e.Status(ctx)
	case "doctor":
		cs := e.Doctor(ctx)
		e.PrintChecks(cs)
		if install.Failed(cs) {
			return errors.New("doctor có mục FAIL")
		}
		return nil
	case "url":
		fmt.Fprintln(e.Out, e.URL())
		return nil
	case "version":
		fmt.Fprintf(e.Out, "itso %s (release đang chạy: %s)\n", version, e.CurrentVersion())
		return nil
	case "help":
		fmt.Fprint(e.Out, usage)
		return nil
	case "setup-code":
		code, err := e.NewSetupCode()
		if err != nil {
			return err
		}
		fmt.Fprintf(e.Out, "Mã thiết lập: %s (hết hạn sau 60 phút, chỉ dùng một lần)\nURL: %s\n", code, e.URL())
		return nil
	case "admin":
		if len(args) != 2 {
			return errUsage
		}
		return e.AdminReset(ctx, args[0], args[1])
	case "policy":
		switch {
		case len(args) >= 1 && args[0] == "get" && len(args) <= 2:
			key := ""
			if len(args) == 2 {
				key = args[1]
			}
			return e.PolicyGet(key)
		case len(args) == 3 && args[0] == "set":
			return e.PolicySet(ctx, args[1], args[2])
		}
		return errUsage
	case "update":
		o, err := installFlags(cmd, args)
		if err != nil {
			return err
		}
		return e.Update(ctx, o.ReleaseDir)
	case "rollback":
		return e.Rollback(ctx)
	case "repair":
		fs := flag.NewFlagSet("repair", flag.ContinueOnError)
		fix := fs.Bool("fix", false, "sửa những gì sai")
		if err := fs.Parse(args); err != nil {
			return errUsage
		}
		cs, err := e.Repair(ctx, *fix)
		if err != nil {
			return err
		}
		e.PrintChecks(cs)
		if install.Failed(cs) {
			return errors.New("repair còn mục FAIL")
		}
		return nil
	case "uninstall":
		fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
		var o install.UninstallOptions
		fs.BoolVar(&o.PurgePanelData, "purge-panel-data", false, "xóa cả dữ liệu panel (/etc/itso, cluster 16/itso)")
		fs.StringVar(&o.ConfirmHostname, "confirm-hostname", "", "gõ hostname để xác nhận purge")
		if err := fs.Parse(args); err != nil {
			return errUsage
		}
		return e.Uninstall(ctx, o)
	case "logs":
		fs := flag.NewFlagSet("logs", flag.ContinueOnError)
		n := fs.Int("n", 200, "số dòng")
		if len(args) < 1 || strings.HasPrefix(args[0], "-") {
			return errUsage
		}
		if err := fs.Parse(args[1:]); err != nil {
			return errUsage
		}
		return e.Logs(ctx, args[0], *n)
	}
	return fmt.Errorf("%w: lệnh lạ %q", errUsage, cmd)
}
