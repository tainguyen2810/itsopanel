package ops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"io/fs"
	"strconv"
	"strings"
	"sync"
	"text/template"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// Website: bố cục site, vhost Nginx, log (Phase 5, D-67, ADR 0014).

//go:embed templates/*
var tmplFS embed.FS

var tmpl = template.Must(template.New("").Funcs(template.FuncMap{
	"join": func(ns []string) string { return strings.Join(ns, " ") },
}).ParseFS(tmplFS, "templates/*.tmpl"))

const (
	// VhostDir chứa vhost do agent sinh.
	VhostDir     = "/etc/nginx/sites-enabled"
	nginxConf    = "/etc/nginx/nginx.conf"
	acmeWebroot  = "/var/lib/itso/acme/webroot"
	suspendedDir = "/var/lib/itso/suspended"
	// SiteLogBase: log Nginx của site nằm NGOÀI home (root:<gid account> 0750), để account không thể
	// đổi thư mục log thành symlink khiến nginx (root) ghi vào file hệ thống (sửa đổi so với 07 §5).
	SiteLogBase = "/var/log/itso/sites"
)

//go:embed templates/suspended.html
var suspendedHTML []byte

// nginxMu tuần tự hóa mọi thay đổi cấu hình Nginx (nginx -t phải thấy đúng một thay đổi).
var nginxMu sync.Mutex

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpFsSiteLayoutEnsure: d.siteLayoutEnsure,
			contracts.OpNginxVhostApply:    d.vhostApply,
			contracts.OpNginxVhostRemove:   d.vhostRemove,
			contracts.OpNginxVhostInspect:  d.vhostInspect,
			contracts.OpNginxGlobalApply:   d.nginxGlobalApply,
			contracts.OpLogTail:            d.logTail,
		}
	})
}

func render(name string, data any) ([]byte, error) {
	var b bytes.Buffer
	if err := tmpl.ExecuteTemplate(&b, name, data); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func siteRoot(u contracts.Username, siteDir string) string {
	return homeOf(u) + "/sites/" + siteDir
}

func siteLogDir(u contracts.Username, siteDir string) string {
	return SiteLogBase + "/" + string(u) + "/" + siteDir
}

// VhostPath là file vhost của website.
func VhostPath(websiteUUID string) string { return VhostDir + "/itso-" + websiteUUID + ".conf" }

// PoolKey là 8 ký tự hex đầu của website_uuid (tên pool, socket).
func PoolKey(websiteUUID string) string { return strings.ReplaceAll(websiteUUID, "-", "")[:8] }

// PHPSocket là socket pool của website (D-68).
func PHPSocket(u contracts.Username, websiteUUID string) string {
	return "/run/itso/php/" + string(u) + "-" + PoolKey(websiteUUID) + ".sock"
}

// ---------- fs.site_layout.ensure ----------

func (d *Deps) siteLayoutEnsure(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsSiteLayoutEnsureParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	if err := validate.Domain(string(p.SiteDir)); err != nil {
		return nil, opErr(err)
	}
	usr, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	created, err := d.ensureSiteLayout(ctx, p.Account, usr, string(p.SiteDir))
	if err != nil {
		return nil, err
	}
	return toData(contracts.FsSiteLayoutEnsureResult{Path: siteRoot(p.Account.Username, string(p.SiteDir)), Created: created})
}

func (d *Deps) ensureSiteLayout(ctx context.Context, a contracts.Account, usr *passwdEntry, siteDir string) (bool, error) {
	home := homeOf(a.Username)
	root := siteRoot(a.Username, siteDir)
	if !d.FS.Exists(home + "/sites") {
		return false, &registry.OpError{Code: "precondition_failed", Message: "account chưa có " + home + "/sites (chạy account.ensure)"}
	}
	if err := d.FS.NoSymlinkBelow(home, root+"/public"); err != nil {
		return false, &registry.OpError{Code: "path_outside_home", Message: err.Error()}
	}
	acct := platform.Owner{UID: int(usr.UID), GID: int(usr.GID)}
	created := !d.FS.Exists(root)
	for _, x := range []struct {
		path string
		mode uint32
	}{{root, 0o750}, {root + "/public", 0o750}, {root + "/tmp", 0o700}} {
		if _, err := d.FS.EnsureDir(x.path, modeOf(x.mode), acct); err != nil {
			return false, opErr(err)
		}
	}
	// www-data: đi qua thư mục site, đọc public/ (kể cả file tạo sau nhờ default ACL).
	for _, acl := range [][2]string{{root, "u:" + WebUser + ":--x"}, {root + "/public", "u:" + WebUser + ":r-x"}, {root + "/public", "d:u:" + WebUser + ":r-x"}} {
		if err := d.ensureACL(ctx, acl[0], acl[1]); err != nil {
			return false, err
		}
	}
	// Log của site: /var/log/itso/sites/<user>/<site_dir> root:<gid> 0750.
	if err := d.FS.MkdirAll(SiteLogBase); err != nil {
		return false, opErr(err)
	}
	logOwner := platform.Owner{UID: 0, GID: int(usr.GID)}
	for _, p := range []string{SiteLogBase + "/" + string(a.Username), siteLogDir(a.Username, siteDir)} {
		if _, err := d.FS.EnsureDir(p, 0o750, logOwner); err != nil {
			return false, opErr(err)
		}
	}
	return created, nil
}

// ---------- nginx.vhost.apply ----------

type header struct{ Name, Value string }

type redirect struct{ From, To, Code string }

type vhostData struct {
	WebsiteUUID, User, Type, Root, LogDir, BodySize, Socket, CertUUID, Scheme, Primary string
	ServerNames, RedirectNames                                                         []string
	ProxyPort                                                                          int64
	HTTP2, HSTS, ForceHTTPS, Suspended, IPv6                                           bool
	Headers                                                                            []header
	Redirects                                                                          []redirect
}

// checkVhost validate lại mọi giá trị đi vào template (không tin schema/panel) và dựng dữ liệu render.
func checkVhost(p contracts.NginxVhostApplyParams) (*vhostData, error) {
	if err := checkAccount(p.Account); err != nil {
		return nil, err
	}
	if err := validate.UUID(string(p.WebsiteUUID)); err != nil {
		return nil, err
	}
	if err := validate.Domain(string(p.SiteDir)); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(p.ServerNames))
	for _, n := range p.ServerNames {
		names = append(names, string(n))
	}
	if err := validate.Domains(names, 1, 50); err != nil {
		return nil, err
	}
	redirs := make([]string, 0, len(p.RedirectNames))
	for _, n := range p.RedirectNames {
		redirs = append(redirs, string(n))
		if contains(names, string(n)) {
			return nil, &validate.Error{Code: "invalid_params", Field: "redirect_names", Msg: "domain vừa là server_name vừa là redirect: " + string(n)}
		}
	}
	if err := validate.Domains(redirs, 0, 50); err != nil {
		return nil, err
	}
	doc := string(p.DocumentRoot)
	if err := validate.RelPath(doc); err != nil {
		return nil, err
	}
	if doc != "public" && !strings.HasPrefix(doc, "public/") {
		return nil, &validate.Error{Code: "invalid_params", Field: "document_root", Msg: "document_root phải là public hoặc nằm dưới public/"}
	}
	v := &vhostData{WebsiteUUID: string(p.WebsiteUUID), User: string(p.Account.Username), Type: string(p.Type),
		Root:   siteRoot(p.Account.Username, string(p.SiteDir)) + "/" + doc,
		LogDir: siteLogDir(p.Account.Username, string(p.SiteDir)), BodySize: "64m",
		ServerNames: names, RedirectNames: redirs, Primary: names[0], Scheme: "http", HTTP2: true,
		Suspended: p.Suspended != nil && *p.Suspended}
	switch p.Type {
	case "php":
		v.Socket = PHPSocket(p.Account.Username, string(p.WebsiteUUID))
		if p.PHPSocket != nil && *p.PHPSocket != v.Socket {
			return nil, &validate.Error{Code: "invalid_params", Field: "php_socket", Msg: "php_socket phải là " + v.Socket}
		}
		if p.ProxyPort != nil {
			return nil, &validate.Error{Code: "invalid_params", Field: "proxy_port", Msg: "proxy_port chỉ dùng cho type=proxy"}
		}
	case "proxy":
		if p.ProxyPort == nil || *p.ProxyPort < 1024 || *p.ProxyPort > 65535 {
			return nil, &validate.Error{Code: "invalid_params", Field: "proxy_port", Msg: "type=proxy cần proxy_port 1024–65535 (127.0.0.1)"}
		}
		v.ProxyPort = *p.ProxyPort
	case "static":
		if p.ProxyPort != nil || p.PHPSocket != nil {
			return nil, &validate.Error{Code: "invalid_params", Field: "type", Msg: "type=static không nhận php_socket/proxy_port"}
		}
	default:
		return nil, &validate.Error{Code: "invalid_params", Field: "type", Msg: "type không hợp lệ"}
	}
	if p.TLS != nil {
		if err := validate.UUID(string(p.TLS.CertUUID)); err != nil {
			return nil, err
		}
		v.CertUUID, v.HSTS, v.ForceHTTPS, v.Scheme = string(p.TLS.CertUUID), p.TLS.HSTS, p.TLS.ForceHTTPS, "https"
	}
	if p.Http2 != nil {
		v.HTTP2 = *p.Http2
	}
	if p.ClientMaxBodySize != nil {
		if err := validate.NginxSize(string(*p.ClientMaxBodySize)); err != nil {
			return nil, err
		}
		v.BodySize = string(*p.ClientMaxBodySize)
	}
	if len(p.ExtraHeaders) > 20 {
		return nil, &validate.Error{Code: "invalid_params", Field: "extra_headers", Msg: "tối đa 20 header"}
	}
	for _, k := range sortedKeys(p.ExtraHeaders) {
		if err := validate.HeaderName(k); err != nil {
			return nil, err
		}
		if strings.EqualFold(k, "Strict-Transport-Security") {
			return nil, &validate.Error{Code: "invalid_params", Field: "extra_headers", Msg: "HSTS đặt qua tls.hsts"}
		}
		if err := validate.HeaderValue(string(p.ExtraHeaders[k])); err != nil {
			return nil, err
		}
		v.Headers = append(v.Headers, header{k, string(p.ExtraHeaders[k])})
	}
	if len(p.Redirects) > 100 {
		return nil, &validate.Error{Code: "invalid_params", Field: "redirects", Msg: "tối đa 100 redirect"}
	}
	seen := map[string]bool{}
	for _, r := range p.Redirects {
		if err := validate.URLPath(string(r.From)); err != nil {
			return nil, err
		}
		if err := validate.RedirectTarget(string(r.To)); err != nil {
			return nil, err
		}
		if r.Code != "301" && r.Code != "302" {
			return nil, &validate.Error{Code: "invalid_params", Field: "redirects.code", Msg: "code phải là 301 hoặc 302"}
		}
		if seen[string(r.From)] || strings.HasPrefix(string(r.From), "/.well-known/acme-challenge/") {
			return nil, &validate.Error{Code: "invalid_params", Field: "redirects.from", Msg: "đường dẫn trùng hoặc bị cấm: " + string(r.From)}
		}
		seen[string(r.From)] = true
		v.Redirects = append(v.Redirects, redirect{string(r.From), string(r.To), r.Code})
	}
	return v, nil
}

// RenderVhost sinh cấu hình vhost từ params đã validate (dùng cho test/fuzz).
func RenderVhost(p contracts.NginxVhostApplyParams) ([]byte, error) {
	v, err := checkVhost(p)
	if err != nil {
		return nil, err
	}
	v.IPv6 = true
	return render("vhost.conf.tmpl", v)
}

func (d *Deps) vhostApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.NginxVhostApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	v, err := checkVhost(p)
	if err != nil {
		return nil, opErr(err)
	}
	// Máy tắt IPv6 (ipv6.disable=1): không listen [::] (nginx -t sẽ lỗi "Address family not supported").
	v.IPv6 = d.host().Exists("/proc/net/if_inet6")
	conf, err := render("vhost.conf.tmpl", v)
	if err != nil {
		return nil, opErr(err)
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	if v.CertUUID != "" && !d.FS.Exists(certDir(v.CertUUID)+"/fullchain.pem") {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "chưa có chứng chỉ " + v.CertUUID + " (cert.issue/cert.install trước)"}
	}
	if v.Type == "php" && !v.Suspended {
		b, err := d.FS.ReadFile(poolPath(PHPSupportedVersion, p.Account.Username, string(p.WebsiteUUID)))
		if err != nil || !bytes.Contains(b, []byte("; website "+v.WebsiteUUID+" ")) {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "chưa có pool PHP của website (php.pool.apply trước)"}
		}
	}
	// Thư mục dùng chung của mọi vhost.
	for _, dir := range []string{VhostDir, acmeWebroot, suspendedDir} {
		if err := d.FS.MkdirAll(dir); err != nil {
			return nil, opErr(err)
		}
	}
	if _, err := d.FS.WriteAtomic(suspendedDir+"/itso-suspended.html", suspendedHTML, 0o644, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	path := VhostPath(v.WebsiteUUID)
	nginxMu.Lock()
	defer nginxMu.Unlock()
	changed, err := d.applyNginxFile(ctx, path, conf, true)
	if err != nil {
		return nil, err
	}
	return toData(contracts.NginxVhostApplyResult{ConfigPath: path, NginxTest: "ok", Reloaded: changed, Changed: changed})
}

// applyNginxFile ghi file cấu hình Nginx theo D-67: giống → không làm gì; khác → lưu bản cũ, ghi atomic,
// nginx -t; lỗi → khôi phục bản cũ (hoặc xóa file mới) và trả config_test_failed, không reload; đúng → reload.
// Gọi khi đang giữ nginxMu.
func (d *Deps) applyNginxFile(ctx context.Context, path string, conf []byte, removeIfNew bool) (bool, error) {
	old, rerr := d.FS.ReadFile(path)
	existed := rerr == nil
	if rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		return false, opErr(rerr)
	}
	if existed && bytes.Equal(old, conf) {
		return false, nil
	}
	if _, err := d.FS.WriteAtomic(path, conf, 0o644, platform.Owner{}); err != nil {
		return false, opErr(err)
	}
	if err := d.nginxTest(ctx); err != nil {
		var rbErr error
		switch {
		case existed:
			_, rbErr = d.FS.WriteAtomic(path, old, 0o644, platform.Owner{})
		case removeIfNew:
			_, rbErr = d.FS.Remove(path)
		}
		if rbErr != nil {
			return false, &registry.OpError{Code: "internal", Message: "nginx -t lỗi và hoàn tác thất bại: " + rbErr.Error()}
		}
		return false, err
	}
	if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service"); err != nil {
		return false, err
	}
	return true, nil
}

func (d *Deps) nginxTest(ctx context.Context) error {
	res, err := d.run(ctx, "nginx", "-t", "-q")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return cmdFailed("config_test_failed", "nginx -t", res)
	}
	return nil
}

// ---------- nginx.vhost.remove / inspect ----------

func (d *Deps) vhostRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.NginxVhostRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	if err := validate.UUID(string(p.WebsiteUUID)); err != nil {
		return nil, opErr(err)
	}
	path := VhostPath(string(p.WebsiteUUID))
	nginxMu.Lock()
	defer nginxMu.Unlock()
	old, err := d.FS.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return toData(contracts.NginxVhostRemoveResult{Removed: false})
	}
	if err != nil {
		return nil, opErr(err)
	}
	// Chỉ xóa vhost của đúng account (dòng đầu file ghi account).
	if !bytes.Contains(old, []byte("· account "+string(p.Account.Username)+" ·")) {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "vhost không thuộc account " + string(p.Account.Username)}
	}
	if _, err := d.FS.Remove(path); err != nil {
		return nil, opErr(err)
	}
	if err := d.nginxTest(ctx); err != nil {
		if _, rb := d.FS.WriteAtomic(path, old, 0o644, platform.Owner{}); rb != nil {
			return nil, &registry.OpError{Code: "internal", Message: "nginx -t lỗi và hoàn tác thất bại: " + rb.Error()}
		}
		return nil, err
	}
	if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service"); err != nil {
		return nil, err
	}
	return toData(contracts.NginxVhostRemoveResult{Removed: true})
}

func (d *Deps) vhostInspect(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.NginxVhostInspectParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.UUID(string(p.WebsiteUUID)); err != nil {
		return nil, opErr(err)
	}
	b, err := d.FS.ReadFile(VhostPath(string(p.WebsiteUUID)))
	if errors.Is(err, fs.ErrNotExist) {
		return toData(contracts.NginxVhostInspectResult{Exists: false})
	}
	if err != nil {
		return nil, opErr(err)
	}
	s, sum := string(b), sha256.Sum256(b)
	h := hex.EncodeToString(sum[:])
	return toData(contracts.NginxVhostInspectResult{Exists: true, Config: &s, SHA256: &h})
}

// ---------- nginx.global.apply ----------

type globalData struct {
	WorkerProcesses, ClientMaxBodySize string
	WorkerConnections                  int64
	Gzip, HTTP2, ServerTokens          bool
}

func (d *Deps) nginxGlobalApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.NginxGlobalApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if p.WorkerProcesses != "auto" {
		if n, err := strconv.Atoi(p.WorkerProcesses); err != nil || n < 1 || n > 256 || strconv.Itoa(n) != p.WorkerProcesses {
			return nil, &registry.OpError{Code: "invalid_params", Message: "worker_processes: auto hoặc 1–256"}
		}
	}
	if p.WorkerConnections < 256 || p.WorkerConnections > 65535 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "worker_connections: 256–65535"}
	}
	if err := validate.NginxSize(string(p.ClientMaxBodySize)); err != nil {
		return nil, opErr(err)
	}
	conf, err := render("nginx.conf.tmpl", globalData{WorkerProcesses: p.WorkerProcesses, ClientMaxBodySize: string(p.ClientMaxBodySize),
		WorkerConnections: p.WorkerConnections, Gzip: p.Gzip, HTTP2: p.Http2, ServerTokens: p.ServerTokens})
	if err != nil {
		return nil, opErr(err)
	}
	nginxMu.Lock()
	defer nginxMu.Unlock()
	// Giữ bản gốc của gói một lần (để gỡ panel khôi phục được).
	if old, err := d.FS.ReadFile(nginxConf); err == nil && !bytes.HasPrefix(old, []byte("# Sinh bởi itso-agent")) && !d.FS.Exists(nginxConf+".itso-orig") {
		if _, err := d.FS.WriteAtomic(nginxConf+".itso-orig", old, 0o644, platform.Owner{}); err != nil {
			return nil, opErr(err)
		}
	}
	changed, err := d.applyNginxFile(ctx, nginxConf, conf, false)
	if err != nil {
		return nil, err
	}
	return toData(contracts.NginxGlobalApplyResult{NginxTest: "ok", Reloaded: changed, Changed: changed})
}

// ---------- log.tail ----------

func (d *Deps) logTail(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.LogTailParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	if err := validate.Domain(string(p.SiteDir)); err != nil {
		return nil, opErr(err)
	}
	if p.Kind != "access" && p.Kind != "error" {
		return nil, &registry.OpError{Code: "invalid_params", Message: "kind: access|error"}
	}
	if p.Lines < 1 || p.Lines > 500 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "lines: 1–500"}
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	lines, truncated, err := d.FS.Tail(siteLogDir(p.Account.Username, string(p.SiteDir))+"/"+p.Kind+".log", int(p.Lines), 512<<10)
	if errors.Is(err, fs.ErrNotExist) {
		return toData(contracts.LogTailResult{Lines: []string{}, Truncated: false})
	}
	if err != nil {
		return nil, opErr(err)
	}
	for i, l := range lines { // log là dữ liệu do client HTTP điều khiển: cắt dòng quá dài
		if len(l) > 4096 {
			lines[i] = l[:4096]
		}
	}
	return toData(contracts.LogTailResult{Lines: lines, Truncated: truncated})
}
