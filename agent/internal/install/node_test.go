package install_test

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"itso.local/agent/internal/install"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/pki"
)

const (
	joinToken = "itso_enr_abcdefghijklmnopqrstuvwxyz0123456789AB"
	joinUUID  = "01938a01-0002-7000-8000-0000000000aa"
	joinHMAC  = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" // 43 ký tự base64url
)

// fakeCP là control plane giả: relay TLS (chứng chỉ do CA nội bộ cấp) + enroll ký CSR như panel thật.
type fakeCP struct {
	srv     *httptest.Server
	ca      *pki.CA
	pin     string
	enrolls atomic.Int32
	token   atomic.Value
	evil    bool // trả chứng chỉ cho khóa khác
}

func newFakeCP(t *testing.T) *fakeCP {
	t.Helper()
	certPEM, keyPEM, err := pki.NewCA("cp CA", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeCP{}
	f.ca, _ = pki.LoadCA(certPEM, keyPEM)
	f.pin, _ = pki.PEMFingerprint(certPEM)
	sc, sk, _ := f.ca.NewServerCert([]string{"127.0.0.1"}, time.Now())
	cert, _ := tls.X509KeyPair(sc, sk)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/ca", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(certPEM) })
	mux.HandleFunc("POST /v1/enroll", func(w http.ResponseWriter, r *http.Request) {
		f.enrolls.Add(1)
		var in struct {
			Token, CSR, Hostname string
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &in)
		f.token.Store(in.Token)
		if in.Token != joinToken {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"type":"about:blank","title":"Không join được","status":422,"code":"enrollment_invalid","detail":"token sai hoặc đã dùng"}`))
			return
		}
		csr := in.CSR
		if f.evil {
			_, other, _ := pki.NewKeyAndCSR(pki.EnrollCN)
			csr = string(other)
		}
		is, err := f.ca.SignCSR([]byte(csr), joinUUID, pki.MaxTTL, time.Now())
		if err != nil {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"server_uuid": joinUUID, "cert_pem": string(is.CertPEM),
			"chain_pem": string(certPEM), "ca_sha256": f.pin, "hmac_key": joinHMAC, "relay_url": "https://cp.itso.local:28444"}})
	})
	f.srv = httptest.NewUnstartedServer(mux)
	f.srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}
	f.srv.StartTLS()
	t.Cleanup(f.srv.Close)
	return f
}

func nodeRig(t *testing.T) *rig {
	r := newRig(t)
	r.e.HTTP = func(tc *tls.Config) *http.Client {
		return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: tc}}
	}
	return r
}

func nodeOpts(dir string, f *fakeCP) install.Options {
	o := opts(dir)
	o.Role, o.Join, o.Token, o.CASHA256 = install.RoleNode, f.srv.URL, joinToken, f.pin
	return o
}

func mode(t *testing.T, r *rig, p string) os.FileMode {
	t.Helper()
	rp, _ := r.fs.Path(p)
	fi, err := os.Stat(rp)
	if err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	return fi.Mode().Perm()
}

func TestInstallControlPlaneCreatesPKIAndRelay(t *testing.T) {
	r := newRig(t)
	o := opts(release(t, "1.0.0"))
	o.Role = install.RoleControlPlane
	if err := r.e.Install(context.Background(), o); err != nil {
		t.Fatal(err, r.out.String())
	}
	for p, want := range map[string]os.FileMode{ops.CAKeyPath: 0o600, ops.CACertPath: 0o644, install.RelayKey: 0o600,
		install.RelayCert: 0o644, install.RelayEnrollKey: 0o640} {
		if m := mode(t, r, p); m != want {
			t.Fatalf("%s quyền %o, muốn %o", p, m, want)
		}
	}
	if o, _ := r.fs.OwnerOf(ops.CAKeyPath); o.UID != 0 {
		t.Fatalf("khóa CA phải thuộc root: %+v", o)
	}
	if o, _ := r.fs.OwnerOf(install.RelayKey); o.UID == 0 {
		t.Fatal("khóa TLS relay phải thuộc user itso-relay")
	}
	if !strings.Contains(string(must(r.fs.ReadFile("/etc/group"))), "itso-relay:x:") ||
		!strings.Contains(strings.Join(r.writes(), "\n"), "gpasswd -a itso itso-relay") {
		t.Fatal("thiếu user/group itso-relay hoặc itso chưa vào nhóm itso-relay")
	}
	if !r.fs.Exists("/etc/systemd/system/itso-relay.service") || !r.fs.Exists("/etc/systemd/system/itso-cert-rotate.timer") {
		t.Fatal("thiếu unit relay / xoay chứng chỉ")
	}
	if r.e.Role() != install.RoleControlPlane {
		t.Fatal(r.e.Role())
	}
	pin, _ := r.e.CAPin()
	if !strings.Contains(r.out.String(), "sha256 "+pin) {
		t.Fatal(r.out.String())
	}
	// Relay cert do CA nội bộ cấp, có SAN là hostname + IP.
	rc, _ := pki.ParseCert(must(r.fs.ReadFile(install.RelayCert)))
	if rc.VerifyHostname("203.0.113.10") != nil || rc.VerifyHostname("srv01.itso.local") != nil {
		t.Fatalf("SAN relay: %v %v", rc.DNSNames, rc.IPAddresses)
	}
	// Chạy lại: không sinh lại CA, không lệnh ghi; đổi vai trò tại chỗ bị từ chối.
	r.fake.Reset()
	if err := r.e.Install(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if w := r.writes(); len(w) != 0 {
		t.Fatalf("chạy lại không được ghi gì: %v", w)
	}
	if err := r.e.PKIInit(); err != nil {
		t.Fatal(err)
	}
	if p2, _ := r.e.CAPin(); p2 != pin {
		t.Fatal("CA bị sinh lại")
	}
	o.Role = install.RoleAllInOne
	if err := r.e.Install(context.Background(), o); err == nil || !strings.Contains(err.Error(), "không đổi vai trò") {
		t.Fatal(err)
	}
}

func TestInstallNodeJoinsWithPinnedCA(t *testing.T) {
	f := newFakeCP(t)
	r := nodeRig(t)
	if err := r.e.Install(context.Background(), nodeOpts(release(t, "1.0.0"), f)); err != nil {
		t.Fatal(err, r.out.String())
	}
	w := strings.Join(r.writes(), "\n")
	for _, bad := range []string{"postgresql-16", "redis-server", "pg_createcluster", "artisan", "itso.target", "useradd"} {
		if strings.Contains(w, bad) {
			t.Fatalf("node không được cài/chạy %q:\n%s", bad, w)
		}
	}
	if !strings.Contains(w, "systemctl enable --now itso-agent-node.service") {
		t.Fatal(w)
	}
	for p, want := range map[string]os.FileMode{ops.NodeKeyPath: 0o600, ops.NodeCertPath: 0o644, ops.NodeCAPath: 0o644,
		install.AgentKey: 0o600, ops.NodeDir: 0o700} {
		if m := mode(t, r, p); m != want {
			t.Fatalf("%s quyền %o, muốn %o", p, m, want)
		}
	}
	if strings.TrimSpace(string(must(r.fs.ReadFile(install.AgentKey)))) != joinHMAC {
		t.Fatal("khóa HMAC riêng chưa được ghi")
	}
	var ni ops.NodeInfo
	_ = json.Unmarshal(must(r.fs.ReadFile(ops.NodeIdentity)), &ni)
	if ni.Role != "node" || ni.ServerUUID != joinUUID || ni.RelayURL != "https://cp.itso.local:28444" {
		t.Fatal(ni)
	}
	c, _ := pki.ParseCert(must(r.fs.ReadFile(ops.NodeCertPath)))
	k, _ := pki.ParseKey(must(r.fs.ReadFile(ops.NodeKeyPath)))
	if c.Subject.CommonName != joinUUID || !k.PublicKey.Equal(c.PublicKey) {
		t.Fatal("chứng chỉ node không khớp khóa sinh trên node / CN")
	}
	out := r.out.String()
	if strings.Contains(out, joinToken) || strings.Contains(out, joinHMAC) || strings.Contains(out, "Mã thiết lập") {
		t.Fatalf("output không được lộ token/khóa, node không có mã thiết lập:\n%s", out)
	}
	if !strings.Contains(out, "Server UUID:  "+joinUUID) || !strings.Contains(out, "KHÔNG mở cổng quản trị inbound") {
		t.Fatal(out)
	}
	for _, f := range []string{install.StateFile} {
		if strings.Contains(string(must(r.fs.ReadFile(f))), joinToken) {
			t.Fatal("token bị ghi xuống đĩa")
		}
	}
	// itso node status / leave.
	r.out.Reset()
	_ = r.e.NodeStatus(context.Background())
	if !strings.Contains(r.out.String(), "Server UUID: "+joinUUID) || !strings.Contains(r.out.String(), "Agent:       active") {
		t.Fatal(r.out.String())
	}
	if err := r.e.NodeLeave(context.Background(), false); err == nil {
		t.Fatal("leave thiếu --yes phải lỗi")
	}
	r.fake.Reset()
	if err := r.e.NodeLeave(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(r.fake.Lines(), "\n"), "systemctl disable --now itso-agent-node.service") {
		t.Fatal(r.fake.Lines())
	}
	for _, p := range []string{ops.NodeKeyPath, ops.NodeCertPath, install.AgentKey, ops.NodeIdentity} {
		if r.fs.Exists(p) {
			t.Fatalf("%s phải bị xóa khi leave", p)
		}
	}
}

func TestJoinRejectsWrongPinBeforeSendingToken(t *testing.T) {
	f := newFakeCP(t)
	r := nodeRig(t)
	j := install.JoinOptions{URL: f.srv.URL, Token: joinToken, CASHA256: strings.Repeat("0", 64)}
	if _, err := r.e.Join(context.Background(), j); err == nil || !strings.Contains(err.Error(), "KHÔNG khớp") {
		t.Fatal(err)
	}
	if f.enrolls.Load() != 0 {
		t.Fatal("token không được gửi khi CA sai pin")
	}
	if r.fs.Exists(ops.NodeKeyPath) || r.fs.Exists(install.AgentKey) {
		t.Fatal("không được ghi gì khi join lỗi")
	}
	// Token sai → control plane từ chối, thông báo rõ.
	j.CASHA256, j.Token = f.pin, "itso_enr_"+strings.Repeat("x", 40)
	if _, err := r.e.Join(context.Background(), j); err == nil || !strings.Contains(err.Error(), "enrollment_invalid") {
		t.Fatal(err)
	}
	// Control plane trả chứng chỉ cho khóa khác → từ chối.
	f.evil, j.Token = true, joinToken
	if _, err := r.e.Join(context.Background(), j); err == nil || !strings.Contains(err.Error(), "không khớp khóa") {
		t.Fatal(err)
	}
	// Cú pháp sai bị chặn trước mọi kết nối.
	before := f.enrolls.Load()
	for _, bad := range []install.JoinOptions{
		{URL: "http://cp:28444", Token: joinToken, CASHA256: f.pin},
		{URL: f.srv.URL + "/x", Token: joinToken, CASHA256: f.pin},
		{URL: f.srv.URL, Token: "abc", CASHA256: f.pin},
		{URL: f.srv.URL, Token: joinToken, CASHA256: "ABC"},
	} {
		if _, err := r.e.Join(context.Background(), bad); err == nil {
			t.Fatalf("phải từ chối %+v", bad)
		}
	}
	if f.enrolls.Load() != before {
		t.Fatal("tham số sai không được gửi đi")
	}
}

func TestNodeInstallNeedsJoinAndRejoin(t *testing.T) {
	f := newFakeCP(t)
	r := nodeRig(t)
	o := nodeOpts(release(t, "1.0.0"), f)
	o.Token = ""
	if err := r.e.Install(context.Background(), o); err == nil || !strings.Contains(err.Error(), "--token") {
		t.Fatal(err)
	}
	ai := opts(release(t, "1.0.0"))
	ai.Token = joinToken
	if err := r.e.Install(context.Background(), ai); err == nil || !strings.Contains(err.Error(), "chỉ dùng với --role node") {
		t.Fatal(err)
	}
	if err := r.e.Install(context.Background(), nodeOpts(release(t, "1.0.0"), f)); err != nil {
		t.Fatal(err)
	}
	old := string(must(r.fs.ReadFile(ops.NodeKeyPath)))
	r.fake.Reset()
	// relay_url trong node.json là tên giả nên truyền --join; thực tế rejoin dùng relay đã lưu.
	if err := r.e.NodeRejoin(context.Background(), install.JoinOptions{URL: f.srv.URL, Token: joinToken, CASHA256: f.pin}); err != nil {
		t.Fatal(err)
	}
	if string(must(r.fs.ReadFile(ops.NodeKeyPath))) == old {
		t.Fatal("rejoin phải sinh khóa mới")
	}
	if !strings.Contains(strings.Join(r.fake.Lines(), "\n"), "systemctl restart itso-agent-node.service") {
		t.Fatal(r.fake.Lines())
	}
	if err := r.e.PKIInit(); err != nil {
		t.Fatal(err) // gọi trực tiếp vẫn được; CLI `itso pki init` chặn trên node
	}
}

func TestNodeUpdateAndRollbackSkipPanel(t *testing.T) {
	f := newFakeCP(t)
	r := nodeRig(t)
	if err := r.e.Install(context.Background(), nodeOpts(release(t, "1.0.0"), f)); err != nil {
		t.Fatal(err)
	}
	r.fake.Reset()
	if err := r.e.Update(context.Background(), release(t, "1.1.0")); err != nil {
		t.Fatal(err, r.out.String())
	}
	w := strings.Join(r.fake.Lines(), "\n")
	if strings.Contains(w, "pg_dump") || strings.Contains(w, "artisan") || strings.Contains(w, "itso.target") ||
		!strings.Contains(w, "systemctl restart itso-agent-node.service") {
		t.Fatalf("update node chỉ đổi release + khởi động lại agent node:\n%s", w)
	}
	if r.e.CurrentVersion() != "1.1.0" {
		t.Fatal(r.e.CurrentVersion())
	}
	r.fake.Reset()
	if err := r.e.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(r.fake.Lines(), "\n"), "systemctl restart itso-agent-node.service") || r.e.CurrentVersion() != "1.0.0" {
		t.Fatal(r.fake.Lines())
	}
}
