package auth

import (
	"context"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

var key = []byte(strings.Repeat("k", 32))

func req(body string, ts int64, nonce, sig string) (*httptest.ResponseRecorder, *Verifier, error) {
	r := httptest.NewRequest("POST", "/v1/ops", strings.NewReader(body))
	r.Header.Set(HeaderTimestamp, strconv.FormatInt(ts, 10))
	r.Header.Set(HeaderNonce, nonce)
	r.Header.Set(HeaderSignature, sig)
	v := NewVerifier(key)
	return nil, v, v.Verify(r, []byte(body))
}

func TestVerify(t *testing.T) {
	now := time.Now().Unix()
	n := "abcdefghijklmnop"
	body := `{"op":"system.ping"}`
	good := Sign(key, "POST", "/v1/ops", now, n, []byte(body))
	if _, _, err := req(body, now, n, good); err != nil {
		t.Fatalf("chữ ký đúng bị từ chối: %v", err)
	}
	cases := map[string]func() error{
		"sai body": func() error { _, _, e := req(body+" ", now, n, good); return e },
		"sai khóa": func() error {
			_, _, e := req(body, now, n, Sign([]byte(strings.Repeat("x", 32)), "POST", "/v1/ops", now, n, []byte(body)))
			return e
		},
		"lệch giờ": func() error {
			s := Sign(key, "POST", "/v1/ops", now-120, n, []byte(body))
			_, _, e := req(body, now-120, n, s)
			return e
		},
		"thiếu chữ ký": func() error { _, _, e := req(body, now, n, ""); return e },
		"nonce ngắn": func() error {
			s := Sign(key, "POST", "/v1/ops", now, "short", []byte(body))
			_, _, e := req(body, now, "short", s)
			return e
		},
		"sai path": func() error {
			s := Sign(key, "POST", "/v1/other", now, n, []byte(body))
			_, _, e := req(body, now, n, s)
			return e
		},
	}
	for name, f := range cases {
		if err := f(); err == nil {
			t.Errorf("%s: phải bị từ chối", name)
		}
	}
}

func TestNonceReplay(t *testing.T) {
	v := NewVerifier(key)
	now := time.Now().Unix()
	n := "abcdefghijklmnop"
	body := []byte(`{}`)
	mk := func() error {
		r := httptest.NewRequest("POST", "/v1/ops", strings.NewReader(string(body)))
		r.Header.Set(HeaderTimestamp, strconv.FormatInt(now, 10))
		r.Header.Set(HeaderNonce, n)
		r.Header.Set(HeaderSignature, Sign(key, "POST", "/v1/ops", now, n, body))
		return v.Verify(r, body)
	}
	if err := mk(); err != nil {
		t.Fatal(err)
	}
	if err := mk(); err == nil {
		t.Fatal("nonce lặp phải bị từ chối")
	}
}

func TestLoadKey(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.key")
	if err := os.WriteFile(p, []byte(strings.Repeat("a", 64)+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if k, err := LoadKey(p); err != nil || len(k) != 64 {
		t.Fatalf("LoadKey = %d, %v", len(k), err)
	}
	_ = os.Chmod(p, 0o644)
	if _, err := LoadKey(p); err == nil {
		t.Fatal("khóa đọc được bởi others phải bị từ chối")
	}
	_ = os.WriteFile(filepath.Join(dir, "short"), []byte("abc"), 0o600)
	if _, err := LoadKey(filepath.Join(dir, "short")); err == nil {
		t.Fatal("khóa ngắn phải bị từ chối")
	}
	_ = os.Symlink(p, filepath.Join(dir, "link"))
	if _, err := LoadKey(filepath.Join(dir, "link")); err == nil {
		t.Fatal("symlink phải bị từ chối")
	}
}

func TestPeerCred(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "a.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan Peer, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		got <- PeerFromContext(ConnContext(context.Background(), c))
		c.Close()
	}()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	p := <-got
	if !p.Known || p.UID != os.Getuid() || p.PID != os.Getpid() {
		t.Fatalf("peer = %+v, muốn uid %d pid %d", p, os.Getuid(), os.Getpid())
	}
	if !(UIDAllow{os.Getuid(): true}).Allowed(p) || (UIDAllow{12345: true}).Allowed(p) {
		t.Fatal("allowlist sai")
	}
	if (UIDAllow{0: true}).Allowed(Peer{}) {
		t.Fatal("peer không rõ (tcp) phải bị từ chối khi có allowlist")
	}
}

// Vector dùng chung với Laravel (apps/api/tests/Unit/AgentClientTest.php).
func TestCrossLanguageVector(t *testing.T) {
	got := Sign([]byte(strings.Repeat("k", 32)), "POST", "/v1/ops", 1700000000, "abcdefghijklmnop", []byte(`{"a":1}`))
	if got != "f5255c6bdc5f11677842af5e7327e438f5803f57bd6c5c91a99e753d022b472d" {
		t.Fatalf("chữ ký = %s", got)
	}
}
