package mock

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"sort"
	"strings"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

// Op website giả (Prompt 5.2): vhost, pool PHP, chứng chỉ, log giữ trong bộ nhớ. Hành vi (idempotent,
// mã lỗi, domain ép nginx -t lỗi) khớp agent thật qua contracttest.WebsiteLifecycle.

const failDomainPrefix = "nginx-test-fail."

type webStore struct {
	acc    *accountStore
	php    map[string]bool               // phiên bản đã cài
	exts   map[string]bool               // extension đã cài
	sites  map[string]bool               // user/site_dir
	pools  map[string]string             // website_uuid → nội dung
	vhosts map[string]string             // website_uuid → cấu hình
	owner  map[string]contracts.Username // website_uuid → account của vhost
	certs  map[string]contracts.CertInfo
	global string
	now    func() time.Time
}

func registerWeb(r *registry.Registry, acc *accountStore) error {
	s := &webStore{acc: acc, php: map[string]bool{}, exts: map[string]bool{}, sites: map[string]bool{}, pools: map[string]string{},
		vhosts: map[string]string{}, owner: map[string]contracts.Username{}, certs: map[string]contracts.CertInfo{}, now: time.Now}
	for op, h := range map[string]registry.Handler{
		contracts.OpFsSiteLayoutEnsure: s.siteLayout, contracts.OpNginxVhostApply: s.vhostApply, contracts.OpNginxVhostRemove: s.vhostRemove,
		contracts.OpNginxVhostInspect: s.vhostInspect, contracts.OpNginxGlobalApply: s.globalApply, contracts.OpLogTail: s.logTail,
		contracts.OpPHPVersionInstall: s.phpInstall, contracts.OpPHPVersionRemove: s.phpRemove, contracts.OpPHPExtInstall: s.extInstall,
		contracts.OpPHPPoolApply: s.poolApply, contracts.OpPHPPoolRemove: s.poolRemove,
		contracts.OpCertIssue: s.certIssue, contracts.OpCertInstall: s.certInstall, contracts.OpCertInspect: s.certInspect, contracts.OpCertRemove: s.certRemove,
	} {
		if err := r.Register(op, h); err != nil {
			return err
		}
	}
	return nil
}

func (s *webStore) lock() func() { s.acc.mu.Lock(); return s.acc.mu.Unlock }

func errf(code, f string, a ...any) error {
	return &registry.OpError{Code: code, Message: fmt.Sprintf(f, a...)}
}

func socketOf(u contracts.Username, ws contracts.UUID) string {
	return "/run/itso/php/" + string(u) + "-" + strings.ReplaceAll(string(ws), "-", "")[:8] + ".sock"
}

func (s *webStore) siteLayout(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.FsSiteLayoutEnsureParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	if _, err := s.acc.get(p.Account); err != nil {
		return nil, err
	}
	k := string(p.Account.Username) + "/" + string(p.SiteDir)
	created := !s.sites[k]
	s.sites[k] = true
	return toData(contracts.FsSiteLayoutEnsureResult{Path: "/home/" + string(p.Account.Username) + "/sites/" + string(p.SiteDir), Created: created})
}

func (s *webStore) phpInstall(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.PHPVersionInstallParams](env)
	if err != nil {
		return nil, err
	}
	if p.Version != "8.3" {
		return nil, errf("precondition_failed", "chỉ hỗ trợ PHP 8.3 (D-68)")
	}
	defer s.lock()()
	changed := !s.php["8.3"]
	s.php["8.3"] = true
	for _, e := range p.Extensions {
		changed = changed || !s.exts[string(e)]
		s.exts[string(e)] = true
	}
	return toData(contracts.PHPVersionInstallResult{Installed: true, Changed: changed})
}

func (s *webStore) phpRemove(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.PHPVersionRemoveParams](env)
	if err != nil {
		return nil, err
	}
	if p.Version != "8.3" {
		return nil, errf("precondition_failed", "chỉ quản lý PHP 8.3")
	}
	defer s.lock()()
	if len(s.pools) > 0 {
		return nil, errf("precondition_failed", "PHP 8.3 còn pool")
	}
	removed := s.php["8.3"]
	delete(s.php, "8.3")
	return toData(contracts.PHPVersionRemoveResult{Removed: removed})
}

func (s *webStore) extInstall(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.PHPExtInstallParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	if p.Version != "8.3" || !s.php["8.3"] {
		return nil, errf("precondition_failed", "PHP %s chưa cài", p.Version)
	}
	changed := false
	exts := append([]contracts.PHPExtension(nil), p.Extensions...)
	for _, e := range exts {
		changed = changed || !s.exts[string(e)]
		s.exts[string(e)] = true
	}
	sort.Slice(exts, func(i, j int) bool { return exts[i] < exts[j] })
	return toData(contracts.PHPExtInstallResult{Installed: exts, Changed: changed})
}

func (s *webStore) poolApply(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.PHPPoolApplyParams](env)
	if err != nil {
		return nil, err
	}
	if p.Version != "8.3" {
		return nil, errf("precondition_failed", "chỉ hỗ trợ PHP 8.3 (D-68)")
	}
	defer s.lock()()
	if _, err := s.acc.get(p.Account); err != nil {
		return nil, err
	}
	if !s.php["8.3"] {
		return nil, errf("precondition_failed", "PHP 8.3 chưa cài")
	}
	if !s.sites[string(p.Account.Username)+"/"+string(p.SiteDir)] {
		return nil, errf("precondition_failed", "chưa có bố cục site")
	}
	b, _ := json.Marshal(p)
	changed := s.pools[string(p.WebsiteUUID)] != string(b)
	s.pools[string(p.WebsiteUUID)] = string(b)
	return toData(contracts.PHPPoolApplyResult{Socket: socketOf(p.Account.Username, p.WebsiteUUID),
		Unit: "itso-php@8.3-" + string(p.Account.Username) + ".service", Reloaded: changed, Changed: changed})
}

func (s *webStore) poolRemove(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.PHPPoolRemoveParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	_, ok := s.pools[string(p.WebsiteUUID)]
	delete(s.pools, string(p.WebsiteUUID))
	return toData(contracts.PHPPoolRemoveResult{Removed: ok})
}

func (s *webStore) vhostApply(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.NginxVhostApplyParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	if _, err := s.acc.get(p.Account); err != nil {
		return nil, err
	}
	ws := string(p.WebsiteUUID)
	suspended := p.Suspended != nil && *p.Suspended
	if p.Type == "php" && !suspended {
		if _, ok := s.pools[ws]; !ok {
			return nil, errf("precondition_failed", "chưa có pool PHP của website")
		}
	}
	if p.TLS != nil {
		if _, ok := s.certs[string(p.TLS.CertUUID)]; !ok {
			return nil, errf("precondition_failed", "chưa có chứng chỉ %s", p.TLS.CertUUID)
		}
	}
	names := make([]string, 0, len(p.ServerNames))
	for _, n := range p.ServerNames {
		names = append(names, string(n))
		if strings.HasPrefix(string(n), failDomainPrefix) {
			return nil, errf("config_test_failed", "nginx -t thoát mã 1: nginx: [emerg] (mock) invalid server_name")
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# mock vhost · website %s · account %s · type %s\nserver {\n    server_name %s;\n", ws, p.Account.Username, p.Type, strings.Join(names, " "))
	if p.TLS != nil {
		fmt.Fprintf(&b, "    listen 443 ssl;\n    ssl_certificate /etc/itso/certs/%s/fullchain.pem;\n", p.TLS.CertUUID)
	}
	if suspended {
		b.WriteString("    location / { return 503; }\n")
	}
	raw, _ := json.Marshal(p)
	fmt.Fprintf(&b, "    # params %x\n}\n", sha256.Sum256(raw))
	conf := b.String()
	changed := s.vhosts[ws] != conf
	s.vhosts[ws], s.owner[ws] = conf, p.Account.Username
	return toData(contracts.NginxVhostApplyResult{ConfigPath: "/etc/nginx/sites-enabled/itso-" + ws + ".conf", NginxTest: "ok", Reloaded: changed, Changed: changed})
}

func (s *webStore) vhostRemove(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.NginxVhostRemoveParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	ws := string(p.WebsiteUUID)
	if _, ok := s.vhosts[ws]; !ok {
		return toData(contracts.NginxVhostRemoveResult{Removed: false})
	}
	if s.owner[ws] != p.Account.Username {
		return nil, errf("precondition_failed", "vhost không thuộc account %s", p.Account.Username)
	}
	delete(s.vhosts, ws)
	delete(s.owner, ws)
	return toData(contracts.NginxVhostRemoveResult{Removed: true})
}

func (s *webStore) vhostInspect(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.NginxVhostInspectParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	c, ok := s.vhosts[string(p.WebsiteUUID)]
	if !ok {
		return toData(contracts.NginxVhostInspectResult{Exists: false})
	}
	sum := sha256.Sum256([]byte(c))
	h := hex.EncodeToString(sum[:])
	return toData(contracts.NginxVhostInspectResult{Exists: true, Config: &c, SHA256: &h})
}

func (s *webStore) globalApply(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.NginxGlobalApplyParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	b, _ := json.Marshal(p)
	changed := s.global != string(b)
	s.global = string(b)
	return toData(contracts.NginxGlobalApplyResult{NginxTest: "ok", Reloaded: changed, Changed: changed})
}

func (s *webStore) logTail(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.LogTailParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	if _, err := s.acc.get(p.Account); err != nil {
		return nil, err
	}
	now := s.now().UTC()
	lines := []string{}
	for i := int64(0); i < p.Lines && i < 5; i++ {
		ts := now.Add(time.Duration(i-5) * time.Minute).Format("02/Jan/2006:15:04:05 -0700")
		if p.Kind == "access" {
			lines = append(lines, fmt.Sprintf(`203.0.113.%d - - [%s] "GET / HTTP/2.0" 200 5120 "-" "Mozilla/5.0 (mock)"`, 10+i, ts))
		} else {
			lines = append(lines, fmt.Sprintf("%s [warn] 1234#1234: *%d (mock) %s: an upstream response is buffered", now.Format("2006/01/02 15:04:05"), i+1, p.SiteDir))
		}
	}
	return toData(contracts.LogTailResult{Lines: lines, Truncated: false})
}

func (s *webStore) certIssue(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.CertIssueParams](env)
	if err != nil {
		return nil, err
	}
	if p.Directory == "pebble" {
		return nil, errf("precondition_failed", "directory pebble chỉ dùng khi policy cục bộ bật acme_pebble (VM/CI)")
	}
	defer s.lock()()
	if _, err := s.acc.get(p.Account); err != nil {
		return nil, err
	}
	now := s.now().UTC()
	info := contracts.CertInfo{CertUUID: p.CertUUID, Issuer: "ITSO Mock ACME CA", NotBefore: now.Format(time.RFC3339),
		NotAfter: now.Add(90 * 24 * time.Hour).Format(time.RFC3339), Domains: append([]contracts.Domain(nil), p.Domains...)}
	sort.Slice(info.Domains, func(i, j int) bool { return info.Domains[i] < info.Domains[j] })
	s.certs[string(p.CertUUID)] = info
	return toData(info)
}

func (s *webStore) certInstall(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.CertInstallParams](env)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode([]byte(p.CertificatePem))
	if blk == nil {
		return nil, errf("invalid_params", "certificate_pem không phải PEM")
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return nil, errf("invalid_params", "certificate_pem: %v", err)
	}
	if kb, _ := pem.Decode([]byte(p.PrivateKeyPem)); kb == nil {
		return nil, errf("invalid_params", "private_key_pem không phải PEM")
	}
	info := contracts.CertInfo{CertUUID: p.CertUUID, Issuer: c.Issuer.CommonName, NotBefore: c.NotBefore.UTC().Format(time.RFC3339),
		NotAfter: c.NotAfter.UTC().Format(time.RFC3339), Domains: []contracts.Domain{}}
	for _, n := range c.DNSNames {
		info.Domains = append(info.Domains, contracts.Domain(n))
	}
	defer s.lock()()
	s.certs[string(p.CertUUID)] = info
	return toData(info)
}

func (s *webStore) certInspect(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.CertInspectParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	info, ok := s.certs[string(p.CertUUID)]
	if !ok {
		return toData(contracts.CertInspectResult{Exists: false, Cert: json.RawMessage("null")})
	}
	raw, _ := json.Marshal(info)
	return toData(contracts.CertInspectResult{Exists: true, Cert: raw})
}

func (s *webStore) certRemove(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.CertRemoveParams](env)
	if err != nil {
		return nil, err
	}
	defer s.lock()()
	if _, ok := s.certs[string(p.CertUUID)]; !ok {
		return toData(contracts.CertRemoveResult{Removed: false})
	}
	for ws, c := range s.vhosts {
		if strings.Contains(c, "/etc/itso/certs/"+string(p.CertUUID)+"/") {
			return nil, errf("precondition_failed", "vhost %s còn dùng chứng chỉ", ws)
		}
	}
	delete(s.certs, string(p.CertUUID))
	return toData(contracts.CertRemoveResult{Removed: true})
}
