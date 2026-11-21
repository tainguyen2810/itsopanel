package ops_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

// realCheck chạy nginx -t và php-fpm8.3 -t THẬT trên file golden (đường dẫn hệ thống đổi sang thư mục tạm).
func realCheck(t *testing.T) {
	root := t.TempDir()
	relocate := func(s string) string {
		for _, p := range []string{"/etc/itso/", "/var/log/itso/", "/var/lib/itso/", "/home/", "/run/itso/"} {
			s = strings.ReplaceAll(s, p, root+p)
		}
		return s
	}
	mk := func(p string) {
		if err := os.MkdirAll(filepath.Join(root, p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{"/var/log/itso/sites/lehoa/lehoa.vn", "/var/lib/itso/acme/webroot", "/var/lib/itso/suspended", "/home/lehoa/sites/lehoa.vn/public",
		"/etc/itso/certs/" + certA, "/run/itso/php", "/vhost", "/confd"} {
		mk(p)
	}
	chain, key, err := ops.SelfSigned([]string{"lehoa.vn", "www.lehoa.vn"}, "Test CA", ct0())
	if err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "/etc/itso/certs/"+certA+"/fullchain.pem"), chain, 0o644)
	_ = os.WriteFile(filepath.Join(root, "/etc/itso/certs/"+certA+"/privkey.pem"), key, 0o600)
	mainConf, err := os.ReadFile("testdata/golden/nginx.conf")
	if err != nil {
		t.Fatal(err)
	}
	conf := strings.ReplaceAll(string(mainConf), "include /etc/nginx/sites-enabled/*;", "include "+root+"/vhost/*.conf;")
	conf = strings.ReplaceAll(conf, "include /etc/nginx/conf.d/*.conf;", "include "+root+"/confd/*.conf;")
	conf = strings.ReplaceAll(conf, "pid /run/nginx.pid;", "pid "+root+"/nginx.pid;")
	confPath := filepath.Join(root, "nginx.conf")
	if err := os.WriteFile(confPath, []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	run := platform.ExecRunner{}
	for _, name := range []string{"php", "static", "proxy", "suspended", "tls"} {
		b, err := os.ReadFile("testdata/golden/vhost-" + name + ".conf")
		if err != nil {
			t.Fatal(err)
		}
		vh := relocate(string(b))
		if _, err := os.Stat("/proc/net/if_inet6"); err != nil { // máy test không có IPv6: agent sẽ không sinh listen [::]
			var keep []string
			for _, l := range strings.Split(vh, "\n") {
				if !strings.Contains(l, "listen [::]") {
					keep = append(keep, l)
				}
			}
			vh = strings.Join(keep, "\n")
		}
		_ = os.WriteFile(filepath.Join(root, "vhost", "site.conf"), []byte(vh), 0o644)
		res, err := run.Run(context.Background(), platform.Cmd{Bin: "nginx", Args: []string{"-t", "-q", "-c", confPath}})
		if err != nil || res.ExitCode != 0 {
			t.Errorf("nginx -t vhost-%s: %v %s", name, err, res.Stderr)
		}
	}
	if _, err := os.Stat(platform.Bins["php-fpm8.3"]); err != nil {
		t.Log("không có php-fpm8.3: bỏ kiểm pool")
		return
	}
	mk("/etc/itso/php/8.3/lehoa/pool.d")
	for src, dst := range map[string]string{"php-pool.conf": "/etc/itso/php/8.3/lehoa/pool.d/01938a06.conf", "php-fpm.conf": "/etc/itso/php/8.3/lehoa/php-fpm.conf"} {
		b, err := os.ReadFile("testdata/golden/" + src)
		if err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(root, dst), []byte(relocate(string(b))), 0o644)
	}
	// Chạy dưới root cần -R (agent thật chạy -t dưới uid account, không có -R).
	res, err := run.Run(context.Background(), platform.Cmd{Bin: "php-fpm8.3", Args: []string{"-t", "-R", "--fpm-config", filepath.Join(root, "/etc/itso/php/8.3/lehoa/php-fpm.conf")}})
	if err != nil || res.ExitCode != 0 {
		t.Errorf("php-fpm -t: %v %s", err, res.Stderr)
	}
}

func ct0() time.Time { return time.Now() }
