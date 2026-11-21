package ops_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
)

const (
	migUUID = "0193dd20-0001-7000-8000-000000000009"
	wsShop  = "01938a05-0001-7000-8000-0000000000a1"
	wsOther = "01938a05-0001-7000-8000-0000000000b2"
	cronID  = "01938a0d-0001-7000-8000-00000d0000c1"
)

func hexSum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// ---------- http.check ----------

func TestHTTPCheck(t *testing.T) {
	e := newEnv(t)
	var hosts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hosts = append(hosts, r.Host)
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "https://evil.example/", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("xin chao"))
	}))
	defer srv.Close()
	e.d.HTTPAddrs = map[string]string{"http": srv.Listener.Addr().String()}
	p := func(path string, expect ...any) map[string]any {
		return map[string]any{"host": "anphat.vn", "path": path, "scheme": "http", "expect_status": expect}
	}
	d := e.h.OK(contracts.OpHTTPCheck, p("/", 200))
	if d["status"] != float64(200) || d["ok"] != true || d["body_sha256"] != hexSum("xin chao") {
		t.Fatal(d)
	}
	if hosts[0] != "anphat.vn" {
		t.Fatal("Host header phải là domain, kết nối tới địa chỉ cố định của node", hosts)
	}
	// Không theo redirect (không thể bị dẫn ra host khác).
	if d := e.h.OK(contracts.OpHTTPCheck, p("/old", 200)); d["status"] != float64(302) || d["ok"] != false {
		t.Fatal(d)
	}
	for _, bad := range []string{"/../etc/passwd", "/a/%2e%2e/b", "//evil", "/a%2fb", "relative", "/a?x=1"} {
		e.h.Fail(contracts.OpHTTPCheck, p(bad, 200), "invalid_params")
	}
	e.h.Fail(contracts.OpHTTPCheck, map[string]any{"host": "127.0.0.1:22", "path": "/", "scheme": "http", "expect_status": []any{200}}, "invalid_params")
	// Không kết nối được → status 0, không lỗi op.
	e.d.HTTPAddrs = map[string]string{"http": "127.0.0.1:1"}
	if d := e.h.OK(contracts.OpHTTPCheck, p("/", 200)); d["status"] != float64(0) || d["ok"] != false || d["body_sha256"] != nil {
		t.Fatal(d)
	}
}

// ---------- account.remove ----------

func removeParams(user string, uid int, confirm string) map[string]any {
	return map[string]any{"account": ct.Acct(user, uid), "reason": "purge", "ref_uuid": migUUID,
		"final_snapshot_id": "0123abcd", "confirm_username": confirm, "confirm": true}
}

func TestAccountRemove(t *testing.T) {
	e := dataEnv(t)
	e.site("lehoa", 20002, "lehoa.vn")
	e.h.OK(contracts.OpPHPPoolApply, poolParams("anphat", 20001, wsShop, "anphat.vn"))
	e.h.OK(contracts.OpNginxVhostApply, vhostParams("anphat", 20001, wsShop, "anphat.vn", "php", "anphat.vn", "www.anphat.vn"))
	e.h.OK(contracts.OpPHPPoolApply, poolParams("lehoa", 20002, wsOther, "lehoa.vn"))
	e.h.OK(contracts.OpNginxVhostApply, vhostParams("lehoa", 20002, wsOther, "lehoa.vn", "php", "lehoa.vn"))
	e.h.OK(contracts.OpCronApply, map[string]any{"account": acct(), "entries": []any{cronEntry(cronID, "*/5 * * * *", "true", true)}})
	e.h.OK(contracts.OpSFTPUserEnsure, map[string]any{"account": acct(), "ssh_access": true, "password": pw})
	e.h.OK(contracts.OpSSHKeysApply, map[string]any{"account": acct(), "keys": []any{edKey(t)}})
	e.h.OK(contracts.OpFTPUserEnsure, map[string]any{"account": acct(), "username": "anphat_dev", "root_path": "sites/anphat.vn", "enabled": true, "password": pw})
	for _, a := range []map[string]any{acct(), ct.Acct("lehoa", 20002)} {
		e.h.OK("db.mysql.owner_ensure", map[string]any{"account": a})
	}
	e.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf8mb4"})
	e.h.OK("db.mysql.user_ensure", map[string]any{"account": acct(), "username": "anphat_app", "password": pw, "host": "localhost", "max_connections": 10})
	e.h.OK("db.mysql.create", map[string]any{"account": ct.Acct("lehoa", 20002), "name": "lehoa_blog", "charset": "utf8mb4"})
	// Symlink trong home trỏ sang dữ liệu account khác: xóa home không được theo symlink.
	lehoaFile := filepath.Join(e.fs.Root, "home/lehoa/sites/lehoa.vn/public/index.html")
	write(t, e.fs.Root, "home/lehoa/sites/lehoa.vn/public/index.html", "lehoa")
	if err := os.Symlink(filepath.Join(e.fs.Root, "home/lehoa/sites"), filepath.Join(e.fs.Root, "home/anphat/sites/anphat.vn/link")); err != nil {
		t.Fatal(err)
	}

	e.h.Fail(contracts.OpAccountRemove, removeParams("anphat", 20001, "lehoa"), "invalid_params")
	e.h.Fail(contracts.OpAccountRemove, removeParams("anphat", 20099, "anphat"), "precondition_failed")
	e.h.Fail(contracts.OpAccountRemove, removeParams("ubuntu", 1000, "ubuntu"), "invalid_params") // uid ngoài dải account

	if ins := e.h.OK("db.mysql.inspect", map[string]any{"account": ct.Acct("lehoa", 20002)}); len(ins["databases"].([]any)) != 1 {
		t.Fatal("trước khi xóa lehoa có 1 DB", ins)
	}
	e.fake.Reset()
	d := e.h.OK(contracts.OpAccountRemove, removeParams("anphat", 20001, "anphat"))
	kinds := map[string][]string{}
	for _, o := range d["removed_objects"].([]any) {
		m := o.(map[string]any)
		kinds[m["kind"].(string)] = append(kinds[m["kind"].(string)], m["name"].(string))
	}
	for _, k := range []string{"nginx_vhost", "php_pool", "cron_job", "group_member", "ssh_keys", "ftp_user", "mysql_database", "mysql_user", "home", "linux_user", "linux_group"} {
		if len(kinds[k]) == 0 {
			t.Errorf("thiếu %s trong removed_objects: %v", k, kinds)
		}
	}
	if strings.Join(kinds["mysql_user"], ",") != "anphat_app,anphat" {
		t.Fatal(kinds["mysql_user"])
	}
	// Thứ tự: vhost → pool → cron → SFTP → DB → home → user.
	order := []string{}
	for _, l := range e.fake.Lines() {
		for _, p := range []string{"systemctl reload nginx", "systemctl disable --now itso-php@", "systemctl disable --now itso-cron-", "gpasswd -d anphat itso-sftp", "gpasswd -d anphat itso-ssh", "mariadb", "userdel anphat", "groupdel anphat"} {
			if strings.HasPrefix(l, p) && (len(order) == 0 || order[len(order)-1] != p) {
				order = append(order, p)
			}
		}
	}
	want := "systemctl reload nginx|systemctl disable --now itso-php@|systemctl disable --now itso-cron-|gpasswd -d anphat itso-ssh|mariadb|userdel anphat|groupdel anphat"
	if strings.Join(order, "|") != want && strings.Join(order, "|") != strings.Replace(want, "itso-ssh", "itso-sftp", 1) {
		t.Fatalf("thứ tự xóa sai:\n%s", strings.Join(order, "\n"))
	}
	if e.exists("/home/anphat") || e.exists("/etc/itso/php/8.3/anphat") || e.exists("/etc/nginx/sites-enabled/itso-"+wsShop+".conf") ||
		e.exists("/etc/systemd/system/itso-cron-"+cronID+".timer") || e.exists("/etc/itso-cron/anphat") || e.exists("/etc/ssh/itso_authorized_keys/anphat") {
		t.Fatal("còn sót đối tượng của account")
	}
	if strings.Contains(e.file("/etc/passwd"), "anphat:") || strings.Contains(e.file("/etc/group"), "anphat") {
		t.Fatal("user/group Linux phải bị xóa", e.file("/etc/group"))
	}
	// Account khác không bị đụng.
	if b, err := os.ReadFile(lehoaFile); err != nil || string(b) != "lehoa" {
		t.Fatal("symlink không được theo: dữ liệu lehoa phải còn", err)
	}
	if !e.exists("/etc/nginx/sites-enabled/itso-"+wsOther+".conf") || !e.exists("/etc/itso/php/8.3/lehoa") || !strings.Contains(e.file("/etc/passwd"), "lehoa:") {
		t.Fatal("đối tượng của lehoa phải còn")
	}
	ins := e.h.OK("db.mysql.inspect", map[string]any{"account": ct.Acct("lehoa", 20002)})
	if dbs := ins["databases"].([]any); len(dbs) != 1 {
		t.Fatal("DB của lehoa phải còn", ins)
	}
	// Chạy lại: không còn gì để xóa.
	if d := e.h.OK(contracts.OpAccountRemove, removeParams("anphat", 20001, "anphat")); len(d["removed_objects"].([]any)) != 0 {
		t.Fatal("chạy lại phải idempotent", d)
	}
}

// ---------- migrate.* với restic thật trên 2 gốc sandbox ----------

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	_ = os.RemoveAll(to)
	err := filepath.Walk(from, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, p)
		dst := filepath.Join(to, rel)
		if fi.IsDir() {
			return os.MkdirAll(dst, fi.Mode().Perm()|0o700)
		}
		b, err := os.ReadFile(p) //nolint:gosec // cây tạm của test
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, fi.Mode().Perm())
	})
	if err != nil {
		t.Fatal(err)
	}
}

func migRepo() map[string]any { return bkRepoParams(localDest(), bkAcct, bkPass) }

func restoreSite(sid string, items ...map[string]any) map[string]any {
	p := restoreParams(migRepo(), sid, "overwrite", items...)
	p["pre_restore_tags"] = []any{}
	return p
}

// migEnv: nguồn có account + site + DB, đích chỉ có PHP; repo local của nguồn chép sang đích (mô phỏng đích backup
// dùng chung như SFTP/S3).
func migEnv(t *testing.T) (src, dst *env) {
	t.Helper()
	needRestic(t)
	src = dataEnv(t)
	dst = newEnv(t)
	for _, e := range []*env{src, dst} {
		e.d.Sandbox = true
		e.d.Now = func() time.Time { return bkNow }
	}
	dst.h.OK(contracts.OpPHPVersionInstall, map[string]any{"version": "8.3", "extensions": []any{}})
	home := filepath.Join(src.fs.Root, "home/anphat")
	write(t, home, "sites/anphat.vn/public/index.php", "<?php echo 'v1';")
	write(t, home, "sites/anphat.vn/public/css/app.css", "body{}")
	write(t, home, "dump.sql", "CREATE TABLE `orders` (id int);\nCREATE TABLE `items` (id int);\nINSERT INTO `orders` VALUES (1);\n")
	src.h.OK("db.mysql.owner_ensure", map[string]any{"account": acct()})
	src.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf8mb4"})
	src.h.OK("db.mysql.import", map[string]any{"account": acct(), "name": "anphat_shop", "source": "dump.sql"})
	src.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": migRepo()})
	return src, dst
}

// sync: backup files + DB ở nguồn → chép repo → (đích) account.ensure + layout + restore → trả snapshot files.
func migSync(t *testing.T, src, dst *env) string {
	t.Helper()
	sid := src.h.OK(contracts.OpBackupRun, bkRun(migRepo(), "files", acct(), nil))["snapshot_id"].(string)
	dbSid := src.h.OK(contracts.OpBackupRun, bkRun(migRepo(), "db", acct(), map[string]any{
		"databases": []any{map[string]any{"engine": "mysql", "name": "anphat_shop"}}}))["snapshot_id"].(string)
	copyTree(t, filepath.Join(src.fs.Root, "var/backups/itso"), filepath.Join(dst.fs.Root, "var/backups/itso"))
	dst.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("anphat", 20001))
	dst.h.OK(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": acct(), "site_dir": "anphat.vn"})
	dst.h.OK("db.mysql.owner_ensure", map[string]any{"account": acct()})
	dst.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf8mb4"})
	dst.h.OK(contracts.OpBackupRestore, restoreSite(sid, map[string]any{"kind": "website", "site_dir": "anphat.vn"}))
	dst.h.OK(contracts.OpBackupRestore, restoreSite(dbSid, map[string]any{"kind": "database",
		"db": map[string]any{"engine": "mysql", "name": "anphat_shop"}, "target_name": "anphat_shop"}))
	return sid
}

func verifyParams(sid string) map[string]any {
	return map[string]any{"account": acct(), "migration_uuid": migUUID, "repo": migRepo(), "snapshot_id": sid,
		"databases": []any{map[string]any{"engine": "mysql", "name": "anphat_shop"}}, "sites": []any{"anphat.vn"}}
}

func checksOf(d map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, c := range d["checks"].([]any) {
		m := c.(map[string]any)
		key, _ := m["key"].(string)
		if key == "" {
			key = m["kind"].(string) + ":" + m["name"].(string)
		}
		out[key] = m
	}
	return out
}

func TestMigratePreflight(t *testing.T) {
	src, dst := migEnv(t)
	copyTree(t, filepath.Join(src.fs.Root, "var/backups/itso"), filepath.Join(dst.fs.Root, "var/backups/itso"))
	p := map[string]any{"account": acct(), "migration_uuid": migUUID, "repo": migRepo(), "need_bytes": 1 << 20,
		"php_versions": []any{"8.3"}, "databases": []any{map[string]any{"engine": "mysql", "name": "anphat_shop"}}, "sites": []any{"anphat.vn"}}
	d := dst.h.OK(contracts.OpMigratePreflight, p)
	c := checksOf(d)
	if d["ok"] != true || c["username"]["level"] != "ok" || c["disk"]["level"] != "ok" || c["php"]["level"] != "ok" || c["repo"]["level"] != "ok" || c["domain"]["level"] != "ok" {
		t.Fatal(d)
	}
	// Chặn: thiếu PHP, đĩa không đủ, uid đã dùng, domain của account khác, mật khẩu repo sai.
	dst.site("lehoa", 20001, "lehoa.vn")
	dst.h.OK(contracts.OpPHPPoolApply, poolParams("lehoa", 20001, wsOther, "lehoa.vn"))
	dst.h.OK(contracts.OpNginxVhostApply, vhostParams("lehoa", 20001, wsOther, "lehoa.vn", "php", "anphat.vn"))
	p["php_versions"] = []any{"8.2"}
	p["need_bytes"] = int64(1) << 60
	repo := migRepo()
	repo["password"] = "Wrong-pass-0000-xxxx-yyyy"
	p["repo"] = repo
	d = dst.h.OK(contracts.OpMigratePreflight, p)
	c = checksOf(d)
	if d["ok"] != false {
		t.Fatal(d)
	}
	for _, k := range []string{"username", "disk", "php", "domain", "repo"} {
		if c[k]["level"] != "block" {
			t.Errorf("%s phải block: %v", k, c[k])
		}
	}
}

func TestMigrateSyncVerifyCutoverRollback(t *testing.T) {
	src, dst := migEnv(t)
	// Nguồn đang chạy: pool + vhost + cron + SFTP.
	src.h.OK(contracts.OpPHPPoolApply, poolParams("anphat", 20001, wsShop, "anphat.vn"))
	src.h.OK(contracts.OpNginxVhostApply, vhostParams("anphat", 20001, wsShop, "anphat.vn", "php", "anphat.vn"))
	src.h.OK(contracts.OpCronApply, map[string]any{"account": acct(), "entries": []any{cronEntry(cronID, "*/5 * * * *", "true", true)}})
	src.h.OK(contracts.OpSFTPUserEnsure, map[string]any{"account": acct(), "ssh_access": false, "password": pw})

	sid := migSync(t, src, dst)
	dst.h.OK(contracts.OpPHPPoolApply, poolParams("anphat", 20001, wsShop, "anphat.vn"))
	dst.h.OK(contracts.OpNginxVhostApply, vhostParams("anphat", 20001, wsShop, "anphat.vn", "php", "anphat.vn"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer srv.Close()
	dst.d.HTTPAddrs = map[string]string{"http": srv.Listener.Addr().String()}

	d := dst.h.OK(contracts.OpMigrateVerify, verifyParams(sid))
	c := checksOf(d)
	if d["ok"] != true || c["files:manifest"]["ok"] != true || c["database:anphat_shop"]["ok"] != true || c["http:anphat.vn"]["ok"] != true {
		t.Fatal(d)
	}
	if !strings.Contains(c["database:anphat_shop"]["detail"].(string), "2/2 bảng") {
		t.Fatal(c["database:anphat_shop"])
	}
	got, err := os.ReadFile(filepath.Join(dst.fs.Root, "home/anphat/sites/anphat.vn/public/index.php"))
	if err != nil || string(got) != "<?php echo 'v1';" {
		t.Fatal("đích phải có dữ liệu của nguồn", string(got), err)
	}

	// Sửa file ở nguồn sau lượt đầu → lượt cuối mang theo; trước đó verify phát hiện lệch.
	write(t, filepath.Join(src.fs.Root, "home/anphat"), "sites/anphat.vn/public/index.php", "<?php echo 'v2';")
	sid2 := src.h.OK(contracts.OpBackupRun, bkRun(migRepo(), "files", acct(), nil))["snapshot_id"].(string)
	copyTree(t, filepath.Join(src.fs.Root, "var/backups/itso"), filepath.Join(dst.fs.Root, "var/backups/itso"))
	if d := dst.h.OK(contracts.OpMigrateVerify, verifyParams(sid2)); d["ok"] != false {
		t.Fatal("chưa restore lượt cuối: verify phải báo lệch", d)
	}

	// Cutover nguồn: bảo trì + dừng pool/cron + gỡ SFTP.
	src.fake.Reset()
	cut := src.h.OK(contracts.OpMigrateCutover, map[string]any{"account": acct(), "migration_uuid": migUUID, "role": "source"})
	if cut["done"] != true || cut["at"] != bkNow.UTC().Format(time.RFC3339) {
		t.Fatal(cut)
	}
	lines := strings.Join(src.fake.Lines(), "\n")
	for _, want := range []string{"systemctl stop itso-php@8.3-anphat.service", "systemctl stop itso-cron-" + cronID + ".timer", "gpasswd -d anphat itso-sftp", "systemctl reload nginx.service"} {
		if !strings.Contains(lines, want) {
			t.Errorf("cutover nguồn thiếu %q:\n%s", want, lines)
		}
	}
	if !strings.Contains(src.file("/etc/itso/waf/"+wsShop+".nginx-migrating"), "return 503") {
		t.Fatal("phải bật trang bảo trì")
	}
	// Chạy lại cutover: không làm lại, cùng thời điểm.
	src.fake.Reset()
	if again := src.h.OK(contracts.OpMigrateCutover, map[string]any{"account": acct(), "migration_uuid": migUUID, "role": "source"}); again["at"] != cut["at"] {
		t.Fatal(again)
	}
	for _, l := range src.fake.Lines() {
		if strings.HasPrefix(l, "systemctl stop") || strings.HasPrefix(l, "gpasswd") {
			t.Fatal("cutover lần 2 không được lặp thao tác", l)
		}
	}

	dst.d.Now = func() time.Time { return bkNow.Add(time.Hour) } // tên thư mục tạm theo thời điểm
	dst.h.OK(contracts.OpBackupRestore, restoreSite(sid2, map[string]any{"kind": "website", "site_dir": "anphat.vn"}))
	if d := dst.h.OK(contracts.OpMigrateVerify, verifyParams(sid2)); d["ok"] != true {
		t.Fatal("sau lượt cuối verify phải khớp", d)
	}
	dst.fake.Reset()
	dst.h.OK(contracts.OpMigrateCutover, map[string]any{"account": acct(), "migration_uuid": migUUID, "role": "target"})
	if l := strings.Join(dst.fake.Lines(), "\n"); !strings.Contains(l, "systemctl enable --now itso-php@8.3-anphat.service") {
		t.Fatal("cutover đích phải bật pool", l)
	}

	// Rollback: đích khóa, nguồn mở lại đúng những gì đã dừng.
	dst.h.OK(contracts.OpMigrateRollback, map[string]any{"account": acct(), "migration_uuid": migUUID, "role": "target"})
	if !dst.exists("/etc/itso/waf/" + wsShop + ".nginx-migrating") {
		t.Fatal("rollback đích phải bật bảo trì ở đích")
	}
	src.fake.Reset()
	rb := src.h.OK(contracts.OpMigrateRollback, map[string]any{"account": acct(), "migration_uuid": migUUID, "role": "source"})
	if rb["rolled_back"] != true {
		t.Fatal(rb)
	}
	lines = strings.Join(src.fake.Lines(), "\n")
	for _, want := range []string{"gpasswd -a anphat itso-sftp", "systemctl start itso-php@8.3-anphat.service", "systemctl start itso-cron-" + cronID + ".timer"} {
		if !strings.Contains(lines, want) {
			t.Errorf("rollback nguồn thiếu %q:\n%s", want, lines)
		}
	}
	if src.exists("/etc/itso/waf/" + wsShop + ".nginx-migrating") {
		t.Fatal("rollback nguồn phải gỡ bảo trì")
	}
	if rb := src.h.OK(contracts.OpMigrateRollback, map[string]any{"account": acct(), "migration_uuid": migUUID, "role": "source"}); rb["rolled_back"] != false {
		t.Fatal("rollback lần 2: không còn gì để mở", rb)
	}
}

// Khôi phục sang server khác (ADR 0038 §3): đích đọc repo của server nguồn, ra bản mới.
func TestBackupRestoreCrossServer(t *testing.T) {
	src, dst := migEnv(t)
	sid := src.h.OK(contracts.OpBackupRun, bkRun(migRepo(), "files", acct(), nil))["snapshot_id"].(string)
	copyTree(t, filepath.Join(src.fs.Root, "var/backups/itso"), filepath.Join(dst.fs.Root, "var/backups/itso"))
	dst.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("anphat", 20001))
	dst.h.OK(contracts.OpFsSiteLayoutEnsure, map[string]any{"account": acct(), "site_dir": "anphat.vn"})
	res := dst.h.OK(contracts.OpBackupRestore, restoreParams(migRepo(), sid, "new", map[string]any{"kind": "website", "site_dir": "anphat.vn"}))
	paths := res["restored_paths"].([]any)
	if len(paths) != 1 {
		t.Fatal(res)
	}
	got, err := os.ReadFile(filepath.Join(dst.fs.Root, "home/anphat", paths[0].(string), "public/index.php"))
	if err != nil || string(got) != "<?php echo 'v1';" {
		t.Fatal("bản mới ở server đích phải có nội dung của nguồn", paths, err)
	}
}
