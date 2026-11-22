# Review bảo mật Monitoring, Alerts, Notifications (Phase 11, Prompt 11.8)

- **Ngày:** 2026-11-22 · **Phạm vi:** metrics (`app/Domain/Servers/MetricsCollector`, `MetricsQuery`, `AccountUsageQuery`, op `metrics.snapshot`/`metrics.cgroup`), alerts (`app/Domain/Monitoring/*`, `itso:alerts-evaluate`), uptime (`UptimeService`, op `uptime.probe`), notifications (`app/Domain/Notifications/*`: `SsrfGuard`, `NotificationSender`, `NotificationDispatcher`, `EmailSender`, kênh, deliveries, tùy chọn), SSE job (`JobEvents`, `JobController::events`), dashboard.
- **Quyết định liên quan:** D-101 → D-107, ADR 0046–0052, threat model `docs/security/threat-model.md`.
- **Cách review:** đọc code theo từng đường vào và đối chiếu với test tự động: Go `ops/metrics_test`, `ops/uptime_test`; Pest `Phase11/*` (30 test: SSRF guard theo dải, DNS rebinding, redirect, ký HMAC, giới hạn tần suất, ma trận quyền, SSE theo phạm vi); `WebhookTransportTest` (HTTP thật qua cURL, không `Http::fake`); e2e stack thật `e2e-real/phase11.spec.ts` (agent sandbox, SMTP giả, webhook giả trên IP dải riêng, 5 luồng). Phần cần cgroup v2, nginx, SMTP và mạng thật ghi **chờ VM** (`tests/vm/phase11.sh` M0–M5).

## 1. Ranh giới tin cậy

```text
Trình duyệt ─HTTPS─► Laravel (itso) ──HMAC──► itso-agent (root): metrics.snapshot, metrics.cgroup, uptime.probe
   USER: số liệu/uptime account mình    │       (chỉ đọc /proc, cgroup itso-acct-*; HTTP tới domain của website)
   ADMIN: server/account được giao      │
   SA: rule, kênh, SMTP                  └─► queue `notifications` ──► SMTP (Settings) · api.telegram.org · webhook
                                                                       (SsrfGuard: DNS → IP → ghim, không redirect)
```

1. **Panel gọi ra ngoài là bề mặt mới:** chỉ SUPER_ADMIN (`monitoring.manage`) tạo kênh và cấu hình SMTP; USER không có kênh gọi ra ngoài (chỉ in-app + email của chính mình, D-104).
2. **Uptime không nhận URL tùy ý:** URL dựng từ domain của website + `path` (D-105), nên không có SSRF qua uptime; probe chạy trên server chứa website qua typed op.
3. **Laravel không chạy lệnh hệ thống:** gửi SMTP/HTTP từ worker là gọi mạng (cho phép theo D-103); `make no-exec` vẫn xanh.

## 2. Các mối đe dọa và biện pháp

| # | Tấn công / rủi ro | Biện pháp | Kiểm bằng |
|---|---|---|---|
| N1 | SSRF qua webhook tới loopback, metadata cloud, link-local, mạng nội bộ | `SsrfGuard`: phân giải DNS trước khi gửi, **mọi** IP trả về phải hợp lệ; luôn chặn 0/8, 127/8, 169.254/16, 224/4, 240/4, dải tài liệu/benchmark, `::/96`, `fe80::/10`, `ff00::/8`, `64:ff9b::/96`, `2001:db8::/32`, `fec0::/10`, `100::/64`, IPv4-mapped xét như IPv4; dải riêng (10/8, 172.16/12, 192.168/16, 100.64/10, `fc00::/7`) chỉ khi SA bật `allow_private_network` cho kênh đó; `http://` chỉ kèm cờ đó; URL IP/`localhost` bị từ chối ngay khi lưu (422) | Pest `NotificationsTest` (bảng dải, 422 khi lưu), e2e (loopback 422); **VM M5** |
| N2 | DNS rebinding (phân giải lần 2 ra IP khác) | IP đã kiểm được ghim bằng `CURLOPT_RESOLVE` cho đúng host:port; tên có nhiều bản ghi mà một bản ghi xấu → chặn | Pest (`rebind.example.test`), `WebhookTransportTest` (Host giữ tên gốc, kết nối tới IP ghim) |
| N3 | **Bỏ qua ghim IP qua proxy môi trường** (`HTTPS_PROXY` trong tiến trình worker: proxy tự phân giải DNS) | Tìm ra ở 11.8: webhook đặt `proxy=''` (CURLOPT_PROXY rỗng) nên luôn đi thẳng; Telegram (host cố định) vẫn dùng proxy nếu có | Pest (`opts['proxy'] === ''`), e2e (container có `HTTPS_PROXY`, webhook vẫn tới IP riêng) |
| N4 | Theo redirect tới đích nội bộ | `allow_redirects=false`; 3xx → `failed`, không thử lại | Pest + `WebhookTransportTest` (302 tới 169.254.169.254 không được gọi) |
| N5 | Đích chậm/lớn làm nghẽn worker (slowloris, body khổng lồ) | Timeout kết nối + tổng 5 giây; body đọc tối đa 64 KB bằng callback progress (hủy cả khi chunked, lỗi `failed` không thử lại); lỗi rút gọn 120 ký tự | `WebhookTransportTest` (256 KB chunked → ngắt, `quá lớn`) |
| N6 | **Webhook không gửi được trên máy thật** (tùy chọn `stream` chuyển sang StreamHandler, bỏ qua tùy chọn cURL → 500) | Tìm ra ở 11.8 bằng e2e (Pest dùng `Http::fake` nên không thấy): bỏ `stream`; thêm test HTTP thật qua cURL | `WebhookTransportTest`, e2e |
| N7 | Lộ secret kênh (mật khẩu SMTP, bot token, webhook secret) | Mã hóa `Crypt`; chỉ ghi, API trả `secret_set`; không có trong audit, delivery, nội dung tin; token Telegram bị xóa khỏi thông điệp lỗi (`[REDACTED]`), mật khẩu SMTP cũng vậy | Pest (response/audit/delivery không chứa secret, lỗi Telegram không chứa token), e2e (danh sách kênh không chứa secret webhook) |
| N8 | Giả mạo webhook tới hệ thống nhận | `X-ITSO-Signature: sha256=HMAC(secret, timestamp + "." + body)` + `X-ITSO-Timestamp` (bên nhận kiểm lệch ≤ 5 phút) + `X-ITSO-Delivery` (chống phát lại) | Pest, `WebhookTransportTest`, e2e (bên nhận tính lại chữ ký) |
| N9 | Rò dữ liệu qua nội dung thông báo | Nội dung dựng từ catalog: tên rule, đối tượng, giá trị, link theo realm; không có params job, mật khẩu, token; USER chỉ nhận sự kiện của account mình (quota, chứng chỉ, backup, khóa/mở, site down/up, WordPress rollback), **không** nhận cảnh báo rule (đã sửa ở 11.5) | Pest `NotificationsTest`, `AlertsTest` (USER khác không nhận) |
| N10 | Bão thông báo / lạm dụng kênh | Giới hạn 30 tin/phút/kênh, phần vượt `blocked` (rate_limited) và gộp thành một tin tóm tắt; nhắc lại firing mặc định 4 giờ; ack ngừng nhắc; silence có hạn | Pest (34 tin → 30 gửi + tóm tắt) |
| N11 | DoS bộ đánh giá qua rule | Chỉ SA tạo rule; tối đa **200 rule tự tạo** (thêm ở 11.8, 409); `alerts-evaluate` `withoutOverlapping`; mẫu cũ > 180 giây bị bỏ qua | Pest (rule thứ 201 → 409) |
| N12 | DoS qua uptime | Một check/website (409), `interval_sec ≥ 60`, lô ≤ 50 URL/lần, timeout 10 giây/URL; chỉ domain của website; `--all` là lệnh artisan (root/itso), không có qua HTTP | Pest `AlertsTest`, Go `ops/uptime_test` |
| N13 | USER/ADMIN xem số liệu, cảnh báo ngoài phạm vi | `Access::accounts/servers` trên metrics, alerts, uptime, SSE; ngoài phạm vi → 404; Portal không có route rule/kênh/deliveries/alerts | Pest (ma trận quyền), e2e (Portal 404, admin API từ phiên Portal bị từ chối) |
| N14 | SSE giữ kết nối quá lâu / rò log job người khác | Kiểm quyền như `GET /jobs/{id}`; tối đa 5 phút, heartbeat 15 giây; `Last-Event-ID` ép kiểu số | Pest `RealtimeTest` |
| N15 | Cấu hình SMTP xấu (SA nhập host nội bộ) | SMTP chỉ SA cấu hình (Settings, step-up), không qua SsrfGuard (cố ý: máy chủ mail nội bộ là trường hợp hợp lệ); ghi audit | Pest `PlatformApiTest` |

## 3. Lỗi tìm ra trong 11.8 (đã sửa, có test hồi quy)

1. Webhook lỗi 500 trên stack thật: `'stream' => true` + `curl` → Guzzle StreamHandler từ chối tùy chọn cURL. Pest không thấy vì `Http::fake`. Sửa: bỏ `stream`, giới hạn body bằng progress; thêm `WebhookTransportTest` (HTTP thật).
2. Webhook đi qua proxy môi trường, làm mất ghim IP của SsrfGuard. Sửa: `proxy=''` cho webhook.
3. Settings không xóa trống được chuỗi có mặc định `""` (`smtp.username`): middleware đổi `""` thành `null` → 422. Sửa trong `SettingsController::update`; test hồi quy `PlatformApiTest`.
4. Không giới hạn số rule cảnh báo: thêm trần 200 rule tự tạo.
5. Link trong email/Telegram thiếu tiền tố realm (`/admin`, `/portal`) nên trỏ sai trang. Sửa: kênh admin → `/admin/…`, email cá nhân theo realm người nhận; test hồi quy `NotificationsTest`.

## 4. Rủi ro còn lại

- SMTP không qua SsrfGuard (xem N15); chỉ SA, có audit.
- Uptime kiểm từ chính server chứa website (D-105): site lên từ trong máy nhưng không vào được từ ngoài thì không báo; kiểm nhiều điểm: DEFERRED.
- Telegram dùng proxy môi trường nếu có (host cố định `api.telegram.org`, không có SSRF).
- Gửi thật tới SMTP/Telegram ngoài và cgroup v2, nftables thật: **chờ VM/người dùng cấu hình** (`tests/vm/phase11.sh` M0–M5).
