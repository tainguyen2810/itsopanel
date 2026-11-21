// itso-relay: kênh agent từ xa trên control plane (D-89, ADR 0035). Chạy bằng user itso-relay, không đặc quyền.
// Cổng công khai :28444 (TLS 1.3, mTLS cho /v1/agent), unix socket cho Laravel. Relay không giữ khóa HMAC của
// node: chỉ chuyển nguyên byte envelope đã ký, nên không giả được op.
//
// Lệnh phụ dev (chỉ gốc sandbox, không bao giờ /etc): `itso-relay dev-init --dir D --hosts h1,h2` tạo CA +
// chứng chỉ relay; `itso-relay dev-issue --dir D --uuid U --out O` cấp chứng chỉ node cho agent sandbox.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/auth"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/pki"
	"itso.local/agent/internal/relay"
	"itso.local/agent/internal/server"
)

func main() {
	if len(os.Args) >= 2 && (os.Args[1] == "dev-init" || os.Args[1] == "dev-issue") {
		if err := devCmd(os.Args[1], os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "itso-relay:", err)
			os.Exit(1)
		}
		return
	}
	listen := flag.String("listen", ":28444", "địa chỉ TLS công khai cho node")
	socket := flag.String("socket", "unix:/run/itso-relay/relay.sock", "unix socket cho Laravel")
	caFile := flag.String("ca", ops.CACertPath, "chứng chỉ CA nội bộ (công khai)")
	certFile := flag.String("cert", "/etc/itso/relay/relay.pem", "chứng chỉ TLS của relay")
	keyFile := flag.String("key", "/etc/itso/relay/relay.key", "khóa TLS của relay")
	stateFile := flag.String("state", "/var/lib/itso-relay/state.json", "danh sách fingerprint bị thu hồi")
	enrollURL := flag.String("enroll-url", "http://127.0.0.1:28480/api/v1/internal/nodes:enroll", "endpoint enroll của Laravel (rỗng = tắt)")
	relayKeyFile := flag.String("relay-key-file", "/etc/itso/relay/enroll.key", "khóa ký yêu cầu enroll chuyển tiếp (dùng chung với panel)")
	sandbox := flag.Bool("sandbox", false, "dev/e2e: cho phép chạy bằng root và đường dẫn tùy ý")
	showVersion := flag.Bool("version", false, "in phiên bản")
	flag.Parse()
	if *showVersion {
		fmt.Println(ops.Version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if !*sandbox && os.Geteuid() == 0 {
		log.Error("itso-relay không chạy bằng root (dùng user itso-relay)")
		os.Exit(1)
	}
	if err := run(*listen, *socket, *caFile, *certFile, *keyFile, *stateFile, *enrollURL, *relayKeyFile, log); err != nil {
		log.Error("itso-relay dừng", "err", err)
		os.Exit(1)
	}
}

func run(listen, socket, caFile, certFile, keyFile, stateFile, enrollURL, relayKeyFile string, log *slog.Logger) error {
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return fmt.Errorf("CA: %w (chạy itso pki init)", err)
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return fmt.Errorf("chứng chỉ relay: %w", err)
	}
	tc, err := relay.TLSConfig(cert, caPEM)
	if err != nil {
		return err
	}
	var relayKey []byte
	if enrollURL != "" {
		if relayKey, err = auth.LoadKey(relayKeyFile); err != nil {
			return fmt.Errorf("khóa enroll: %w", err)
		}
	}
	hub, err := relay.NewHub(stateFile, log)
	if err != nil {
		return err
	}
	s := &relay.Server{Hub: hub, CAPEM: caPEM, EnrollURL: enrollURL, RelayKey: relayKey}

	sockLn, cleanup, err := server.Listen(socket)
	if err != nil {
		return err
	}
	defer cleanup()
	pubLn, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	pub := &http.Server{Handler: s.PublicHandler(), TLSConfig: tc, ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes: 16 << 10, ErrorLog: slog.NewLogLogger(log.Handler(), slog.LevelDebug)}
	priv := &http.Server{Handler: s.SocketHandler(), ReadHeaderTimeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = pub.Shutdown(sctx)
		_ = priv.Shutdown(sctx)
	}()
	go func() {
		if err := priv.Serve(sockLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("socket Laravel dừng", "err", err)
			stop()
		}
	}()
	log.Info("itso-relay đang chạy", "listen", listen, "socket", socket, "version", ops.Version)
	if err := pub.ServeTLS(pubLn, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func devCmd(cmd string, args []string) error {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	dir := fs.String("dir", "", "thư mục PKI sandbox")
	hosts := fs.String("hosts", "127.0.0.1,localhost", "tên/IP của relay (dev-init)")
	uuid := fs.String("uuid", "", "server_uuid của node (dev-issue)")
	out := fs.String("out", "", "thư mục ghi node.pem/node.key/ca.pem (dev-issue)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	abs, err := filepath.Abs(*dir)
	if err != nil || *dir == "" || strings.HasPrefix(abs, "/etc") {
		return errors.New("--dir phải là thư mục sandbox (không phải /etc)")
	}
	now := time.Now()
	write := func(name string, b []byte, mode os.FileMode) error {
		return os.WriteFile(filepath.Join(abs, name), b, mode)
	}
	switch cmd {
	case "dev-init":
		if err := os.MkdirAll(abs, 0o700); err != nil {
			return err
		}
		if _, err := os.Stat(filepath.Join(abs, "ca.pem")); err == nil {
			return nil // đã có: giữ nguyên để node đã cấp vẫn dùng được
		}
		certPEM, keyPEM, err := pki.NewCA("ITSO Panel dev CA", now)
		if err != nil {
			return err
		}
		ca, err := pki.LoadCA(certPEM, keyPEM)
		if err != nil {
			return err
		}
		sc, sk, err := ca.NewServerCert(strings.Split(*hosts, ","), now)
		if err != nil {
			return err
		}
		for _, f := range []struct {
			n string
			b []byte
		}{{"ca.pem", certPEM}, {"ca.key", keyPEM}, {"relay.pem", sc}, {"relay.key", sk}} {
			if err := write(f.n, f.b, 0o600); err != nil {
				return err
			}
		}
		return write("enroll.key", []byte(randHex()+"\n"), 0o600)
	default:
		outAbs, err := filepath.Abs(*out)
		if err != nil || *out == "" || strings.HasPrefix(outAbs, "/etc") {
			return errors.New("--out phải là thư mục sandbox (không phải /etc)")
		}
		certPEM, err := os.ReadFile(filepath.Join(abs, "ca.pem"))
		if err != nil {
			return err
		}
		keyPEM, err := os.ReadFile(filepath.Join(abs, "ca.key"))
		if err != nil {
			return err
		}
		ca, err := pki.LoadCA(certPEM, keyPEM)
		if err != nil {
			return err
		}
		nk, csr, err := pki.NewKeyAndCSR(*uuid)
		if err != nil {
			return err
		}
		iss, err := ca.SignCSR(csr, *uuid, pki.MaxTTL, now)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(outAbs, 0o700); err != nil {
			return err
		}
		for _, f := range []struct {
			n string
			b []byte
		}{{"node.pem", iss.CertPEM}, {"node.key", nk}, {"ca.pem", certPEM}} {
			if err := os.WriteFile(filepath.Join(outAbs, f.n), f.b, 0o600); err != nil {
				return err
			}
		}
		fmt.Println(iss.Fingerprint)
		return nil
	}
}

func randHex() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", b)
}
