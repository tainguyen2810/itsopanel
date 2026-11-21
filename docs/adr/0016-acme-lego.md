# ADR 0016: Chứng chỉ ACME bằng lego, gia hạn tự động, chứng chỉ tải lên

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 5)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-69, D-63

## Bối cảnh

Website cần HTTPS hợp lệ và tự gia hạn. Cấp chứng chỉ phải chạy trên máy phục vụ site (HTTP-01). Khóa riêng không được xuất hiện trong job, log hay audit.

## Quyết định

1. Công cụ: binary `lego` (gói `lego` trong kho Ubuntu 24.04, recipe `lego`), agent gọi qua Runner với argv cố định:
   `lego --accept-tos --email=<email> --server=<directory_url> --path=/etc/itso/acme/<dir-key> --http --http.webroot=/var/lib/itso/acme/webroot --domains=<d1> --domains=<d2> run` (hoặc `renew --days 30`).
2. Directory là enum: `letsencrypt`, `letsencrypt-staging`, `pebble`; `pebble` chỉ được khi policy cục bộ bật `acme_pebble: true` (VM/CI).
3. Khóa tài khoản ACME do lego tạo và giữ trên máy (`/etc/itso/acme/`, root 0700). Bảng `acme_accounts` lưu `server_id`, email, directory, `key_location = 'agent'`; cột `key_encrypted` chỉ dùng khi sau này chuyển khóa về DB.
4. Sau khi lego xong, agent copy chứng chỉ vào `/etc/itso/certs/<cert_uuid>/{fullchain.pem,privkey.pem}` (root 0600 cho khóa) và trả `CertInfo` (issuer, not_before, not_after, SAN). Panel sau đó áp lại vhost với `tls`.
5. Gia hạn: lệnh `itso:certs-renew` (scheduler hằng ngày) chọn chứng chỉ ACME còn < 30 ngày, tạo job `certificate.renew`. Thất bại → `last_error`, thông báo in-app và audit; thử lại hôm sau.
6. Chứng chỉ tải lên: panel kiểm PEM, khóa khớp chứng chỉ, SAN phủ domain, còn hạn; khóa riêng lưu mã hóa (`certificates.private_key_encrypted`). Job chỉ mang `{"$secret": "cert_key:<uuid>"}`; `JobRunner` thay bằng giá trị thật ngay trước khi gọi agent, không ghi vào `job_steps`, log hay audit.
7. Xóa: `cert.remove` xóa thư mục chứng chỉ; vhost được áp lại không TLS trước đó.

## Hệ quả

- Không cần ACME client trong Laravel; ACME chạy đúng máy phục vụ HTTP-01.
- Test: runner giả cho argv lego; sandbox sinh chứng chỉ tự ký; Pebble trên VM/CI là bằng chứng cấp thật.
