package ops_test

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

type scanRes struct {
	SourceVersion *string `json:"source_version"`
	Truncated     bool    `json:"truncated"`
	Sites         []struct {
		Domain     string   `json:"domain"`
		Aliases    []string `json:"aliases"`
		Docroot    string   `json:"docroot"`
		VhostPath  string   `json:"vhost_path"`
		PHPVersion *string  `json:"php_version"`
		SSL        struct {
			CertPath *string `json:"cert_path"`
			NotAfter *string `json:"not_after"`
		} `json:"ssl"`
		SizeBytes  int64 `json:"size_bytes"`
		Files      int64 `json:"files"`
		Databases  []struct{ Name string }
		Crons      []struct{ Schedule, Command string }
		SystemUser string `json:"system_user"`
		Warnings   []struct{ Code, Message string }
	} `json:"sites"`
}

func asScan(t *testing.T, d map[string]any) scanRes {
	t.Helper()
	b, _ := json.Marshal(d)
	var r scanRes
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func warnCodes(ws []struct{ Code, Message string }) []string {
	var out []string
	for _, w := range ws {
		out = append(out, w.Code)
	}
	return out
}

func TestImportScanAaPanel(t *testing.T) {
	e := newEnv(t)
	ops.SeedAaPanel(e.fs, ct.Now)
	e.fake.Reset()
	r := asScan(t, e.h.OK(contracts.OpImportScan, map[string]any{"source": "aapanel", "max_sites": 500}))
	if w := e.writes(); len(w) != 0 {
		t.Fatalf("scan chỉ đọc, đã chạy: %v", w)
	}
	if r.SourceVersion == nil || *r.SourceVersion != "7.0.9" || len(r.Sites) != 3 || r.Truncated {
		t.Fatalf("%+v", r)
	}
	by := map[string]int{}
	for i, s := range r.Sites {
		by[s.Domain] = i
	}
	shop := r.Sites[by["shop.anphatgroup.vn"]]
	if shop.Docroot != "/www/wwwroot/shop.anphatgroup.vn" || shop.VhostPath != ops.AaVhostDir+"/shop.anphatgroup.vn.conf" ||
		shop.PHPVersion == nil || *shop.PHPVersion != "7.4" || shop.SystemUser != "www" ||
		!slices.Equal(shop.Aliases, []string{"www.shop.anphatgroup.vn"}) || shop.SSL.NotAfter == nil || shop.Files != 4 {
		t.Fatalf("shop: %+v", shop)
	}
	for _, c := range []string{"php_missing", "ssl_expired", "symlink_outside"} {
		if !slices.Contains(warnCodes(shop.Warnings), c) {
			t.Fatalf("shop thiếu cảnh báo %s: %+v", c, shop.Warnings)
		}
	}
	// symlink nội bộ (wp-content/latest → uploads/2026) không bị cảnh báo: đúng 1 symlink ra ngoài.
	if !slices.ContainsFunc(shop.Warnings, func(w struct{ Code, Message string }) bool {
		return w.Code == "symlink_outside" && strings.HasPrefix(w.Message, "1 ")
	}) {
		t.Fatalf("%+v", shop.Warnings)
	}
	blog := r.Sites[by["blog.anphatgroup.vn"]]
	if *blog.PHPVersion != "8.2" || len(blog.Warnings) != 0 || blog.SSL.CertPath != nil {
		t.Fatalf("blog: %+v", blog)
	}
	if api := r.Sites[by["api.anphatgroup.vn"]]; !slices.Contains(warnCodes(api.Warnings), "unsupported") {
		t.Fatalf("api: %+v", api)
	}
	// max_sites cắt bớt.
	if r := asScan(t, e.h.OK(contracts.OpImportScan, map[string]any{"source": "aapanel", "max_sites": 2})); len(r.Sites) != 2 || !r.Truncated {
		t.Fatalf("%+v", r)
	}
	// Không có cài đặt nguồn → not_found.
	e.h.Fail(contracts.OpImportScan, map[string]any{"source": "hestia", "max_sites": 10}, "not_found")
}

func TestImportScanHestiaAndNginx(t *testing.T) {
	e := newEnv(t)
	ops.SeedHestia(e.fs)
	ops.SeedNginx(e.fs)
	write(t, e.fs.Root, ops.VhostDir+"/itso-01938a06-0002-7000-8000-000006000002.conf", "server { server_name shop.anphat.vn; root /home/anphat/sites/x/public; }\n")
	r := asScan(t, e.h.OK(contracts.OpImportScan, map[string]any{"source": "hestia", "max_sites": 50}))
	if r.SourceVersion == nil || *r.SourceVersion != "1.8.12" || len(r.Sites) != 1 {
		t.Fatalf("%+v", r)
	}
	hr := r.Sites[0]
	if hr.Domain != "hr.itso.vn" || hr.SystemUser != "hr" || hr.VhostPath != ops.HestiaVhostDir+"/hr.itso.vn.conf" ||
		*hr.PHPVersion != "8.2" || len(hr.Databases) != 1 || hr.Databases[0].Name != "hr_wp" || len(hr.Crons) != 1 ||
		hr.Crons[0].Schedule != "*/5 * * * *" || hr.SSL.NotAfter == nil || len(hr.Warnings) != 0 {
		t.Fatalf("hr: %+v", hr)
	}
	n := asScan(t, e.h.OK(contracts.OpImportScan, map[string]any{"source": "nginx", "max_sites": 50}))
	var doms []string
	for _, s := range n.Sites {
		doms = append(doms, s.Domain+"|"+s.VhostPath+"|"+s.Docroot)
	}
	// vhost ITSO (itso-*.conf) bị bỏ; vhost Hestia trong conf.d/domains không thuộc nguồn nginx.
	want := []string{"wiki.itso.vn|/etc/nginx/sites-enabled/wiki|/var/www/wiki", "static.itso.vn|/etc/nginx/conf.d/static.conf|/srv/static"}
	if !slices.Equal(doms, want) || *n.Sites[0].PHPVersion != "8.1" || n.Sites[0].SystemUser != "www-data" {
		t.Fatalf("%v", doms)
	}
}

func TestImportScanRejectsUnsafeVhosts(t *testing.T) {
	e := newEnv(t)
	ops.SeedNginx(e.fs)
	// symlink trỏ ra ngoài sites-available, file quá lớn, vhost có docroot trong home account ITSO hoặc /etc.
	rp, _ := e.fs.Path(ops.VhostDir + "/evil")
	_ = os.Symlink("/etc/shadow", rp)
	write(t, e.fs.Root, ops.VhostDir+"/big", "server { server_name big.itso.vn; root /var/www/big; }\n"+strings.Repeat("#", 300<<10))
	write(t, e.fs.Root, ops.VhostDir+"/etc", "server { server_name etc.itso.vn; root /etc; }\n")
	write(t, e.fs.Root, ops.VhostDir+"/itsoacct", "server { server_name acct.itso.vn; root /home/anphat/sites/a; }\n")
	write(t, e.fs.Root, "/home/anphat/.itso/.keep", "")
	write(t, e.fs.Root, ops.VhostDir+"/broken", "server { server_name broken.itso.vn; root /var/www/b;\n")
	n := asScan(t, e.h.OK(contracts.OpImportScan, map[string]any{"source": "nginx", "max_sites": 50}))
	for _, s := range n.Sites {
		if s.Domain != "wiki.itso.vn" && s.Domain != "static.itso.vn" {
			t.Fatalf("không được nhận %s (%s)", s.Domain, s.Docroot)
		}
	}
}

func TestImportCopyUnderAccountUID(t *testing.T) {
	e := newEnv(t)
	ops.SeedAaPanel(e.fs, ct.Now)
	e.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("anphat", 20001))
	// hardlink trong docroot: bỏ (có thể trỏ tới file ngoài).
	src, _ := e.fs.Path("/www/wwwroot/shop.anphatgroup.vn/index.php")
	dst, _ := e.fs.Path("/www/wwwroot/shop.anphatgroup.vn/hard.php")
	if err := os.Link(src, dst); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"source": "aapanel", "src": "/www/wwwroot/shop.anphatgroup.vn", "account": ct.Acct("anphat", 20001),
		"dst": "sites/shop.anphatgroup.vn/public", "max_bytes": 1 << 30}
	d := e.h.OK(contracts.OpImportCopy, params)
	if d["files"].(float64) != 3 || d["skipped"].(float64) != 4 {
		t.Fatalf("%+v", d)
	}
	rs := strings.Join(toStrings(d["skipped_reasons"]), ",")
	if rs != "hardlink: 2,symlink: 2" {
		t.Fatalf("lý do: %s", rs)
	}
	home := "/home/anphat/sites/shop.anphatgroup.vn/public"
	if e.file(home+"/wp-config.php") != "<?php define('DB_NAME', 'demo');\n" || e.fs.Exists(home+"/etc-link") || e.fs.Exists(home+"/hard.php") {
		t.Fatal("nội dung chép sai")
	}
	// Chạy lại → đích đã có, không ghi đè.
	e.h.Fail(contracts.OpImportCopy, params, "already_exists")
	// max_bytes nhỏ → quota_exceeded, không để lại thư mục đích.
	params["dst"], params["max_bytes"] = "sites/small/public", 10
	e.h.Fail(contracts.OpImportCopy, params, "quota_exceeded")
	if e.fs.Exists("/home/anphat/sites/small/public") {
		t.Fatal("không được để lại đích dở")
	}
	// Đường dẫn nguồn có symlink → từ chối.
	rp, _ := e.fs.Path("/www/wwwroot/link")
	_ = os.Symlink("/etc", rp)
	params["src"], params["dst"], params["max_bytes"] = "/www/wwwroot/link", "sites/l/public", 1<<20
	e.h.Fail(contracts.OpImportCopy, params, "precondition_failed")
	// Nguồn là home account ITSO → từ chối.
	params["src"] = "/home/anphat/sites"
	e.h.Fail(contracts.OpImportCopy, params, "invalid_params")
}

func TestImportCutoverRollback(t *testing.T) {
	e := newEnv(t)
	ops.SeedHestia(e.fs)
	ops.SeedNginx(e.fs)
	uuid := "01938a3a-0002-7000-8000-00003a000002"
	hv := ops.HestiaVhostDir + "/hr.itso.vn.conf"
	p := map[string]any{"source": "hestia", "import_uuid": uuid, "vhost_paths": []any{hv}}
	e.fake.Reset()
	d := e.h.OK(contracts.OpImportCutover, p)
	if got := toStrings(d["disabled"]); !slices.Equal(got, []string{hv, ops.HestiaVhostDir + "/hr.itso.vn.ssl.conf"}) {
		t.Fatalf("%v", got)
	}
	if e.fs.Exists(hv) || !e.fs.Exists(hv+ops.ImportDisabledSufx) || !e.fs.Exists(ops.HestiaVhostDir+"/hr.itso.vn.ssl.conf"+ops.ImportDisabledSufx) {
		t.Fatal("chưa đổi tên vhost")
	}
	if l := strings.Join(e.fake.Lines(), "\n"); !strings.Contains(l, "nginx -t -q") || !strings.Contains(l, "systemctl reload nginx.service") {
		t.Fatal(l)
	}
	// Idempotent: lần 2 không chạy lệnh nào.
	e.fake.Reset()
	e.h.OK(contracts.OpImportCutover, p)
	if len(e.fake.Lines()) != 0 {
		t.Fatal(e.fake.Lines())
	}
	e.h.OK(contracts.OpImportRollback, p)
	if !e.fs.Exists(hv) || e.fs.Exists(hv+ops.ImportDisabledSufx) {
		t.Fatal("rollback chưa khôi phục")
	}
	// nginx sites-enabled: symlink chuyển sang /etc/nginx/itso-disabled/<import>/, giữ nguyên symlink.
	np := map[string]any{"source": "nginx", "import_uuid": uuid, "vhost_paths": []any{ops.VhostDir + "/wiki"}}
	e.h.OK(contracts.OpImportCutover, np)
	moved := ops.NginxDisabledDir + "/" + uuid + "/wiki"
	if t2, err := e.fs.Readlink(moved); err != nil || t2 != "../sites-available/wiki" || e.fs.Exists(ops.VhostDir+"/wiki") {
		t.Fatalf("%q %v", t2, err)
	}
	e.h.OK(contracts.OpImportRollback, np)
	if _, err := e.fs.Readlink(ops.VhostDir + "/wiki"); err != nil {
		t.Fatal(err)
	}
	// nginx -t lỗi → hoàn tác.
	e.fail["nginx -t"] = platform.Result{ExitCode: 1, Stderr: []byte("nginx: [emerg] test failed")}
	e.h.Fail(contracts.OpImportCutover, p, "config_test_failed")
	if !e.fs.Exists(hv) || e.fs.Exists(hv+ops.ImportDisabledSufx) {
		t.Fatal("nginx -t lỗi phải hoàn tác")
	}
	delete(e.fail, "nginx -t")
	// Từ chối: vhost ITSO, vhost không thuộc nguồn, file không có.
	e.h.Fail(contracts.OpImportCutover, map[string]any{"source": "nginx", "import_uuid": uuid, "vhost_paths": []any{ops.VhostDir + "/itso-x.conf"}}, "invalid_params")
	e.h.Fail(contracts.OpImportCutover, map[string]any{"source": "aapanel", "import_uuid": uuid, "vhost_paths": []any{hv}}, "invalid_params")
	e.h.Fail(contracts.OpImportCutover, map[string]any{"source": "nginx", "import_uuid": uuid, "vhost_paths": []any{ops.VhostDir + "/none"}}, "not_found")
}

func TestCisAudit(t *testing.T) {
	e := newEnv(t)
	host := e.host
	for p, v := range map[string]string{
		"/proc/mounts":                                 "/dev/sda1 / ext4 rw 0 0\ntmpfs /tmp tmpfs rw,nosuid,nodev,noexec 0 0\n",
		"/proc/sys/kernel/randomize_va_space":          "2\n",
		"/proc/sys/fs/suid_dumpable":                   "2\n",
		"/proc/sys/net/ipv4/ip_forward":                "0\n",
		"/proc/sys/net/ipv4/conf/all/send_redirects":   "0\n",
		"/proc/sys/net/ipv4/conf/all/accept_redirects": "0\n",
		"/proc/sys/net/ipv4/tcp_syncookies":            "1\n",
		"/proc/sys/net/ipv6/conf/all/accept_ra":        "1\n",
		"/sys/module/apparmor/parameters/enabled":      "Y\n",
		"/sys/kernel/security/apparmor/profiles":       "/usr/sbin/nginx (enforce)\nlsb_release (complain)\n",
	} {
		write(t, host, p, v)
	}
	write(t, e.fs.Root, "/etc/ssh/sshd_config.d/10-itso-hardening.conf", "PermitRootLogin no\nPasswordAuthentication no\nMaxAuthTries 3\nClientAliveInterval 300\nAllowGroups itso-ssh sudo\n")
	write(t, e.fs.Root, "/etc/ssh/sshd_config", "PermitRootLogin yes\nInclude /etc/ssh/sshd_config.d/*.conf\n")
	write(t, e.fs.Root, "/etc/crontab", "# cron\n")
	write(t, e.fs.Root, "/etc/apt/apt.conf.d/20auto-upgrades", "APT::Periodic::Unattended-Upgrade \"1\";\n")
	write(t, e.fs.Root, "/etc/systemd/journald.conf", "[Journal]\nStorage=persistent\n")
	e.fake.Reset()
	d := e.h.OK(contracts.OpCisAudit, map[string]any{"profile": ops.CisProfile})
	for _, l := range e.fake.Lines() {
		if !strings.HasPrefix(l, "dpkg-query ") && !strings.HasPrefix(l, "apt-get -s ") {
			t.Fatalf("cis.audit chỉ được chạy lệnh đọc, đã chạy: %s", l)
		}
	}
	items := d["items"].([]any)
	st := map[string]string{}
	for _, x := range items {
		m := x.(map[string]any)
		st[m["id"].(string)] = m["status"].(string)
		if len(m["evidence"].(string)) > 500 {
			t.Fatal("bằng chứng quá dài")
		}
	}
	if len(items) < 30 {
		t.Fatalf("chỉ %d mục", len(items))
	}
	want := map[string]string{"1.1.2.1": "pass", "1.1.2.4": "pass", "1.1.3.1": "fail", "1.3.1.3": "pass", "1.5.1": "pass",
		"1.5.3": "fail", "3.3.9": "fail", "5.1.20": "pass", "5.1.21": "pass", "5.1.4": "pass", "5.4.2.1": "pass",
		"2.4.1.2": "fail", "8.1.1": "pass", "6.2.1.1": "pass", "6.1.1": "fail", "5.3.3.2.1": "fail"}
	for id, w := range want {
		if st[id] != w {
			t.Errorf("%s = %s, muốn %s", id, st[id], w)
		}
	}
	e.h.Fail(contracts.OpCisAudit, map[string]any{"profile": "ubuntu22.04"}, "invalid_params")
}
