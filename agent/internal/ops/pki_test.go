package ops_test

import (
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/pki"
)

const testNode = "01938a01-0002-7000-8000-000000000002"

func withCA(t *testing.T, e *env, dir string) *pki.CA {
	t.Helper()
	certPEM, keyPEM, err := pki.NewCA("test CA", ct.Now)
	if err != nil {
		t.Fatal(err)
	}
	write(t, e.fs.Root, dir+"/ca.pem", string(certPEM))
	if dir == "/etc/itso/pki" {
		write(t, e.fs.Root, dir+"/ca.key", string(keyPEM))
	}
	ca, err := pki.LoadCA(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

func TestPkiSignCSR(t *testing.T) {
	e := newEnv(t)
	_, csr, _ := pki.NewKeyAndCSR(testNode)
	params := map[string]any{"server_uuid": testNode, "csr": string(csr), "ttl_days": 30}
	e.h.Fail(contracts.OpPkiSignCsr, params, "precondition_failed") // chưa itso pki init
	withCA(t, e, "/etc/itso/pki")
	d := e.h.OK(contracts.OpPkiSignCsr, params)
	cert, err := pki.ParseCert([]byte(d["cert_pem"].(string)))
	if err != nil || cert.Subject.CommonName != testNode || cert.NotAfter.Sub(ct.Now) > 30*24*time.Hour {
		t.Fatalf("chứng chỉ sai: %v %+v", err, cert)
	}
	if fp, _ := pki.PEMFingerprint([]byte(d["cert_pem"].(string))); fp != d["fingerprint_sha256"] {
		t.Fatal("fingerprint không khớp chứng chỉ")
	}
	// CSR của server khác (CN ≠ server_uuid) bị từ chối.
	_, other, _ := pki.NewKeyAndCSR("01938a01-0002-7000-8000-000000000099")
	e.h.Fail(contracts.OpPkiSignCsr, map[string]any{"server_uuid": testNode, "csr": string(other), "ttl_days": 30}, "enrollment_invalid")
	// Agent chế độ node không bao giờ ký CSR.
	e.d.NodeMode = true
	e.h.Fail(contracts.OpPkiSignCsr, params, "op_disabled")
}

func TestAgentCertRotateTwoPhase(t *testing.T) {
	e := newEnv(t)
	p1 := map[string]any{"server_uuid": testNode, "cert_pem": nil}
	e.h.Fail(contracts.OpAgentCertRotate, p1, "precondition_failed") // chưa join
	write(t, e.fs.Root, ops.NodeIdentity, `{"role":"node","server_uuid":"`+testNode+`","relay_url":"https://cp:28444"}`)
	ca := withCA(t, e, ops.NodeDir)
	d := e.h.OK(contracts.OpAgentCertRotate, p1)
	if d["installed"] != false || d["csr"] == nil {
		t.Fatal(d)
	}
	iss, err := ca.SignCSR([]byte(d["csr"].(string)), testNode, pki.MaxTTL, ct.Now)
	if err != nil {
		t.Fatal(err)
	}
	// Chứng chỉ không khớp khóa chờ (khóa khác) → từ chối, chứng chỉ cũ giữ nguyên.
	_, strayCSR, _ := pki.NewKeyAndCSR(testNode)
	stray, _ := ca.SignCSR(strayCSR, testNode, pki.MaxTTL, ct.Now)
	e.h.Fail(contracts.OpAgentCertRotate, map[string]any{"server_uuid": testNode, "cert_pem": string(stray.CertPEM)}, "precondition_failed")
	// Chứng chỉ do CA khác cấp → từ chối.
	otherCert, otherKey, _ := pki.NewCA("evil", ct.Now)
	evil, _ := pki.LoadCA(otherCert, otherKey)
	bad, _ := evil.SignCSR([]byte(d["csr"].(string)), testNode, pki.MaxTTL, ct.Now)
	e.h.Fail(contracts.OpAgentCertRotate, map[string]any{"server_uuid": testNode, "cert_pem": string(bad.CertPEM)}, "precondition_failed")
	// Đúng chứng chỉ → cài nguyên tử, khóa chờ thành khóa chính.
	d = e.h.OK(contracts.OpAgentCertRotate, map[string]any{"server_uuid": testNode, "cert_pem": string(iss.CertPEM)})
	if d["installed"] != true || d["fingerprint_sha256"] != iss.Fingerprint {
		t.Fatal(d)
	}
	if fp, _ := pki.PEMFingerprint([]byte(e.file(ops.NodeCertPath))); fp != iss.Fingerprint {
		t.Fatal("node.pem chưa được thay")
	}
	key, err := pki.ParseKey([]byte(e.file(ops.NodeKeyPath)))
	cert, _ := pki.ParseCert(iss.CertPEM)
	if err != nil || !key.PublicKey.Equal(cert.PublicKey) {
		t.Fatal("node.key không khớp chứng chỉ mới")
	}
	if _, err := e.fs.ReadFile(ops.NodePendingPath); err == nil {
		t.Fatal("khóa chờ phải được dời đi")
	}
	// server_uuid khác danh tính node → từ chối.
	e.h.Fail(contracts.OpAgentCertRotate, map[string]any{"server_uuid": "01938a01-0002-7000-8000-000000000099", "cert_pem": nil}, "precondition_failed")
}
