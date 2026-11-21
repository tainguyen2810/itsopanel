// Command itso-agent là agent THẬT của ITSO Panel (Phase 4): typed operation qua Unix socket,
// xác thực SO_PEERCRED + HMAC (D-66), chính sách cục bộ, audit cục bộ hash-chain, lớp nền tảng (D-63).
// Không có op chạy lệnh tùy ý. --sandbox dùng runner giả + gốc thư mục riêng: không đụng hệ thống (dev/e2e).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/audit"
	"itso.local/agent/internal/auth"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/policy"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/server"
)

type options struct {
	listen, keyFile, policyFile, auditLog, root, allowUID, socketGroup string
	sandbox                                                            bool
}

func main() {
	// Helper File Manager (ADR 0019): agent tự chạy lại chính nó dưới uid account; xử lý trước mọi flag.
	if len(os.Args) == 2 && os.Args[1] == "fs-helper" {
		os.Exit(fsx.HelperMain(os.Stdin, os.Stdout, os.Stderr))
	}
	var o options
	flag.StringVar(&o.listen, "listen", "unix:/run/itso/agent.sock", "unix:/path.sock (máy thật chỉ dùng unix socket)")
	flag.StringVar(&o.keyFile, "key-file", "/etc/itso/agent.key", "khóa HMAC dùng chung với panel (≤ 0640)")
	flag.StringVar(&o.policyFile, "policy", policy.DefaultPath, "chính sách cục bộ YAML (root 0600)")
	flag.StringVar(&o.auditLog, "audit-log", "/var/log/itso/agent-audit.jsonl", "audit cục bộ JSONL")
	flag.StringVar(&o.root, "root", "/", "gốc hệ thống file (sandbox/test)")
	flag.StringVar(&o.allowUID, "allow-uid", "itso,itso-gw,root", "uid hoặc tên user được gọi agent (SO_PEERCRED)")
	flag.StringVar(&o.socketGroup, "socket-group", "itso-agent-clients", "group sở hữu socket (máy thật)")
	flag.BoolVar(&o.sandbox, "sandbox", false, "runner giả + gốc riêng, không chạy lệnh hệ thống (dev/e2e)")
	showVersion := flag.Bool("version", false, "in phiên bản")
	flag.Parse()
	if *showVersion {
		fmt.Println(ops.Version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(o, log); err != nil {
		log.Error("itso-agent dừng", "err", err)
		os.Exit(1)
	}
}

func run(o options, log *slog.Logger) error {
	if !o.sandbox {
		if os.Geteuid() != 0 {
			return errors.New("agent thật phải chạy bằng root (dùng --sandbox cho dev)")
		}
		if !strings.HasPrefix(o.listen, "unix:") {
			return errors.New("agent thật chỉ nghe trên unix socket")
		}
		if o.root != "/" {
			return errors.New("--root chỉ dùng với --sandbox")
		}
	} else if o.root == "/" {
		return errors.New("--sandbox cần --root là thư mục riêng (không phải /): sandbox ghi /etc, /home giả vào đó")
	}
	key, err := auth.LoadKey(o.keyFile)
	if err != nil {
		return fmt.Errorf("khóa HMAC: %w", err)
	}
	pol, err := policy.Load(o.policyFile, !o.sandbox)
	if err != nil {
		return err
	}
	allow, err := parseAllow(o.allowUID, o.sandbox)
	if err != nil {
		return err
	}
	alog, err := audit.Open(o.auditLog)
	if err != nil {
		return err
	}
	defer alog.Close()

	// Host: chỉ đọc /proc, /sys của máy (kể cả sandbox, để số liệu là thật).
	deps := &ops.Deps{Run: platform.ExecRunner{}, FS: platform.NewFS(o.root, false), Host: platform.NewFS("/", true),
		AuditPath: o.auditLog, Sandbox: o.sandbox, CPUSample: 250 * time.Millisecond, AcmePebble: pol.File.AcmePebble}
	if o.sandbox {
		deps.FS = platform.NewFS(o.root, os.Geteuid() != 0)
		deps.Run = ops.SandboxRunner(deps)
	}
	reg := registry.New(ops.Version)
	reg.SetAllow(pol.Enabled)
	if err := ops.Register(reg, deps); err != nil {
		return err
	}

	ln, cleanup, err := server.Listen(o.listen)
	if err != nil {
		return err
	}
	defer cleanup()
	if !o.sandbox {
		if err := chgrpSocket(strings.TrimPrefix(o.listen, "unix:"), o.socketGroup); err != nil {
			return err
		}
	}
	srv := server.New(server.Secure(server.Config{Registry: reg, Verifier: auth.NewVerifier(key), Allow: allow,
		Audit: alog, Log: log, Version: ops.Version}))
	srv.ConnContext = auth.ConnContext

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("itso-agent đang chạy", "listen", o.listen, "version", ops.Version, "sandbox", o.sandbox, "ops", len(reg.Ops()))
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// parseAllow đổi "itso,itso-gw,root,1000" thành allowlist uid. User không tồn tại bị bỏ qua (cảnh báo ở doctor);
// allowlist rỗng ở máy thật → lỗi. Sandbox: luôn thêm uid hiện tại.
func parseAllow(s string, sandbox bool) (auth.UIDAllow, error) {
	a := auth.UIDAllow{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if n, err := strconv.Atoi(part); err == nil {
			a[n] = true
			continue
		}
		if u, err := user.Lookup(part); err == nil {
			if n, err := strconv.Atoi(u.Uid); err == nil {
				a[n] = true
			}
		}
	}
	if sandbox {
		a[os.Getuid()] = true
	}
	if len(a) == 0 {
		return nil, errors.New("allowlist uid rỗng: agent không nhận caller nào")
	}
	return a, nil
}

func chgrpSocket(path, group string) error {
	g, err := user.LookupGroup(group)
	if err != nil {
		return fmt.Errorf("group %s: %w (chạy itso install hoặc itso repair)", group, err)
	}
	gid, _ := strconv.Atoi(g.Gid)
	return os.Lchown(path, 0, gid)
}
