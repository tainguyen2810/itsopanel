package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"itso.local/agent/internal/mock"
	"itso.local/agent/internal/registry"
)

func TestUnixSocketPing(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "a.sock")
	ln, cleanup, err := Listen("unix:" + sock)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	reg := registry.New(mock.Version)
	if err := mock.Register(reg, time.Now()); err != nil {
		t.Fatal(err)
	}
	srv := New(Handler(reg))
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	body, _ := json.Marshal(map[string]any{
		"v": 1, "op": "system.ping", "op_id": "01938a0f-0005-7000-8000-00000f000005:1:1", "params": map[string]any{},
		"deadline": time.Now().Add(time.Minute).Format(time.RFC3339), "ts": time.Now().Unix(),
		"nonce": "nonce_eeeeeeeeeeeeeeee", "requested_by": map[string]any{"user_uuid": nil, "role": "SYSTEM"},
	})
	resp, err := client.Post("http://agent/v1/ops", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var res registry.Result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Data["pong"] != true || res.Data["mode"] != "mock" {
		t.Fatalf("ping lỗi: %+v %+v", res, res.Error)
	}

	resp2, err := client.Post("http://agent/v1/ops", "text/plain", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("muốn 415, có %d", resp2.StatusCode)
	}
}

func TestListenRejectsNonLoopbackTCP(t *testing.T) {
	if _, _, err := Listen("tcp:0.0.0.0:0"); err == nil {
		t.Fatal("muốn từ chối 0.0.0.0")
	}
	ln, cleanup, err := Listen("tcp:127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cleanup()
	_ = ln.Close()
}
