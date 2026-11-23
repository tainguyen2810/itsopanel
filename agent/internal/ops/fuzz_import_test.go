package ops

import (
	"strings"
	"testing"
)

// FuzzNginxImportParser: parser vhost của panel nguồn không panic, không treo, và chỉ trả docroot/PHP dạng hợp lệ
// với mọi đầu vào ≤ 256 KB (D-108, ADR 0053 §2).
func FuzzNginxImportParser(f *testing.F) {
	for _, s := range []string{
		"server { listen 80; server_name a.vn www.a.vn; root /www/wwwroot/a.vn; include enable-php-74.conf; }",
		"http { server { listen 443 ssl; server_name \"b.vn\"; root '/home/b/web/b.vn/public_html'; ssl_certificate /etc/ssl/b.pem; location ~ \\.php$ { fastcgi_pass unix:/run/php/php8.2-fpm.sock; } } }",
		"server { location / { proxy_pass http://127.0.0.1:3000; } }",
		"server { server_name x; root /a\\;b; } # comment {",
		"server {{{{",
		"}}}",
		"\"unterminated",
		strings.Repeat("server { ", 40),
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		servers, err := nginxServers(b)
		if err != nil {
			return
		}
		for _, s := range servers {
			if s.phpVer != "" && (len(s.phpVer) != 3 || s.phpVer[1] != '.') {
				t.Fatalf("php %q", s.phpVer)
			}
			if s.root != "" && CheckImportSrc(s.root) == nil && (strings.Contains(s.root+"/", "/../") || strings.Contains(s.root+"/", "/./")) {
				t.Fatalf("root traversal lọt: %q", s.root)
			}
		}
	})
}

// FuzzImportPaths: kiểm đường dẫn nguồn/vhost không bao giờ nhận `..`, `//`, ký tự điều khiển hoặc vhost ITSO.
func FuzzImportPaths(f *testing.F) {
	for _, s := range []string{"/www/wwwroot/a.vn", "/home/hr/web/hr.vn/public_html", "/etc/nginx/sites-enabled/wiki",
		"/etc/nginx/conf.d/domains/a.conf", "/www/wwwroot/../etc", "/etc/nginx/sites-enabled/..", "/etc/nginx/sites-enabled/itso-a.conf"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, p string) {
		bad := func() bool {
			for _, seg := range strings.Split(p, "/")[1:] {
				if seg == "" || seg == "." || seg == ".." {
					return true
				}
			}
			return strings.ContainsAny(p, "\x00\n\r\t") || !strings.HasPrefix(p, "/")
		}()
		if CheckImportSrc(p) == nil && bad {
			t.Fatalf("src nhận %q", p)
		}
		if CheckImportVhost(p) == nil && (bad || strings.HasPrefix(p[strings.LastIndexByte(p, '/')+1:], "itso-")) {
			t.Fatalf("vhost nhận %q", p)
		}
	})
}
