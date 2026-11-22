package ops_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

const (
	wsA   = "01938a06-0002-7000-8000-000006000002"
	wsB   = "02938a06-0003-7000-8000-000006000003"
	certA = "01938a0c-0001-7000-8000-00000c000001"
)

// site chuẩn bị account + PHP 8.3 + bố cục site.
func (e *env) site(user string, uid int, siteDir string) {
	e.t.Helper()
	e.h.OK(contracts.OpAccountEnsure, ct.EnsureParams(user, uid))
	e.h.OK(contracts.OpPHPVersionInstall, map[string]any{"version": "8.3", "extensions": []any{}})
	e.h.OK(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": ct.Acct(user, uid), "site_dir": siteDir})
}

func poolParams(user string, uid int, ws, siteDir string) map[string]any {
	return map[string]any{"account": ct.Acct(user, uid), "website_uuid": ws, "site_dir": siteDir, "version": "8.3",
		"pm_max_children": 6, "memory_limit": "256m", "max_execution_time": 60, "upload_max_filesize": "64m",
		"disable_functions": []any{"shell_exec", "exec"}}
}

func vhostParams(user string, uid int, ws, siteDir, typ string, names ...string) map[string]any {
	ns := []any{}
	for _, n := range names {
		ns = append(ns, n)
	}
	p := map[string]any{"account": ct.Acct(user, uid), "website_uuid": ws, "site_dir": siteDir, "type": typ,
		"server_names": ns, "document_root": "public"}
	return p
}

func (e *env) mode(p string) os.FileMode {
	e.t.Helper()
	rp, _ := e.fs.Path(p)
	fi, err := os.Lstat(rp)
	if err != nil {
		e.t.Fatal(err)
	}
	return fi.Mode()
}

func (e *env) exists(p string) bool { return e.fs.Exists(p) }

func TestSiteLayoutGolden(t *testing.T) {
	e := newEnv(t)
	e.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("lehoa", 20001))
	d := e.step("fs.site_layout.ensure", contracts.OpFsSiteLayoutEnsure, map[string]any{"account": ct.Acct("lehoa", 20001), "site_dir": "lehoa.vn"}, true)
	if d["path"] != "/home/lehoa/sites/lehoa.vn" || d["created"] != true {
		t.Fatal(d)
	}
	for p, w := range map[string]struct {
		mode     os.FileMode
		uid, gid int
	}{
		"/home/lehoa/sites/lehoa.vn": {0o750, 20001, 20001}, "/home/lehoa/sites/lehoa.vn/public": {0o750, 20001, 20001},
		"/home/lehoa/sites/lehoa.vn/tmp": {0o700, 20001, 20001}, "/var/log/itso/sites/lehoa/lehoa.vn": {0o750, 0, 20001},
	} {
		if m := e.mode(p); m.Perm() != w.mode || !m.IsDir() {
			t.Errorf("%s: %v", p, m)
		}
		if o, _ := e.fs.OwnerOf(p); o.UID != w.uid || o.GID != w.gid {
			t.Errorf("%s: chủ %+v", p, o)
		}
	}
	// Lần 2: created=false.
	if d := e.h.OK(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": ct.Acct("lehoa", 20001), "site_dir": "lehoa.vn"}); d["created"] != false {
		t.Fatal(d)
	}
	// Account đổi thư mục site thành symlink → từ chối, không đụng tới đích.
	rp, _ := e.fs.Path("/home/lehoa/sites/evil.vn")
	if err := os.Symlink("/etc", rp); err != nil {
		t.Fatal(err)
	}
	e.fake.Reset()
	e.h.Fail(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": ct.Acct("lehoa", 20001), "site_dir": "evil.vn"}, "path_outside_home")
	if len(e.writes()) != 0 {
		t.Fatal(e.writes())
	}
	// Account chưa có → not_found; domain nội bộ → reserved_name.
	e.h.Fail(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": ct.Acct("khac", 20002), "site_dir": "khac.vn"}, "not_found")
	e.h.Fail(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": ct.Acct("lehoa", 20001), "site_dir": "panel.localhost"}, "reserved_name")
}

func TestPHPVersionAndExtGolden(t *testing.T) {
	e := newEnv(t)
	if d := e.step("php.version.install", contracts.OpPHPVersionInstall, map[string]any{"version": "8.3", "extensions": []any{"intl", "mbstring"}}, true); d["changed"] != true {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpPHPVersionInstall, map[string]any{"version": "8.3", "extensions": []any{}}); d["changed"] != false {
		t.Fatal(d)
	}
	e.h.Fail(contracts.OpPHPVersionInstall, map[string]any{"version": "7.4", "extensions": []any{}}, "precondition_failed")
	if d := e.step("php.ext.install", contracts.OpPHPExtInstall, map[string]any{"version": "8.3", "extensions": []any{"redis", "gd", "intl"}}, true); d["changed"] != true ||
		strings.Join(toStrings(d["installed"]), ",") != "gd,intl,redis" {
		t.Fatal(d)
	}
	// Còn pool → không gỡ được.
	e.site("lehoa", 20001, "lehoa.vn")
	e.h.OK(contracts.OpPHPPoolApply, poolParams("lehoa", 20001, wsA, "lehoa.vn"))
	e.h.Fail(contracts.OpPHPVersionRemove, map[string]any{"version": "8.3"}, "precondition_failed")
	e.h.OK(contracts.OpPHPPoolRemove, map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": wsA})
	e.step("php.version.remove", contracts.OpPHPVersionRemove, map[string]any{"version": "8.3"}, true)
	e.h.Fail(contracts.OpPHPExtInstall, map[string]any{"version": "8.3", "extensions": []any{"intl"}}, "precondition_failed")
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestPHPPoolGolden(t *testing.T) {
	e := newEnv(t)
	e.site("lehoa", 20001, "lehoa.vn")
	e.h.OK(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": ct.Acct("lehoa", 20001), "site_dir": "shop.lehoa.vn"})
	d := e.step("php.pool.apply", contracts.OpPHPPoolApply, poolParams("lehoa", 20001, wsA, "lehoa.vn"), true)
	if d["socket"] != "/run/itso/php/lehoa-01938a06.sock" || d["unit"] != "itso-php@8.3-lehoa.service" || d["changed"] != true || d["reloaded"] != true {
		t.Fatal(d)
	}
	golden(t, "php-pool.conf", e.file("/etc/itso/php/8.3/lehoa/pool.d/01938a06.conf"))
	golden(t, "php-fpm.conf", e.file("/etc/itso/php/8.3/lehoa/php-fpm.conf"))
	golden(t, "itso-php-dropin.conf", e.file("/etc/systemd/system/itso-php@8.3-lehoa.service.d/10-itso.conf"))
	if m := e.mode("/run/itso/php"); m&os.ModeSticky == 0 || m.Perm() != 0o733 {
		t.Fatalf("/run/itso/php: %v", m)
	}
	// Pool thứ 2 cùng hex8 (website khác) → already_exists; pool website B (hex khác) → chỉ reload.
	clash := poolParams("lehoa", 20001, "01938a06-9999-7000-8000-000006009999", "shop.lehoa.vn")
	e.h.Fail(contracts.OpPHPPoolApply, clash, "already_exists")
	pb := poolParams("lehoa", 20001, "02938a06-0003-7000-8000-000006000003", "shop.lehoa.vn")
	e.fake.Reset()
	e.h.OK(contracts.OpPHPPoolApply, pb)
	if w := strings.Join(e.writes(), "\n"); !strings.Contains(w, "systemctl reload itso-php@8.3-lehoa.service") || strings.Contains(w, "daemon-reload") {
		t.Fatal(w)
	}
	// php-fpm -t lỗi khi sửa → bản cũ được khôi phục.
	old := e.file("/etc/itso/php/8.3/lehoa/pool.d/01938a06.conf")
	e.fail["[uid=20001] php-fpm8.3 -t"] = platform.Result{ExitCode: 78, Stderr: []byte("ERROR: [pool lehoa-01938a06] invalid value")}
	changed := poolParams("lehoa", 20001, wsA, "lehoa.vn")
	changed["pm_max_children"] = 12
	e.fake.Reset()
	r := e.h.Fail(contracts.OpPHPPoolApply, changed, "config_test_failed")
	if !strings.Contains(r.Error.Message, "invalid value") || e.file("/etc/itso/php/8.3/lehoa/pool.d/01938a06.conf") != old {
		t.Fatal(r.Error, "bản cũ phải được khôi phục")
	}
	if strings.Contains(strings.Join(e.writes(), "\n"), "systemctl reload") {
		t.Fatal("không được reload khi -t lỗi")
	}
	delete(e.fail, "[uid=20001] php-fpm8.3 -t")
	// Xóa pool A → reload; xóa pool B (cuối) → dừng master, xóa cấu hình master + drop-in.
	e.fake.Reset()
	e.h.OK(contracts.OpPHPPoolRemove, map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": wsA})
	if w := strings.Join(e.writes(), "\n"); w != "systemctl reload itso-php@8.3-lehoa.service" {
		t.Fatal(w)
	}
	d = e.step("php.pool.remove.last", contracts.OpPHPPoolRemove, map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": "02938a06-0003-7000-8000-000006000003"}, true)
	if d["removed"] != true || e.exists("/etc/itso/php/8.3/lehoa/php-fpm.conf") || e.exists("/etc/systemd/system/itso-php@8.3-lehoa.service.d/10-itso.conf") {
		t.Fatal(d)
	}
	// Chưa có bố cục site / PHP 8.1 / max_children ngoài dải.
	e.h.Fail(contracts.OpPHPPoolApply, poolParams("lehoa", 20001, wsA, "chua-co.vn"), "precondition_failed")
	bad := poolParams("lehoa", 20001, wsA, "lehoa.vn")
	bad["version"] = "8.1"
	e.h.Fail(contracts.OpPHPPoolApply, bad, "precondition_failed")
}

func TestVhostGolden(t *testing.T) {
	e := newEnv(t)
	e.site("lehoa", 20001, "lehoa.vn")
	e.h.OK(contracts.OpPHPPoolApply, poolParams("lehoa", 20001, wsA, "lehoa.vn"))

	p := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "php", "lehoa.vn")
	p["redirect_names"] = []any{"www.lehoa.vn"}
	p["extra_headers"] = map[string]any{"X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "strict-origin"}
	p["redirects"] = []any{map[string]any{"from": "/old-shop", "to": "https://lehoa.vn/shop", "code": "301"}}
	p["client_max_body_size"] = "128m"
	d := e.step("nginx.vhost.apply.php", contracts.OpNginxVhostApply, p, true)
	if d["config_path"] != "/etc/nginx/sites-enabled/itso-"+wsA+".conf" || d["changed"] != true || d["reloaded"] != true || d["nginx_test"] != "ok" {
		t.Fatal(d)
	}
	golden(t, "vhost-php.conf", e.file("/etc/nginx/sites-enabled/itso-"+wsA+".conf"))
	if !e.exists("/var/lib/itso/suspended/itso-suspended.html") || !e.exists("/var/lib/itso/acme/webroot") {
		t.Fatal("thiếu thư mục dùng chung")
	}

	// static, proxy, suspended: chỉ so file.
	for name, mut := range map[string]func(m map[string]any){
		"static": func(m map[string]any) { m["type"] = "static"; m["document_root"] = "public/dist"; m["http2"] = false },
		"proxy":  func(m map[string]any) { m["type"] = "proxy"; m["proxy_port"] = 3000 },
		"suspended": func(m map[string]any) {
			m["suspended"] = true
			m["redirects"] = []any{map[string]any{"from": "/x", "to": "https://lehoa.vn/", "code": "302"}}
		},
	} {
		q := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "php", "lehoa.vn", "lehoa.com.vn")
		mut(q)
		e.h.OK(contracts.OpNginxVhostApply, q)
		golden(t, "vhost-"+name+".conf", e.file("/etc/nginx/sites-enabled/itso-"+wsA+".conf"))
	}

	// TLS: thiếu chứng chỉ → precondition_failed; có chứng chỉ → 443 + HSTS + chuyển HTTPS.
	tls := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "php", "lehoa.vn")
	tls["redirect_names"] = []any{"www.lehoa.vn"}
	tls["tls"] = map[string]any{"cert_uuid": certA, "hsts": true, "force_https": true}
	e.h.Fail(contracts.OpNginxVhostApply, tls, "precondition_failed")
	e.h.OK(contracts.OpCertIssue, issueParams("letsencrypt-staging", "lehoa.vn", "www.lehoa.vn"))
	e.h.OK(contracts.OpNginxVhostApply, tls)
	golden(t, "vhost-tls.conf", e.file("/etc/nginx/sites-enabled/itso-"+wsA+".conf"))

	// inspect / remove.
	ins := e.h.OK(contracts.OpNginxVhostInspect, map[string]any{"website_uuid": wsA})
	if ins["exists"] != true || !strings.Contains(ins["config"].(string), "ssl_certificate /etc/itso/certs/"+certA) || len(ins["sha256"].(string)) != 64 {
		t.Fatal(ins)
	}
	e.h.Fail(contracts.OpCertRemove, map[string]any{"account": ct.Acct("lehoa", 20001), "cert_uuid": certA}, "precondition_failed")
	e.h.Fail(contracts.OpNginxVhostRemove, map[string]any{"account": ct.Acct("khac", 20002), "website_uuid": wsA}, "precondition_failed")
	d = e.step("nginx.vhost.remove", contracts.OpNginxVhostRemove, map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": wsA}, true)
	if d["removed"] != true || e.exists("/etc/nginx/sites-enabled/itso-"+wsA+".conf") {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpNginxVhostInspect, map[string]any{"website_uuid": wsA}); d["exists"] != false || d["config"] != nil {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpCertRemove, map[string]any{"account": ct.Acct("lehoa", 20001), "cert_uuid": certA}); d["removed"] != true || e.exists("/etc/itso/certs/"+certA) {
		t.Fatal(d)
	}

	// php vhost khi chưa có pool → precondition_failed; php_socket lệch → invalid_params.
	e.h.Fail(contracts.OpNginxVhostApply, vhostParams("lehoa", 20001, wsB, "lehoa.vn", "php", "b.lehoa.vn"), "precondition_failed")
	sock := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "php", "lehoa.vn")
	sock["php_socket"] = "/run/itso/php/khac-01938a06.sock"
	e.h.Fail(contracts.OpNginxVhostApply, sock, "invalid_params")
	tmp := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "static", "lehoa.vn")
	tmp["document_root"] = "tmp"
	e.h.Fail(contracts.OpNginxVhostApply, tmp, "invalid_params")
}

// nginx -t lỗi → bản cũ được khôi phục (site sửa) hoặc file bị xóa (site mới), không reload; site khác không bị ảnh hưởng.
func TestVhostRollback(t *testing.T) {
	e := newEnv(t)
	e.site("lehoa", 20001, "lehoa.vn")
	good := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "static", "lehoa.vn")
	e.h.OK(contracts.OpNginxVhostApply, good)
	before := e.file(ops.VhostPath(wsA))

	e.fake.Reset()
	r := e.h.Fail(contracts.OpNginxVhostApply, vhostParams("lehoa", 20001, wsB, "lehoa.vn", "static", ops.SimFailDomainPrefix+"lehoa.vn"), "config_test_failed")
	if !strings.Contains(r.Error.Message, "invalid server_name") {
		t.Fatal(r.Error)
	}
	if e.exists(ops.VhostPath(wsB)) {
		t.Fatal("site mới lỗi phải bị xóa")
	}
	golden(t, "nginx.vhost.apply.rollback-new.argv", strings.Join(e.fake.Lines(), "\n")+"\n")

	bad := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "static", "lehoa.vn", ops.SimFailDomainPrefix+"lehoa.vn")
	e.fake.Reset()
	e.h.Fail(contracts.OpNginxVhostApply, bad, "config_test_failed")
	if e.file(ops.VhostPath(wsA)) != before {
		t.Fatal("bản cũ phải được khôi phục")
	}
	for _, l := range e.fake.Lines() {
		if strings.Contains(l, "reload") {
			t.Fatal("không được reload khi nginx -t lỗi:", e.fake.Lines())
		}
	}
	// Sau hoàn tác, nginx -t lại xanh: site khác vẫn áp được.
	e.h.OK(contracts.OpNginxVhostApply, vhostParams("lehoa", 20001, wsB, "lehoa.vn", "static", "b.lehoa.vn"))
}

func TestNginxGlobalGolden(t *testing.T) {
	e := newEnv(t)
	write(t, e.fs.Root, "/etc/nginx/nginx.conf", "user www-data;\n# bản gốc của gói\n")
	p := map[string]any{"worker_processes": "auto", "worker_connections": 2048, "client_max_body_size": "64m", "gzip": true, "http2": true, "server_tokens": false}
	if d := e.step("nginx.global.apply", contracts.OpNginxGlobalApply, p, true); d["changed"] != true || d["reloaded"] != true {
		t.Fatal(d)
	}
	golden(t, "nginx.conf", e.file("/etc/nginx/nginx.conf"))
	if e.file("/etc/nginx/nginx.conf.itso-orig") != "user www-data;\n# bản gốc của gói\n" {
		t.Fatal("phải giữ bản gốc")
	}
	p["worker_processes"] = "0"
	e.h.Fail(contracts.OpNginxGlobalApply, p, "invalid_params")
	p["worker_processes"] = "4"
	p["gzip"] = false
	e.h.OK(contracts.OpNginxGlobalApply, p)
	if c := e.file("/etc/nginx/nginx.conf"); !strings.Contains(c, "worker_processes 4;") || !strings.Contains(c, "gzip off;") {
		t.Fatal(c)
	}
	if e.file("/etc/nginx/nginx.conf.itso-orig") != "user www-data;\n# bản gốc của gói\n" {
		t.Fatal("bản gốc không được ghi đè bằng bản do agent sinh")
	}
}

func TestLogTail(t *testing.T) {
	e := newEnv(t)
	e.site("lehoa", 20001, "lehoa.vn")
	acct := ct.Acct("lehoa", 20001)
	if d := e.h.OK(contracts.OpLogTail, map[string]any{"account": acct, "site_dir": "lehoa.vn", "kind": "access", "lines": 10}); len(d["lines"].([]any)) != 0 {
		t.Fatal(d)
	}
	write(t, e.fs.Root, "/var/log/itso/sites/lehoa/lehoa.vn/access.log", "l1\nl2\nl3\nl4\n")
	d := e.step("log.tail", contracts.OpLogTail, map[string]any{"account": acct, "site_dir": "lehoa.vn", "kind": "access", "lines": 2}, false)
	if strings.Join(toStrings(d["lines"]), ",") != "l3,l4" || d["truncated"] != true {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpLogTail, map[string]any{"account": acct, "site_dir": "lehoa.vn", "kind": "access", "lines": 500}); d["truncated"] != false || len(d["lines"].([]any)) != 4 {
		t.Fatal(d)
	}
	// File log là symlink → không đọc.
	rp, _ := e.fs.Path("/var/log/itso/sites/lehoa/lehoa.vn/error.log")
	if err := os.Symlink(filepath.Join(e.fs.Root, "etc/shadow"), rp); err != nil {
		t.Fatal(err)
	}
	e.h.Fail(contracts.OpLogTail, map[string]any{"account": acct, "site_dir": "lehoa.vn", "kind": "error", "lines": 10}, "internal")
	e.h.Fail(contracts.OpLogTail, map[string]any{"account": acct, "site_dir": "lehoa.vn", "kind": "access", "lines": 501}, "invalid_params")
}

func issueParams(dir string, doms ...string) map[string]any {
	ds := []any{}
	for _, d := range doms {
		ds = append(ds, d)
	}
	return map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": wsA, "cert_uuid": certA, "site_dir": "lehoa.vn",
		"domains": ds, "challenge": "http-01", "email": "it@lehoa.vn", "directory": dir, "renew": false}
}

func TestCertOps(t *testing.T) {
	e := newEnv(t)
	e.site("lehoa", 20001, "lehoa.vn")
	d := e.step("cert.issue", contracts.OpCertIssue, issueParams("letsencrypt", "lehoa.vn", "www.lehoa.vn"), false)
	if d["cert_uuid"] != certA || d["issuer"] != "ITSO Sandbox ACME CA" || strings.Join(toStrings(d["domains"]), ",") != "lehoa.vn,www.lehoa.vn" {
		t.Fatal(d)
	}
	if m := e.mode("/etc/itso/certs/" + certA + "/privkey.pem"); m.Perm() != 0o600 {
		t.Fatal(m)
	}
	// Gia hạn: có cert của lego → argv renew.
	rn := issueParams("letsencrypt", "lehoa.vn", "www.lehoa.vn")
	rn["renew"] = true
	e.step("cert.issue.renew", contracts.OpCertIssue, rn, false)

	ins := e.h.OK(contracts.OpCertInspect, map[string]any{"cert_uuid": certA})
	if ins["exists"] != true || ins["cert"].(map[string]any)["issuer"] != "ITSO Sandbox ACME CA" {
		t.Fatal(ins)
	}
	if d := e.h.OK(contracts.OpCertInspect, map[string]any{"cert_uuid": "01938a0c-0009-7000-8000-00000c000009"}); d["exists"] != false || d["cert"] != nil {
		t.Fatal(d)
	}
	// Pebble cần policy; domain chưa trỏ → precondition_failed (không retry).
	e.h.Fail(contracts.OpCertIssue, issueParams("pebble", "lehoa.vn"), "precondition_failed")
	e.d.AcmePebble = true
	e.h.Fail(contracts.OpCertIssue, issueParams("pebble", "lehoa.vn"), "precondition_failed") // thiếu CA của Pebble
	write(t, e.fs.Root, ops.PebbleCA, "-----BEGIN CERTIFICATE-----\n")
	e.fake.Reset()
	e.h.OK(contracts.OpCertIssue, issueParams("pebble", "lehoa.vn"))
	if c := e.fake.Calls[len(e.fake.Calls)-1]; c.Bin != "lego" || len(c.Env) != 1 || c.Env[0] != "LEGO_CA_CERTIFICATES="+ops.PebbleCA {
		t.Fatalf("%+v", c)
	}
	r := e.h.Fail(contracts.OpCertIssue, issueParams("letsencrypt", ops.SimACMEFailPrefix+"lehoa.vn"), "precondition_failed")
	if r.Error.Retryable || !strings.Contains(r.Error.Message, "unauthorized") {
		t.Fatal(r.Error)
	}

	// Tải lên: cặp hợp lệ → ghi; khóa lệch → invalid_params; hết hạn → invalid_params.
	chain, key, err := ops.SelfSigned([]string{"lehoa.vn"}, "Upload CA", ct.Now)
	if err != nil {
		t.Fatal(err)
	}
	_, other, _ := ops.SelfSigned([]string{"lehoa.vn"}, "Upload CA", ct.Now)
	up := map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": wsA, "cert_uuid": "01938a0c-0002-7000-8000-00000c000002",
		"certificate_pem": string(chain), "private_key_pem": string(key)}
	if d := e.h.OK(contracts.OpCertInstall, up); d["issuer"] != "Upload CA" || d["not_after"] != ct.Now.Add(90*24*time.Hour).UTC().Format(time.RFC3339) {
		t.Fatal(d)
	}
	up["private_key_pem"] = string(other)
	e.h.Fail(contracts.OpCertInstall, up, "invalid_params")
	old, oldKey, _ := ops.SelfSigned([]string{"lehoa.vn"}, "Upload CA", ct.Now.Add(-200*24*time.Hour))
	up["certificate_pem"], up["private_key_pem"] = string(old), string(oldKey)
	e.h.Fail(contracts.OpCertInstall, up, "invalid_params")
	up["certificate_pem"], up["private_key_pem"] = "not pem", string(key)
	e.h.Fail(contracts.OpCertInstall, up, "invalid_params")
	e.step("cert.remove", contracts.OpCertRemove, map[string]any{"account": ct.Acct("lehoa", 20001), "cert_uuid": certA}, true)
}

// Mọi file cấu hình sinh ra đúng cú pháp Nginx/PHP-FPM thật khi có binary (container dev, VM).
func TestRenderedConfigsWithRealBinaries(t *testing.T) {
	if _, err := os.Stat(platform.Bins["nginx"]); err != nil {
		t.Skip("không có nginx trên máy chạy test: kiểm ở VM (tests/vm/phase5.sh)")
	}
	if os.Geteuid() != 0 {
		t.Skip("nginx -t cần root để mở log/pid")
	}
	realCheck(t)
}

// Thay chứng chỉ vhost đang dùng (gia hạn/tải lại) → nginx -t + reload; chứng chỉ chưa ai dùng → không reload.
func TestCertReplaceInUseReloadsNginx(t *testing.T) {
	e := newEnv(t)
	e.site("lehoa", 20001, "lehoa.vn")
	e.h.OK(contracts.OpCertIssue, issueParams("letsencrypt", "lehoa.vn"))
	up := func(issuer string) map[string]any {
		chain, key, err := ops.SelfSigned([]string{"lehoa.vn"}, issuer, ct.Now)
		if err != nil {
			t.Fatal(err)
		}
		return map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": wsA, "cert_uuid": certA,
			"certificate_pem": string(chain), "private_key_pem": string(key)}
	}
	reloaded := func() bool {
		for _, l := range e.fake.Lines() {
			if strings.Contains(l, "reload nginx.service") {
				return true
			}
		}
		return false
	}
	e.fake.Reset()
	e.h.OK(contracts.OpCertInstall, up("Chưa dùng CA"))
	if reloaded() {
		t.Fatal("chứng chỉ chưa có vhost dùng: không reload", e.fake.Lines())
	}
	tls := vhostParams("lehoa", 20001, wsA, "lehoa.vn", "static", "lehoa.vn")
	tls["tls"] = map[string]any{"cert_uuid": certA, "hsts": false, "force_https": true}
	e.h.OK(contracts.OpNginxVhostApply, tls)
	e.fake.Reset()
	e.h.OK(contracts.OpCertInstall, up("Mới CA"))
	if !reloaded() {
		t.Fatal("thay chứng chỉ đang dùng phải reload nginx", e.fake.Lines())
	}
	e.fake.Reset()
	e.h.OK(contracts.OpCertInstall, map[string]any{"account": ct.Acct("lehoa", 20001), "website_uuid": wsA, "cert_uuid": certA,
		"certificate_pem": e.file("/etc/itso/certs/" + certA + "/fullchain.pem"), "private_key_pem": e.file("/etc/itso/certs/" + certA + "/privkey.pem")})
	if reloaded() {
		t.Fatal("nội dung không đổi: không reload", e.fake.Lines())
	}
}
