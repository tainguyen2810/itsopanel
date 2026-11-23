package ops

// Cây file giả của panel nguồn (Phase 12, D-108) cho agent --sandbox và test: aaPanel (/www), HestiaCP
// (/usr/local/hestia + /home/<u>/web), nginx thuần (/etc/nginx/sites-enabled, conf.d). Chỉ tạo khi chưa có.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"itso.local/agent/internal/platform"
)

func seedFile(fs *platform.FS, p, content string) {
	rp, err := fs.Path(p)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(rp), 0o755)
	_ = os.WriteFile(rp, []byte(content), 0o644)
}

func seedSymlink(fs *platform.FS, link, target string) {
	rp, err := fs.Path(link)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(rp), 0o755)
	_ = os.Symlink(target, rp)
}

// seedCert ghi chứng chỉ tự ký (chỉ phần công khai) hết hạn lúc notAfter.
func seedCert(fs *platform.FS, p, cn string, notAfter time.Time) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: cn}, DNSNames: []string{cn},
		NotBefore: notAfter.AddDate(0, -3, 0), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return
	}
	seedFile(fs, p, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})))
}

func seedSite(fs *platform.FS, root string) {
	seedFile(fs, root+"/index.php", "<?php require __DIR__.'/wp-blog-header.php';\n")
	seedFile(fs, root+"/wp-config.php", "<?php define('DB_NAME', 'demo');\n")
	seedFile(fs, root+"/wp-content/uploads/2026/11/logo.png", "PNG-giả")
	seedFile(fs, root+"/.htaccess", "# rewrite\n")
}

// SeedAaPanel tạo aaPanel giả: 3 vhost (PHP 7.4 + SSL hết hạn, PHP 8.2, proxy_pass) + vhost mặc định bị bỏ qua.
func SeedAaPanel(fs *platform.FS, now time.Time) {
	if fs.Exists(AaVhostDir) {
		return
	}
	seedFile(fs, aaVersionFile, "class common:\n    pass\n    g.version = '7.0.9'\n")
	seedFile(fs, AaVhostDir+"/0.default.conf", "server { listen 80 default_server; server_name _; root /www/server/nginx/html; }\n")
	seedFile(fs, AaVhostDir+"/phpfpm_status.conf", "server { listen 80; server_name 127.0.0.1; location /phpfpm_74_status { fastcgi_pass unix:/tmp/php-cgi-74.sock; } }\n")
	seedFile(fs, AaVhostDir+"/shop.anphatgroup.vn.conf", `server
{
    listen 80;
    listen 443 ssl http2;
    server_name shop.anphatgroup.vn www.shop.anphatgroup.vn;
    index index.php index.html;
    root /www/wwwroot/shop.anphatgroup.vn;
    #SSL-START
    ssl_certificate    /www/server/panel/vhost/cert/shop.anphatgroup.vn/fullchain.pem;
    ssl_certificate_key    /www/server/panel/vhost/cert/shop.anphatgroup.vn/privkey.pem;
    #SSL-END
    include enable-php-74.conf;
    include /www/server/panel/vhost/rewrite/shop.anphatgroup.vn.conf;
    location ~ ^/(\.user.ini|\.htaccess|\.git|\.env) { return 404; }
    access_log  /www/wwwlogs/shop.anphatgroup.vn.log;
}
`)
	seedCert(fs, "/www/server/panel/vhost/cert/shop.anphatgroup.vn/fullchain.pem", "shop.anphatgroup.vn", now.AddDate(0, -1, 0))
	seedFile(fs, AaVhostDir+"/blog.anphatgroup.vn.conf", `server {
    listen 80;
    server_name blog.anphatgroup.vn;
    root "/www/wwwroot/blog.anphatgroup.vn";
    include enable-php-82.conf;
}
`)
	seedFile(fs, AaVhostDir+"/api.anphatgroup.vn.conf", `server {
    listen 80;
    server_name api.anphatgroup.vn;
    root /www/wwwroot/api.anphatgroup.vn;
    location / { proxy_pass http://127.0.0.1:3000; }
}
`)
	for _, s := range []string{"shop", "blog", "api"} {
		seedSite(fs, "/www/wwwroot/"+s+".anphatgroup.vn")
	}
	seedSymlink(fs, "/www/wwwroot/shop.anphatgroup.vn/etc-link", "/etc")
	seedSymlink(fs, "/www/wwwroot/shop.anphatgroup.vn/wp-content/latest", "uploads/2026")
}

// SeedHestia tạo HestiaCP giả: user hr có 1 website (PHP 8.2), 1 DB, 1 cron.
func SeedHestia(fs *platform.FS) {
	if fs.Exists(HestiaUsersDir) {
		return
	}
	seedFile(fs, hestiaConf, "VERSION='1.8.12'\nWEB_SYSTEM='nginx'\n")
	seedFile(fs, HestiaUsersDir+"/hr/web.conf",
		"DOMAIN='hr.itso.vn' IP='203.0.113.10' IP6='' CUSTOM_DOCROOT='' ALIAS='www.hr.itso.vn' TPL='default' BACKEND='PHP-8_2' SSL='yes' SUSPENDED='no' TIME='10:00:00' DATE='2025-01-02'\n")
	seedFile(fs, HestiaUsersDir+"/hr/db.conf", "DB='hr_wp' DBUSER='hr_wp' MD5='*' HOST='localhost' TYPE='mysql' CHARSET='utf8mb4' U_DISK='120' SUSPENDED='no'\n")
	seedFile(fs, HestiaUsersDir+"/hr/cron.conf",
		"JOB='1' MIN='*/5' HOUR='*' DAY='*' MONTH='*' WDAY='*' CMD='php /home/hr/web/hr.itso.vn/public_html/cron.php' SUSPENDED='no'\n")
	seedSite(fs, "/home/hr/web/hr.itso.vn/public_html")
	seedCert(fs, "/home/hr/conf/web/hr.itso.vn/ssl/hr.itso.vn.crt", "hr.itso.vn", time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC))
	vh := "server {\n    listen 203.0.113.10:80;\n    server_name hr.itso.vn www.hr.itso.vn;\n    root /home/hr/web/hr.itso.vn/public_html;\n    location ~ \\.php$ { fastcgi_pass unix:/run/php/php8.2-fpm-hr.itso.vn.sock; }\n}\n"
	seedFile(fs, HestiaVhostDir+"/hr.itso.vn.conf", vh)
	seedFile(fs, HestiaVhostDir+"/hr.itso.vn.ssl.conf", vh)
}

// SeedNginx tạo nginx thuần giả: sites-enabled/wiki → sites-available/wiki, conf.d/static.conf, vhost ITSO bị bỏ qua.
func SeedNginx(fs *platform.FS) {
	if fs.Exists("/etc/nginx/sites-available/wiki") {
		return
	}
	if !fs.Exists(nginxConf) {
		seedFile(fs, nginxConf, "user www-data;\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}\n")
	}
	seedFile(fs, "/etc/nginx/sites-available/wiki", "server {\n    listen 80;\n    server_name wiki.itso.vn;\n    root /var/www/wiki;\n    location ~ \\.php$ { fastcgi_pass unix:/run/php/php8.1-fpm.sock; }\n}\n")
	seedSymlink(fs, VhostDir+"/wiki", "../sites-available/wiki")
	seedFile(fs, NginxConfD+"/static.conf", "server { listen 80; server_name static.itso.vn; root /srv/static; }\n")
	seedSite(fs, "/var/www/wiki")
	seedFile(fs, "/srv/static/index.html", "<h1>static</h1>\n")
}
