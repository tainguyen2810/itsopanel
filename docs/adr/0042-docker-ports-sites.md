# ADR 0042: Cấp cổng và website loại Docker

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 10)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-97, D-96, Phase 5 (vhost, ACME)

## Quyết định

1. Dải cổng **20000–29999** mỗi server. Bảng `port_allocations` (server, port, protocol unique), cấp trong transaction khi tạo/sửa project; trả lại khi xóa project.
2. Agent kiểm cổng trống (`/proc/net/tcp*`, `udp*`) trước khi apply; bận → lỗi `port_unavailable`.
3. Cổng 22, 80, 443, cổng panel không bao giờ được publish (validator chặn).
4. **Website loại `docker`** (chỉ Admin, `docker_target` = project + service): vhost Nginx `proxy_pass http://127.0.0.1:<port>` có websocket upgrade, ACME như site thường; project phải cùng server với account.
5. Mở cổng ra ngoài trực tiếp (không qua Nginx) chỉ qua firewall Docker (ADR 0040), SA chọn CIDR nguồn.

## Hệ quả

Ra ngoài mặc định chỉ qua Nginx + SSL; không trùng cổng với Nginx/PHP-FPM.
