package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"sync"

	"itso.local/agent/internal/auth"
)

// ServeStream nhận kết nối trên socket stream (terminal, D-75): chỉ peer trong allowlist (itso-gw) mới được
// chuyển cho handle; còn lại đóng ngay. Trả khi ctx hủy (đóng listener, chờ các kết nối kết thúc).
func ServeStream(ctx context.Context, ln net.Listener, allow auth.UIDAllow, log *slog.Logger, handle func(context.Context, net.Conn)) error {
	var wg sync.WaitGroup
	go func() { <-ctx.Done(); _ = ln.Close() }()
	defer wg.Wait()
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		peer := auth.PeerFromContext(auth.ConnContext(ctx, c))
		if !allow.Allowed(peer) {
			if log != nil {
				log.Warn("stream: từ chối caller", "uid", peer.UID, "pid", peer.PID)
			}
			_ = c.Close()
			continue
		}
		wg.Add(1)
		go func() { defer wg.Done(); handle(ctx, c) }()
	}
}
