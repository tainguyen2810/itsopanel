# Runbook Phase 11: Monitoring, Alerts, Notifications

Vận hành số liệu, cảnh báo, uptime và kênh thông báo (Phase 11, D-101 → D-107). Quyết định thiết kế ở ADR 0046–0052,
review bảo mật ở `docs/security/monitoring-notifications-review.md`.

## 1. Lịch chạy

Scheduler của Laravel (`itso-scheduler`) chạy các lệnh sau; worker phải nghe cả queue `notifications`
(`queue:work --queue=default,notifications`, đã có trong unit `itso-worker@` và `scripts/dev.sh`).

| Lệnh | Lịch | Việc |
|---|---|---|
| `itso:metrics-collect` | mỗi phút | `metrics.snapshot` mọi server → `metric_samples`, dịch vụ, `last_seen_at` của agent |
| `itso:usage-refresh` | 5 phút | `metrics.cgroup` (một lần/server cho mọi slice `itso-acct-*`) + quota → usage account |
| `itso:alerts-evaluate` | mỗi phút | đánh giá rule → `pending/firing/resolved`, gửi thông báo |
| `itso:uptime-probe` | mỗi phút | `uptime.probe` các check đến hạn, gom theo server. `--all`: kiểm ngay mọi check đang bật |
| `itso:notifications-tick` | mỗi phút | gửi lại delivery `retrying` đến hạn, gộp tin vượt giới hạn |
| `itso:metrics-rollup` · `itso:metrics-prune` | mỗi giờ · 00:13 | rollup 1 giờ (90 ngày) · drop partition samples quá 7 ngày |
| `itso:certificates-expiry` | 08:17 | thông báo chứng chỉ còn 14/7/1 ngày |

Không có scheduler (dev, `make dev`): gọi tay các lệnh trên. Lệnh cần socket agent:
`ITSO_AGENT_SOCKET=.dev/agent-sandbox/agent.sock ITSO_AGENT_KEY_FILE=.dev/agent-sandbox/agent.key php artisan …`.

## 2. Cấu hình SMTP (email)

1. Admin → Cài đặt → SMTP (SUPER_ADMIN + step-up): host, cổng, mã hóa (`starttls` mặc định, `tls` cho 465, `none`
   chỉ cho relay nội bộ), tài khoản (để trống nếu relay không cần AUTH), mật khẩu (chỉ ghi), địa chỉ gửi.
2. Monitoring → Kênh thông báo → "Thêm kênh" → Email, danh sách người nhận (email nhóm trực ca) → "Gửi thử".
3. Email cá nhân của từng người: Thông báo → Tùy chọn (Admin: ma trận sự kiện × kênh; Portal: in-app + email).

Lỗi thường gặp trong nhật ký gửi: `SMTP chưa được cấu hình` (chưa có host), `SMTP: Connection refused`, `535`
(sai tài khoản). Mật khẩu không bao giờ xuất hiện trong lỗi.

## 3. Telegram

1. Tạo bot với BotFather, lấy token; thêm bot vào nhóm, lấy `chat_id` (vd. gọi `getUpdates` từ máy quản trị).
2. Kênh thông báo → Telegram: `chat_id` + token (chỉ ghi) → "Gửi thử". Token bị xóa khỏi mọi thông điệp lỗi.

## 4. Webhook

- Chỉ `https://`. Hệ thống nhận trong mạng riêng (10/8, 172.16/12, 192.168/16, 100.64/10, `fc00::/7`): bật
  "Cho phép mạng riêng" cho kênh đó (khi đó được dùng `http://`). Loopback, link-local, metadata (`169.254.169.254`)
  luôn bị chặn, kể cả qua tên miền trỏ về các IP đó.
- Không theo redirect, timeout 5 giây, đọc tối đa 64 KB phản hồi; webhook không đi qua proxy HTTP của môi trường.
- Bên nhận kiểm chữ ký:

  ```text
  X-ITSO-Timestamp: 1763840000
  X-ITSO-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body thô>")>
  X-ITSO-Event: alert.firing
  X-ITSO-Delivery: <uuid>   (bỏ qua nếu đã xử lý — chống phát lại)
  ```

  Từ chối nếu lệch thời gian > 5 phút hoặc chữ ký sai (so sánh hằng thời gian).

## 5. Đọc và xử lý cảnh báo

- Monitoring → Cảnh báo: **đang bật** (mức, đối tượng, từ lúc, giá trị), **lịch sử**, **rule**.
- `pending`: vượt ngưỡng nhưng chưa đủ thời gian kéo dài. `firing`: đã gửi thông báo, nhắc lại mỗi 4 giờ (mặc định).
  `resolved`: 2 lượt đánh giá liên tiếp dưới ngưỡng (hysteresis).
- **Xác nhận (ack)**: ngừng nhắc lại, vẫn firing tới khi hết. **Tắt tạm (silence)** 1h/4h/24h: không gửi thông báo.
- "Server mất kết nối": agent không trả lời ≥ 90 giây (từ `metrics-collect`/`relay-sync`) → firing ngay ở lượt kế
  tiếp (≤ 2 phút). Kiểm `systemctl status itso-agent` (node: `itso-agent-node`, relay tới panel).
- "Disk server > 90%" (kéo dài 60 giây): dọn log/backup cũ; xem Monitoring → Account để tìm account chiếm nhiều.
- Rule mặc định sửa được (ngưỡng, kênh, bật/tắt), không xóa được. Tối đa 200 rule tự tạo.

## 6. Nhật ký gửi

Monitoring → Nhật ký gửi: `queued` → `sending` → `sent`; lỗi tạm → `retrying` (1, 5, 15 phút) → `failed`;
`blocked` = bị SsrfGuard chặn hoặc vượt 30 tin/phút/kênh (phần vượt được gộp thành một tin tóm tắt).
"Gửi lại" tạo lượt gửi mới cho delivery `failed`/`blocked`.

## 7. E2E và VM

- `make test-e2e-real` (cần `make dev` + `DemoSeeder`) gồm `e2e-real/phase11.spec.ts`. Webhook giả nghe trên IP dải
  riêng vì SsrfGuard chặn loopback: trước khi chạy, thêm IP vào `lo` (Linux, một lần mỗi lần khởi động):

  ```bash
  sudo ip addr add 10.99.0.1/32 dev lo     # hoặc đặt ITSO_E2E_WEBHOOK_HOST=<IP dải riêng của máy>
  ```

  Worker `make dev` phải được khởi động lại sau khi đổi code gửi thông báo (queue worker giữ code cũ).
- VM: `sudo bash tests/vm/phase11.sh` (M0–M5, xem `tests/vm/README.md`). M2 trên VM một máy dừng `itso-agent`;
  với node (Phase 9) chặn kết nối relay trên node:

  ```bash
  nft add table inet itso_block
  nft add chain inet itso_block out '{ type filter hook output priority 0; }'
  nft add rule inet itso_block out ip daddr <IP panel> tcp dport 443 drop
  # … chờ cảnh báo "Server mất kết nối" ≤ 2 phút …
  nft delete table inet itso_block
  ```
