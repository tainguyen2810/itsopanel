package relay

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"itso.local/agent/internal/auth"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/pki"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/server"
)

const nodeUUID = "01938a01-0002-7000-8000-000000000002"

var (
	nodeKey  = []byte(strings.Repeat("n", 40))
	otherKey = []byte(strings.Repeat("o", 40))
)

type testCA struct {
	cert *x509.Certificate
	pem  []byte
	key  *ecdsa.PrivateKey
	ca   *pki.CA
}

func newTestCA(t *testing.T) *testCA {
	t.Helper()
	certPEM, keyPEM, err := pki.NewCA("test CA", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ca, err := pki.LoadCA(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	k, _ := pki.ParseKey(keyPEM)
	return &testCA{cert: ca.Cert, pem: certPEM, key: k, ca: ca}
}

// issue cấp chứng chỉ client với CN và thời hạn tùy ý (để thử CN sai, hết hạn), ghi vào thư mục node.
func (c *testCA) issue(t *testing.T, cn string, nb, na time.Time) (dir, fp string) {
	t.Helper()
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: nb, NotAfter: na, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.cert, &k.PublicKey, c.key)
	if err != nil {
		t.Fatal(err)
	}
	kd, _ := x509.MarshalPKCS8PrivateKey(k)
	dir = t.TempDir()
	write := func(n string, b []byte) {
		if err := os.WriteFile(filepath.Join(dir, n), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("node.pem", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	write("node.key", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}))
	sum := sha256.Sum256(der)
	return dir, hex.EncodeToString(sum[:])
}

type rig struct {
	ca      *testCA
	hub     *Hub
	srv     *Server
	pub     *httptest.Server
	sock    *httptest.Server
	handled atomic.Int32
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{ca: newTestCA(t)}
	sc, sk, err := r.ca.ca.NewServerCert([]string{"127.0.0.1"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(sc, sk)
	if err != nil {
		t.Fatal(err)
	}
	r.hub, err = NewHub(filepath.Join(t.TempDir(), "state.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	r.srv = &Server{Hub: r.hub, CAPEM: r.ca.pem}
	r.pub = httptest.NewUnstartedServer(r.srv.PublicHandler())
	r.pub.TLS, err = TLSConfig(cert, r.ca.pem)
	if err != nil {
		t.Fatal(err)
	}
	r.pub.StartTLS()
	r.sock = httptest.NewServer(r.srv.SocketHandler())
	t.Cleanup(func() { r.pub.Close(); r.sock.Close() })
	return r
}

// startNode chạy agent node (handler Secure thật: HMAC khóa của server, registry idempotent theo op_id).
func (r *rig) startNode(t *testing.T, dir string) chan struct{} {
	t.Helper()
	reg := registry.New("test")
	if err := reg.Register("system.ping", func(context.Context, *envelope.Envelope) (map[string]any, error) {
		r.handled.Add(1)
		return map[string]any{"pong": true, "agent_version": "test", "mode": "sandbox"}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), r.ca.pem, 0o600); err != nil {
		t.Fatal(err)
	}
	connected := make(chan struct{}, 8)
	n := &Node{RelayURL: r.pub.URL, CertFile: filepath.Join(dir, "node.pem"), KeyFile: filepath.Join(dir, "node.key"),
		CAFile: filepath.Join(dir, "ca.pem"), MinBackoff: 20 * time.Millisecond, MaxBackoff: 100 * time.Millisecond,
		Handler:     server.Secure(server.Config{Registry: reg, Verifier: auth.NewVerifier(nodeKey), Version: "test"}),
		OnConnected: func() { connected <- struct{}{} }}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = n.Run(ctx) }()
	return connected
}

func (r *rig) waitConnected(t *testing.T, ch chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("node không kết nối được relay")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(r.hub.Status()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
}

func expectNoConnect(t *testing.T, ch chan struct{}) {
	t.Helper()
	select {
	case <-ch:
		t.Fatal("relay lẽ ra phải từ chối node")
	case <-time.After(600 * time.Millisecond):
	}
}

var seq atomic.Int32

func envelopeFor(opSeq int) ([]byte, string, int64) {
	n := seq.Add(1)
	nonce := fmt.Sprintf("nonce-%012d-relay", n)
	ts := time.Now().Unix()
	b := fmt.Sprintf(`{"v":1,"op":"system.ping","op_id":"0193a000-0000-7000-8000-%012d:1:1","params":{},"deadline":%q,"ts":%d,"nonce":%q,"requested_by":{"user_uuid":null,"role":"SYSTEM"}}`,
		opSeq, time.Now().Add(time.Minute).UTC().Format(time.RFC3339), ts, nonce)
	return []byte(b), nonce, ts
}

// call mô phỏng Laravel: ký envelope bằng khóa server, gửi qua unix socket của relay.
func (r *rig) call(t *testing.T, uuid string, key []byte, opSeq int) (int, registry.Result) {
	t.Helper()
	body, nonce, ts := envelopeFor(opSeq)
	req, _ := http.NewRequest(http.MethodPost, r.sock.URL+"/v1/nodes/"+uuid+"/ops", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderSignature, auth.Sign(key, "POST", "/v1/ops", ts, nonce, body))
	req.Header.Set(auth.HeaderTimestamp, strconv.FormatInt(ts, 10))
	req.Header.Set(auth.HeaderNonce, nonce)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var res registry.Result
	b, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(b, &res)
	return resp.StatusCode, res
}

func TestRoundTripAndStatus(t *testing.T) {
	r := newRig(t)
	dir, fp := r.ca.issue(t, nodeUUID, time.Now().Add(-time.Minute), time.Now().Add(24*time.Hour))
	r.waitConnected(t, r.startNode(t, dir))
	code, res := r.call(t, nodeUUID, nodeKey, 1)
	if code != 200 || !res.OK {
		t.Fatalf("code=%d res=%+v", code, res)
	}
	st := r.hub.Status()
	if len(st) != 1 || st[0].ServerUUID != nodeUUID || st[0].Fingerprint != fp || !st[0].Connected {
		t.Fatalf("status = %+v", st)
	}
	resp, err := http.Get(r.sock.URL + "/v1/status")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("GET /v1/status: %v %v", err, resp)
	}
	_ = resp.Body.Close()
}

func TestWrongServerKeyRejectedByAgent(t *testing.T) {
	r := newRig(t)
	dir, _ := r.ca.issue(t, nodeUUID, time.Now().Add(-time.Minute), time.Now().Add(24*time.Hour))
	r.waitConnected(t, r.startNode(t, dir))
	_, res := r.call(t, nodeUUID, otherKey, 2)
	if res.OK || res.Error == nil || res.Error.Code != "unauthorized_caller" {
		t.Fatalf("envelope ký sai khóa phải bị agent từ chối, res=%+v", res)
	}
	if r.handled.Load() != 0 {
		t.Fatal("handler không được chạy")
	}
}

func TestNotConnectedIs503(t *testing.T) {
	r := newRig(t)
	code, _ := r.call(t, nodeUUID, nodeKey, 3)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, muốn 503 agent_unreachable", code)
	}
	if c, _ := r.call(t, "not-a-uuid", nodeKey, 3); c != http.StatusBadRequest {
		t.Fatalf("uuid sai: code = %d", c)
	}
}

func TestRejectsBadCertificates(t *testing.T) {
	r := newRig(t)
	other := newTestCA(t)
	cases := map[string]func() string{
		"CA khác": func() string {
			d, _ := other.issue(t, nodeUUID, time.Now().Add(-time.Minute), time.Now().Add(time.Hour))
			return d
		},
		"hết hạn": func() string {
			d, _ := r.ca.issue(t, nodeUUID, time.Now().Add(-48*time.Hour), time.Now().Add(-time.Hour))
			return d
		},
		"CN không phải uuid": func() string {
			d, _ := r.ca.issue(t, "srv-hn-02", time.Now().Add(-time.Minute), time.Now().Add(time.Hour))
			return d
		},
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			expectNoConnect(t, r.startNode(t, mk()))
			if len(r.hub.Status()) != 0 {
				t.Fatalf("hub không được nhận node: %+v", r.hub.Status())
			}
		})
	}
	// Không có chứng chỉ client: /v1/agent trả 401, /v1/ca vẫn mở.
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(r.ca.pem)
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
	resp, err := c.Get(r.pub.URL + AgentPath)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("thiếu chứng chỉ client: %v %v", err, resp)
	}
	_ = resp.Body.Close()
	resp, err = c.Get(r.pub.URL + "/v1/ca")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("GET /v1/ca: %v %v", err, resp)
	}
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !bytes.Equal(b, r.ca.pem) {
		t.Fatal("/v1/ca phải trả đúng CA PEM")
	}
}

func TestRevocationCutsAndBlocks(t *testing.T) {
	r := newRig(t)
	dir, fp := r.ca.issue(t, nodeUUID, time.Now().Add(-time.Minute), time.Now().Add(time.Hour))
	ch := r.startNode(t, dir)
	r.waitConnected(t, ch)
	body := strings.NewReader(`{"fingerprints":["` + fp + `"]}`)
	req, _ := http.NewRequest(http.MethodPut, r.sock.URL+"/v1/revocations", body)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("PUT /v1/revocations: %v %v", err, resp)
	}
	_ = resp.Body.Close()
	expectNoConnect(t, ch)
	if code, _ := r.call(t, nodeUUID, nodeKey, 4); code != http.StatusServiceUnavailable {
		t.Fatalf("node bị thu hồi vẫn nhận op: %d", code)
	}
	// Danh sách thu hồi được lưu: hub mới đọc lại vẫn chặn.
	h2, err := NewHub(r.hub.StateFile, nil)
	if err != nil || !h2.IsRevoked(fp) {
		t.Fatalf("danh sách thu hồi không được lưu: %v", err)
	}
	bad, _ := http.NewRequest(http.MethodPut, r.sock.URL+"/v1/revocations", strings.NewReader(`{"fingerprints":["xyz"]}`))
	if resp, _ := http.DefaultClient.Do(bad); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("fingerprint sai định dạng: %d", resp.StatusCode)
	}
}

func TestReconnectKeepsOpIDIdempotent(t *testing.T) {
	r := newRig(t)
	dir, fp := r.ca.issue(t, nodeUUID, time.Now().Add(-time.Minute), time.Now().Add(time.Hour))
	ch := r.startNode(t, dir)
	r.waitConnected(t, ch)
	if _, res := r.call(t, nodeUUID, nodeKey, 5); !res.OK {
		t.Fatalf("lần 1: %+v", res)
	}
	// Cắt kết nối (thu hồi rồi bỏ thu hồi) → node tự quay số lại.
	if err := r.hub.SetRevoked([]string{fp}); err != nil {
		t.Fatal(err)
	}
	if err := r.hub.SetRevoked(nil); err != nil {
		t.Fatal(err)
	}
	r.waitConnected(t, ch)
	_, res := r.call(t, nodeUUID, nodeKey, 5) // worker thử lại cùng op_id (chữ ký/nonce mới)
	if !res.OK || !res.Cached {
		t.Fatalf("lần 2 phải trả kết quả cache theo op_id: %+v", res)
	}
	if r.handled.Load() != 1 {
		t.Fatalf("handler chạy %d lần, muốn 1", r.handled.Load())
	}
}

func TestEnrollForwardSignedAndRateLimited(t *testing.T) {
	r := newRig(t)
	relayKey := []byte(strings.Repeat("r", 40))
	var gotIP string
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		ts, _ := strconv.ParseInt(req.Header.Get(HeaderRelayTimestamp), 10, 64)
		if req.Header.Get(HeaderRelaySignature) != SignEnroll(relayKey, ts, b) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		gotIP = req.Header.Get(HeaderRelayClientIP)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"server_uuid":"` + nodeUUID + `"}`))
	}))
	defer panel.Close()
	r.srv.EnrollURL, r.srv.RelayKey = panel.URL, relayKey
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(r.ca.pem)
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
	post := func() int {
		resp, err := c.Post(r.pub.URL+"/v1/enroll", "application/json", strings.NewReader(`{"token":"x"}`))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if code := post(); code != http.StatusCreated || gotIP != "127.0.0.1" {
		t.Fatalf("enroll chuyển tiếp: %d ip=%q", code, gotIP)
	}
	for i := 1; i < EnrollLimit; i++ {
		post()
	}
	if code := post(); code != http.StatusTooManyRequests {
		t.Fatalf("lần thứ %d phải bị giới hạn: %d", EnrollLimit+1, code)
	}
	if resp, _ := c.Post(r.pub.URL+"/v1/enroll", "application/json", strings.NewReader(`{`)); resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("vẫn bị giới hạn trước khi kiểm body: %d", resp.StatusCode)
	}
}
