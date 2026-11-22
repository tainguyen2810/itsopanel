# Phase 11 — Monitoring, Alerts, Notifications: prompt chi tiết

> Viết ngày 2026-11-22, sau khi Phase 10 hoàn tất (merge `ea528c9`) và người dùng duyệt ("ok merge và lên kế hoạch làm tiếp"). Nguồn: `ROADMAP.md` §Phase 11, `docs/planning/03-MODULES.md` §1 (Dashboard), §23 (Monitoring & Alerts), §28 (Notifications), `docs/planning/11-ROADMAP.md` §Phase 11 (phần multi-server đã làm ở Phase 9), `DECISIONS.md` D-15 (mốc `v0.5.0-beta` sau Phase 11), D-60 (job runner), D-91 (job khi node mất kết nối), ADR 0027 (sự kiện bảo mật → thông báo), `contracts/agent-ops/catalog.json` (`metrics.snapshot`, `metrics.cgroup`, `http.check`), OpenAPI `/alert-rules*`, `/alerts`, `/uptime-checks`, `/metrics/*`, `/notification-preferences`, `/notifications*` (admin + portal), DBML `metric_samples`, `metric_rollups`, `alert_rules`, `alerts`, `uptime_checks`, `notification_channels`, `notification_preferences` (đã có trong DBML, **chưa có migration**), mã đã có từ Phase 4 (`MetricsCollector`, `itso:metrics-collect` mỗi phút, `account_usage_snapshots`, `itso:usage-refresh`), `Notifier` (chỉ in-app), trang demo Phase 2 (`MonitoringPage`, `AlertsPage`, `DashboardPage`, chuông thông báo).
> Nhánh `phase-11`. Làm hàng loạt 11.0 → 11.8, tự merge local, DỪNG trước Phase 12. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.
> Mockup trước khi code: Prompt 11.0 dựng màn hình và trạng thái mới trên bản demo (MSW), chụp ảnh vào `docs/screenshots/phase-11/`.
> **Mốc phát hành:** cuối Phase 11 là `v0.5.0-beta` (D-15), gói release ký Ed25519 + tag local như `v0.1.0-alpha` ở Phase 8.
> **Điều kiện bắt đầu:** người dùng chọn bắt đầu Phase 11.

## Mục tiêu Phase 11

1. **Metrics:** số liệu server (CPU, RAM, swap, disk, inode, IO, network, load) và theo account (từ cgroup: CPU, RAM, IO, tasks) được lưu 1 phút × 7 ngày, rollup 1 giờ × 90 ngày; biểu đồ theo khoảng thời gian; trạng thái dịch vụ.
2. **Uptime check:** kiểm HTTP(S) cho website do panel quản lý, thời gian phản hồi, % uptime, hạn chứng chỉ TLS.
3. **Alerts:** rule theo ngưỡng + thời gian kéo dài, phạm vi (toàn hệ thống / server / account / website), rule mặc định, trạng thái `pending → firing → resolved`, xác nhận (ack), tắt tạm (silence), nhắc lại, lịch sử.
4. **Notifications:** kênh email (SMTP), Telegram, webhook (ký HMAC) ngoài in-app; danh mục sự kiện + tùy chọn theo người; thông báo cho USER (quota 80 %/100 %, chứng chỉ sắp hết hạn, backup lỗi, account bị khóa, site down); nhật ký gửi + gửi lại.
5. **Realtime nhẹ:** luồng sự kiện job thật (SSE qua Redis pub/sub, thay snapshot + retry hiện tại); dashboard dùng dữ liệu thật (cảnh báo đang bật, sự kiện bảo mật).

**Tiêu chí nghiệm thu (ROADMAP):** cảnh báo đến trong ≤ 2 phút khi server mất kết nối hoặc disk vượt 90 %; dashboard hiển thị đúng usage của từng account.

## Ràng buộc môi trường

- Như Phase 4–10: container không có systemd/KVM/cgroup v2 đầy đủ. Số liệu cgroup test bằng cây `/sys/fs/cgroup` giả trong gốc sandbox; agent sandbox sinh số liệu có thể điều khiển (file điều khiển như 10.8) để e2e đẩy disk > 90 % hoặc làm server mất kết nối.
- Email test bằng SMTP giả trong tiến trình (Laravel `array`/`log` transport ở Pest, server SMTP nhỏ bằng Node trong e2e); Telegram và webhook test bằng HTTP server giả cục bộ. Gửi thật tới Telegram/SMTP ngoài: **chờ VM/người dùng cấu hình**, không gửi ra Internet từ container.
- Laravel **không chạy lệnh hệ thống**. Gửi email/HTTP từ queue worker của Laravel là gọi mạng, không phải lệnh hệ thống, được phép; vẫn chặn SSRF (D-103).
- Uptime và metrics đi qua typed op của agent; không mở cổng mới.

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-101 | Lưu metrics | Giữ PostgreSQL (không thêm Prometheus/TSDB): `metric_samples` partition theo ngày, 1 phút, giữ 7 ngày (drop partition, không DELETE); `metric_rollups` 1 giờ (min/avg/max), giữ 90 ngày, lệnh `itso:metrics-rollup` mỗi giờ + `itso:metrics-prune` hằng ngày. Server: `metrics.snapshot` mỗi phút (đã có, mở rộng swap/inode/IO/net). Account: `metrics.cgroup` mỗi 5 phút, một lần gọi trả mọi slice `itso-acct-*` (không gọi theo từng account). API chọn nguồn theo khoảng: ≤ 24 giờ đọc samples, > 24 giờ đọc rollup; tối đa ~500 điểm mỗi series | Đủ cho nội bộ (200 account/server ≈ 60 nghìn dòng/giờ), không thêm dịch vụ phải vận hành |
| D-102 | Bộ máy cảnh báo | Laravel `itso:alerts-evaluate` mỗi phút (scheduler, `withoutOverlapping`), đọc samples gần nhất; rule = `metric op threshold` kéo dài `duration_sec`, phạm vi `global\|server\|account\|website`, mức `info…critical`. Trạng thái `pending → firing → resolved`, khóa trùng theo `fingerprint` (rule + đối tượng), resolve có trễ (hysteresis 2 lần đánh giá), nhắc lại mặc định 4 giờ khi còn firing, ack (ngừng nhắc), silence có hạn. **Mất kết nối server**: không tiếp xúc được agent ≥ 90 giây (từ `metrics-collect` và `relay-sync`) → firing ngay ở lượt đánh giá kế tiếp, không chờ `duration_sec` ⇒ ≤ 2 phút. Rule mặc định (seed, sửa được, không xóa được): server mất kết nối, disk > 90 %, inode > 90 %, RAM > 95 % 10 phút, load > 2×core 15 phút, dịch vụ lõi dừng, uptime down, chứng chỉ ≤ 7 ngày, backup lỗi, quota account ≥ 100 % | Đơn giản, test được bằng Pest + travelTo; đạt tiêu chí 2 phút |
| D-103 | Kênh gửi | `notification_channels` (email/telegram/webhook), cấu hình mã hóa `Crypt` (mật khẩu SMTP, bot token, webhook secret không bao giờ trả về API). SMTP cấu hình ở Settings (SA). Webhook chỉ `https://` (SA bật `http` cho mạng nội bộ có cảnh báo), body JSON + header `X-ITSO-Signature: sha256=<HMAC>` + `X-ITSO-Timestamp`; **chặn SSRF**: phân giải DNS trước khi gửi, từ chối loopback/link-local/metadata (`169.254.0.0/16`), dải riêng chỉ khi SA bật cho kênh đó, không theo redirect, timeout 5 giây, body ≤ 64 KB. Gửi qua queue `notifications` (retry 3 lần, backoff 1/5/15 phút), bảng mới `notification_deliveries` (trạng thái, lỗi rút gọn, số lần thử) + gửi lại thủ công; giới hạn tần suất mỗi kênh (mặc định 30/phút, gộp phần vượt thành 1 tin tóm tắt). Nút "Gửi thử" | An toàn khi panel gọi ra ngoài; không mất thông báo khi kênh lỗi tạm |
| D-104 | Định tuyến thông báo | Danh mục sự kiện ở code (`type`, mức mặc định, đối tượng nhận: SA / ADMIN trong phạm vi server/account / USER chủ account). `notification_preferences` theo người × sự kiện × kênh; in-app luôn bật với mức `critical`. USER chỉ có in-app + email của chính mình (email đã xác minh); Telegram/webhook là kênh của realm admin, gắn vào rule hoặc sự kiện. Nội dung không chứa bí mật; link về trang liên quan theo realm. Sự kiện USER: quota 80 %/100 % (disk, inode, backup), chứng chỉ còn 14/7/1 ngày hoặc gia hạn lỗi, backup lỗi, account bị khóa/mở, website down/up, WordPress cập nhật rollback | 03 §28; USER không cấu hình được kênh gọi ra ngoài |
| D-105 | Uptime check | Bật theo website (mặc định bật cho website có SSL khi tạo; SA/ADMIN/USER chủ website bật/tắt), URL **chỉ thuộc domain của website đó** (không nhập URL tùy ý ⇒ không SSRF). Chạy bằng op agent mới `uptime.probe` (lô nhiều URL, giới hạn 50/lần, timeout 10 giây/URL, không theo redirect ra domain khác, trả status, thời gian, hạn chứng chỉ, khớp từ khóa tùy chọn) trên **server chứa website**, mỗi 60 giây (`interval_sec` ≥ 60). Down = 3 lần lỗi liên tiếp; bảng mới `uptime_results` (partition ngày, 7 ngày) + rollup % uptime theo giờ/ngày. Kiểm từ một điểm (server) là giới hạn đã biết | Tái dùng `http.check`, không để panel gọi URL do người dùng nhập |
| D-106 | Realtime | Sự kiện job phát qua Redis pub/sub (`itso:job:<uuid>`), endpoint SSE `GET /jobs/{id}/events` giữ kết nối tối đa 5 phút, heartbeat 15 giây, client tự nối lại với `Last-Event-ID`; vẫn kiểm quyền như `GET /jobs/{id}`. Dashboard và chuông thông báo poll 30 giây (không WebSocket). Log container realtime: vẫn DEFERRED | `JobController` đã ghi "luồng thật Phase 11"; tránh thêm hạ tầng WebSocket |
| D-107 | Phát hành `v0.5.0-beta` | Cuối 11.8: `make release` (ký Ed25519), release notes `docs/releases/v0.5.0-beta.md` (Phase 9–11: multi-server, Docker/WordPress/Software, monitoring), tag local `v0.5.0-beta` trên `main` sau merge; không push, không publish. Ghi rõ mục còn **chờ VM** từ Phase 4–11 | D-15 |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code; mọi thay đổi máy chủ đi qua job + audit; params job và nội dung thông báo không chứa bí mật; USER chỉ thấy dữ liệu account/website của mình.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 11.0 | **Mockup:** Monitoring (server + account, khoảng thời gian, biểu đồ, dịch vụ), Uptime, Alerts (rule, đang bật, lịch sử, ack/silence), kênh thông báo + nhật ký gửi, tùy chọn thông báo (Admin + Portal), dashboard có cảnh báo thật, Portal: usage + uptime site của mình; ảnh `docs/screenshots/phase-11/` | 0,5 ngày |
| 11.1 | ADR 0046–0052 (D-101…D-107); contracts agent-ops (`metrics.snapshot` mở rộng, `metrics.cgroup` lô, `uptime.probe`); OpenAPI rà lại; DBML + migration Phase 11 | 0,5 ngày |
| 11.2 | Agent: metrics mở rộng, cgroup theo lô, `uptime.probe`, sandbox điều khiển được; Go test | 0,5 ngày |
| 11.3 | Panel metrics: thu account, rollup, prune, API metrics theo khoảng, usage account trên dashboard + Portal; Pest | 1 ngày |
| 11.4 | Panel alerts: rule (CRUD + mặc định), bộ máy đánh giá, mất kết nối ≤ 2 phút, ack/silence/nhắc lại, uptime check + kết quả; Pest | 1 ngày |
| 11.5 | Notifications: kênh email/Telegram/webhook, SSRF guard, queue + deliveries + gửi lại, danh mục sự kiện, preferences, sự kiện USER; Pest | 1 ngày |
| 11.6 | Realtime job SSE qua Redis, dashboard dữ liệu thật (cảnh báo, bảo mật); Pest + Vitest | 0,5 ngày |
| 11.7 | UI nối API thật theo mockup 11.0, MSW theo hành vi mới, i18n vi/en | 1 ngày |
| 11.8 | Tích hợp: e2e stack thật, `tests/vm/phase11.sh`, review bảo mật, `make check`, báo cáo, release `v0.5.0-beta`, merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p11)`, `test(p11)`, `docs(p11)`; đồng bộ bản sao lưu.

## Prompt 11.0 — Mockup

```
[ITSO Panel] Prompt 11.0 — Mockup Monitoring, Alerts, Notifications (trước khi code)
Phạm vi: chỉ bản demo (apps/web + src/demo + contracts/tools/demo.py), không đụng API/agent.
Màn hình và trạng thái:
- Monitoring › Server: chọn server + khoảng (1 giờ, 24 giờ, 7 ngày, 30 ngày, 90 ngày), biểu đồ CPU/RAM/swap/disk/
  inode/IO/network/load, dịch vụ (chạy/dừng, từ lúc), server mất kết nối (banner + số liệu cuối), không có dữ liệu.
- Monitoring › Account: top account theo CPU/RAM/IO/disk, chi tiết account (biểu đồ so với giới hạn gói).
- Uptime: danh sách website (trạng thái, % 24h/7d/30d, thời gian phản hồi, hạn chứng chỉ), chi tiết (biểu đồ, sự cố).
- Alerts: đang bật (mức, đối tượng, từ lúc, ack, silence 1h/4h/24h), lịch sử, rule (mặc định có khóa xóa, tạo rule:
  metric, toán tử, ngưỡng, thời gian, phạm vi, kênh), xem trước "rule này đang khớp N đối tượng".
- Kênh thông báo (SA): email (SMTP ở Settings), Telegram, webhook (secret chỉ ghi, chữ ký HMAC, cảnh báo mạng riêng),
  gửi thử, nhật ký gửi (lỗi, thử lại, gửi lại).
- Tùy chọn thông báo: Admin (ma trận sự kiện × kênh) và Portal (in-app + email của tôi).
- Dashboard Admin: thẻ cảnh báo đang bật + sự kiện bảo mật thật; Portal: usage account + uptime website của tôi.
Chụp: e2e/screenshots-phase11.spec.ts, make screenshots → docs/screenshots/phase-11.
Kiểm thử: Vitest/Playwright demo + axe xanh; i18n vi = en; check_demo.py.
```

## Prompt 11.1 — ADR và contracts

```
[ITSO Panel] Prompt 11.1 — ADR Monitoring/Alerts/Notifications, contracts Phase 11, migration
Phạm vi: docs/adr/0046-metrics-storage.md (D-101), 0047-alert-engine.md (D-102), 0048-notification-channels.md
(D-103), 0049-notification-routing.md (D-104), 0050-uptime-checks.md (D-105), 0051-realtime-sse.md (D-106),
0052-release-v0.5.0-beta.md (D-107). DECISIONS.md: D-101…D-107 Accepted.
Contracts agent-ops: metrics.snapshot (thêm swap, inode, io, net theo interface), metrics.cgroup (lô mọi slice
itso-acct-*), uptime.probe (mới: urls[≤50], timeout, keyword, trả status/ms/cert_expires_at/error). Vector độc: URL
không phải http(s), host là IP, cổng lạ, quá 50 URL, keyword quá dài.
OpenAPI rà lại: metrics servers/accounts (range, step, nguồn), alert-rules (CRUD, mặc định không xóa, preview),
alerts (lọc, :ack, :silence, :unsilence), uptime-checks (CRUD theo website, results, summary) admin + portal (chỉ của
mình), notification-channels (CRUD, :test), notification-deliveries (lọc, :resend), notification-preferences (admin +
portal), event catalog, jobs/{id}/events (SSE). DBML: metric_samples partition + chỉ mục account, metric_rollups
unique (server, account, metric, bucket), alert_rules (+severity, scope, is_default, repeat_sec), alerts (+fingerprint
unique khi firing, hosting_account_id, website_id, severity, acked_by/at, silenced_until, last_notified_at),
uptime_checks (+keyword, enabled, consecutive_failures), uptime_results (mới), notification_channels,
notification_deliveries (mới), notification_preferences; migration Phase 11; make db-verify.
make contracts, make codegen, codegen-check xanh.
```

## Prompt 11.2 — Agent

```
[ITSO Panel] Prompt 11.2 — Agent: metrics mở rộng, cgroup theo lô, uptime.probe
Phạm vi: metrics.snapshot (đọc /proc: meminfo, swap, diskstats, net/dev, statvfs disk + inode theo mount), metrics.cgroup
(một lần đọc mọi itso-acct-*.slice: cpu.stat, memory.current/max, io.stat, pids.current; slice thiếu → bỏ qua, không
lỗi), uptime.probe (HTTP client riêng: không proxy, không redirect sang host khác, TLS đọc hạn chứng chỉ, giới hạn body
đọc 64 KB cho keyword, chạy song song có giới hạn). Sandbox: cây cgroup giả + file điều khiển
/var/lib/itso-sandbox/metrics-control.json (disk_pct, offline) để e2e mô phỏng disk > 90 % và mất kết nối.
Test Go: parse /proc mẫu, cgroup giả nhiều slice, uptime với server httptest (200, 500, timeout, redirect ra ngoài bị
chặn, cert sắp hết hạn, keyword), vector độc, policy.
```

## Prompt 11.3 — Panel metrics

```
[ITSO Panel] Prompt 11.3 — Metrics lưu trữ, rollup, API, usage account
Phạm vi: MetricsCollector ghi thêm metric mới; thu account qua metrics.cgroup mỗi 5 phút (một op/server); partition
theo ngày (tạo trước 2 ngày, drop quá 7 ngày) trong itso:metrics-prune; itso:metrics-rollup mỗi giờ (idempotent, chạy
bù khi trễ); API GET /metrics/servers/{id} và /metrics/hosting-accounts/{id} (range, step, nguồn samples/rollup,
≤ 500 điểm), top account theo server; Portal: usage account của mình (so với giới hạn gói); dashboard usage đúng từng
account (tiêu chí nghiệm thu).
Test Pest: rollup đúng min/avg/max, chạy lại không nhân đôi, range > 24h đọc rollup, prune chỉ drop partition cũ,
USER chỉ xem account mình (404 ngoài phạm vi), ADMIN theo phạm vi server.
```

## Prompt 11.4 — Panel alerts và uptime

```
[ITSO Panel] Prompt 11.4 — Alert engine, rule mặc định, mất kết nối ≤ 2 phút, uptime
Phạm vi: AlertRule (CRUD, rule mặc định seed: sửa ngưỡng/kênh/tắt được, không xóa), AlertEngine (itso:alerts-evaluate
mỗi phút: pending → firing → resolved, fingerprint, hysteresis, nhắc lại, ack, silence), nguồn: metric_samples, kết
nối agent (last_seen ≥ 90 giây), dịch vụ, uptime, chứng chỉ, backup lỗi, quota; mỗi lần chuyển trạng thái → sự kiện
thông báo (11.5 gắn kênh). Uptime: uptime_checks theo website (mặc định bật khi website có SSL), itso:uptime-probe mỗi
phút gom theo server → uptime.probe, 3 lỗi liên tiếp → down, uptime_results + % theo giờ/ngày.
Test Pest (travelTo): agent im lặng 90 giây → firing trong lượt kế tiếp, tổng ≤ 2 phút; disk 91 % kéo dài → firing,
xuống 85 % hai lượt → resolved; không nhân đôi alert; ack ngừng nhắc; silence hết hạn thì nhắc lại; uptime 3 lỗi →
down → 1 lần thành công → up; USER không sửa được rule, chỉ thấy cảnh báo của account mình.
```

## Prompt 11.5 — Notifications

```
[ITSO Panel] Prompt 11.5 — Kênh email/Telegram/webhook, định tuyến, sự kiện USER
Phạm vi: Settings SMTP (SA, mật khẩu Crypt), notification_channels CRUD + :test (SA), NotificationDispatcher (danh mục
sự kiện, đối tượng nhận theo vai trò + phạm vi, preferences, in-app luôn có với critical) → job queue `notifications`
(retry/backoff) → notification_deliveries + :resend; webhook ký HMAC + timestamp, SSRF guard (phân giải DNS, chặn
loopback/link-local/metadata, dải riêng chỉ khi bật, không redirect, timeout, giới hạn body); Telegram qua Bot API
(token Crypt); giới hạn tần suất + tin tóm tắt. Notifier hiện có chuyển qua Dispatcher (giữ hành vi in-app). Sự kiện
USER: quota 80/100 %, chứng chỉ 14/7/1 ngày + gia hạn lỗi, backup lỗi, account khóa/mở, website down/up, WordPress
rollback.
Test Pest: webhook tới 127.0.0.1 / 169.254.169.254 / tên miền phân giải ra IP riêng → bị chặn, ghi delivery lỗi; chữ
ký HMAC đúng; kênh lỗi → retry rồi failed, resend được; secret không có trong response/audit/delivery; USER không tạo
được kênh, chỉ chỉnh preferences in-app/email; ADMIN chỉ nhận sự kiện trong phạm vi.
```

## Prompt 11.6 — Realtime và dashboard

```
[ITSO Panel] Prompt 11.6 — SSE sự kiện job, dashboard dữ liệu thật
Phạm vi: JobRunner phát sự kiện bước/log/trạng thái lên Redis pub/sub; GET /jobs/{id}/events (SSE thật, heartbeat,
Last-Event-ID, tối đa 5 phút, kiểm quyền như GET job); client JobProgress dùng SSE, fallback poll khi SSE lỗi;
DashboardController: cảnh báo đang bật + sự kiện bảo mật thật (bỏ giá trị 0 tạm).
Test: Pest (SSE trả sự kiện theo thứ tự, ngoài phạm vi → 404, Last-Event-ID bỏ sự kiện cũ), Vitest (JobProgress với SSE
và fallback).
```

## Prompt 11.7 — UI nối API thật

```
[ITSO Panel] Prompt 11.7 — UI Monitoring/Alerts/Notifications nối API thật
Phạm vi: các màn 11.0 dùng client sinh từ OpenAPI; MSW cập nhật theo hành vi API 11.3–11.6 (lỗi, quyền, SSRF bị chặn,
secret chỉ ghi); i18n vi/en; biểu đồ theo skill dataviz (token màu, sáng/tối); chụp lại ảnh nếu đổi.
Test: Vitest, Playwright demo + axe (390px + EN), check-i18n.
```

## Prompt 11.8 — Tích hợp và phát hành

```
[ITSO Panel] Prompt 11.8 — e2e, VM, review bảo mật, make check, v0.5.0-beta
Phạm vi:
- e2e stack thật apps/web/e2e-real/phase11.spec.ts: biểu đồ server có số liệu thật từ agent sandbox; usage account
  đúng trên dashboard; file điều khiển đẩy disk 92 % → cảnh báo firing + webhook giả nhận tin có chữ ký đúng + email
  giả nhận thư; về 80 % → resolved; dừng agent sandbox → "mất kết nối" firing ≤ 2 phút; uptime site sandbox down/up;
  USER thấy usage + uptime của mình, không thấy rule/kênh.
- tests/vm/phase11.sh (M0–M5): M0 số liệu thật /proc + cgroup v2 thật theo account, M1 disk > 90 % (fallocate) →
  cảnh báo ≤ 2 phút, M2 chặn agent bằng nftables → mất kết nối ≤ 2 phút, M3 uptime nginx thật + chứng chỉ, M4 email qua
  SMTP thật nếu có cấu hình, M5 webhook tới IP riêng bị chặn.
- docs/security/monitoring-notifications-review.md (SSRF, secret kênh, rò dữ liệu qua thông báo, DoS qua rule/uptime,
  phạm vi USER/ADMIN); runbook docs/runbooks/phase-11-monitoring.md (cấu hình SMTP/Telegram/webhook, đọc cảnh báo).
- make check, docs/reports/phase-11.md, release notes docs/releases/v0.5.0-beta.md, make release, merge --no-ff vào
  main, tag local v0.5.0-beta, không push. DỪNG trước Phase 12.
```

## Tiêu chí nghiệm thu (ROADMAP §Phase 11)

| Tiêu chí | Cách chứng minh |
|---|---|
| Cảnh báo đến trong ≤ 2 phút khi server mất kết nối | Pest (travelTo) · e2e (dừng agent sandbox) · **VM M2** |
| Cảnh báo đến trong ≤ 2 phút khi disk vượt 90 % | Pest · e2e (file điều khiển) · **VM M1** |
| Dashboard hiển thị đúng usage của từng account | Pest (so với cgroup giả) · e2e · **VM M0** |
| Kênh email/Telegram/webhook gửi được và không bị lợi dụng SSRF | Pest (guard) · e2e (webhook/SMTP giả) · **VM M4, M5** |
| USER chỉ thấy số liệu, uptime, thông báo của mình | Pest (ma trận quyền) · e2e |

## Rủi ro

- `metric_samples` phình to trên server nhiều account → partition theo ngày + drop, cgroup 5 phút; đo ở Phase 12 (200 account/server).
- Uptime kiểm từ chính server chứa site: site "lên" từ trong máy nhưng không vào được từ ngoài → ghi giới hạn đã biết; kiểm từ nhiều điểm: DEFERRED.
- Panel gọi ra ngoài (SMTP/Telegram/webhook) mở rộng bề mặt tấn công → SSRF guard, chỉ SA cấu hình, không theo redirect, có review bảo mật riêng.
- Bão cảnh báo khi một server sập kéo theo hàng loạt rule → gộp theo server (cảnh báo con bị ẩn khi server mất kết nối), giới hạn tần suất kênh.
- Container không có cgroup v2 và SMTP thật → kiểm chứng trên VM (M0, M4).
