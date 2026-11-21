package ops

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io/fs"
	"sort"
	"strings"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// Chứng chỉ: ACME bằng lego (HTTP-01 webroot), chứng chỉ tải lên, đọc thông tin (D-69, ADR 0016).

const (
	certBase = "/etc/itso/certs"
	acmeBase = "/etc/itso/acme"
	// PebbleCA là CA của Pebble (VM/CI) để lego tin directory https://localhost:14000.
	PebbleCA = acmeBase + "/pebble-ca.pem"
)

// ACMEDirectories là allowlist directory → URL (không nhận URL tự do từ panel).
var ACMEDirectories = map[string]string{
	"letsencrypt":         "https://acme-v02.api.letsencrypt.org/directory",
	"letsencrypt-staging": "https://acme-staging-v02.api.letsencrypt.org/directory",
	"pebble":              "https://localhost:14000/dir",
}

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpCertIssue:   d.certIssue,
			contracts.OpCertInstall: d.certInstall,
			contracts.OpCertInspect: d.certInspect,
			contracts.OpCertRemove:  d.certRemove,
		}
	})
}

func certDir(id string) string { return certBase + "/" + id }

// parseCertPEM đọc chuỗi chứng chỉ PEM (lá đầu tiên).
func parseCertPEM(b []byte) ([]*x509.Certificate, error) {
	var out []*x509.Certificate
	rest := b
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			return nil, errors.New("PEM chứa khối không phải CERTIFICATE")
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, errors.New("không có chứng chỉ PEM")
	}
	if len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("dữ liệu thừa sau PEM")
	}
	return out, nil
}

func parseKeyPEM(b []byte) (crypto.PrivateKey, error) {
	blk, rest := pem.Decode(b)
	if blk == nil || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("khóa riêng phải là đúng một khối PEM")
	}
	switch blk.Type {
	case "RSA PRIVATE KEY":
		return x509.ParsePKCS1PrivateKey(blk.Bytes)
	case "EC PRIVATE KEY":
		return x509.ParseECPrivateKey(blk.Bytes)
	case "PRIVATE KEY":
		return x509.ParsePKCS8PrivateKey(blk.Bytes)
	}
	return nil, errors.New("loại khóa PEM không hỗ trợ: " + blk.Type)
}

// keyMatches kiểm khóa riêng khớp khóa công khai của chứng chỉ.
func keyMatches(c *x509.Certificate, k crypto.PrivateKey) bool {
	type pub interface{ Equal(crypto.PublicKey) bool }
	var pk crypto.PublicKey
	switch kk := k.(type) {
	case *rsa.PrivateKey:
		pk = &kk.PublicKey
	case *ecdsa.PrivateKey:
		pk = &kk.PublicKey
	case ed25519.PrivateKey:
		pk = kk.Public()
	default:
		return false
	}
	p, ok := pk.(pub)
	return ok && p.Equal(c.PublicKey)
}

func certInfo(id string, c *x509.Certificate) contracts.CertInfo {
	issuer := c.Issuer.CommonName
	if issuer == "" {
		issuer = c.Issuer.String()
	}
	doms := []contracts.Domain{}
	names := append([]string(nil), c.DNSNames...)
	sort.Strings(names)
	for _, n := range names {
		doms = append(doms, contracts.Domain(n))
	}
	return contracts.CertInfo{CertUUID: contracts.UUID(id), Issuer: issuer, NotBefore: c.NotBefore.UTC().Format(time.RFC3339),
		NotAfter: c.NotAfter.UTC().Format(time.RFC3339), Domains: doms}
}

// storeCert kiểm cặp chứng chỉ/khóa rồi ghi /etc/itso/certs/<id>/{fullchain.pem 0644, privkey.pem 0600} (root).
func (d *Deps) storeCert(ctx context.Context, id string, chain, key []byte) (contracts.CertInfo, error) {
	if len(chain) > 64<<10 || len(key) > 16<<10 {
		return contracts.CertInfo{}, &registry.OpError{Code: "invalid_params", Message: "PEM quá lớn"}
	}
	certs, err := parseCertPEM(chain)
	if err != nil {
		return contracts.CertInfo{}, &registry.OpError{Code: "invalid_params", Message: "certificate_pem: " + err.Error()}
	}
	k, err := parseKeyPEM(key)
	if err != nil {
		return contracts.CertInfo{}, &registry.OpError{Code: "invalid_params", Message: "private_key_pem: " + err.Error()}
	}
	if !keyMatches(certs[0], k) {
		return contracts.CertInfo{}, &registry.OpError{Code: "invalid_params", Message: "khóa riêng không khớp chứng chỉ"}
	}
	if err := d.FS.MkdirAll(certBase); err != nil {
		return contracts.CertInfo{}, opErr(err)
	}
	if _, err := d.FS.EnsureDir(certDir(id), 0o750, platform.Owner{}); err != nil {
		return contracts.CertInfo{}, opErr(err)
	}
	// Thay chứng chỉ đang được vhost dùng (gia hạn, tải lại) → nginx -t + reload để nạp bản mới; lỗi → trả bản cũ.
	nginxMu.Lock()
	defer nginxMu.Unlock()
	oldChain, cerr := d.FS.ReadFile(certDir(id) + "/fullchain.pem")
	oldKey, kerr := d.FS.ReadFile(certDir(id) + "/privkey.pem")
	replaced := cerr == nil && kerr == nil && (!bytes.Equal(oldChain, chain) || !bytes.Equal(oldKey, key))
	// Khóa ghi trước để không bao giờ có fullchain mới đi với khóa cũ khi nginx đọc giữa chừng.
	if _, err := d.FS.WriteAtomic(certDir(id)+"/privkey.pem", key, 0o600, platform.Owner{}); err != nil {
		return contracts.CertInfo{}, opErr(err)
	}
	if _, err := d.FS.WriteAtomic(certDir(id)+"/fullchain.pem", chain, 0o644, platform.Owner{}); err != nil {
		return contracts.CertInfo{}, opErr(err)
	}
	if replaced && d.certInUse(id) {
		if err := d.nginxTest(ctx); err != nil {
			_, _ = d.FS.WriteAtomic(certDir(id)+"/privkey.pem", oldKey, 0o600, platform.Owner{})
			_, _ = d.FS.WriteAtomic(certDir(id)+"/fullchain.pem", oldChain, 0o644, platform.Owner{})
			return contracts.CertInfo{}, err
		}
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service"); err != nil {
			return contracts.CertInfo{}, err
		}
	}
	return certInfo(id, certs[0]), nil
}

// certInUse: có vhost trỏ tới /etc/itso/certs/<id>/ không. Gọi khi đang giữ nginxMu.
func (d *Deps) certInUse(id string) bool {
	names, err := d.FS.ReadDir(VhostDir)
	if err != nil {
		return false
	}
	for _, n := range names {
		if b, err := d.FS.ReadFile(VhostDir + "/" + n); err == nil && bytes.Contains(b, []byte(certDir(id)+"/")) {
			return true
		}
	}
	return false
}

// LegoArgs sinh argv cố định cho lego (D-69). Giá trị đã được validate trước.
func LegoArgs(email, directory string, domains []string, renew bool) []string {
	args := []string{"--accept-tos", "--email=" + email, "--server=" + ACMEDirectories[directory], "--path=" + acmeBase + "/" + directory,
		"--http", "--http.webroot=" + acmeWebroot}
	for _, dm := range domains {
		args = append(args, "--domains="+dm)
	}
	if renew {
		return append(args, "renew", "--days=30", "--no-random-sleep")
	}
	return append(args, "run")
}

func (d *Deps) certIssue(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CertIssueParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	for _, id := range []string{string(p.WebsiteUUID), string(p.CertUUID)} {
		if err := validate.UUID(id); err != nil {
			return nil, opErr(err)
		}
	}
	if err := validate.Domain(string(p.SiteDir)); err != nil {
		return nil, opErr(err)
	}
	doms := make([]string, 0, len(p.Domains))
	for _, dm := range p.Domains {
		doms = append(doms, string(dm))
	}
	if err := validate.Domains(doms, 1, 100); err != nil {
		return nil, opErr(err)
	}
	if p.Challenge != "http-01" {
		return nil, &registry.OpError{Code: "invalid_params", Message: "challenge: chỉ http-01"}
	}
	if err := validate.Email(string(p.Email)); err != nil {
		return nil, opErr(err)
	}
	dir := string(p.Directory)
	if _, ok := ACMEDirectories[dir]; !ok {
		return nil, &registry.OpError{Code: "invalid_params", Message: "directory ngoài allowlist"}
	}
	var envs []string
	if dir == "pebble" {
		if !d.AcmePebble {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "directory pebble chỉ dùng khi policy cục bộ bật acme_pebble (VM/CI)"}
		}
		if !d.FS.Exists(PebbleCA) {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "thiếu " + PebbleCA}
		}
		envs = []string{"LEGO_CA_CERTIFICATES=" + PebbleCA}
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	if err := d.FS.MkdirAll(acmeWebroot); err != nil {
		return nil, opErr(err)
	}
	if err := d.FS.MkdirAll("/etc/itso"); err != nil {
		return nil, opErr(err)
	}
	if _, err := d.FS.EnsureDir(acmeBase, 0o700, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	legoPath := acmeBase + "/" + dir
	crt, key := legoPath+"/certificates/"+doms[0]+".crt", legoPath+"/certificates/"+doms[0]+".key"
	renew := p.Renew && d.FS.Exists(crt)
	res, err := d.Run.Run(ctx, platform.Cmd{Bin: "lego", Args: LegoArgs(string(p.Email), dir, doms, renew), Env: envs})
	if err != nil {
		if ctx.Err() != nil {
			return nil, &registry.OpError{Code: "deadline_exceeded", Message: "lego: " + ctx.Err().Error(), Retryable: true}
		}
		return nil, &registry.OpError{Code: "dependency_unavailable", Message: "lego: " + err.Error(), Retryable: true}
	}
	if res.ExitCode != 0 {
		// Thường do domain chưa trỏ về máy hoặc giới hạn tần suất của CA: không tự thử lại.
		return nil, cmdFailed("precondition_failed", "lego", res)
	}
	chain, err := d.FS.ReadFile(crt)
	if err != nil {
		return nil, &registry.OpError{Code: "internal", Message: "lego không tạo " + crt}
	}
	kb, err := d.FS.ReadFile(key)
	if err != nil {
		return nil, &registry.OpError{Code: "internal", Message: "lego không tạo " + key}
	}
	info, err := d.storeCert(ctx, string(p.CertUUID), chain, kb)
	if err != nil {
		return nil, err
	}
	return toData(info)
}

func (d *Deps) certInstall(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CertInstallParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	for _, id := range []string{string(p.WebsiteUUID), string(p.CertUUID)} {
		if err := validate.UUID(id); err != nil {
			return nil, opErr(err)
		}
	}
	if strings.Contains(p.PrivateKeyPem, `"$secret"`) {
		return nil, &registry.OpError{Code: "invalid_params", Message: "private_key_pem chưa được thay giá trị bí mật"}
	}
	certs, err := parseCertPEM([]byte(p.CertificatePem))
	if err == nil && d.now().After(certs[0].NotAfter) {
		return nil, &registry.OpError{Code: "invalid_params", Message: "chứng chỉ đã hết hạn"}
	}
	info, err := d.storeCert(ctx, string(p.CertUUID), []byte(p.CertificatePem), []byte(p.PrivateKeyPem))
	if err != nil {
		return nil, err
	}
	return toData(info)
}

func (d *Deps) certInspect(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CertInspectParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.UUID(string(p.CertUUID)); err != nil {
		return nil, opErr(err)
	}
	b, err := d.FS.ReadFile(certDir(string(p.CertUUID)) + "/fullchain.pem")
	if errors.Is(err, fs.ErrNotExist) {
		return toData(contracts.CertInspectResult{Exists: false, Cert: json.RawMessage("null")})
	}
	if err != nil {
		return nil, opErr(err)
	}
	certs, err := parseCertPEM(b)
	if err != nil {
		return nil, &registry.OpError{Code: "internal", Message: "fullchain.pem hỏng: " + err.Error()}
	}
	raw, err := json.Marshal(certInfo(string(p.CertUUID), certs[0]))
	if err != nil {
		return nil, opErr(err)
	}
	return toData(contracts.CertInspectResult{Exists: true, Cert: raw})
}

func (d *Deps) certRemove(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CertRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	id := string(p.CertUUID)
	if err := validate.UUID(id); err != nil {
		return nil, opErr(err)
	}
	if !d.FS.Exists(certDir(id)) {
		return toData(contracts.CertRemoveResult{Removed: false})
	}
	// Không xóa chứng chỉ vhost còn dùng (nginx -t sẽ lỗi, mọi site không reload được).
	nginxMu.Lock()
	defer nginxMu.Unlock()
	if _, err := d.FS.ReadDir(VhostDir); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, opErr(err)
	}
	if d.certInUse(id) {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "còn vhost dùng chứng chỉ (áp lại vhost không TLS trước)"}
	}
	if err := d.FS.RemoveTree(certDir(id)); err != nil {
		return nil, opErr(err)
	}
	return toData(contracts.CertRemoveResult{Removed: true})
}
