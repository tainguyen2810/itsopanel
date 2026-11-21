// itso-gateway: cầu WebSocket ↔ socket stream của agent cho terminal USER (D-75). Chạy bằng user itso-gw,
// không đặc quyền, không đọc DB; nghe trên loopback sau Caddy (/gateway/*).
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
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/gateway"
	"itso.local/agent/internal/ops"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:7811", "địa chỉ loopback nghe HTTP/WebSocket")
	stream := flag.String("agent-stream", "unix:/run/itso/agent-stream.sock", "socket stream của agent")
	origins := flag.String("origin", "", "Origin được phép thêm (phân cách bằng dấu phẩy), vd. localhost:5173")
	showVersion := flag.Bool("version", false, "in phiên bản")
	flag.Parse()
	if *showVersion {
		fmt.Println(ops.Version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(*listen, *stream, *origins, log); err != nil {
		log.Error("itso-gateway dừng", "err", err)
		os.Exit(1)
	}
}

func run(listen, stream, origins string, log *slog.Logger) error {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return errors.New("gateway chỉ nghe trên loopback (Caddy đứng trước)")
	}
	path, ok := strings.CutPrefix(stream, "unix:")
	if !ok || path == "" {
		return errors.New("--agent-stream cần dạng unix:/path")
	}
	var pats []string
	for _, o := range strings.Split(origins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			pats = append(pats, o)
		}
	}
	var d net.Dialer
	h := gateway.Handler(gateway.Config{Log: log, OriginPatterns: pats,
		Dial: func(ctx context.Context) (net.Conn, error) { return d.DialContext(ctx, "unix", path) }})
	srv := &http.Server{Addr: listen, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("itso-gateway đang chạy", "listen", listen, "agent_stream", path)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
