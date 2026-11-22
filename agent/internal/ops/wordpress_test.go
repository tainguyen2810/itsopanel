package ops_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/ops"
)

const (
	wpAdminPass = "Wp-Admin-7xQ2-secret-Lk9"
	wpDBPass    = "Db-User-4mN8-secret-Zt3"
	wpNewPass   = "Wp-Reset-2vB6-secret-Hd1"
	wpStgPass   = "Db-Stg-8kR1-secret-Pq5"
)

func wpSite(path string) map[string]any {
	return map[string]any{"account": acct(), "domain": "anphat.vn", "path": path, "php_version": "8.3"}
}

func wpInstallParams(path string) map[string]any {
	return map[string]any{"site": wpSite(path), "url": "https://anphat.vn", "title": "An Phát", "admin_user": "admin",
		"admin_email": "admin@anphat.vn", "admin_password": wpAdminPass, "locale": "vi",
		"db": map[string]any{"engine": "mariadb", "name": "anphat_wp", "user": "anphat_wpu", "password": wpDBPass}}
}

// wpEnv: account anphat + site anphat.vn + DB anphat_wp rỗng + WordPress đã cài ở sites/anphat.vn/public.
func wpEnv(t *testing.T) (*env, string) {
	t.Helper()
	e := dataEnv(t)
	e.h.OK("db.mysql.owner_ensure", map[string]any{"account": acct()})
	e.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_wp", "charset": "utf8mb4"})
	if d := e.h.OK(contracts.OpWpInstall, wpInstallParams("sites/anphat.vn/public")); d["installed"] != true || d["version"] != "6.6.2" {
		t.Fatal(d)
	}
	return e, filepath.Join(e.fs.Root, "home/anphat/sites/anphat.vn/public")
}

// noSecret: mật khẩu không nằm trong argv đã chạy, nhật ký audit hay kết quả; chỉ đi qua stdin.
func (e *env) noSecret(secrets ...string) {
	e.t.Helper()
	audit, _ := os.ReadFile(e.d.AuditPath)
	argv := strings.Join(e.fake.Lines(), "\n")
	for _, s := range secrets {
		if strings.Contains(argv, s) {
			e.t.Fatalf("mật khẩu xuất hiện trong argv: %s", s)
		}
		if strings.Contains(string(audit), s) {
			e.t.Fatalf("mật khẩu xuất hiện trong audit: %s", s)
		}
	}
}

func TestWPInstallInfoDetect(t *testing.T) {
	e, root := wpEnv(t)
	e.noSecret(wpAdminPass, wpDBPass)
	stdin := strings.Join(e.sim.WP().Stdin, "|")
	if !strings.Contains(stdin, wpAdminPass) || !strings.Contains(stdin, wpDBPass) {
		t.Fatal("mật khẩu phải đi qua stdin (--prompt)")
	}
	for _, l := range e.fake.Lines() {
		if strings.Contains(l, ops.WPCLIPath) {
			for _, want := range []string{"--uid=20001", "--gid=20001", "--slice=itso-acct-20001.slice", "/usr/bin/php8.3", "--skip-plugins"} {
				if !strings.Contains(l, want) {
					t.Fatalf("lệnh WP-CLI phải chạy dưới uid account trong slice (%s): %s", want, l)
				}
			}
			if !strings.HasPrefix(l, "systemd-run ") || strings.Contains(l, "sh -c") {
				t.Fatal(l)
			}
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "wp-includes/version.php")); !strings.Contains(string(b), "6.6.2") {
		t.Fatal(string(b))
	}
	// Cài lại vào site có sẵn: không ghi đè.
	e.h.Fail(contracts.OpWpInstall, wpInstallParams("sites/anphat.vn/public"), "already_exists")

	info := e.h.OK(contracts.OpWpInfo, map[string]any{"site": wpSite("sites/anphat.vn/public")})
	if info["version"] != "6.6.2" || info["site_url"] != "https://anphat.vn" || info["maintenance"] != false || info["checksums_ok"] != true || info["db_name"] != "anphat_wp" {
		t.Fatal(info)
	}
	comps := info["components"].([]any)
	names := map[string]bool{}
	for _, c := range comps {
		m := c.(map[string]any)
		if m["slug"] != nil {
			names[m["type"].(string)+"/"+m["slug"].(string)] = true
		}
	}
	if len(comps) != 3 || !names["plugin/akismet"] || !names["theme/twentytwentyfour"] {
		t.Fatal(comps)
	}
	e.sim.WP().Available["plugin/akismet"] = "5.4"
	e.sim.WP().Available["core"] = "6.6.3"
	info = e.h.OK(contracts.OpWpInfo, map[string]any{"site": wpSite("sites/anphat.vn/public")})
	for _, c := range info["components"].([]any) {
		m := c.(map[string]any)
		if (m["type"] == "core" && m["update_version"] != "6.6.3") || (m["slug"] == "akismet" && m["update_version"] != "5.4") {
			t.Fatal("thiếu bản cập nhật", m)
		}
	}

	write(t, filepath.Join(e.fs.Root, "home/anphat"), "sites/anphat.vn/public/blog/wp-includes/version.php", "<?php\n$wp_version = '6.5.5';\n")
	write(t, filepath.Join(e.fs.Root, "home/anphat"), "sites/anphat.vn/public/blog/wp-config.php", "<?php\ndefine( 'MULTISITE', true );\n")
	d := e.h.OK(contracts.OpWpDetect, map[string]any{"account": acct(), "roots": []any{"sites/anphat.vn/public", "sites/anphat.vn/public/blog", "sites/none.vn/public"}})
	sites := d["sites"].([]any)
	if len(sites) != 2 || sites[0].(map[string]any)["version"] != "6.6.2" || sites[1].(map[string]any)["multisite"] != true {
		t.Fatal(sites)
	}
	e.h.Fail(contracts.OpWpDetect, map[string]any{"account": acct(), "roots": []any{"backups"}}, "invalid_params")
}

func TestWPPathGuards(t *testing.T) {
	e, root := wpEnv(t)
	home := filepath.Join(e.fs.Root, "home/anphat")
	// Ngoài sites/<domain>/public, domain khác, thoát khỏi home.
	for _, p := range []string{"sites/anphat.vn", "backups/x", "sites/khac.vn/public", "sites/anphat.vn/public/../../.ssh"} {
		e.h.Fail(contracts.OpWpInfo, map[string]any{"site": wpSite(p)}, "invalid_params")
	}
	// Thành phần đường dẫn là symlink (ra ngoài home hoặc trong home) → chặn, không đi theo.
	if err := os.Symlink("/etc", filepath.Join(root, "evil")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, "sites/anphat.vn/public"), filepath.Join(root, "loop")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"sites/anphat.vn/public/evil", "sites/anphat.vn/public/loop", "sites/anphat.vn/public/evil/ssl"} {
		e.h.Fail(contracts.OpWpInfo, map[string]any{"site": wpSite(p)}, "path_outside_home")
		e.h.Fail(contracts.OpWpMaintenance, map[string]any{"site": wpSite(p), "enabled": true}, "path_outside_home")
	}
	d := e.h.OK(contracts.OpWpDetect, map[string]any{"account": acct(), "roots": []any{"sites/anphat.vn/public/loop"}})
	if len(d["sites"].([]any)) != 0 {
		t.Fatal("detect không được đi theo symlink", d)
	}
	// wp-config.php là symlink → không coi là WordPress.
	write(t, home, "sites/anphat.vn/public/sub/wp-includes/version.php", "<?php\n$wp_version = '6.6.2';\n")
	if err := os.Symlink("/etc/shadow", filepath.Join(root, "sub/wp-config.php")); err != nil {
		t.Fatal(err)
	}
	e.h.Fail(contracts.OpWpInfo, map[string]any{"site": wpSite("sites/anphat.vn/public/sub")}, "path_outside_home")
	// PHP ngoài 8.1–8.4.
	bad := wpSite("sites/anphat.vn/public")
	bad["php_version"] = "7.4"
	e.h.Fail(contracts.OpWpInfo, map[string]any{"site": bad}, "precondition_failed")
	// Allowlist subcommand: không có eval/shell/cờ nạp mã.
	for _, a := range [][]string{{"eval", "phpinfo();"}, {"shell"}, {"package", "install", "x"}, {"plugin", "install", "x"},
		{"core", "version", "--require=/tmp/x.php"}, {"option", "get", "siteurl", "--exec=system('id');"}, {"db", "query"},
		{"core", "version", "--path=/etc"}, {"search-replace", "a", "b", "--ssh=host"}} {
		if ops.WPAllowed(a) == nil {
			t.Fatalf("phải chặn %v", a)
		}
	}
	if ops.WPAllowed([]string{"plugin", "update", "akismet", "--minor"}) != nil {
		t.Fatal("plugin update phải được phép")
	}
}

func wpUpdateParams(repo map[string]any, comps ...map[string]any) map[string]any {
	cs := make([]any, len(comps))
	for i, c := range comps {
		cs[i] = c
	}
	return map[string]any{"site": wpSite("sites/anphat.vn/public"), "components": cs, "minor_only": false,
		"snapshot":     map[string]any{"repo": repo, "db": map[string]any{"engine": "mariadb", "name": "anphat_wp"}, "tags": []any{"auto"}},
		"check_scheme": "http"}
}

func wpRepo(t *testing.T, e *env) map[string]any {
	t.Helper()
	needRestic(t)
	e.d.Sandbox = true
	repo := bkRepoParams(localDest(), bkAcct, bkPass)
	e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo})
	return repo
}

func httpStatus(t *testing.T, e *env, code int) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }))
	t.Cleanup(srv.Close)
	e.d.HTTPAddrs = map[string]string{"http": srv.Listener.Addr().String()}
}

func TestWPUpdateOK(t *testing.T) {
	e, root := wpEnv(t)
	repo := wpRepo(t, e)
	httpStatus(t, e, 200)
	e.sim.WP().Available["plugin/akismet"] = "5.4"
	e.sim.WP().Available["core"] = "6.6.3"
	d := e.h.OK(contracts.OpWpUpdate, wpUpdateParams(repo, map[string]any{"type": "plugin", "slug": "akismet"}, map[string]any{"type": "core"}))
	if d["rolled_back"] != false || d["checksums_ok"] != true || d["http_status"] != float64(200) || d["snapshot_id"] == "" || d["db_snapshot_id"] == nil {
		t.Fatal(d)
	}
	res := d["results"].([]any)
	core, plug := res[0].(map[string]any), res[1].(map[string]any)
	if core["type"] != "core" || core["from_version"] != "6.6.2" || core["to_version"] != "6.6.3" || core["ok"] != true {
		t.Fatal("core cập nhật trước", res)
	}
	if plug["slug"] != "akismet" || plug["from_version"] != "5.3" || plug["to_version"] != "5.4" || plug["ok"] != true {
		t.Fatal(res)
	}
	if _, err := os.Stat(filepath.Join(root, ".maintenance")); !os.IsNotExist(err) {
		t.Fatal("maintenance phải tắt sau cập nhật")
	}
	// Snapshot pre-wp-update có trong repo.
	snaps := e.h.OK(contracts.OpBackupSnapshots, map[string]any{"repo": repo, "tags": []any{"pre-wp-update"}, "limit": 10})["snapshots"].([]any)
	if len(snaps) != 2 {
		t.Fatal("cần snapshot file + DB gắn tag pre-wp-update", snaps)
	}
	// Plugin chưa cài → kết quả lỗi, khôi phục.
	d = e.h.OK(contracts.OpWpUpdate, wpUpdateParams(repo, map[string]any{"type": "plugin", "slug": "khongco"}))
	if d["rolled_back"] != true || d["results"].([]any)[0].(map[string]any)["ok"] != false {
		t.Fatal(d)
	}
}

// Cập nhật lỗi giữa chừng (file plugin ghi dở + DB đã migrate) → khôi phục cả file và DB từ snapshot.
func TestWPUpdateFailureRestoresSnapshot(t *testing.T) {
	e, root := wpEnv(t)
	repo := wpRepo(t, e)
	httpStatus(t, e, 200)
	pluginFile := filepath.Join(root, "wp-content/plugins/akismet/akismet.php")
	before, _ := os.ReadFile(pluginFile)
	dbBefore := e.sim.DBDump("mariadb", "anphat_wp")
	e.sim.WP().Available["plugin/akismet"] = "5.4"
	e.sim.WP().Fail["plugin update akismet"] = "Download failed."
	d := e.h.OK(contracts.OpWpUpdate, wpUpdateParams(repo, map[string]any{"type": "plugin", "slug": "akismet"}))
	if d["rolled_back"] != true || d["rollback_error"] != nil {
		t.Fatal(d)
	}
	r := d["results"].([]any)[0].(map[string]any)
	if r["ok"] != false || !strings.Contains(r["error"].(string), "Download failed") {
		t.Fatal(r)
	}
	after, _ := os.ReadFile(pluginFile)
	if string(after) != string(before) {
		t.Fatalf("file plugin phải về bản snapshot:\n%s", after)
	}
	dbAfter := e.sim.DBDump("mariadb", "anphat_wp")
	if strings.Contains(dbAfter, "-- migrated") || !strings.Contains(dbAfter, strings.TrimSpace(dbBefore)) {
		t.Fatalf("DB phải về bản snapshot:\n%s", dbAfter)
	}
	if _, err := os.Stat(filepath.Join(root, ".maintenance")); !os.IsNotExist(err) {
		t.Fatal("site khôi phục không được kẹt maintenance")
	}
	// Bản lỗi được giữ lại để điều tra, không xóa.
	if m, _ := filepath.Glob(filepath.Join(e.fs.Root, "home/anphat/sites/anphat.vn.restore-*")); len(m) != 1 {
		t.Fatal("thiếu bản lỗi giữ lại", m)
	}

	// Checksum core sai sau cập nhật → khôi phục.
	delete(e.sim.WP().Fail, "plugin update akismet")
	e.sim.WP().ChecksumFail = true
	e.sim.WP().Available["core"] = "6.6.3"
	d = e.h.OK(contracts.OpWpUpdate, wpUpdateParams(repo, map[string]any{"type": "core"}))
	if d["rolled_back"] != true || d["checksums_ok"] != false {
		t.Fatal(d)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "wp-includes/version.php")); !strings.Contains(string(b), "6.6.2") {
		t.Fatal("core phải về 6.6.2", string(b))
	}

	// http.check 500 sau cập nhật → khôi phục.
	e.sim.WP().ChecksumFail = false
	httpStatus(t, e, 500)
	d = e.h.OK(contracts.OpWpUpdate, wpUpdateParams(repo, map[string]any{"type": "plugin", "slug": "akismet"}))
	if d["rolled_back"] != true || d["http_status"] != float64(500) {
		t.Fatal(d)
	}
	if after, _ := os.ReadFile(pluginFile); string(after) != string(before) {
		t.Fatal("plugin phải về 5.3")
	}

	// Repo server (không phải repo account) bị từ chối.
	e.h.Fail(contracts.OpWpUpdate, wpUpdateParams(bkRepoParams(localDest(), "", bkPass), map[string]any{"type": "core"}), "invalid_params")
}

func TestWPClone(t *testing.T) {
	e, _ := wpEnv(t)
	e.site("anphat", 20001, "staging.anphat.vn")
	e.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_stg", "charset": "utf8mb4"})
	target := map[string]any{"account": acct(), "domain": "staging.anphat.vn", "path": "sites/staging.anphat.vn/public", "php_version": "8.3"}
	params := map[string]any{"source": wpSite("sites/anphat.vn/public"), "target": target, "target_url": "https://staging.anphat.vn",
		"source_db": "anphat_wp", "target_db": map[string]any{"engine": "mariadb", "name": "anphat_stg", "user": "anphat_stgu", "password": wpStgPass},
		"noindex": true}
	srcDB := e.sim.DBDump("mariadb", "anphat_wp")
	d := e.h.OK(contracts.OpWpClone, params)
	if d["cloned"] != true || d["replaced"].(float64) < 2 {
		t.Fatal(d)
	}
	e.noSecret(wpStgPass)
	stg := filepath.Join(e.fs.Root, "home/anphat/sites/staging.anphat.vn/public")
	cfg, _ := os.ReadFile(filepath.Join(stg, "wp-config.php"))
	if !strings.Contains(string(cfg), "'DB_NAME', 'anphat_stg'") || !strings.Contains(string(cfg), "'DB_USER', 'anphat_stgu'") {
		t.Fatal(string(cfg))
	}
	stgDB := e.sim.DBDump("mariadb", "anphat_stg")
	if !strings.Contains(stgDB, "siteurl=https://staging.anphat.vn") || !strings.Contains(stgDB, "blog_public=0") {
		t.Fatal(stgDB)
	}
	if e.sim.DBDump("mariadb", "anphat_wp") != srcDB {
		t.Fatal("DB nguồn không được đổi")
	}
	// Đích đã có dữ liệu (file hoặc DB) → không ghi đè.
	e.h.Fail(contracts.OpWpClone, params, "already_exists")
	e.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_stg2", "charset": "utf8mb4"})
	e.sim.SetDBDump("mariadb", "anphat_stg2", "CREATE TABLE wp_posts (id int);\n")
	e.site("anphat", 20001, "dev.anphat.vn")
	p2 := map[string]any{}
	for k, v := range params {
		p2[k] = v
	}
	p2["target"] = map[string]any{"account": acct(), "domain": "dev.anphat.vn", "path": "sites/dev.anphat.vn/public", "php_version": "8.3"}
	p2["target_url"] = "https://dev.anphat.vn"
	p2["target_db"] = map[string]any{"engine": "mariadb", "name": "anphat_stg2", "user": "anphat_stgu", "password": wpStgPass}
	e.h.Fail(contracts.OpWpClone, p2, "already_exists")
	if ents, _ := os.ReadDir(filepath.Join(e.fs.Root, "home/anphat/sites/dev.anphat.vn/public")); len(ents) != 0 {
		t.Fatal("clone lỗi không để lại file", ents)
	}
	// URL đích phải thuộc domain đích.
	p2["target_db"] = map[string]any{"engine": "mariadb", "name": "anphat_stg2", "user": "anphat_stgu", "password": wpStgPass}
	p2["target_url"] = "https://evil.example"
	e.h.Fail(contracts.OpWpClone, p2, "invalid_params")
}

func TestWPHardenPasswordMaintenance(t *testing.T) {
	e, root := wpEnv(t)
	site := wpSite("sites/anphat.vn/public")
	all := []any{"file_edit_disabled", "xmlrpc_blocked", "php_in_uploads_blocked", "wp_config_protected", "version_hidden", "salts_rotated"}
	d := e.h.OK(contracts.OpWpHarden, map[string]any{"site": site, "enable": all, "disable": []any{}})
	if len(d["applied"].([]any)) != 6 || d["needs_vhost_reload"] != true {
		t.Fatal(d)
	}
	cfg, _ := os.ReadFile(filepath.Join(root, "wp-config.php"))
	if !strings.Contains(string(cfg), "DISALLOW_FILE_EDIT', true") || strings.Contains(string(cfg), "'AUTH_KEY', 'sim-0'") {
		t.Fatal(string(cfg))
	}
	if fi, _ := os.Stat(filepath.Join(root, "wp-config.php")); fi.Mode().Perm() != 0o400 {
		t.Fatal("wp-config phải 0400", fi.Mode())
	}
	if _, err := os.Stat(filepath.Join(root, ops.WPHardeningPlugin)); err != nil {
		t.Fatal(err)
	}
	if d := e.h.OK(contracts.OpWpHarden, map[string]any{"site": site, "enable": []any{"xmlrpc_blocked"}, "disable": []any{}}); d["needs_vhost_reload"] != false {
		t.Fatal("bật lại không cần reload vhost", d)
	}
	// Tắt file_edit khi wp-config đang khóa: mở tạm rồi khóa lại.
	d = e.h.OK(contracts.OpWpHarden, map[string]any{"site": site, "enable": []any{}, "disable": []any{"file_edit_disabled", "xmlrpc_blocked"}})
	ap := map[string]bool{}
	for _, a := range d["applied"].([]any) {
		ap[a.(string)] = true
	}
	if ap["file_edit_disabled"] || ap["xmlrpc_blocked"] || !ap["wp_config_protected"] || d["needs_vhost_reload"] != true {
		t.Fatal(d)
	}
	e.h.Fail(contracts.OpWpHarden, map[string]any{"site": site, "enable": []any{}, "disable": []any{"salts_rotated"}}, "invalid_params")
	info := e.h.OK(contracts.OpWpInfo, map[string]any{"site": site})["hardening"].(map[string]any)
	if info["php_in_uploads_blocked"] != true || info["xmlrpc_blocked"] != false || info["version_hidden"] != true || info["salts_rotated"] != true {
		t.Fatal(info)
	}

	e.fake.Reset()
	if d := e.h.OK(contracts.OpWpAdminPassword, map[string]any{"site": site, "user": "admin", "password": wpNewPass}); d["changed"] != true {
		t.Fatal(d)
	}
	e.noSecret(wpNewPass)
	e.h.Fail(contracts.OpWpAdminPassword, map[string]any{"site": site, "user": "khongco", "password": wpNewPass}, "not_found")

	if d := e.h.OK(contracts.OpWpMaintenance, map[string]any{"site": site, "enabled": true}); d["enabled"] != true {
		t.Fatal(d)
	}
	if _, err := os.Stat(filepath.Join(root, ".maintenance")); err != nil {
		t.Fatal(err)
	}
	e.fake.Reset()
	e.h.OK(contracts.OpWpMaintenance, map[string]any{"site": site, "enabled": true})
	for _, l := range e.fake.Lines() {
		if strings.Contains(l, "maintenance-mode activate") {
			t.Fatal("bật lần 2 không chạy lại activate")
		}
	}
	e.h.OK(contracts.OpWpMaintenance, map[string]any{"site": site, "enabled": false})
	if _, err := os.Stat(filepath.Join(root, ".maintenance")); !os.IsNotExist(err) {
		t.Fatal("phải tắt maintenance")
	}
}

func TestVhostWPHardening(t *testing.T) {
	e := newEnv(t)
	e.site("lehoa", 20001, "lehoa.vn")
	ws := "0193aa10-0001-7000-8000-0000000000a1"
	e.h.OK(contracts.OpPHPPoolApply, poolParams("lehoa", 20001, ws, "lehoa.vn"))
	p := vhostParams("lehoa", 20001, ws, "lehoa.vn", "php", "lehoa.vn")
	p["wp_hardening"] = map[string]any{"xmlrpc_blocked": true, "php_in_uploads_blocked": true}
	e.h.OK(contracts.OpNginxVhostApply, p)
	conf := e.file("/etc/nginx/sites-enabled/itso-" + ws + ".conf")
	xi, ui, pi := strings.Index(conf, "location = /xmlrpc.php"), strings.Index(conf, "location ~* ^/wp-content/uploads/"), strings.Index(conf, `location ~ \.php$`)
	if xi < 0 || ui < 0 || pi < 0 || ui > pi {
		t.Fatalf("thiếu chặn xmlrpc/PHP trong uploads (phải đứng trước location php):\n%s", conf)
	}
	p["wp_hardening"] = map[string]any{"xmlrpc_blocked": false, "php_in_uploads_blocked": false}
	e.h.OK(contracts.OpNginxVhostApply, p)
	if strings.Contains(e.file("/etc/nginx/sites-enabled/itso-"+ws+".conf"), "xmlrpc") {
		t.Fatal("tắt cờ phải bỏ chặn")
	}
	q := vhostParams("lehoa", 20001, ws, "lehoa.vn", "static", "lehoa.vn")
	q["wp_hardening"] = map[string]any{"xmlrpc_blocked": true, "php_in_uploads_blocked": false}
	e.h.Fail(contracts.OpNginxVhostApply, q, "invalid_params")
}

// File điều khiển sandbox (e2e stack thật): bản cập nhật có sẵn + lỗi giả lập đọc lại trước mỗi lệnh WP-CLI.
func TestWPSandboxControlFile(t *testing.T) {
	e, _ := wpEnv(t)
	write(t, e.fs.Root, strings.TrimPrefix(ops.SimWPControl, "/"), `{"available":{"plugin/akismet":"5.4"},"fail":{"plugin update akismet":"Download failed."}}`)
	info := e.h.OK(contracts.OpWpInfo, map[string]any{"site": wpSite("sites/anphat.vn/public")})
	found := false
	for _, c := range info["components"].([]any) {
		if m := c.(map[string]any); m["slug"] == "akismet" && m["update_version"] == "5.4" {
			found = true
		}
	}
	if !found || e.sim.WP().Fail["plugin update akismet"] != "Download failed." {
		t.Fatal("file điều khiển không được áp dụng", info)
	}
	write(t, e.fs.Root, strings.TrimPrefix(ops.SimWPControl, "/"), `{"fail":{}}`)
	e.h.OK(contracts.OpWpInfo, map[string]any{"site": wpSite("sites/anphat.vn/public")})
	if len(e.sim.WP().Fail) != 0 || e.sim.WP().Available["plugin/akismet"] != "5.4" {
		t.Fatal("chỉ khóa có mặt mới bị thay")
	}
}
