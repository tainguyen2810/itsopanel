// Package pki là CA nội bộ của ITSO Panel (D-90, ADR 0036): CA ECDSA P-256 tự ký trên control plane,
// ký CSR của node (CN = server_uuid, chỉ ClientAuth, tối đa 30 ngày), sinh khóa + CSR trên node.
// Khóa riêng của node không bao giờ rời node; khóa CA chỉ agent local (root) đọc.
package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"regexp"
	"time"
)

// MaxTTL là thời hạn tối đa của chứng chỉ node.
const MaxTTL = 30 * 24 * time.Hour

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// CA giữ chứng chỉ + khóa CA trong bộ nhớ.
type CA struct {
	Cert    *x509.Certificate
	CertPEM []byte
	key     *ecdsa.PrivateKey
}

// Issued là chứng chỉ vừa cấp.
type Issued struct {
	CertPEM     []byte
	Serial      string
	Fingerprint string
	NotBefore   time.Time
	NotAfter    time.Time
}

// NewCA tạo CA mới (hạn 10 năm). Trả PEM chứng chỉ và PEM khóa (PKCS#8).
func NewCA(commonName string, now time.Time) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := randSerial()
	if err != nil {
		return nil, nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: commonName, Organization: []string{"ITSO Panel"}},
		NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(10, 0, 0),
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign, BasicConstraintsValid: true, IsCA: true,
		MaxPathLen: 0, MaxPathLenZero: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	kd, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}), nil
}

// LoadCA đọc CA từ PEM.
func LoadCA(certPEM, keyPEM []byte) (*CA, error) {
	cert, err := ParseCert(certPEM)
	if err != nil {
		return nil, fmt.Errorf("chứng chỉ CA: %w", err)
	}
	if !cert.IsCA {
		return nil, errors.New("chứng chỉ không phải CA")
	}
	key, err := ParseKey(keyPEM)
	if err != nil {
		return nil, fmt.Errorf("khóa CA: %w", err)
	}
	if !key.PublicKey.Equal(cert.PublicKey) {
		return nil, errors.New("khóa CA không khớp chứng chỉ")
	}
	return &CA{Cert: cert, CertPEM: certPEM, key: key}, nil
}

// ValidUUID kiểm server_uuid (dạng uuid chữ thường).
func ValidUUID(s string) bool { return uuidRe.MatchString(s) }

// EnrollCN là CN của CSR lúc join: node chưa biết server_uuid, panel cấp uuid và chứng chỉ luôn mang
// CN = server_uuid. Khi xoay vòng, CSR bắt buộc CN = server_uuid.
const EnrollCN = "itso-enroll"

// SignCSR ký CSR của node. Kiểm: một khối PEM CSR, chữ ký hợp lệ, khóa ECDSA P-256, CN = serverUUID.
// Mọi extension xin thêm (SAN, IsCA, KeyUsage) bị bỏ: chứng chỉ chỉ dùng ClientAuth.
func (ca *CA) SignCSR(csrPEM []byte, serverUUID string, ttl time.Duration, now time.Time) (*Issued, error) {
	if !uuidRe.MatchString(serverUUID) {
		return nil, errors.New("server_uuid không hợp lệ")
	}
	if ttl <= 0 || ttl > MaxTTL {
		return nil, fmt.Errorf("thời hạn phải trong (0, %s]", MaxTTL)
	}
	csr, err := ParseCSR(csrPEM)
	if err != nil {
		return nil, err
	}
	if csr.Subject.CommonName != serverUUID && csr.Subject.CommonName != EnrollCN {
		return nil, fmt.Errorf("CN của CSR (%q) khác server_uuid", csr.Subject.CommonName)
	}
	serial, err := randSerial()
	if err != nil {
		return nil, err
	}
	nb := now.Add(-time.Minute)
	tpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: serverUUID, Organization: []string{"ITSO Panel node"}},
		NotBefore: nb, NotAfter: now.Add(ttl), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, BasicConstraintsValid: true, IsCA: false,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.Cert, csr.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}
	return &Issued{CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		Serial: hex.EncodeToString(serial.Bytes()), Fingerprint: Fingerprint(der), NotBefore: tpl.NotBefore, NotAfter: tpl.NotAfter}, nil
}

// ParseCSR đọc đúng MỘT khối CSR (không nhận khối thừa như khóa riêng) và kiểm chữ ký + loại khóa.
func ParseCSR(csrPEM []byte) (*x509.CertificateRequest, error) {
	block, rest := pem.Decode(csrPEM)
	if block == nil || block.Type != "CERTIFICATE REQUEST" {
		return nil, errors.New("CSR không phải PEM CERTIFICATE REQUEST")
	}
	if len(trimSpace(rest)) != 0 {
		return nil, errors.New("CSR có dữ liệu thừa sau khối PEM")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("CSR: %w", err)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, fmt.Errorf("chữ ký CSR: %w", err)
	}
	pub, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, errors.New("CSR phải dùng khóa ECDSA P-256")
	}
	return csr, nil
}

// NewKeyAndCSR (serverUUID = EnrollCN khi join) sinh khóa ECDSA P-256 + CSR CN = serverUUID (chạy trên node).
func NewKeyAndCSR(serverUUID string) (keyPEM, csrPEM []byte, err error) {
	if !uuidRe.MatchString(serverUUID) && serverUUID != EnrollCN {
		return nil, nil, errors.New("server_uuid không hợp lệ")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: serverUUID}}, key)
	if err != nil {
		return nil, nil, err
	}
	kd, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

// ParseCert đọc chứng chỉ đầu tiên trong PEM.
func ParseCert(certPEM []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("không phải PEM CERTIFICATE")
	}
	return x509.ParseCertificate(block.Bytes)
}

// ParseKey đọc khóa ECDSA (PKCS#8 hoặc SEC1).
func ParseKey(keyPEM []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, errors.New("không phải PEM")
	}
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if ek, ok := k.(*ecdsa.PrivateKey); ok {
			return ek, nil
		}
		return nil, errors.New("khóa không phải ECDSA")
	}
	return x509.ParseECPrivateKey(block.Bytes)
}

// Fingerprint là sha256 hex của DER chứng chỉ.
func Fingerprint(der []byte) string {
	s := sha256.Sum256(der)
	return hex.EncodeToString(s[:])
}

// PEMFingerprint là sha256 hex của chứng chỉ PEM đầu tiên (dùng cho ghim CA: --ca-sha256).
func PEMFingerprint(certPEM []byte) (string, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", errors.New("không phải PEM CERTIFICATE")
	}
	return Fingerprint(block.Bytes), nil
}

func randSerial() (*big.Int, error) {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	return n.Add(n, big.NewInt(1<<62)), nil // ≥ 8 byte để serial hex luôn ≥ 16 ký tự
}

func trimSpace(b []byte) []byte {
	for len(b) > 0 && (b[0] == '\n' || b[0] == '\r' || b[0] == ' ' || b[0] == '\t') {
		b = b[1:]
	}
	return b
}

// NewServerCert cấp chứng chỉ TLS server cho itso-relay (ServerAuth, SAN là tên/IP của control plane).
// Hạn 1 năm; installer cấp lại khi `itso pki rotate-relay`. Trả PEM chứng chỉ và PEM khóa.
func (ca *CA) NewServerCert(hosts []string, now time.Time) (certPEM, keyPEM []byte, err error) {
	if len(hosts) == 0 {
		return nil, nil, errors.New("cần ít nhất một tên máy chủ")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := randSerial()
	if err != nil {
		return nil, nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: hosts[0], Organization: []string{"ITSO Panel relay"}},
		NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true,
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
		} else {
			tpl.DNSNames = append(tpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.Cert, &key.PublicKey, ca.key)
	if err != nil {
		return nil, nil, err
	}
	kd, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}), nil
}
