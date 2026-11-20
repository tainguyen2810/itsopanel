// Package server phục vụ HTTP JSON: POST /v1/ops (envelope → result).
package server

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

// Handler trả về http.Handler cho registry.
func Handler(r *registry.Registry) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ops", func(w http.ResponseWriter, req *http.Request) {
		if ct := req.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			http.Error(w, "Content-Type phải là application/json", http.StatusUnsupportedMediaType)
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, envelope.MaxBytes+1))
		if err != nil {
			http.Error(w, "đọc body lỗi", http.StatusBadRequest)
			return
		}
		res := r.Handle(req.Context(), body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(registry.MarshalResult(res))
	})
	return mux
}

// Listen mở listener từ chuỗi "unix:/path/to.sock" hoặc "tcp:127.0.0.1:7810".
// TCP chỉ cho phép địa chỉ loopback.
func Listen(addr string) (net.Listener, func(), error) {
	network, target, ok := strings.Cut(addr, ":")
	if !ok {
		return nil, nil, fmt.Errorf("listen %q: cần dạng unix:/path hoặc tcp:127.0.0.1:port", addr)
	}
	switch network {
	case "unix":
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return nil, nil, err
		}
		if fi, err := os.Lstat(target); err == nil {
			if fi.Mode()&os.ModeSocket == 0 {
				return nil, nil, fmt.Errorf("%s đã tồn tại và không phải socket", target)
			}
			_ = os.Remove(target) // socket cũ của lần chạy trước
		}
		ln, err := net.Listen("unix", target)
		if err != nil {
			return nil, nil, err
		}
		if err := os.Chmod(target, 0o660); err != nil {
			_ = ln.Close()
			return nil, nil, err
		}
		return ln, func() { _ = os.Remove(target) }, nil
	case "tcp":
		host, _, err := net.SplitHostPort(target)
		if err != nil {
			return nil, nil, err
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return nil, nil, errors.New("tcp chỉ được nghe trên địa chỉ loopback")
		}
		ln, err := net.Listen("tcp", target)
		return ln, func() {}, err
	default:
		return nil, nil, fmt.Errorf("network %q không hỗ trợ", network)
	}
}

// New tạo http.Server với timeout an toàn.
func New(h http.Handler) *http.Server {
	return &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: 60 * time.Second, IdleTimeout: 120 * time.Second}
}
