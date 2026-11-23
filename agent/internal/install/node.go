package install

// Phase 9 (ADR 0034/0036, D-88): vai trò cài đặt, CA nội bộ, join node qua itso-relay, `itso node`.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/pki"
	"itso.local/agent/internal/platform"
)

// Vai trò cài đặt (D-88).
const (
	RoleAllInOne     = "all-in-one"
	RoleControlPlane = "control-plane"
	RoleNode         = "node"
)

// Đường dẫn relay trên control plane (ADR 0035).
const (
	RelayDir       = "/etc/itso/relay"
	RelayCert      = RelayDir + "/relay.pem"
	RelayKey       = RelayDir + "/relay.key"
	RelayEnrollKey = RelayDir + "/enroll.key"
	RelayPort      = 28444
	NodeUnit       = "itso-agent-node.service"
)

var (
	tokenRe = regexp.MustCompile(`^itso_enr_[A-Za-z0-9_-]{32,64}$`)
	pinRe   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hmacRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

// ValidRole kiểm --role.
func ValidRole(r string) bool { return r == RoleAllInOne || r == RoleControlPlane || r == RoleNode }

// StepsFor trả các bước cài theo vai trò. Node không cài Laravel, PostgreSQL, Redis, itso-relay.
func StepsFor(role string) []Step {
	if role == RoleNode {
		return []Step{
			{"users", "Tạo group hệ thống", stepNodeUsers},
			{"packages", "Cài gói tối thiểu cho node (apt)", stepNodePackages},
			{"release", "Giải nén bản phát hành", stepRelease},
			{"join", "Join control plane (ghim CA, CSR, chứng chỉ, khóa HMAC)", stepJoin},
			{"systemd", "Bật itso-agent chế độ node", stepNodeSystemd},
			{"firewall", "Tường lửa cơ bản", stepFirewall},
		}
	}
	out := make([]Step, 0, len(Steps)+2)
	for _, s := range Steps {
		if s.Name == "systemd" {
			out = append(out, Step{"pki", "CA nội bộ + chứng chỉ itso-relay", stepPKI})
		}
		out = append(out, s)
	}
	return out
}

func (e *Env) nodeInfo() (ops.NodeInfo, bool) {
	var n ops.NodeInfo
	ok, err := e.readJSON(ops.NodeIdentity, &n)
	return n, ok && err == nil
}

// Role trả vai trò đã cài (không có node.json = all-in-one của Phase 4–8).
func (e *Env) Role() string {
	if n, ok := e.nodeInfo(); ok && ValidRole(n.Role) {
		return n.Role
	}
	return RoleAllInOne
}

func stepPKI(_ context.Context, e *Env, o Options, _ *Release) error {
	if err := e.PKIInit(); err != nil {
		return err
	}
	role := o.Role
	if role == "" {
		role = RoleAllInOne
	}
	if _, ok := e.nodeInfo(); !ok {
		return e.writeJSON(ops.NodeIdentity, ops.NodeInfo{Role: role}, 0o644, platform.Owner{})
	}
	return nil
}

// PKIInit tạo CA nội bộ (một lần), chứng chỉ TLS relay và khóa ký enroll. Chạy lại không sinh lại gì.
func (e *Env) PKIInit() error {
	if !e.FS.Exists(ops.CACertPath) || !e.FS.Exists(ops.CAKeyPath) {
		certPEM, keyPEM, err := pki.NewCA("ITSO Panel internal CA", e.now())
		if err != nil {
			return err
		}
		if err := e.FS.MkdirAll(dirOf(ops.CACertPath)); err != nil {
			return err
		}
		if _, err := e.FS.EnsureDir(dirOf(ops.CACertPath), 0o755, platform.Owner{}); err != nil {
			return err
		}
		// Khóa trước, chứng chỉ sau: có ca.pem nghĩa là cặp đã hoàn chỉnh.
		if _, err := e.FS.WriteAtomic(ops.CAKeyPath, keyPEM, 0o600, platform.Owner{}); err != nil {
			return err
		}
		if _, err := e.FS.WriteAtomic(ops.CACertPath, certPEM, 0o644, platform.Owner{}); err != nil {
			return err
		}
	}
	relay := e.userOwner("itso-relay")
	if err := e.FS.MkdirAll(RelayDir); err != nil {
		return err
	}
	if _, err := e.FS.EnsureDir(RelayDir, 0o750, e.rootGroup("itso-relay")); err != nil {
		return err
	}
	if !e.FS.Exists(RelayCert) || !e.FS.Exists(RelayKey) {
		certPEM, err := e.FS.ReadFile(ops.CACertPath)
		if err != nil {
			return err
		}
		keyPEM, err := e.FS.ReadFile(ops.CAKeyPath)
		if err != nil {
			return err
		}
		ca, err := pki.LoadCA(certPEM, keyPEM)
		if err != nil {
			return err
		}
		hosts := []string{}
		if h := strings.TrimSpace(e.hostText("/proc/sys/kernel/hostname")); h != "" {
			hosts = append(hosts, h)
		}
		ip := defaultIP()
		if e.IP != nil {
			ip = e.IP()
		}
		if ip != "" {
			hosts = append(hosts, ip)
		}
		var p Panel
		if ok, _ := e.readJSON(PanelFile, &p); ok && p.Domain != "" {
			hosts = append(hosts, p.Domain)
		}
		if len(hosts) == 0 {
			hosts = []string{"itso-panel"}
		}
		sc, sk, err := ca.NewServerCert(hosts, e.now())
		if err != nil {
			return err
		}
		if _, err := e.FS.WriteAtomic(RelayKey, sk, 0o600, relay); err != nil {
			return err
		}
		if _, err := e.FS.WriteAtomic(RelayCert, sc, 0o644, platform.Owner{}); err != nil {
			return err
		}
	}
	// Khóa ký enroll: relay (itso-relay) ký, Laravel (itso, thành viên nhóm itso-relay) kiểm.
	return e.writeOnce(RelayEnrollKey, func() (string, error) { s, err := e.randomB64(48); return s + "\n", err },
		0o640, e.rootGroup("itso-relay"))
}

// CAPin trả sha256 của chứng chỉ CA (DER, hex) — giá trị `--ca-sha256` của lệnh join.
func (e *Env) CAPin() (string, error) {
	b, err := e.FS.ReadFile(ops.CACertPath)
	if err != nil {
		return "", err
	}
	return pki.PEMFingerprint(b)
}

func stepNodeUsers(ctx context.Context, e *Env, _ Options, _ *Release) error {
	for _, g := range systemGroups {
		if _, ok := e.gid(g); !ok {
			if _, err := e.cmd(ctx, "groupadd", "-r", g); err != nil {
				return err
			}
		}
	}
	return nil
}

// nodePackages: node chỉ cần công cụ cho agent; nginx/PHP/DB/restic cài qua op software.* theo role tag.
var nodePackages = []string{"nftables", "acl", "quota", "ca-certificates"}

func stepNodePackages(ctx context.Context, e *Env, o Options, _ *Release) error {
	return e.aptEnsure(ctx, o, nodePackages)
}

func stepJoin(ctx context.Context, e *Env, o Options, _ *Release) error {
	_, err := e.Join(ctx, JoinOptions{URL: o.Join, Token: o.Token, CASHA256: o.CASHA256})
	return err
}

func stepNodeSystemd(ctx context.Context, e *Env, _ Options, _ *Release) error {
	if err := e.installUnits(ctx); err != nil {
		return err
	}
	_, err := e.cmd(ctx, "systemctl", "enable", "--now", NodeUnit)
	return err
}

// JoinOptions là tham số join/rejoin. Token không bao giờ được in hay ghi xuống đĩa.
type JoinOptions struct {
	URL, Token, CASHA256 string
}

// ValidateJoin kiểm cú pháp trước khi có bất kỳ kết nối mạng nào.
func ValidateJoin(j JoinOptions) error {
	u, err := url.Parse(j.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		return errors.New("--join phải dạng https://<control-plane>:28444")
	}
	if !tokenRe.MatchString(j.Token) {
		return errors.New("--token không đúng định dạng (itso_enr_…)")
	}
	if !pinRe.MatchString(j.CASHA256) {
		return errors.New("--ca-sha256 phải là 64 ký tự hex thường")
	}
	return nil
}

func (e *Env) httpClient(tc *tls.Config) *http.Client {
	if e.HTTP != nil {
		return e.HTTP(tc)
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: tc, Proxy: http.ProxyFromEnvironment}}
}

// fetchCA tải CA công khai của relay và so với pin. Kết nối đầu chưa tin ai (InsecureSkipVerify) nhưng chỉ
// đọc dữ liệu công khai; niềm tin đến từ pin. Sai pin → dừng, token chưa từng được gửi.
func (e *Env) fetchCA(ctx context.Context, base, pin string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/ca", nil)
	if err != nil {
		return nil, err
	}
	//nolint:gosec // chỉ tải CA công khai; xác thực bằng so sha256 với --ca-sha256 ngay dưới
	resp, err := e.httpClient(&tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("không tải được CA từ %s: %w", base, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("relay trả HTTP %d khi tải CA", resp.StatusCode)
	}
	blk, _ := pem.Decode(body)
	if blk == nil || blk.Type != "CERTIFICATE" {
		return nil, errors.New("relay không trả chứng chỉ CA hợp lệ")
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil || !c.IsCA {
		return nil, errors.New("relay không trả chứng chỉ CA hợp lệ")
	}
	sum := sha256.Sum256(blk.Bytes)
	if hex.EncodeToString(sum[:]) != pin {
		return nil, errors.New("CA của control plane KHÔNG khớp --ca-sha256: dừng, không gửi token (kiểm lại lệnh join trong panel)")
	}
	return pem.EncodeToMemory(blk), nil
}

type enrollment struct {
	ServerUUID string `json:"server_uuid"`
	CertPEM    string `json:"cert_pem"`
	ChainPEM   string `json:"chain_pem"`
	CASHA256   string `json:"ca_sha256"`
	HMACKey    string `json:"hmac_key"`
	RelayURL   string `json:"relay_url"`
}

// Join ghim CA, sinh khóa + CSR trên máy này, gửi token qua TLS đã ghim, kiểm kết quả rồi ghi
// /etc/itso/node/{node.key,node.pem,ca.pem}, /etc/itso/agent.key, /etc/itso/node.json.
func (e *Env) Join(ctx context.Context, j JoinOptions) (string, error) {
	if err := ValidateJoin(j); err != nil {
		return "", err
	}
	base := strings.TrimRight(j.URL, "/")
	caPEM, err := e.fetchCA(ctx, base, j.CASHA256)
	if err != nil {
		return "", err
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)
	keyPEM, csrPEM, err := pki.NewKeyAndCSR(pki.EnrollCN)
	if err != nil {
		return "", err
	}
	osr := osRelease(e.hostText("/etc/os-release"))
	ip := defaultIP()
	if e.IP != nil {
		ip = e.IP()
	}
	ips := []string{}
	if ip != "" {
		ips = append(ips, ip)
	}
	host := strings.TrimSpace(e.hostText("/proc/sys/kernel/hostname"))
	if host == "" {
		host = "itso-node"
	}
	reqBody, _ := json.Marshal(map[string]any{"token": j.Token, "csr": string(csrPEM), "hostname": host, "ip_addresses": ips,
		"facts": map[string]any{"os": osr["PRETTY_NAME"], "kernel": strings.TrimSpace(e.hostText("/proc/sys/kernel/osrelease")),
			"arch": e.arch(), "agent_version": ops.Version}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/enroll", bytes.NewReader(reqBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := e.httpClient(&tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS13}).Do(req)
	if err != nil {
		return "", fmt.Errorf("gửi yêu cầu join: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var p struct { // RFC 9457 Problem Details (panel) hoặc {code} (relay)
			Code   string `json:"code"`
			Detail string `json:"detail"`
		}
		_ = json.Unmarshal(body, &p)
		if p.Code == "" {
			p.Code = http.StatusText(resp.StatusCode)
		}
		return "", fmt.Errorf("control plane từ chối join (HTTP %d %s): %s", resp.StatusCode, p.Code, p.Detail)
	}
	var wrap struct {
		Data enrollment `json:"data"`
	}
	if err := json.Unmarshal(body, &wrap); err != nil {
		return "", errors.New("phản hồi join không hợp lệ")
	}
	en := wrap.Data
	if err := checkEnrollment(en, keyPEM, caPEM, j.CASHA256); err != nil {
		return "", err
	}
	root := platform.Owner{}
	if err := e.FS.MkdirAll(ops.NodeDir); err != nil {
		return "", err
	}
	if _, err := e.FS.EnsureDir(ops.NodeDir, 0o700, root); err != nil {
		return "", err
	}
	for _, f := range []struct {
		p    string
		b    []byte
		mode fs.FileMode
	}{
		{ops.NodeKeyPath, keyPEM, 0o600}, {ops.NodeCertPath, []byte(strings.TrimSpace(en.CertPEM) + "\n"), 0o644},
		{ops.NodeCAPath, caPEM, 0o644}, {AgentKey, []byte(en.HMACKey + "\n"), 0o600},
	} {
		if _, err := e.FS.WriteAtomic(f.p, f.b, f.mode, root); err != nil {
			return "", err
		}
	}
	relay := en.RelayURL
	if relay == "" {
		relay = base
	}
	if err := e.writeJSON(ops.NodeIdentity, ops.NodeInfo{Role: RoleNode, ServerUUID: en.ServerUUID, RelayURL: relay}, 0o644, root); err != nil {
		return "", err
	}
	if !e.FS.Exists(PolicyFile) {
		if _, err := e.FS.WriteAtomic(PolicyFile, []byte("version: 1\n"), 0o600, root); err != nil {
			return "", err
		}
	}
	e.printf("  Đã join: server_uuid %s, relay %s\n", en.ServerUUID, relay)
	return en.ServerUUID, nil
}

func checkEnrollment(en enrollment, keyPEM, caPEM []byte, pin string) error {
	if !pki.ValidUUID(en.ServerUUID) {
		return errors.New("phản hồi join: server_uuid không hợp lệ")
	}
	if en.CASHA256 != "" && en.CASHA256 != pin {
		return errors.New("phản hồi join: ca_sha256 khác pin")
	}
	if !hmacRe.MatchString(en.HMACKey) {
		return errors.New("phản hồi join: khóa HMAC không hợp lệ")
	}
	cert, err := pki.ParseCert([]byte(en.CertPEM))
	if err != nil {
		return fmt.Errorf("phản hồi join: chứng chỉ: %w", err)
	}
	key, err := pki.ParseKey(keyPEM)
	if err != nil {
		return err
	}
	ca, err := pki.ParseCert(caPEM)
	if err != nil {
		return err
	}
	switch {
	case !key.PublicKey.Equal(cert.PublicKey):
		return errors.New("phản hồi join: chứng chỉ không khớp khóa vừa sinh")
	case cert.Subject.CommonName != en.ServerUUID:
		return errors.New("phản hồi join: CN chứng chỉ khác server_uuid")
	case cert.CheckSignatureFrom(ca) != nil:
		return errors.New("phản hồi join: chứng chỉ không do CA đã ghim cấp")
	}
	return nil
}

// NodeStatus in vai trò, server_uuid, relay, hạn chứng chỉ và trạng thái dịch vụ.
func (e *Env) NodeStatus(ctx context.Context) error {
	n, ok := e.nodeInfo()
	if !ok {
		e.printf("Vai trò: %s (chưa có %s)\n", RoleAllInOne, ops.NodeIdentity)
		return nil
	}
	e.printf("Vai trò:     %s\n", n.Role)
	if n.Role != RoleNode {
		if pin, err := e.CAPin(); err == nil {
			e.printf("CA nội bộ:   sha256 %s (giá trị --ca-sha256 khi join node)\n", pin)
		}
		st := strings.TrimSpace(string(e.try(ctx, "systemctl", "is-active", "itso-relay.service").Stdout))
		e.printf("itso-relay:  %s (cổng %d)\n", orUnknown(st), RelayPort)
		return nil
	}
	e.printf("Server UUID: %s\nRelay:       %s\n", n.ServerUUID, n.RelayURL)
	b, err := e.FS.ReadFile(ops.NodeCertPath)
	if err != nil {
		e.printf("Chứng chỉ:   không có (chạy itso node rejoin)\n")
		return errors.New("thiếu chứng chỉ node")
	}
	c, err := pki.ParseCert(b)
	if err != nil {
		return err
	}
	left := c.NotAfter.Sub(e.now())
	e.printf("Chứng chỉ:   sha256 %s, hết hạn %s (còn %d ngày)\n", pki.Fingerprint(c.Raw), c.NotAfter.UTC().Format(time.RFC3339), int(left.Hours()/24))
	st := strings.TrimSpace(string(e.try(ctx, "systemctl", "is-active", NodeUnit).Stdout))
	e.printf("Agent:       %s\n", orUnknown(st))
	switch {
	case left <= 0:
		return errors.New("chứng chỉ đã hết hạn: relay sẽ từ chối, chạy itso node rejoin")
	case st != "active":
		return errors.New("itso-agent (node) không chạy (xem itso logs agent)")
	}
	return nil
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

// NodeRejoin cấp lại chứng chỉ + khóa HMAC (khi bị thu hồi/mất/hết hạn) rồi khởi động lại agent.
func (e *Env) NodeRejoin(ctx context.Context, j JoinOptions) error {
	n, ok := e.nodeInfo()
	if ok && n.Role != RoleNode {
		return errors.New("máy này không phải node")
	}
	if j.URL == "" {
		j.URL = n.RelayURL
	}
	if _, err := e.Join(ctx, j); err != nil {
		return err
	}
	_, err := e.cmd(ctx, "systemctl", "restart", NodeUnit)
	return err
}

// NodeLeave dừng agent và xóa chứng chỉ, khóa HMAC, danh tính node. Dữ liệu hosting giữ nguyên.
func (e *Env) NodeLeave(ctx context.Context, yes bool) error {
	n, ok := e.nodeInfo()
	if !ok || n.Role != RoleNode {
		return errors.New("máy này không phải node")
	}
	if !yes {
		return errors.New("itso node leave cần --yes (panel nên thu hồi node trước; dữ liệu hosting giữ nguyên)")
	}
	_ = e.try(ctx, "systemctl", "disable", "--now", NodeUnit)
	for _, p := range []string{ops.NodeKeyPath, ops.NodePendingPath, ops.NodeCertPath, ops.NodeCAPath, AgentKey, ops.NodeIdentity} {
		if _, err := e.FS.Remove(p); err != nil {
			return err
		}
	}
	e.printf("Đã rời control plane (server_uuid %s). Dữ liệu hosting giữ nguyên; join lại bằng itso install --role node --join …\n", n.ServerUUID)
	return nil
}
