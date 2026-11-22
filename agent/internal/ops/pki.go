package ops

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/pki"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Đường dẫn PKI (ADR 0036). CA chỉ có trên control plane / all-in-one; chứng chỉ node chỉ có trên node.
const (
	CACertPath      = "/etc/itso/pki/ca.pem"
	CAKeyPath       = "/etc/itso/pki/ca.key"
	NodeDir         = "/etc/itso/node"
	NodeCertPath    = NodeDir + "/node.pem"
	NodeKeyPath     = NodeDir + "/node.key"
	NodePendingPath = NodeDir + "/node.key.pending"
	NodeCAPath      = NodeDir + "/ca.pem"
	NodeIdentity    = "/etc/itso/node.json"
)

// NodeInfo là /etc/itso/node.json (installer ghi khi join).
type NodeInfo struct {
	Role       string `json:"role"`
	ServerUUID string `json:"server_uuid"`
	RelayURL   string `json:"relay_url"`
}

var rootOwner = platform.Owner{UID: 0, GID: 0}

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpPkiSignCsr:      d.pkiSignCSR,
			contracts.OpAgentCertRotate: d.agentCertRotate,
		}
	})
}

// pkiSignCSR ký CSR của node bằng CA nội bộ. Op chỉ bật trên agent local của control plane
// (agent chế độ node chặn op này dù policy bật).
func (d *Deps) pkiSignCSR(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	if d.NodeMode {
		return nil, &registry.OpError{Code: "op_disabled", Message: "pki.sign_csr chỉ chạy trên control plane"}
	}
	var p contracts.PkiSignCsrParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	certPEM, err := d.FS.ReadFile(CACertPath)
	if err != nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "chưa có CA nội bộ (itso pki init)"}
	}
	keyPEM, err := d.FS.ReadFile(CAKeyPath)
	if err != nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "không đọc được khóa CA"}
	}
	ca, err := pki.LoadCA(certPEM, keyPEM)
	if err != nil {
		return nil, &registry.OpError{Code: "internal", Message: err.Error()}
	}
	is, err := ca.SignCSR([]byte(p.Csr), string(p.ServerUUID), time.Duration(p.TTLDays)*24*time.Hour, d.now())
	if err != nil {
		return nil, &registry.OpError{Code: "enrollment_invalid", Message: err.Error()}
	}
	return toData(contracts.PkiSignCsrResult{CertPem: contracts.CertPem(is.CertPEM), ChainPem: contracts.CertPem(certPEM),
		Serial: is.Serial, FingerprintSHA256: contracts.SHA256(is.Fingerprint),
		NotBefore: is.NotBefore.UTC().Format(time.RFC3339), NotAfter: is.NotAfter.UTC().Format(time.RFC3339)})
}

// ReadNodeInfo đọc /etc/itso/node.json.
func ReadNodeInfo(fs *platform.FS) (NodeInfo, error) {
	var n NodeInfo
	b, err := fs.ReadFile(NodeIdentity)
	if err != nil {
		return n, err
	}
	err = json.Unmarshal(b, &n)
	return n, err
}

// agentCertRotate xoay chứng chỉ node hai pha (ADR 0036 §3): không có cert_pem → sinh khóa chờ + trả CSR;
// có cert_pem → kiểm khớp khóa chờ, CN = server_uuid, ký bởi CA đã ghim, rồi thay chứng chỉ + khóa nguyên tử.
// Kết nối relay tiếp theo dùng chứng chỉ mới (dialer đọc lại file mỗi lần bắt tay).
func (d *Deps) agentCertRotate(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.AgentCertRotateParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	info, err := ReadNodeInfo(d.FS)
	if err != nil || info.Role != "node" {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "máy này không phải node (thiếu /etc/itso/node.json)"}
	}
	if info.ServerUUID != string(p.ServerUUID) {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "server_uuid khác danh tính node"}
	}
	var certPEM string
	if len(p.CertPem) > 0 && string(p.CertPem) != "null" {
		if err := json.Unmarshal(p.CertPem, &certPEM); err != nil {
			return nil, &registry.OpError{Code: "invalid_params", Message: "cert_pem không hợp lệ"}
		}
	}
	if certPEM == "" {
		keyPEM, csrPEM, err := pki.NewKeyAndCSR(info.ServerUUID)
		if err != nil {
			return nil, opErr(err)
		}
		if _, err := d.FS.WriteAtomic(NodePendingPath, keyPEM, 0o600, rootOwner); err != nil {
			return nil, opErr(err)
		}
		csr, _ := json.Marshal(string(csrPEM))
		return toData(contracts.AgentCertRotateResult{Csr: csr, Installed: false, FingerprintSHA256: json.RawMessage("null")})
	}
	pending, err := d.FS.ReadFile(NodePendingPath)
	if err != nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "không có khóa chờ: gọi lại pha 1 trước"}
	}
	key, err := pki.ParseKey(pending)
	if err != nil {
		return nil, opErr(err)
	}
	cert, err := pki.ParseCert([]byte(certPEM))
	if err != nil {
		return nil, &registry.OpError{Code: "invalid_params", Message: "cert_pem: " + err.Error()}
	}
	if !key.PublicKey.Equal(cert.PublicKey) {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "chứng chỉ không khớp khóa chờ"}
	}
	if cert.Subject.CommonName != info.ServerUUID {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "CN chứng chỉ khác server_uuid"}
	}
	caPEM, err := d.FS.ReadFile(NodeCAPath)
	if err != nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "thiếu CA đã ghim (" + NodeCAPath + ")"}
	}
	if ca, err := pki.ParseCert(caPEM); err != nil || cert.CheckSignatureFrom(ca) != nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "chứng chỉ không do CA đã ghim cấp"}
	}
	if d.now().After(cert.NotAfter) {
		return nil, &registry.OpError{Code: "cert_expired", Message: "chứng chỉ mới đã hết hạn"}
	}
	if _, err := d.FS.WriteAtomic(NodeCertPath, []byte(strings.TrimSpace(certPEM)+"\n"), 0o644, rootOwner); err != nil {
		return nil, opErr(err)
	}
	if err := d.FS.Rename(NodePendingPath, NodeKeyPath); err != nil {
		return nil, opErr(err)
	}
	fp, _ := json.Marshal(pki.Fingerprint(cert.Raw))
	return toData(contracts.AgentCertRotateResult{Csr: json.RawMessage("null"), Installed: true, FingerprintSHA256: fp})
}
