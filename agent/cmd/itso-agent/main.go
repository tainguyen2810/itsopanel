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
	"net"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/audit"
	"itso.local/agent/internal/auth"
	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/policy"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/relay"
	"itso.local/agent/internal/server"
)

type options struct {
	listen, keyFile, policyFile, auditLog, root, allowUID, socketGroup string
	streamListen, streamAllow                                          string
	mode, relayURL, nodeCert, nodeKey, nodeCA                          string
	sandbox                                                            bool
}

func main() {
	// Helper File Manager (ADR 0019): agent tự chạy lại chính nó dưới uid account; xử lý trước mọi flag.
	if len(os.Args) == 2 && os.Args[1] == "fs-helper" {
		os.Exit(fsx.HelperMain(os.Stdin, os.Stdout, os.Stderr))
	}
	// Hoàn tác safe-apply (ADR 0023/0024): transient timer systemd gọi `itso-agent safe-rollback <kind> <apply_id>`.
	if len(os.Args) == 4 && os.Args[1] == "safe-rollback" {
		os.Exit(safeRollback(os.Args[2], os.Args[3]))
	}
	var o options
	flag.StringVar(&o.listen, "listen", "unix:/run/itso/agent.sock", "unix:/path.sock (máy thật chỉ dùng unix socket)")
	flag.StringVar(&o.keyFile, "key-file", "/etc/itso/agent.key", "khóa HMAC dùng chung với panel (≤ 0640)")
	flag.StringVar(&o.policyFile, "policy", policy.DefaultPath, "chính sách cục bộ YAML (root 0600)")
	flag.StringVar(&o.auditLog, "audit-log", "/var/log/itso/agent-audit.jsonl", "audit cục bộ JSONL")
	flag.StringVar(&o.root, "root", "/", "gốc hệ thống file (sandbox/test)")
	flag.StringVar(&o.allowUID, "allow-uid", "itso,itso-gw,root", "uid hoặc tên user được gọi agent (SO_PEERCRED)")
	flag.StringVar(&o.socketGroup, "socket-group", "itso-agent-clients", "group sở hữu socket (máy thật)")
	flag.StringVar(&o.streamListen, "stream-listen", "unix:/run/itso/agent-stream.sock", "socket stream terminal (rỗng = tắt terminal)")
	flag.StringVar(&o.streamAllow, "stream-allow-uid", "itso-gw", "uid hoặc tên user được ATTACH phiên terminal (SO_PEERCRED)")
	flag.StringVar(&o.mode, "mode", "local", "local (cùng máy panel) | node (quay số ra itso-relay bằng mTLS, D-89)")
	flag.StringVar(&o.relayURL, "relay-url", "", "chế độ node: https://control-plane:28444 (rỗng = đọc /etc/itso/node.json)")
	flag.StringVar(&o.nodeCert, "node-cert", ops.NodeCertPath, "chế độ node: chứng chỉ node")
	flag.StringVar(&o.nodeKey, "node-key", ops.NodeKeyPath, "chế độ node: khóa riêng node (0600)")
	flag.StringVar(&o.nodeCA, "node-ca", ops.NodeCAPath, "chế độ node: CA nội bộ đã ghim")
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
	if o.mode != "local" && o.mode != "node" {
		return fmt.Errorf("--mode %q: chỉ nhận local | node", o.mode)
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
		AuditPath: o.auditLog, Sandbox: o.sandbox, CPUSample: 250 * time.Millisecond, AcmePebble: pol.File.AcmePebble,
		RootTerminal: pol.RootTerminal(), RecordUser: pol.File.RecordUser, NodeMode: o.mode == "node"}
	if o.sandbox {
		deps.FS = platform.NewFS(o.root, os.Geteuid() != 0)
		deps.Run = ops.SandboxRunner(deps) // gắn docker.Fake
	} else {
		deps.Docker = docker.NewClient(docker.DefaultSocket)
	}
	var streamLn net.Listener
	var streamAllow auth.UIDAllow
	if o.streamListen != "" {
		streamAllow, err = parseAllow(o.streamAllow, o.sandbox)
		if err != nil {
			return fmt.Errorf("stream-allow-uid: %w", err)
		}
		ln, cleanup, err := server.Listen(o.streamListen)
		if err != nil {
			return fmt.Errorf("socket stream: %w", err)
		}
		defer cleanup()
		if !o.sandbox {
			if err := chgrpSocket(strings.TrimPrefix(o.streamListen, "unix:"), o.socketGroup); err != nil {
				return err
			}
		}
		streamLn = ln
		deps.Term = ops.NewTermManager(deps, log)
	}
	// Lần safe-apply đã quá hạn mà timer chưa chạy (máy khởi động lại, timer lỗi) → hoàn tác ngay.
	if err := ops.RecoverSafeApply(context.Background(), deps); err != nil {
		log.Error("hoàn tác safe-apply quá hạn lỗi", "err", err)
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
	if streamLn != nil {
		go func() {
			if err := server.ServeStream(ctx, streamLn, streamAllow, log, deps.Term.Serve); err != nil {
				log.Error("socket stream dừng", "err", err)
			}
		}()
	}
	if o.mode == "node" {
		relayURL := o.relayURL
		if relayURL == "" {
			ni, err := ops.ReadNodeInfo(deps.FS)
			if err != nil {
				return fmt.Errorf("chế độ node cần --relay-url hoặc %s: %w", ops.NodeIdentity, err)
			}
			relayURL = ni.RelayURL
		}
		if !strings.HasPrefix(relayURL, "https://") {
			return errors.New("relay-url phải là https://")
		}
		// Qua relay không có SO_PEERCRED: bảo vệ là mTLS (kênh) + HMAC khóa riêng của server này (envelope).
		nodeHandler := server.Secure(server.Config{Registry: reg, Verifier: auth.NewVerifier(key), Audit: alog,
			Log: log, Version: ops.Version})
		if o.sandbox { // sandbox: chứng chỉ node nằm trong gốc riêng (agent.cert.rotate ghi vào đó)
			for _, f := range []*string{&o.nodeCert, &o.nodeKey, &o.nodeCA} {
				if !strings.HasPrefix(*f, o.root) {
					*f = filepath.Join(o.root, *f)
				}
			}
		}
		n := &relay.Node{RelayURL: relayURL, CertFile: o.nodeCert, KeyFile: o.nodeKey, CAFile: o.nodeCA,
			Handler: nodeHandler, Log: log}
		go func() { _ = n.Run(ctx) }()
	}
	log.Info("itso-agent đang chạy", "mode", o.mode, "listen", o.listen, "version", ops.Version, "sandbox", o.sandbox, "ops", len(reg.Ops()))
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

// safeRollback chạy bằng root từ timer systemd: khôi phục cấu hình đã lưu nếu lần áp dụng vẫn chờ xác nhận.
func safeRollback(kind, applyID string) int {
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "safe-rollback phải chạy bằng root")
		return 1
	}
	d := &ops.Deps{Run: platform.ExecRunner{}, FS: platform.NewFS("/", false)}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := ops.SafeRollback(ctx, d, kind, applyID); err != nil {
		fmt.Fprintln(os.Stderr, "safe-rollback:", err)
		return 1
	}
	return 0
}
