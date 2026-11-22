# Báo cáo Phase 11: Monitoring, Alerts, Notifications → v0.5.0-beta

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM, **chờ duyệt**. Nhánh `phase-11`, merge `--no-ff` vào `main`, đẩy `main` và `phase-11` lên `github`; tag `v0.5.0-beta` chỉ ở local (proxy môi trường cloud chặn đẩy tag, HTTP 403). Tiêu chí cần cgroup v2, nftables, nginx và SMTP thật được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`tests/vm/phase11.sh`, M0–M5).
- **Thời gian:** 2026-11-22, chạy liền 11.0 → 11.8 theo lựa chọn "Bắt đầu Phase 11" và yêu cầu "làm hàng loạt và tự merge".
- **Cách làm:** mockup trước (11.0, ảnh `docs/screenshots/phase-11/`) → ADR + contracts + migration → agent (metrics mở rộng, cgroup theo lô, `uptime.probe`, sandbox điều khiển được) → panel metrics → alerts + uptime → notifications → SSE + dashboard → UI nối API thật → tích hợp. Container không có cgroup v2, systemd, SMTP thật: agent sandbox sinh cây cgroup giả và số liệu điều khiển bằng `metrics-control.json`; e2e dùng SMTP giả (Node) và webhook giả trên IP dải riêng.
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh); gửi SMTP/HTTP từ worker là gọi mạng, có SsrfGuard. Agent không có op chạy lệnh tùy ý, không `sh -c`; uptime chỉ kiểm domain của website. Nội dung thông báo và params job không chứa bí mật. USER chỉ thấy số liệu, uptime, thông báo của account mình. Billing/WooCommerce/thanh toán: OUT OF SCOPE; Public Provisioning API: DEFERRED.
- **Quyết định:** D-101 → D-107, ADR 0046 → 0052 (Accepted ở 11.1).

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 11.0 Mockup | Monitoring server/account, Uptime, Alerts (đang bật, lịch sử, rule, xem trước), kênh + nhật ký gửi, tùy chọn Admin/Portal, dashboard; 19 cảnh × 4 = 76 ảnh | ac806f7 |
| 11.1 Contracts | ADR 0046–0052; `metrics.snapshot` mở rộng, `metrics.cgroup` lô, `uptime.probe`; OpenAPI; DBML + migration Phase 11 | 1c13c74 |
| 11.2 Agent | swap/inode/IO/net theo interface, cgroup một lần cho mọi slice `itso-acct-*`, `uptime.probe` (lô 50, timeout 10 giây, không redirect ra domain khác), sandbox điều khiển được | b7ff570 |
| 11.3 Metrics | Thu account 5 phút, rollup 1 giờ, prune bằng drop partition, API theo khoảng (samples ≤ 24 giờ, rollup sau đó, ≤ 500 điểm), usage account trên dashboard + Portal | 11ae375 |
| 11.4 Alerts | Rule CRUD + 9 rule mặc định, bộ máy đánh giá (pending → firing → resolved, hysteresis, nhắc lại, ack, silence), mất kết nối ≤ 2 phút, uptime check + kết quả | 1fb7cc7 |
| 11.5 Notifications | Kênh email/Telegram/webhook, SsrfGuard, queue `notifications` + deliveries + thử lại/gửi lại, giới hạn tần suất, danh mục sự kiện, tùy chọn, sự kiện USER | 1573800 |
| 11.6 Realtime | SSE job qua Redis pub/sub + `Last-Event-ID`, JobProgress dùng SSE + poll dự phòng, dashboard số liệu thật | 7e7964d |
| 11.7 UI | Đối chiếu mọi API giao diện dùng; `If-Match` theo `updated_at` (sửa cả lỗi có từ trước ở user/backup), danh mục chỉ kênh cá nhân, MSW kiểm như API | 6977ffa |
| 11.8 Tích hợp | e2e stack thật Phase 11 (5 luồng), `tests/vm/phase11.sh` (M0–M5), review bảo mật, runbook, 5 lỗi tìm ra và sửa, `make check`, release `v0.5.0-beta` | xem `git log` |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/internal/ops/{metrics,uptime}.go` |
| Panel | `apps/api/app/Domain/Monitoring/`, `app/Domain/Notifications/`, `app/Domain/Servers/{MetricsCollector,MetricsQuery,AccountUsageQuery}.php`, `app/Domain/Jobs/JobEvents.php`, controller `Admin/{MonitoringController,NotificationChannelController}`, `NotificationPreferenceController`, `Portal/PortalMonitoringController` |
| UI | `apps/web/src/entries/admin/system/{MonitoringPage,UptimePage}.tsx` và các trang Alerts/kênh, `entries/portal/pages/MonitoringPage.tsx`, `shared/jobs/useJobEvents.ts` |
| E2E · test VM | `apps/web/e2e-real/phase11.spec.ts`, `tests/vm/phase11.sh` |
| Bảo mật · vận hành | `docs/security/monitoring-notifications-review.md`, `docs/runbooks/phase-11-monitoring.md` |
| Phát hành | `docs/releases/v0.5.0-beta.md` |

## 3. Cách chạy thử

- Dev: `ITSO_ACME_EMAIL=ops@itso.local make dev`, `php artisan migrate:fresh --seed`, `db:seed --class=DemoSeeder`. Scheduler không chạy trong dev: gọi tay `itso:metrics-collect`, `itso:usage-refresh`, `itso:alerts-evaluate`, `itso:uptime-probe --all` (kèm `ITSO_AGENT_SOCKET`/`ITSO_AGENT_KEY_FILE` của sandbox, xem runbook §1).
- E2E: thêm IP dải riêng cho webhook giả (`sudo ip addr add 10.99.0.1/32 dev lo`), rồi `make test-e2e-real`. Mô phỏng bằng `.dev/agent-sandbox/root/var/lib/itso-sandbox/metrics-control.json` (`disk_pct`, `offline`, `uptime_down`, `cert_days`).
- VM: `sudo bash tests/vm/phase11.sh` (M4 cần `ITSO_VM_SMTP_*`).

## 4. Kết quả test

`make check`: xem `TEST_REPORT.md` (Prompt 11.8).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | 536/536 (Phase 11: 31 test trong `Phase11/*`) |
| Go (agent) | PASS |
| Vitest | 623/623 |
| Playwright stack thật | `phase11.spec.ts` 5/5; toàn bộ: xem TEST_REPORT |
| Script VM | `bash -n tests/vm/phase11.sh` OK; M0–M5 **chờ VM** |

E2E stack thật Phase 11 (`e2e-real/phase11.spec.ts`, agent sandbox, 3,6 phút):

1. **Số liệu:** CPU/RAM/disk/load server có điểm từ agent sandbox; RAM account trong bảng top account đúng bằng `memory.current` của slice cgroup giả `itso-acct-<uid>.slice`; trang Monitoring hiển thị.
2. **Disk 92 %:** cấu hình SMTP giả (step-up), kênh email + webhook (URL loopback bị 422), gửi thử webhook ký đúng → disk 92 % → firing trong ≤ 120 giây (rule kéo dài 60 giây) → webhook nhận `alert.firing` có chữ ký HMAC đúng, không chứa secret; SMTP giả nhận thư; nhật ký gửi `sent` → disk 80 % → resolved + webhook `alert.resolved`.
3. **Mất kết nối:** `offline=true` → "Server mất kết nối" firing trong dưới 120 giây (test đo và chặn ở 120 giây) → nối lại → resolved.
4. **Uptime:** website tĩnh → check up → `uptime_down` → down sau 3 lần → cảnh báo "Website không phản hồi"; USER chủ thấy `down` trong Portal → lên lại → up, cảnh báo đóng.
5. **USER:** usage, lịch sử usage, uptime của mình 200; `/alert-rules`, `/notification-channels`, `/notification-deliveries`, `/alerts` ở Portal 404, gọi API Admin bị từ chối; tùy chọn chỉ in-app + email; trang Monitoring Portal hiện website.

**Lỗi e2e tìm ra (đã sửa, có test hồi quy):** (1) webhook lỗi 500 trên stack thật vì tùy chọn `stream` làm Guzzle bỏ qua tùy chọn cURL (Pest dùng `Http::fake` nên không thấy) → bỏ `stream`, giới hạn body bằng progress, thêm `WebhookTransportTest` gửi HTTP thật; (2) webhook đi qua `HTTPS_PROXY` của môi trường, làm mất ghim IP chống SSRF → `proxy=''`; (3) Cài đặt không xóa trống được `smtp.username` (`""` bị đổi thành `null` → 422); (4) thêm trần 200 rule tự tạo (review bảo mật); (5) link trong email/Telegram thiếu tiền tố `/admin`, `/portal`. Thêm `itso:uptime-probe --all` để kiểm ngay (vận hành + e2e).

## 5. Tiêu chí nghiệm thu Phase 11 (ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Cảnh báo ≤ 2 phút khi server mất kết nối | ✓ · **chờ VM** | Pest (travelTo), e2e (< 120 giây); **VM M2** |
| Cảnh báo ≤ 2 phút khi disk vượt 90 % | ✓ · **chờ VM** | Pest, e2e (< 120 giây với rule kéo dài 60 giây); **VM M1** |
| Dashboard hiển thị đúng usage từng account | ✓ · **chờ VM** | Pest (so với cgroup giả), e2e (RAM = `memory.current`); **VM M0** cgroup v2 thật |
| Email/Telegram/webhook gửi được, không bị lợi dụng SSRF | ✓ (email, webhook) · **chờ VM/người dùng** | Pest (guard, rebinding, redirect, proxy), `WebhookTransportTest`, e2e (SMTP + webhook giả); Telegram chỉ Pest (`Http::fake`); **VM M4** (SMTP thật), **M5** |
| USER chỉ thấy số liệu, uptime, thông báo của mình | ✓ | Pest (ma trận quyền), e2e |

## 6. Lệch so với kế hoạch

- Rule mặc định không có "load > 2×core 15 phút" (9 rule: mất kết nối, disk, inode, RAM, dịch vụ lõi, uptime, chứng chỉ, backup, quota); tạo rule `load_1m` tùy chọn được.
- E2E "dừng agent sandbox" làm bằng `offline=true` trong file điều khiển (agent vẫn chạy để các spec khác dùng); VM M2 dừng agent thật.
- Webhook giả trong e2e cần một IP dải riêng trên máy chạy test (SsrfGuard chặn loopback và cả `192.0.2.0/24` của container cloud).
- Thêm `itso:uptime-probe --all` (không có trong kế hoạch).

## 7. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 → 11 (Phase 11: M0–M5); gửi thật SMTP/Telegram chờ người dùng cấu hình.
- `metric_samples` với 200 account/server chưa đo (Phase 12).
- Uptime kiểm từ một điểm; SMTP không qua SsrfGuard (chỉ SA, có audit).
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 8. Bước tiếp theo

Dừng trước Phase 12, chờ duyệt Phase 11 và bản `v0.5.0-beta`.
