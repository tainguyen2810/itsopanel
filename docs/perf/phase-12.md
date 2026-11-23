# Hiệu năng Phase 12: 200 account/server (Prompt 12.5, D-112, ADR 0057)

Đo ngày 2026-11-23 trong container cloud (4 vCPU, PostgreSQL 16.15, PHP 8.3.6 CLI, không opcache JIT, Redis thật, cache
`array`). Số liệu là thời gian xử lý trong panel qua HTTP kernel nội bộ (không mạng, không Caddy/PHP-FPM), nên trên máy
thật cần cộng thêm độ trễ mạng và FPM (thường vài ms).

## Cách chạy lại

```bash
cd apps/api
# DB riêng cho đo (không dùng DB dev/test): đặt DB_DATABASE=itso_perf, APP_ENV=local
php artisan migrate:fresh --force
php artisan db:seed --class=PerfSeeder --force     # ~32 s
php artisan itso:bench --n=30                      # bảng Markdown; --json để lấy JSON; mã thoát ≠ 0 nếu trượt mục tiêu
```

Dữ liệu `PerfSeeder` (chỉ chạy ở local/testing): 1 server, 200 account × 3 website (+ domain) × 2 DB, 50 USER chủ,
7 ngày metrics (6 metric server mỗi phút, 6 metric account mỗi 5 phút: ≈ 2,5 triệu dòng `metric_samples` + rollup giờ),
10 000 job, 100 000 audit (đi qua trigger chuỗi hash thật).

## Mục tiêu (D-112)

| Phép đo | Mục tiêu |
|---|---|
| API danh sách | p95 ≤ 300 ms |
| API chi tiết | p95 ≤ 200 ms |
| `itso:alerts-evaluate` | ≤ 10 s/lượt |
| Insert `metric_samples` của 200 account | ≤ 5 s/phút |

## Trước khi sửa (cùng dữ liệu, mã Prompt 12.4, `--n=20`)

| Phép đo | HTTP | SQL/lượt | p50 ms | p95 ms | max ms | Mục tiêu p95 | Đạt |
|---|---|---|---|---|---|---|---|
| GET /api/v1/admin/hosting-accounts?limit=50 | 200 | 656 | 570.5 | 703.0 | 727.1 | ≤ 300 | ✗ |
| GET /api/v1/admin/hosting-accounts?limit=50&q=perf1 | 200 | 656 | 579.1 | 681.6 | 717.9 | ≤ 300 | ✗ |
| GET /api/v1/admin/websites?limit=50 | 200 | 59 | 46.2 | 69.7 | 75.0 | ≤ 300 | ✓ |
| GET /api/v1/admin/databases?limit=50 | 200 | 156 | 95.7 | 124.0 | 124.5 | ≤ 300 | ✓ |
| GET /api/v1/admin/jobs?limit=50 | 200 | 206 | 146.0 | 213.4 | 224.9 | ≤ 300 | ✓ |
| GET /api/v1/admin/audit-logs?limit=50 | 500 | 8 | 12.5 | 16.3 | 16.7 | ≤ 300 | ✓ |
| GET /api/v1/admin/users?limit=50 | 200 | 57 | 45.5 | 51.1 | 55.9 | ≤ 300 | ✓ |
| GET /api/v1/admin/servers | 200 | 8 | 7.0 | 8.3 | 8.5 | ≤ 300 | ✓ |
| GET /api/v1/admin/metrics/servers/{id}/accounts | 200 | 208 | 143.6 | 176.9 | 177.8 | ≤ 300 | ✓ |
| GET /api/v1/admin/dashboard/summary | 200 | 14 | 10.1 | 12.5 | 13.5 | ≤ 200 | ✓ |
| GET /api/v1/admin/hosting-accounts/{id} | 200 | 19 | 16.7 | 19.6 | 20.0 | ≤ 200 | ✓ |
| GET /api/v1/admin/websites/{id} | 200 | 10 | 8.0 | 10.0 | 10.6 | ≤ 200 | ✓ |
| GET /api/v1/admin/jobs/{id} | 200 | 10 | 7.3 | 8.6 | 9.7 | ≤ 200 | ✓ |
| GET /api/v1/admin/servers/{id} | 200 | 8 | 7.2 | 11.3 | 12.6 | ≤ 200 | ✓ |
| GET /api/v1/admin/metrics/servers/{id}?range=24h&metric=cpu_pct | 200 | 7 | 30.6 | 33.8 | 33.8 | ≤ 200 | ✓ |
| GET /api/v1/admin/metrics/servers/{id}?range=7d&metric=cpu_pct | 200 | 7 | 9.4 | 9.8 | 9.9 | ≤ 200 | ✓ |
| GET /api/v1/admin/metrics/hosting-accounts/{id}?range=24h&metric=cpu_pct | 200 | 8 | 10.4 | 11.8 | 12.1 | ≤ 200 | ✓ |
| itso:alerts-evaluate (1 lượt) | - | 0 | 38.7 | 42.9 | 42.9 | ≤ 10000 | ✓ |
| insert metric_samples 200 account × 7 metric | - | 200 | 118.0 | 133.5 | 133.5 | ≤ 5000 | ✓ |

Danh sách `hosting-accounts` trượt mục tiêu (p95 ≈ 700 ms, **656 truy vấn SQL/trang**). `audit-logs` trả 500 khi
`resource_type` không phải tên bảng (dữ liệu tổng hợp ghi `hosting_account`), nên số đo của nó không có nghĩa.

## Sau khi sửa (`--n=30`)

| Phép đo | HTTP | SQL/lượt | p50 ms | p95 ms | max ms | Mục tiêu p95 | Đạt |
|---|---|---|---|---|---|---|---|
| GET /api/v1/admin/hosting-accounts?limit=50 | 200 | 15 | 24.9 | 34.3 | 35.2 | ≤ 300 | ✓ |
| GET /api/v1/admin/hosting-accounts?limit=50&q=perf1 | 200 | 15 | 23.8 | 34.0 | 36.6 | ≤ 300 | ✓ |
| GET /api/v1/admin/websites?limit=50 | 200 | 9 | 14.4 | 16.9 | 17.4 | ≤ 300 | ✓ |
| GET /api/v1/admin/databases?limit=50 | 200 | 9 | 14.8 | 18.9 | 19.1 | ≤ 300 | ✓ |
| GET /api/v1/admin/jobs?limit=50 | 200 | 10 | 22.6 | 44.6 | 46.0 | ≤ 300 | ✓ |
| GET /api/v1/admin/audit-logs?limit=50 | 200 | 10 | 19.5 | 35.1 | 39.2 | ≤ 300 | ✓ |
| GET /api/v1/admin/users?limit=50 | 200 | 8 | 14.6 | 16.9 | 21.2 | ≤ 300 | ✓ |
| GET /api/v1/admin/servers | 200 | 8 | 8.6 | 11.4 | 11.4 | ≤ 300 | ✓ |
| GET /api/v1/admin/metrics/servers/{id}/accounts | 200 | 9 | 50.3 | 61.3 | 61.7 | ≤ 300 | ✓ |
| GET /api/v1/admin/dashboard/summary | 200 | 14 | 9.1 | 11.4 | 11.4 | ≤ 200 | ✓ |
| GET /api/v1/admin/hosting-accounts/{id} | 200 | 15 | 11.2 | 13.4 | 16.4 | ≤ 200 | ✓ |
| GET /api/v1/admin/websites/{id} | 200 | 10 | 9.6 | 11.4 | 11.9 | ≤ 200 | ✓ |
| GET /api/v1/admin/jobs/{id} | 200 | 10 | 7.4 | 9.1 | 10.2 | ≤ 200 | ✓ |
| GET /api/v1/admin/servers/{id} | 200 | 8 | 7.8 | 10.0 | 10.0 | ≤ 200 | ✓ |
| GET /api/v1/admin/metrics/servers/{id}?range=24h&metric=cpu_pct | 200 | 7 | 25.1 | 35.6 | 37.9 | ≤ 200 | ✓ |
| GET /api/v1/admin/metrics/servers/{id}?range=7d&metric=cpu_pct | 200 | 7 | 8.2 | 12.0 | 12.1 | ≤ 200 | ✓ |
| GET /api/v1/admin/metrics/hosting-accounts/{id}?range=24h&metric=cpu_pct | 200 | 8 | 11.9 | 14.8 | 15.0 | ≤ 200 | ✓ |
| itso:alerts-evaluate (1 lượt) | - | 0 | 37.7 | 42.1 | 42.1 | ≤ 10000 | ✓ |
| insert metric_samples 200 account × 7 metric | - | 200 | 82.2 | 85.7 | 85.7 | ≤ 5000 | ✓ |

**Mọi phép đo đạt mục tiêu.** Số truy vấn mỗi trang không còn tăng theo số dòng.

## Điểm nóng đã sửa

| # | Điểm nóng | Nguyên nhân | Sửa | Kết quả |
|---|---|---|---|---|
| 1 | Ghi audit chậm dần theo kích thước bảng | Trigger `itso_audit_hash` tìm cuối chuỗi bằng `ORDER BY at DESC, id DESC LIMIT 1` cho mỗi dòng chèn, nhưng chỉ có PK `(id, at)` → quét toàn bộ partition | Chỉ mục `audit_logs (at, id)` (đặc tả `gen_dbml.py` + migration `2026_11_23_000002_audit_logs_chain_index` cho DB cũ) | 200 audit ở 100 000 dòng: **3 657 ms → 5,7 ms**; seed 100 000 audit: kẹt > 7 phút (đã hủy) → cả seed 31 s |
| 2 | `GET /admin/hosting-accounts` 656 truy vấn/50 dòng | Mỗi dòng: gói, phiên bản gói, server, chủ, và `QuotaService::usage` (đếm website/DB/domain/email/FTP/cron + snapshot disk + CPU) | `HostingPresenter::prefetch` + `QuotaService::prefetchUsage` (đếm `GROUP BY`, snapshot bằng `DISTINCT ON`) | 15 truy vấn, p95 703 → 34 ms |
| 3 | `GET /admin/jobs` 206 truy vấn | Bước, server, người yêu cầu, tài nguyên theo từng job | `JobPresenter::prefetch` | 10 truy vấn, p95 213 → 45 ms |
| 4 | `GET /admin/databases` 156 truy vấn | Account, server, grant theo từng DB | `DataPresenter::prefetch` | 9 truy vấn, p95 124 → 19 ms |
| 5 | `GET /admin/websites` 59 truy vấn | Đếm domain theo từng site | `withCount('domains')` | 9 truy vấn, p95 70 → 17 ms |
| 6 | `GET /admin/audit-logs` | Người dùng, server, job, tài nguyên theo từng dòng; `DB::table(resource_type)` lỗi khi `resource_type` số ít | `prefetch` + tra bảng thật qua model (`JobPresenter::RESOURCE_MODELS`) | 10 truy vấn, không còn 500 |
| 7 | `GET /admin/users` 57 truy vấn | Trạng thái MFA theo từng user | `UserPresenter::prefetch` | 8 truy vấn, p95 51 → 17 ms |
| 8 | `GET /admin/metrics/servers/{id}/accounts` 208 truy vấn | `QuotaService::limits` nạp phiên bản gói cho từng account | Nạp phiên bản gói một lần | 9 truy vấn, p95 177 → 61 ms |

`Listing::page` có thêm tham số `prefetch` (nhận cả trang model trước khi trình bày; nếu trả closure thì gọi sau để dọn).
Phân trang: các danh sách đã dùng cursor/offset có giới hạn từ trước (`limit` ≤ 100), không cần đổi.

## Chặn hồi quy

`tests/Feature/Phase12/QueryCountTest.php`: 10 trang danh sách chính (Admin + Portal), so số truy vấn ở `limit=5` và
`limit=40` trên 45 account (mỗi account một chủ, website, domain, DB, job, audit); chênh quá 3 là trượt. Chạy với mã
12.4 (đã thử bằng `git stash`), test trượt đúng 6 trang #2–#7 (ví dụ `hosting-accounts` 77 → 528 truy vấn). Trang #8
tính cho mọi account rồi mới cắt trang nên số truy vấn không đổi theo `limit`; nó được theo dõi bằng cột SQL/lượt của
`itso:bench` (208 → 9).

## Giới hạn của phép đo

- Không đo qua Caddy + PHP-FPM + mạng; không đo đồng thời nhiều người dùng. Đo tải song song trên VM thật để ở bài Gate
  (`tests/vm/gate.sh`, Prompt 12.8).
- Một server; tải đa server (Phase 9) chưa đo ở quy mô này.
- `itso:alerts-evaluate` nhanh (≈ 40 ms) vì dữ liệu tổng hợp không kích hoạt nhiều cảnh báo; trường hợp nhiều cảnh báo
  cùng mở sẽ thêm ghi `alert_events` + thông báo, vẫn còn xa ngưỡng 10 s.
