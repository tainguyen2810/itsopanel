// Command itso-mock-agent là agent GIẢ cho môi trường dev: nhận envelope theo
// contracts/agent-ops, chỉ hỗ trợ system.ping và system.info với dữ liệu demo.
// Không chạy lệnh hệ thống, không chạm cấu hình máy.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"itso.local/agent/internal/mock"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/server"
)

func defaultListen() string {
	if v := os.Getenv("ITSO_AGENT_LISTEN"); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		return "tcp:127.0.0.1:7810"
	}
	return "unix:" + os.TempDir() + "/itso-mock-agent.sock"
}

func main() {
	listen := flag.String("listen", defaultListen(), "unix:/path.sock hoặc tcp:127.0.0.1:port")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	reg := registry.New(mock.Version)
	if err := mock.Register(reg, time.Now()); err != nil {
		log.Error("đăng ký op", "err", err)
		os.Exit(1)
	}
	ln, cleanup, err := server.Listen(*listen)
	if err != nil {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
	defer cleanup()

	srv := server.New(server.Handler(reg))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("itso-mock-agent đang chạy", "listen", *listen, "version", mock.Version, "ops", reg.Ops())
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
