package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/audit"
	"itso.local/agent/internal/auth"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/policy"
	"itso.local/agent/internal/registry"
)

var testKey = []byte(strings.Repeat("z", 40))

type rig struct {
	sock, auditPath string
	client          *http.Client
}

func newRig(t *testing.T, allow auth.UIDAllow, pol *policy.Policy) *rig {
	t.Helper()
	dir := t.TempDir()
	r := registry.New("test")
	if pol != nil {
		r.SetAllow(pol.Enabled)
	}
	for _, op := range []string{"system.ping", "system.reboot"} {
		if err := r.Register(op, func(context.Context, *envelope.Envelope) (map[string]any, error) {
			return map[string]any{"pong": true, "agent_version": "test", "mode": "sandbox"}, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	alog, err := audit.Open(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = alog.Close() })
	sock := filepath.Join(dir, "agent.sock")
	ln, cleanup, err := Listen("unix:" + sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := New(Secure(Config{Registry: r, Verifier: auth.NewVerifier(testKey), Allow: allow, Audit: alog, Version: "test"}))
	srv.ConnContext = auth.ConnContext
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close(); cleanup() })
	c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}, Timeout: 5 * time.Second}
	return &rig{sock: sock, auditPath: filepath.Join(dir, "audit.jsonl"), client: c}
}

var seq int

func envelopeFor(op string) ([]byte, string) {
	seq++
	nonce := fmt.Sprintf("nonce-%012d-xyz", seq)
	params := `{}`
	if op == "system.reboot" {
		params = `{"delay_sec":0,"reason":"t"}`
	}
	b := fmt.Sprintf(`{"v":1,"op":%q,"op_id":"0193a000-0000-7000-8000-%012d:1:1","params":%s,"deadline":%q,"ts":%d,"nonce":%q,"requested_by":{"user_uuid":null,"role":"SYSTEM"}}`,
		op, seq, params, time.Now().Add(time.Minute).UTC().Format(time.RFC3339), time.Now().Unix(), nonce)
	return []byte(b), nonce
}

func (r *rig) call(t *testing.T, op string, sign bool) registry.Result {
	t.Helper()
	body, nonce := envelopeFor(op)
	req, _ := http.NewRequest("POST", "http://agent/v1/ops", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if sign {
		ts := time.Now().Unix()
		req.Header.Set(auth.HeaderTimestamp, strconv.FormatInt(ts, 10))
		req.Header.Set(auth.HeaderNonce, nonce)
		req.Header.Set(auth.HeaderSignature, auth.Sign(testKey, "POST", "/v1/ops", ts, nonce, body))
	}
	resp, err := r.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var res registry.Result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	return res
}

func TestSecureFlow(t *testing.T) {
	pol, _ := policy.Default()
	_ = pol.Set("ops.system.reboot", false)
	r := newRig(t, auth.UIDAllow{os.Getuid(): true}, pol)

	if res := r.call(t, "system.ping", true); !res.OK {
		t.Fatalf("request ký đúng bị từ chối: %+v", res.Error)
	}
	if res := r.call(t, "system.ping", false); res.OK || res.Error.Code != "unauthorized_caller" {
		t.Fatalf("thiếu chữ ký phải bị từ chối: %+v", res)
	}
	if res := r.call(t, "system.reboot", true); res.OK || res.Error.Code != "op_disabled" {
		t.Fatalf("op bị policy tắt phải trả op_disabled: %+v", res)
	}
	if res := r.call(t, "khong.co", true); res.OK {
		t.Fatalf("op lạ phải bị từ chối: %+v", res)
	}

	entries, v, err := audit.Tail(r.auditPath, 0, 100)
	if err != nil || !v.OK || len(entries) != 4 {
		t.Fatalf("audit: %d bản ghi, %+v, %v", len(entries), v, err)
	}
	want := []string{"ok", "rejected", "error", "error"}
	for i, e := range entries {
		if e.Result != want[i] || e.CallerUID != os.Getuid() {
			t.Errorf("audit[%d] = %s uid %d, muốn %s", i, e.Result, e.CallerUID, want[i])
		}
	}
}

func TestPeerNotAllowed(t *testing.T) {
	r := newRig(t, auth.UIDAllow{os.Getuid() + 4242: true}, nil)
	if res := r.call(t, "system.ping", true); res.OK || res.Error.Code != "unauthorized_caller" {
		t.Fatalf("uid ngoài allowlist phải bị từ chối: %+v", res)
	}
}
