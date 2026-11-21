package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"strings"
	"testing"
	"time"
)

const srv = "01938a02-0004-7000-8000-000002000004"

func newCA(t *testing.T) *CA {
	t.Helper()
	c, k, err := NewCA("ITSO test CA", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ca, err := LoadCA(c, k)
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

func TestSignCSRIssuesClientCertBoundToServer(t *testing.T) {
	ca := newCA(t)
	_, csr, err := NewKeyAndCSR(srv)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	is, err := ca.SignCSR(csr, srv, 30*24*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := ParseCert(is.CertPEM)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Subject.CommonName != srv || cert.IsCA || len(cert.ExtKeyUsage) != 1 || cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Fatalf("chứng chỉ sai: CN=%s CA=%v EKU=%v", cert.Subject.CommonName, cert.IsCA, cert.ExtKeyUsage)
	}
	if len(cert.DNSNames) != 0 || len(cert.IPAddresses) != 0 {
		t.Fatal("không được có SAN")
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.Cert)
	if _, err := cert.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatalf("không xác minh được với CA: %v", err)
	}
	if len(is.Serial) < 16 || len(is.Fingerprint) != 64 {
		t.Fatalf("serial/fingerprint: %q %q", is.Serial, is.Fingerprint)
	}
	if d := is.NotAfter.Sub(now); d > MaxTTL {
		t.Fatalf("hạn quá 30 ngày: %s", d)
	}
}

func TestSignCSRRejects(t *testing.T) {
	ca := newCA(t)
	_, csrOther, _ := NewKeyAndCSR("01938a02-0009-7000-8000-000002000009")
	if _, err := ca.SignCSR(csrOther, srv, time.Hour, time.Now()); err == nil || !strings.Contains(err.Error(), "CN") {
		t.Fatalf("CN khác server_uuid phải bị từ chối: %v", err)
	}
	_, csr, _ := NewKeyAndCSR(srv)
	if _, err := ca.SignCSR(csr, srv, 31*24*time.Hour, time.Now()); err == nil {
		t.Fatal("hạn > 30 ngày phải bị từ chối")
	}
	if _, err := ca.SignCSR(csr, "../etc", time.Hour, time.Now()); err == nil {
		t.Fatal("server_uuid sai phải bị từ chối")
	}
	// Khóa riêng kèm sau CSR → dữ liệu thừa.
	withKey := append(append([]byte{}, csr...), []byte("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n")...)
	if _, err := ca.SignCSR(withKey, srv, time.Hour, time.Now()); err == nil {
		t.Fatal("CSR kèm khối thừa phải bị từ chối")
	}
	// Khóa RSA.
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: srv}}, rk)
	rsaCSR := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
	if _, err := ca.SignCSR(rsaCSR, srv, time.Hour, time.Now()); err == nil || !strings.Contains(err.Error(), "P-256") {
		t.Fatalf("RSA phải bị từ chối: %v", err)
	}
	// P-384.
	k384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	der, _ = x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: srv}}, k384)
	if _, err := ca.SignCSR(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), srv, time.Hour, time.Now()); err == nil {
		t.Fatal("P-384 phải bị từ chối")
	}
	// CSR xin IsCA + SAN: vẫn ký nhưng bỏ hết.
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ = x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: srv},
		DNSNames: []string{"admin.itso.local"}}, k)
	is, err := ca.SignCSR(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), srv, time.Hour, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	c, _ := ParseCert(is.CertPEM)
	if len(c.DNSNames) != 0 {
		t.Fatal("SAN xin thêm phải bị bỏ")
	}
}

func TestLoadCARejectsMismatchedKey(t *testing.T) {
	c1, _, _ := NewCA("a", time.Now())
	_, k2, _ := NewCA("b", time.Now())
	if _, err := LoadCA(c1, k2); err == nil {
		t.Fatal("khóa khác chứng chỉ phải bị từ chối")
	}
	fp, err := PEMFingerprint(c1)
	if err != nil || len(fp) != 64 {
		t.Fatal(fp, err)
	}
}
