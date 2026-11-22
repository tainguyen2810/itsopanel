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
	version       = "0.5.0-beta"
	releasePubKey = ""
)

const usage = `itso — quản trị ITSO Panel

Dùng: itso [--root DIR --sandbox] <lệnh> [tùy chọn]

  install [--release-dir D] [--port N] [--no-firewall] [--yes] [--dry-run] [--restore]
          [--role all-in-one|control-plane|node] [--join https://CP:28444 --token T --ca-sha256 PIN]
  pki init | pki pin                               (control plane: CA nội bộ + chứng chỉ relay; in pin cho node)
  node status | node rejoin --token T --ca-sha256 PIN [--join URL] | node leave --yes
  preflight [--release-dir D] [--port N]
  status | doctor | url | setup-code | version
  admin reset-password|reset-mfa <email>
  policy get [khóa] | policy set <khóa> <on|off>   (khóa: terminal.root, terminal.record_user, docker, backup_forget, ops.<op>)
  allowlist reset                                  (xóa IP allowlist Admin khi tự khóa mình)
  update --release-dir D | rollback
  repair [--fix]
  uninstall [--purge-panel-data --confirm-hostname <hostname>]
  logs <agent|web|worker|scheduler|redis> [-n 200]
  backup prune --kit FILE --keep-daily N [--keep-last|--keep-weekly|--keep-monthly|--keep-yearly N] [--ssh-key FILE] [--dry-run]
  backup panel-restore --kit FILE --snapshot ID [--out DIR] [--ssh-key FILE]
  panel-restore-apply --dir /var/lib/itso/restore/panel-<ts>   (DR: thay DB panel + /etc/itso đã giải mã)
                                                   (credential đích đọc từ stdin: s3 = 2 dòng key id/secret, rest = 1 dòng mật khẩu)
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

// readOnly là lệnh không cần root.
var readOnly = map[string]bool{"preflight": true, "status": true, "url": true, "version": true, "help": true, "doctor": true}

// readOnlySub: lệnh con chỉ đọc (itso node status, itso pki pin).
func readOnlySub(cmd string, rest []string) bool {
	return len(rest) == 1 && ((cmd == "node" && rest[0] == "status") || (cmd == "pki" && rest[0] == "pin"))
}

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
	if !*sandbox && !readOnly[cmd] && !readOnlySub(cmd, rest) && !dry && os.Geteuid() != 0 {
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
	sandboxMode = *sandbox
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

// sandboxMode / stdin: đặt bởi run (test thay stdin).
var (
	sandboxMode bool
	stdin       io.Reader = os.Stdin
)

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
	if name == "install" {
		fs.BoolVar(&o.Restore, "restore", false, "cài như mới rồi vào chế độ khôi phục từ backup (DR)")
		fs.StringVar(&o.Role, "role", install.RoleAllInOne, "all-in-one | control-plane | node")
		fs.StringVar(&o.Join, "join", "", "node: URL relay của control plane (https://CP:28444)")
		fs.StringVar(&o.Token, "token", "", "node: token join một lần (hoặc biến môi trường ITSO_JOIN_TOKEN)")
		fs.StringVar(&o.CASHA256, "ca-sha256", "", "node: sha256 CA nội bộ (ghim trước khi gửi token)")
	}
	if err := fs.Parse(args); err != nil {
		return o, errUsage
	}
	if o.Role == install.RoleNode && o.Token == "" {
		o.Token = os.Getenv("ITSO_JOIN_TOKEN")
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
	case "panel-restore-apply":
		// Do unit tạm của op panel.restore gọi (DR); chạy tay được theo runbook.
		fs := flag.NewFlagSet("panel-restore-apply", flag.ContinueOnError)
		fs.SetOutput(e.Out)
		dir := fs.String("dir", "", "thư mục đã giải mã (/var/lib/itso/restore/panel-<ts>)")
		if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *dir == "" {
			return errUsage
		}
		return e.PanelRestoreApply(ctx, *dir)
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
	case "allowlist":
		if len(args) != 1 || args[0] != "reset" {
			return errUsage
		}
		return e.AllowlistReset(ctx)
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
	case "backup":
		return backupCmd(ctx, e, args)
	case "pki":
		switch {
		case len(args) == 1 && args[0] == "init":
			if e.Role() == install.RoleNode {
				return errors.New("node không giữ CA (CA chỉ ở control plane)")
			}
			if err := e.PKIInit(); err != nil {
				return err
			}
			fallthrough
		case len(args) == 1 && args[0] == "pin":
			pin, err := e.CAPin()
			if err != nil {
				return fmt.Errorf("chưa có CA nội bộ (itso pki init): %w", err)
			}
			fmt.Fprintf(e.Out, "CA nội bộ sha256: %s\n", pin)
			return nil
		}
		return errUsage
	case "node":
		return nodeCmd(ctx, e, args)
	}
	return fmt.Errorf("%w: lệnh lạ %q", errUsage, cmd)
}

func nodeCmd(ctx context.Context, e *install.Env, args []string) error {
	if len(args) == 0 {
		return errUsage
	}
	switch args[0] {
	case "status":
		if len(args) != 1 {
			return errUsage
		}
		return e.NodeStatus(ctx)
	case "rejoin":
		fs := flag.NewFlagSet("node rejoin", flag.ContinueOnError)
		var j install.JoinOptions
		fs.StringVar(&j.URL, "join", "", "URL relay (mặc định: relay trong /etc/itso/node.json)")
		fs.StringVar(&j.Token, "token", "", "token join một lần (hoặc ITSO_JOIN_TOKEN)")
		fs.StringVar(&j.CASHA256, "ca-sha256", "", "sha256 CA nội bộ")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
			return errUsage
		}
		if j.Token == "" {
			j.Token = os.Getenv("ITSO_JOIN_TOKEN")
		}
		return e.NodeRejoin(ctx, j)
	case "leave":
		fs := flag.NewFlagSet("node leave", flag.ContinueOnError)
		yes := fs.Bool("yes", false, "xác nhận rời control plane")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
			return errUsage
		}
		return e.NodeLeave(ctx, *yes)
	}
	return errUsage
}
