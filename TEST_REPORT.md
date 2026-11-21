# TEST_REPORT — ITSO Panel

> Cập nhật cuối mỗi prompt và cuối mỗi Phase. Ghi lệnh chạy thật và kết quả thật.

## 2026-11-21 — Phase 4 / Prompt 4.3 — nhánh `phase-4`

Môi trường: như 4.1. Op thật chạy với runner giả `ops.Sim` trên gốc FS tạm (`/etc/passwd|group|shadow`, `/home`) và `/proc`, `/sys` giả; không lệnh nào chạy trên máy.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go toàn bộ (race) | `cd agent && go test -race -count=1 ./...` | PASS: 11 package |
| Op thật | `go test ./internal/ops -v` | PASS 10 test: golden argv cho 15 op (`testdata/golden/*.argv`) + 3 drop-in slice; lần 2 cùng tham số không có lệnh ghi (account.ensure, limits.apply, suspend, unsuspend, quota.apply, hostname.set, service.control, software.install/remove); quyền/chủ home đúng 07 §5; soft quota đo được file 3 MB; system.info/metrics đọc đúng /proc, cgroup (throttled, memory.max, oom_kill, pids); lệnh lỗi → `internal` / `dependency_unavailable` (retryable) / `precondition_failed`; op.cancel hủy op đang chạy → `cancelled` |
| Vector độc | `TestEvilInputsRejectedBeforeAnyCommand` | PASS: gọi thẳng handler (bỏ qua schema) với mọi vector reject của username/hostname/service_name/recipe + uid 0, home `..`, shell lạ → từ chối, **0 lệnh** được chạy |
| Contract dùng chung | `internal/contracttest` từ `internal/mock` và `internal/ops` | PASS cả hai: vòng đời account, idempotent, mã lỗi already_exists/not_found/precondition_failed/path_outside_home; ví dụ `valid-06-account.ensure.json` chạy qua agent thật |
| Drop-in slice | `systemd-analyze verify itso-acct-20001.slice user-20001.slice` (nội dung golden) | PASS, không cảnh báo. Kiểm đối chứng: `Slice=` trong unit `.slice` bị báo "Failed to assign slice" → sửa ADR 0011/D-64/07 §3 (cha suy ra từ tên). Ghi chú: báo cáo 4.1 ghi PASS cho mẫu cũ vì `verify` trả mã 0 cả khi có cảnh báo; từ nay đọc cả output |
| Contracts | `make contracts-check` · `make codegen-check` | PASS (sửa `ts` trong ví dụ envelope cho khớp `deadline`: 2026-11-20 01:15Z thay vì 11-26) |
| Laravel | `make test-api` | PASS: 294 test (không đổi) |
| Lint / no-exec / docs | `make lint-agent` · `make no-exec` · `make docs-check` · `make structure` | PASS |
| Smoke binary | `itso-agent --sandbox` không có `--root` | Từ chối đúng ("sandbox cần --root là thư mục riêng") |

**Test bị bỏ qua:** không. Chưa kiểm trên hệ thống thật: useradd/setquota/setfacl/systemctl thật (chờ VM, `tests/vm/` ở 4.6).

## 2026-11-21 — Phase 4 / Prompt 4.2 — nhánh `phase-4`

Môi trường: như 4.1 (PostgreSQL 16 + Redis cục bộ cho Pest).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go toàn bộ (race) | `cd agent && go test -race ./...` | PASS: 10 package |
| Xác thực | `go test ./internal/auth` | PASS: chữ ký đúng; sai body/khóa/path, lệch giờ 120 s, thiếu chữ ký, nonce ngắn → từ chối; nonce lặp → từ chối; khóa others đọc được/ngắn/symlink → từ chối; SO_PEERCRED trả đúng uid/pid; allowlist; vector chữ ký chung với PHP |
| Handler có xác thực | `go test ./internal/server` | PASS: qua socket Unix thật — ký đúng → ok; không ký → `unauthorized_caller`; op bị policy tắt → `op_disabled`; op lạ → lỗi; uid ngoài allowlist → `unauthorized_caller`; audit ghi 4 bản ghi đúng kết quả + uid caller, chuỗi hợp lệ |
| Policy | `go test ./internal/policy` | PASS: mặc định theo catalog (docker/backup.forget tắt), ghi đè op, cờ docker thắng ops, op/khóa lạ, sai version → từ chối; strict: quyền 0644 hoặc chủ không phải root → từ chối; lưu 0600 |
| Audit cục bộ | `go test ./internal/audit` | PASS: chuỗi nối tiếp qua lần mở lại; sửa một dòng hoặc xóa dòng giữa → phát hiện, không ghi tiếp |
| Lớp nền tảng | `go test ./internal/platform` | PASS: bảng lệnh không có sh/bash/env/sudo…, đường dẫn tuyệt đối; argv có NUL/xuống dòng → từ chối; FakeRunner; ExecRunner chỉ chạy lệnh chỉ-đọc `findmnt`; FS: đường dẫn tương đối/chưa chuẩn hóa → từ chối, ghi atomic idempotent, symlink → từ chối ghi/đọc/EnsureDir |
| Validator + vector evil | `go test ./internal/validate` | PASS: mọi vector username/hostname/service/recipe đúng expect (kể cả layer semantic) |
| Fuzz | `go test -fuzz=FuzzUsername/FuzzHostname -fuzztime=10s` | PASS (thêm vào `make test-fuzz`) |
| Laravel | `make test-api` · `make lint-api` | PASS: 294 test (thêm 2: vector chữ ký, header khớp body đã gửi + khóa ngắn → AgentUnavailable); pint, phpstan |
| No-exec | `make no-exec` | PASS (os/exec chỉ trong `agent/internal/platform`) |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 4 / Prompt 4.1 — nhánh `phase-4`

Môi trường: container cloud Ubuntu 24.04, kernel 6.18, **không có** cgroup v2 (`/sys/fs/cgroup` là tmpfs), systemd không phải PID 1, không có `setquota`/`repquota`/`setfacl`; có `systemd-analyze` (verify offline).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: agent-ops 67 op có schema (thêm 6), 21 op khai báo; evil-inputs 112 vector (thêm 19); ajv examples hợp lệ/không hợp lệ |
| Go | `cd agent && go vet ./... && go test ./...` | PASS (mock `system.info` trả đủ trường mới, khớp schema) |
| Kiểm cú pháp slice mẫu | `systemd-analyze verify itso-acct-20001.slice` | PASS (không cảnh báo) |
| Docs | `make docs-check` | PASS |

**Test bị bỏ qua:** không. Test cần VM (slice, quota thật) ghi trong ADR 0011/0012 và chạy ở 4.6 bằng `tests/vm/`.

Ghi chú: `account.remove` giữ ở Phase 8 (cần backup cuối hợp lệ theo D-46), không đưa vào Phase 4.

## 2026-11-20 — Phase 3 / Prompt 3.6 — nhánh `phase-3`

Môi trường: như 3.4; stack thật chạy bằng `make dev` (Vite 5173, Laravel 8000, mock agent, queue worker), DB `itso` đã `migrate:fresh --seed` + `DemoSeeder`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| E2E stack thật | `make test-e2e-real` | PASS: 4/4 — Admin đăng nhập MFA (mã sai bị từ chối, chưa xác minh bị đưa về MFA); tạo user portal → gói → account qua wizard → job mock agent → Hoạt động → tạm khóa → mở khóa; Portal chỉ thấy `anphat`, `oldshop`, account người khác 404 (API + URL); sai realm 401 và user portal không vào được Admin |
| Endpoint còn thiếu test | `php artisan test tests/Feature/Platform` | PASS: 20 test (mới: 501 purge/migrate, gợi ý đặt account, đánh dấu đọc thông báo Admin, sự kiện + chạy lại job Portal) |
| DemoSeeder | `php artisan test tests/Feature/Demo/DemoSeederTest.php` | PASS |
| Toàn bộ | `make check` | 20 PASS · 1 SKIP (staticcheck) · 0 FAIL; Pest 292 (2095 assertion), Vitest 457, Playwright 259, db-verify 41, fuzz 240.425 lần, git-clean PASS |

Lần chạy `make check` đầu: FAIL ở docs-check (URL/email trần trong runbook), test-e2e (21 test shell bị đưa về đăng nhập vì build thường dùng phiên thật), test-api (1 test còn kỳ vọng `type` `not_found` cho route không tồn tại), git-clean (sửa file trong lúc chạy). Đã sửa runbook, thêm giả lập `/auth/me` vào fixture e2e, cập nhật kỳ vọng test theo hành vi mới; lần 2 xanh hết.

Coverage: không có pcov/xdebug, build pcov trong container bị chặn → thay bằng đối chiếu route (87/87 route có test gọi tới), chi tiết ở `docs/reports/phase-3.md` §6.

**Test bị bỏ qua:** không.

### Acceptance Prompt 3.6

- ✓ Client gửi CSRF, xử lý 401/419; phiên thật thay persona ở build thường
- ✓ DemoSeeder (mật khẩu dev, SA dùng secret TOTP dev), `make dev` chạy web + api + queue + mock agent
- ✓ Module Phase sau hiện "Chưa có ở bản này"
- ✓ Playwright trên stack thật; `make check` xanh; báo cáo `docs/reports/phase-3.md`; runbook `docs/runbooks/phase-3-demo.md`

## 2026-11-20 — Phase 3 / Prompt 3.5 — nhánh `phase-3`

Môi trường: như 3.4.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS (thêm response `NotImplemented` 501 và 2 mã lỗi; admin 220 / portal 103 operation) |
| Gói + account + Portal | `php artisan test tests/Feature/Hosting/HostingTest.php` | PASS: 25 test — gói tạo/409/422/412, sửa limits → phiên bản 2, phiên bản bị DB chặn sửa, xóa còn account → 409; tạo account qua job với agent giả → `active` (op `account.ensure` + `quota.apply`, home `/home/<user>`, shell theo `ssh_allowed`, override áp vào limits), username trùng 409, sai/tên hệ thống 422, server ngoài phạm vi / không nhận account 422; agent lỗi → `failed` → retry → `active`; suspend/unsuspend/terminate/khôi phục, quá hạn giữ 409, chuyển sai 409, 501 cho purge/migrate, account bận 409 `resource_locked`, terminate thiếu quyền 403; bảng chuyển trạng thái (15 ca); đổi gói / giảm override dưới mức dùng → 422 `quota_exceeded`, migrate-accounts qua job; `ensureCanAdd`; UID không tái dùng trong 90 ngày; Portal chỉ account của mình (404 với account người khác), overview, profile (ETag), USER gọi Admin API → 401; `itso:usage-refresh` |
| Ma trận quyền | `php artisan test tests/Feature/Rbac/MatrixTest.php` | PASS: 169 test — admin 37 endpoint × 4 nhân vật; Portal 10 endpoint × chủ / USER khác (USER khác → 404 với account, job của người khác) |
| Pest toàn bộ | `make test-api` | PASS: 287 test, 1991 assertion |
| Lint | `make lint-api` · `make no-exec` | PASS |

**Test bị bỏ qua:** không.

Ghi chú:

- `account_usage_snapshots` thuộc Phase 4 nên mức dùng Phase 3 lưu ở `hosting_accounts.observed_facts.usage` (lệnh `itso:usage-refresh`); `QuotaService` tự dùng bảng snapshot khi có.
- Bảng website/database/FTP/cron có từ Phase 5–6: số đếm hiện bằng 0, `QuotaService` tự đếm khi bảng xuất hiện.
- Step `php.pool.apply` trong ví dụ contract của job tạo account chưa có trong mock (Phase 5 PHP-FPM), job Phase 3 gồm `account.ensure` + `quota.apply`.

### Acceptance Prompt 3.5

- ✓ /hosting-packages CRUD, phiên bản bất biến, /versions, migrate-accounts qua job
- ✓ Provisioning: tạo (username, server, UID 90 ngày, job), suspend có lý do, unsuspend, terminate (≥30 ngày, legal hold), khôi phục trong thời gian giữ, đổi gói; lifecycle events
- ✓ /features, /usage, /lifecycle-events; QuotaService 422 `quota_exceeded`
- ✓ API Portal: hosting-accounts, overview, profile, jobs, notifications
- ✓ Purge/migrate trả 501 có mã rõ ràng

## 2026-11-20 — Phase 3 / Prompt 3.4 — nhánh `phase-3`

Môi trường: như 3.1 (PostgreSQL 16 local, Redis; queue `sync` trong Pest, agent giả bằng `Http::fake` — `tests/Support/FakeAgent.php`).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Agent mock | `cd agent && go test ./...` · `make lint-agent` · `make no-exec` | PASS — `accounts_test.go`: vòng đời ensure → quota.apply → suspend → unsuspend → remove, quota.report; params sai schema / home ngoài `/home/<user>` / shell ngoài enum → `invalid_params` / `path_outside_home` |
| Job | `php artisan test tests/Feature/Platform/JobsTest.php` | PASS: 8 test — thành công (op_id `uuid:seq:1`, requested_by, tiến độ 100, audit `job.create`); lỗi tạm thời tự thử lại với op_id mới; hết lượt → failed; agent không kết nối = lỗi tạm thời; lỗi không thử lại → failed + thông báo; retry qua API cần Idempotency-Key, không chạy lại bước đã xong, replay trả response cũ + `Idempotent-Replayed`, cùng key khác request → 409; cancel queued / running (dừng trước bước kế), cancel lần hai 409; timeout → `timed_out`; phạm vi (ADMIN ngoài phạm vi, USER khác → 404); mọi endpoint admin/portal khớp OpenAPI |
| Audit, thông báo, cài đặt, server, dashboard | `php artisan test tests/Feature/Platform/PlatformApiTest.php` | PASS: 8 test — UPDATE/DELETE audit bị DB chặn, chuỗi hash hợp lệ, sửa trực tiếp (bỏ trigger) bị `itso:audit-verify` phát hiện; lọc `prefix.*`, phạm vi ADMIN, CSV thêm `'` trước `= + - @`; 403 khi ghi → audit `denied`; thông báo chỉ của chính user, đọc một/đọc hết; cài đặt không trả secret (lưu mã hóa, không vào audit), 412, 422, 403 cho ADMIN, step-up hết hạn → 403; server local + `itso:server-local` (agent giả), phạm vi ADMIN, ETag/412, 409 trùng tên, agent mất liên lạc → `agent_connected=false` / `degraded`; dashboard theo phạm vi |
| Ma trận quyền | `php artisan test tests/Feature/Rbac/MatrixTest.php` | PASS: 113 test — thêm 11 endpoint 3.4 × 4 nhân vật |
| Contracts | `make contracts-check` · `make codegen-check` | PASS (không đổi contract) |
| Pest toàn bộ | `make test-api` | PASS: 206 test, 1496 assertion |
| Lint | `make lint-api` (pint + Larastan) · `make lint-agent` · `make no-exec` | PASS |

**Test bị bỏ qua:** không.

Ghi chú:

- Helper `tests/Support/OpenApi.php`: YAML `{}` (schema rỗng) được parse thành mảng PHP rỗng; nay đổi thành `true` để validate được `SettingsGroup`/`DashboardSummary.counts`.
- `make no-exec` báo nhầm chuỗi `"/bin/sh"` trong test Go (giá trị shell sai để kiểm validate); đổi sang `/usr/bin/zsh`, không nới luật kiểm.
- Idempotency-Key dùng lại với request khác trả 409 `idempotency_key_reused` theo contract (prompt ghi 422). `/jobs/{id}/events` trả một bản chụp SSE (contract không có tham số `after`); luồng liên tục qua gateway ở Phase 11.

### Acceptance Prompt 3.4

- ✓ JobRunner nhiều bước, retry/cancel/timeout, job_logs; mock agent op account/quota theo schema
- ✓ /jobs admin + portal (portal chỉ job của account mình); Idempotency-Key
- ✓ Audit append-only + hash chain + CSV chống chèn công thức; audit `denied`
- ✓ Thông báo in-app; /settings/{group} chỉ SA, không trả secret
- ✓ /servers (server local seed từ cấu hình), /dashboard/summary

## 2026-11-20 — Phase 3 / Prompt 3.3 — nhánh `phase-3`

Môi trường: như 3.1.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS (portal thêm `POST /auth/impersonation:accept`, `POST /auth/impersonation:end`; admin 220 / portal 103 operation) |
| Ma trận quyền | `php artisan test tests/Feature/Rbac/MatrixTest.php` | PASS: 69 test — 17 endpoint × 4 nhân vật (SA, ADMIN trong phạm vi, ADMIN ngoài phạm vi, USER) + danh sách theo phạm vi. Ngoài phạm vi → 404, thiếu quyền → 403, USER gọi Admin API → 401 (GET) / 419 (ghi, không có phiên admin nên chặn ở CSRF) |
| Users API | `php artisan test tests/Feature/Rbac/UsersApiTest.php` | PASS: 12 test — mọi endpoint users/roles/api-tokens khớp OpenAPI (200/201/204/404/409/412/422); token tạo qua API dùng được đúng scope; mời user 72 giờ; ≥1 SUPER_ADMIN; ETag/If-Match; khóa thu hồi phiên, mở khóa xóa bộ đếm, reset MFA; step-up hết hạn; gán phạm vi; giả danh (vé một lần, hết hạn 60 giây / 30 phút, chặn đổi mật khẩu/MFA, audit kèm người giả danh); audit che secret + hash chain; cursor + sort sai 422 |
| Pest toàn bộ | `make test-api` | PASS: 146 test, 983 assertion |
| Lint | `make lint-api` · `make docs-check` · web `tsc -b` | PASS (Larastan 0 lỗi) |

**Test bị bỏ qua:** không.

Ghi chú: Policies hiện thực bằng `App\Auth\Access` (truy vấn có phạm vi dùng chung cho list và chi tiết) + middleware `itso.perm`; model của 3.4/3.5 (job, audit, account, gói) dùng cùng lớp này khi có endpoint.

### Acceptance Prompt 3.3

- ✓ Seed vai trò/quyền, phạm vi ADMIN, USER chỉ thấy của mình (`Access::accounts`)
- ✓ /users (lọc, tạo, sửa, khóa/mở, reset MFA, scopes), /roles, API token
- ✓ Giả danh chỉ SA, có lý do, chỉ USER Portal đang hoạt động, impersonation_sessions, audit
- ✓ Luôn còn ít nhất một SUPER_ADMIN; ADMIN chỉ quản lý USER Portal trong phạm vi
- ✓ Ma trận quyền tự động

## 2026-11-20 — Phase 3 / Prompt 3.2 — nhánh `phase-3`

Môi trường: như 3.1 (PostgreSQL 16 + Redis 7 cục bộ).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS (thêm header `X-ITSO-Realm`, scheme `adminSession`/`portalSession`) |
| TOTP | `php artisan test tests/Unit/Auth` | PASS: 10 test — 6 vector RFC 6238 (SHA-1, 8 số), 10 vector HOTP RFC 4226, base32, cửa sổ ±1 bước, otpauth URI |
| Auth (Feature) | `php artisan test tests/Feature/Auth` | PASS: 32 test. Mọi endpoint `/auth/*` kiểm response theo schema OpenAPI (200/204/401/409/422/429). Khóa sau 5 lần sai (429 + Retry-After, khóa tăng 1 → 2 phút, đúng mật khẩu xóa bộ đếm), khóa theo IP; sai realm = sai mật khẩu; CSRF thiếu/sai → 419 `csrf_mismatch` (cả khi đã đăng nhập); phiên admin không gọi được API portal và ngược lại (kể cả đổi tên cookie, đổi header realm); realm theo host; MFA enroll/confirm/verify, chặn dùng lại mã, mã khôi phục một lần, 429 sau 5 lần sai; SA chưa bật MFA bị chặn; step-up hết hạn sau 10 phút; danh sách/thu hồi phiên; đổi/quên/đặt lại mật khẩu (token một lần, hết hạn 60 phút); IP allowlist; API token (sai, hết hạn, CIDR, scope, user portal/khóa) |
| Pest toàn bộ | `make test-api` | PASS: 65 test, 431 assertion |
| Thử thật qua HTTP | `php artisan serve` + `curl` (csrf → login SA → me → admin/system/version) | PASS: cookie `XSRF-TOKEN-ADMIN`, `itso_admin_session` mã hóa; SA chưa bật MFA nhận `403 mfa_required` |
| Lint | `make lint-api` · `make docs-check` · `make structure` | PASS (Pint, Larastan 0 lỗi) |

**Test bị bỏ qua:** không.

Phát hiện và sửa trong lúc test:

- `ResolveRealm` (đặt tên cookie phiên theo realm) bị Laravel xếp sau `StartSession` theo middleware priority → request admin ngay sau một request portal đọc nhầm cookie portal. Thêm `ResolveRealm` vào priority trước `EncryptCookies`; test "phiên admin và portal xen kẽ" bắt được lỗi này.
- Test giả lập trình duyệt (`tests/Support/Spa.php`) dựng lại session store và guard mỗi request để không dùng trạng thái session trong bộ nhớ của test.

### Acceptance Prompt 3.2

- ✓ Đăng nhập theo realm, khóa lũy tiến, argon2id, logout, me
- ✓ MFA TOTP + mã khôi phục, SUPER_ADMIN bắt buộc MFA, step-up
- ✓ Phiên (liệt kê, thu hồi), đổi/quên/đặt lại mật khẩu
- ✓ IP allowlist realm admin, guard API token
- ✓ Pest khớp OpenAPI; vector RFC 6238; khóa sau N lần sai; tách realm; CSRF 419

## 2026-11-20 — Phase 3 / Prompt 3.1 — nhánh `phase-3`

Môi trường: PHP 8.3.6, Laravel 13, Pest 4; PostgreSQL 16 (cluster tạm `initdb`, database `itso` và `itso_test`) + Redis 7 chạy cục bộ.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Đặc tả DB + migration | `make db-verify` | PASS: 41 test SQL; `2026_11_20_000003_phase_3_schema.php` khớp đặc tả; áp lần lượt SQL Phase 3 → 11 vào DB rỗng cho `pg_dump --schema-only` giống hệt itso.sql + extras.sql. Đã thử cả chế độ `DB_VERIFY_URL` (như CI) |
| Pest | `make test-api` | PASS: 23 test (9 test schema mới + 14 cũ) — đủ 26 bảng Phase 3, partition mặc định audit; 3 vai trò đúng realm, CHECK chặn vai trò lạ; uuid do DB sinh có ngay sau create; realm bất biến; vai trò khác realm bị chặn; email citext duy nhất; chủ account phải là USER portal, username/UID sai bị chặn, terminated thiếu purge_after bị chặn; phiên bản gói bất biến, retention < 30 ngày bị chặn, cột `text[]` đọc/ghi đúng; audit append-only và chuỗi hash nối tiếp; lịch sử vòng đời append-only; job sai trạng thái/tiến độ bị chặn |
| Migrate thật | `php artisan migrate:fresh --seed`, `migrate:rollback`, `migrate` (DB `itso`) | PASS |
| Lint | `make lint-api` · `make docs-check` · `make structure` · `python3 scripts/check-ci.py` | PASS (Larastan 0 lỗi) |

**Test bị bỏ qua:** không.

### Acceptance Prompt 3.1

- ✓ Migrations 26 bảng Phase 3 + phần extras.sql tương ứng (purge guard để Phase 8 vì cần `purge_records`)
- ✓ Model, cast, factory; Pest chạy trên PostgreSQL 16 (D-59)
- ✓ So khớp schema migrate với đặc tả; test trigger/CHECK

## 2026-11-20 — Phase 2 / Prompt 2.8 — nhánh `phase-2` (kiểm tra tổng)

Môi trường: như 2.1; PostgreSQL 16 (cluster tạm `initdb`) và Redis 7 chạy cục bộ cho `test-api-pg`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Số liệu nhất quán | `npx vitest run src/demo/__tests__/consistency.test.ts` | PASS: 5 test — dashboard = tổng danh sách (server, account đang sống, website, database, user, gói, phân bổ gói); số account theo server; usage website/DB/SFTP/cron = danh sách; Portal và Admin cùng usage, số thông báo chưa đọc khớp; tạo website ở Portal → usage, dashboard, danh sách cùng tăng |
| Kiểm tra mọi route | `npx playwright test e2e/demo-audit.spec.ts` | PASS: 74 route (56 Admin + 18 Portal, bỏ 2 route chuyển hướng) — axe light + dark 0 critical/serious, không tràn ngang 390px, giao diện EN không lẫn tiếng Việt (trừ dataset, nội dung API trả về, tên "Tiếng Việt"). Lần đầu 59/74: sửa 5 lỗi a11y (xem dưới) và bộ lọc dữ liệu API trong test |
| Ảnh trang chính | `make screenshots` | PASS: 56 ảnh `docs/screenshots/phase-2/` (14 trang × 1440/390 × light/dark) + Design System; cả bộ Playwright 259 test |
| Toàn bộ | `make check` | Lần đầu 19 PASS · 1 SKIP · 2 FAIL: `docs-check` (dấu gạch đứng trong code span ở bảng TEST_REPORT) và `test-api-pg` (cluster tạm chưa có database `itso_test`). Sửa và chạy lại riêng hai bước: `make docs-check` PASS, `make test-api-pg` PASS 14/14. Còn lại: Vitest 457, Playwright 259, db-verify 41, fuzz 212.940 lần, git-clean PASS |
| Bản demo tĩnh | `python3 -m http.server` trên `apps/web/dist-demo` + script Playwright | PASS: `/admin/` và `/portal/` hiện H1, điều hướng sidebar tới Website thấy dữ liệu giả lập, không lỗi trang |

Phát hiện và sửa:

- Bộ lọc Thông báo dùng tab không có panel (`aria-controls` trỏ tới phần tử không tồn tại) → nhóm nút bật/tắt `aria-pressed`.
- Nút "Đã đọc" và link trạng thái ở danh sách Khôi phục có `aria-label` không chứa chữ hiển thị → chữ bổ sung `sr-only`.
- Link "Quên mật khẩu" (đăng nhập Portal) thiếu tương phản ở dark, link "Quay lại đăng nhập" vùng bấm < 24px → `text-primary-text`, `min-h-6`.

**Test bị bỏ qua:** không. `staticcheck` SKIP vì chưa cài được (như Phase 1).

### Acceptance Prompt 2.8 / Phase 2

- ✓ Mọi mục sidebar mở trang có nội dung thật
- ✓ VI/EN không chuỗi cứng; dark/light đúng; không tràn ngang 390px
- ✓ Số liệu nhất quán giữa các trang
- ✓ Screenshot trong repo; bản demo tĩnh build được; báo cáo `docs/reports/phase-2.md`

## 2026-11-20 — Phase 2 / Prompt 2.7 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: thêm `AccountFeatures` + `GET /hosting-accounts/{id}/features` cho admin (220 op) và portal (101 op) |
| API giả lập Portal | `npx vitest run src/demo/__tests__/portal.test.ts` | PASS: 12 test — An Phát chỉ thấy anphat/oldshop, Marketing chỉ thấy mktitso/pending01; website, database, SFTP, cron, snapshot, khôi phục chỉ thuộc account của mình; account/usage/tính năng/website/job của người khác → 404 và không lộ tên; job và thông báo tách theo user; không tạo website trên account người khác; không có endpoint admin trong realm portal |
| Portal không gọi /admin/ | `npx vitest run src/entries/portal` | PASS: 22 test — render từng route trong 18 route Portal trên API giả lập, ghi lại mọi request: không request nào chứa `/admin/`, chỉ `/api/v1/portal`, `/api/v1/system`, `/api/v1/auth`, trang dữ liệu đều có gọi API; đăng nhập portal gọi `/auth/login` rồi vào Portal; menu chỉ chức năng USER; chuông đếm thông báo chưa đọc thật |
| Vitest toàn bộ | `npx vitest run` | PASS: 452 test (26 file) |
| Đổi user demo (Portal) | `npx playwright test e2e/demo-portal.spec.ts` | PASS: 2 test — An Phát thấy anphat.vn/shop.anphat.vn, không có cột WAF; đổi sang Phòng Marketing thì website, database, Tổng quan chỉ còn dữ liệu mktitso, menu không có link admin; đổi lại thấy dữ liệu An Phát; mở thẳng URL account/website của An Phát khi là Marketing → "Không tìm thấy" |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 129 test (smoke 18 route Portal, axe shell Portal 4 tổ hợp theme/ngôn ngữ) |
| Lint | `make lint` | PASS: ESLint (gồm ranh giới realm), Prettier, tsc, i18n (6 namespace, 2476 key, vi = en), pint, phpstan, check-no-exec |
| API | `make test-api` | PASS: 14 test Pest |
| Build | `make build-demo` | PASS: build thường không chứa MSW |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 18 route Portal | Không lỗi console, không tràn ngang ở 390px |

Phát hiện và sửa:

- Đổi user demo chỉ xóa cache (`clear()`), trang đang mở vẫn giữ dữ liệu của người trước tới khi chuyển trang → dùng `resetQueries()` để tải lại ngay (lỗi có từ 2.1, test Playwright mới bắt được).
- Chuông thông báo trên topbar là số cố định (3/1) từ 2.1 → đếm từ `/notifications` của người đang đăng nhập, cùng key với trang Thông báo nên đánh dấu đã đọc cập nhật ngay.
- Select đổi từ uncontrolled sang controlled (cảnh báo React) ở 4 trang → luôn truyền `value` (rỗng = placeholder).
- axe: nút "Chi tiết" có `aria-label` không chứa chữ hiển thị (label-content-name-mismatch) → nhãn "Chi tiết {{name}}".
- Test 1.5/1.6 của shell Portal chờ dòng health của trang tạm cũ → kiểm Tổng quan thật (fixture thêm `/portal/overview`).

**Chưa kiểm:** `make check` đầy đủ (2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.7

- ✓ Mọi route mục B sitemap: đăng nhập/MFA/quên mật khẩu, Tổng quan usage/quota, account, websites (+new, :id), databases, files, sftp, cron, backups, wordpress, terminal (chỉ gói có SSH), jobs/:id, notifications, profile
- ✓ Chỉ dữ liệu của USER đang đăng nhập; không có route/menu admin, không mua hàng (nâng gói: liên hệ quản trị)
- ✓ Vitest Portal không gọi /admin/; Playwright đổi user demo → chỉ thấy dữ liệu của mình

## 2026-11-20 — Phase 2 / Prompt 2.6 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make codegen-check` | PASS: dataset thêm 4 quy tắc cảnh báo, 2 cảnh báo (đã xử lý / đã xác nhận), 5 kiểm tra uptime, 3 lần quét mã độc, chính sách "Cấu hình panel hằng tuần", 1 lần khôi phục lỗi |
| API giả lập quản trị | `npx vitest run src/demo/__tests__/governance.test.ts` | PASS: 21 test — xác nhận sự kiện một lần, ADMIN không thấy sự kiện ngoài phạm vi; SSH chỉ SA, chặn cấu hình tự khóa, áp dụng qua job; fail2ban; allowlist kiểm CIDR, không rỗng, chống ghi đè khi dữ liệu đã đổi; khôi phục file cách ly; đích sao lưu kiểm cấu hình theo loại, không trả credentials, không giảm Object Lock; chính sách tạo/sửa/chạy/xóa, chặn cron sai; snapshot thủ công, snapshot trên đích bất biến không xóa được; duyệt cây, link tải có hạn, kiểm chứng; khôi phục ghi đè phải gõ đúng username; người dùng (vai trò khớp realm, email duy nhất, ADMIN chỉ tạo user portal, không tự hạ quyền, luôn còn 1 SA, khóa/mở khóa/MFA, phạm vi ADMIN); đăng nhập thay cần lý do và ghi audit; quy tắc cảnh báo; xuất CSV audit theo bộ lọc và phạm vi; đánh dấu đã đọc; cài đặt chỉ SA, không tắt MFA quản trị, không lộ mật khẩu SMTP; API token hiện secret một lần |
| Ma trận quyền + nhật ký | `npx vitest run src/entries/admin/system` | PASS: 10 test — `allows` (`*`, `x.*`, không suy diễn write ⇒ read), ma trận với 3 vai trò mẫu, render `RoleMatrix` (cột theo vai trò, ô Có/Không cho trình đọc màn hình, đếm ô được phép, không có ô nhập/nút), bảng thay đổi audit |
| CSV | `npx vitest run src/shared/lib` | PASS: 4 test — RFC 4180 (dấu phẩy, nháy kép, xuống dòng), chặn chèn công thức `= + - @` nhưng giữ số âm, khứ hồi `toCsv` → `parseCsv` có tiếng Việt, CRLF |
| Sao lưu + bảo mật | `npx vitest run src/entries/admin/backups src/entries/admin/security` | PASS: 19 test — quy tắc 3-2-1-1-0 (đủ, thiếu, đích lỗi và lỗi kiểm chứng/chính sách), snapshot mới nhất theo account bỏ bản `final`, hạn kiểm chứng 7 ngày; mục khôi phục (bỏ mục con khi đã chọn cha, gộp config); form đích S3/local, chính sách; CIDR/IP, allowlist trùng, SSH không để trống nhóm |
| Vitest toàn bộ | `npx vitest run` | PASS: 383 test (24 file) |
| Luồng quản trị (demo) | `npx playwright test e2e/demo-admin2.spec.ts` | PASS: 3 test — wizard khôi phục (chưa chọn snapshot, chưa chọn mục, gõ sai username đều bị chặn → ghi đè `database:anphat_shop` + config → job "Đã xong" → dòng "Thành công" trong /restores); khôi phục từ menu snapshot ra bản mới sang srv-hn-02; nhật ký lọc "Thất bại", xem chi tiết, tải CSV đúng tên file và tiêu đề cột |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 127 test (smoke 76 route gồm 18 route mới) |
| Lint | `make lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 2417 key, vi = en), pint, phpstan, check-no-exec |
| Build | `make build-demo` | PASS |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 24 màn/tab mới | Không lỗi console; sau khi sửa không tràn ngang ở 390px |

Phát hiện và sửa:

- Bảng Vai trò tràn ngang 136px ở 390px dù đã bọc `overflow-x-auto`: chữ `sr-only` (định vị tuyệt đối) thoát khỏi vùng cuộn → thêm `relative` cho vùng cuộn (cả bảng Thông báo và chi tiết Nhật ký).
- Thông báo dùng `setState` trong `useEffect` (ESLint) → tách form, khởi tạo từ dữ liệu, `key` theo `updated_at`.
- Test 1.5 mong tiêu đề tạm "Cài đặt hệ thống"; trang thật tên "Cài đặt" → cập nhật kỳ vọng (vẫn kiểm SA vào được).
- Ký tự BOM viết trực tiếp trong mã → đổi thành `\uFEFF`.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.6

- ✓ /security + WAF, mã độc (quét, cách ly, khôi phục), SSH, fail2ban, FIM, IP được phép (cảnh báo khi IP phiên hiện tại không nằm trong danh sách)
- ✓ /backups: Đích, Chính sách, Lịch sử, Kiểm chứng, checklist 3-2-1-1-0
- ✓ /restores + wizard khôi phục mới
- ✓ /users (+ :id, phạm vi ADMIN, impersonate có lý do), /roles (ma trận chỉ xem)
- ✓ /monitoring (+ cảnh báo), /audit-logs (lọc, chi tiết, xuất CSV), /notifications, /settings (tab)
- ✓ Vitest ma trận quyền hiển thị, xuất CSV; Playwright wizard khôi phục

## 2026-11-20 — Phase 2 / Prompt 2.5 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| DB + Contract | `make db-schema` · `make db-verify` · `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: 80 bảng (thêm `git_repositories`, `git_deployments`), db-verify 41 test; OpenAPI thêm Git deploy (admin + portal), op `git.deploy`/`git.rollback` khai báo; dataset 3 zone DNS, 2 repository, 4 lần deploy |
| Thư viện Hosting II | `npx vitest run src/shared/hosting` | PASS: 43 test — đường dẫn File Manager (chuẩn hóa `~`, tuyệt đối trong home, chặn `..` thoát home, `/etc/passwd`, home người khác, ký tự điều khiển; breadcrumb; chuyển thư mục vào chính nó; quyền 0755 → rwxr-xr-x), cron (5 trường, khoảng/bước/danh sách, ngoài miền, 5 lần chạy tới, khoảng cách ngắn nhất, mô tả bằng lời), record DNS (IPv4/IPv6 kể cả `:::`, CNAME ở gốc, proxy chỉ A/AAAA/CNAME, MX/SRV cần độ ưu tiên, TTL 60–86400 theo contract, SRV/CAA) |
| Form Hosting II | `npx vitest run src/entries/admin/sites` | PASS: 13 test — website (domain chữ thường, thư mục gốc `..`/tuyệt đối, proxy chỉ 127.0.0.1, PHP bắt buộc), tiền tố username cho database/SFTP, cron sai/lệnh nhiều dòng, chỉ nhận khóa SSH công khai, URL repo/branch/đường dẫn dùng chung/số release, ngày còn lại của chứng chỉ |
| API giả lập Hosting II | `npx vitest run src/demo/__tests__/sites.test.ts` | PASS: 27 test — tạo website → job (4 bước) → `ready` + domain xác minh + chứng chỉ; chặn vượt số website, PHP ngoài gói, domain trùng, proxy ra ngoài, document root thoát site, account tạm ngưng, ADMIN ngoài phạm vi; PHP/log đúng contract; File Manager chặn `../`, `/etc/passwd`, `/home/mktitso`, lưu với etag cũ → 412, mkdir/move vào chính nó/xóa; DNS 1 ca thêm + 5 ca chặn; cron sai và dày hơn gói; chạy cron thêm lịch sử; tiền tố tên DB, SFTP ngoài home, SSH khi gói không cho; WordPress cần site PHP, cập nhật; Git deploy chồng → 409 `resource_locked`, rollback đánh dấu release sau `rolled_back`, xoay webhook secret |
| API giả lập theo OpenAPI | `npx vitest run src/demo/__tests__/handlers.test.ts` | PASS: mọi handler đăng ký có trong OpenAPI, mọi GET trả body hợp lệ schema (thêm Git, file, log) |
| Vitest toàn bộ | `npx vitest run` | PASS: 326 test (19 file) |
| Luồng Hosting II (demo) | `npx playwright test e2e/demo-sites.spec.ts` | PASS: 4 test — tạo website (báo lỗi khi thiếu dữ liệu, chặn `../../etc`) → job "Đã xong: Tạo website" → dòng "Sẵn sàng" PHP 8.2 → tab SSL có chứng chỉ; File Manager chặn `/etc/passwd`, sửa `index.php`, tạo thư mục qua job; DNS báo IPv4 sai → thêm record A → có trong zone; cron xem trước "Hằng ngày lúc 02:00", báo biểu thức sai, chạy ngay → lịch sử; Git deploy → quay về release cũ → "Đang chạy" |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 124 test (smoke 76 route + luồng lõi, hạ tầng, hosting I/II + Design System + axe) |
| Lint | `pnpm lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 1750 key, vi = en) |
| Build | `make build-demo` | PASS |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 11 màn Hosting II | Không tràn ngang ở 390px, không lỗi console |

Phát hiện và sửa:

- `ListPage` ở chế độ nhúng (trong tab) bỏ luôn mô tả và nút thao tác → nút "Thêm record", "Thêm domain"… không hiện; nay hiện mô tả và nút phía trên bảng (không ảnh hưởng trang cũ vì chưa trang nào truyền hai thuộc tính này khi nhúng).
- Chứng chỉ SSL không lọc theo phạm vi ADMIN (chỉ gắn website) → suy ra account qua website.
- TTL "tự động" (1) của Cloudflare không có trong contract (`ttl` 60–86400) → bỏ khỏi form, schema và API giả lập.
- Tên op sai so với contract agent (`db.*.user_remove`, `db.pg.restore`, `cron.run`) → `user_drop`, `import`, `cron.run_once`.
- Lỗi form có tham số chuỗi (tiền tố tên) → `translateError` truyền thêm `{{value}}`.
- Khóa deploy/URL webhook dài chạy dưới nút sao chép → `CodeBlock` có chế độ xuống dòng và nền cho nút.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.5

- ✓ /websites (+ thêm website → job) và /websites/:id 8 tab: Tổng quan, Domain, PHP, SSL, Nginx, WAF, Log, Sao lưu
- ✓ /databases (database + user, quyền, đổi mật khẩu hiện một lần, xuất)
- ✓ /files: chọn account trước, 2 khung (cây thư mục + danh sách), chặn đường dẫn ngoài home, sửa file có etag, tải lên, thao tác hàng loạt qua job
- ✓ /sftp (+ SSH key), /ssl, /dns (zone + record), /cron (+ lịch sử chạy, xem trước lịch), /wordpress, /git-deployments
- ✓ Vitest đường dẫn File Manager, form record DNS, cron expr; Playwright tạo website → job

## 2026-11-20 — Phase 2 / Prompt 2.4 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: dataset thêm Super Admin thứ hai (14 user); bản nhúng trong agent đồng bộ lại |
| API giả lập hosting | `npx vitest run src/demo/__tests__/hosting.test.ts` | PASS: 35 test — 28 ca ghi/đọc (201/202/403/409/422) hợp lệ schema, gồm ADMIN ngoài phạm vi server, username trùng/hệ thống, server không nhận account, legal hold chỉ SA; tạo account → `provisioning` → job xong → `active`, có website và vòng đời; D-43 đổi giới hạn → v2, account giữ v1 tới khi chuyển, đổi tên không tạo phiên bản; D-46 chấm dứt (giữ ≥ 30 ngày) → ADMIN không lên lịch purge → SA A lên lịch → SA A tự xác nhận bị 403 → SA B xác nhận → lần 2 bị 409; legal hold chặn purge; chuyển server → `verifying` → không mở lần thứ hai → cutover → account ở máy đích |
| Logic form/wizard | `npx vitest run src/entries/admin/hosting` | PASS: 10 test — form gói (giới hạn mẫu hợp lệ; mã gói, số âm/thập phân/rỗng, PHP rỗng, giữ dữ liệu < 30 ngày → khóa lỗi i18n); so sánh phiên bản; username 3–16 ký tự + tên hệ thống; bước wizard bắt buộc chọn, domain tùy chọn + chuyển chữ thường; gợi ý username từ tên tiếng Việt; đếm ngày còn lại; bước wizard chuyển server; giai đoạn purge |
| Vitest toàn bộ | `npx vitest run` | PASS: 233 test (16 file) |
| Luồng hosting (demo) | `npx playwright test e2e/demo-hosting.spec.ts` | PASS: 4 test — wizard tạo account (chặn khi chưa chọn chủ sở hữu, gợi ý username, chặn `root`) → job "Đã xong" → trang account Hoạt động → có trong danh sách; purge 2 bước: người lên lịch bị chặn tự xác nhận, đổi vai trò sang Nguyễn Hải → gõ username → "Đã xác nhận, chờ tới hạn"; sửa RAM gói Basic → v3 → tab So sánh hiện 1 GB → 2 GB; chuyển server lehoa: cutover → "Đã chuyển sang srv-hn-02" |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 120 test (smoke 76 route + luồng lõi, hạ tầng, hosting + Design System + axe) |
| Lint | `pnpm lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 1190 key, vi = en) |
| Build | `make build-demo` | PASS |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 10 màn gói/tài khoản | Không tràn ngang ở 390px, không lỗi console |

Phát hiện và sửa:

- Bấm "Tiếp" ở bước cuối wizard gửi luôn form: React tái dùng cùng nút và đổi `type` thành `submit` trước khi trình duyệt xử lý click → đặt `key` riêng cho nút Tiếp và nút Tạo.
- Lần chuyển server mẫu giữ `job_uuid` của job cũ không có trong dữ liệu → trang tiến trình gọi job 404; cutover/hoàn tác nay gán job mới.
- Gợi ý đặt account là danh sách tĩnh, ADMIN thấy cả server ngoài phạm vi → tính điểm theo RAM/disk/số account của server trong phạm vi.
- Lỗi form chỉ truyền `{{min}}` → thêm `{{max}}` cho thông báo "Tối đa".
- Danh sách tài khoản loại account đã chấm dứt/xóa (có trang riêng) để khớp số trên dashboard.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.4

- ✓ /hosting-packages (+new, :id với lịch sử phiên bản, so sánh giới hạn)
- ✓ /hosting-accounts (danh sách, mức dùng, vòng đời), /new wizard (người dùng, gói, server có gợi ý, username)
- ✓ /hosting-accounts/:id: Tổng quan + mức dùng, Website, Database, SFTP, Cron, Backup, Vòng đời; khóa/mở khóa, đổi gói, chuyển server, chấm dứt gõ username, legal hold
- ✓ /:id/migrate wizard (kiểm tra trước, đồng bộ, kiểm tra dữ liệu, cutover, hoàn tác)
- ✓ /hosting-accounts/terminated: đếm ngược 30 ngày, backup đã kiểm chứng, purge 2 bước (D-46)
- ✓ Vitest validate form gói/wizard; Playwright tạo account → job → xuất hiện trong danh sách

## 2026-11-20 — Phase 2 / Prompt 2.3 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: thêm `compose_yaml` vào `ComposeProject` (lấy từ revision hiện tại, bảng `compose_revisions`); dataset có YAML mẫu |
| API giả lập hạ tầng | `npx vitest run src/demo/__tests__/infra.test.ts` | PASS: 35 test — 30 ca ghi (201/202/204/403/404/409/422) hợp lệ schema; dữ liệu con tách theo server (dừng nginx ở srv-hn-01 không đổi srv-hn-02); safe-apply: xác nhận trong hạn giữ rule, quá hạn tự hoàn tác về bộ rule cũ + audit `firewall.rollback`, xác nhận sau khi hoàn tác → 409; token thêm server → sau 6 giây server mới xuất hiện trong danh sách (hợp lệ schema); compose tạo → job xong → `running` |
| Logic trang server | `npx vitest run src/entries/admin/servers` | PASS: 11 test — reducer đếm ngược safe-apply (bắt đầu khi job xong, hết hạn → hoàn tác, xác nhận → giữ, job lỗi → idle); form rule (cổng 1–65535 và khoảng hợp lệ, ICMP không cần cổng, IPv4/IPv6 CIDR, ưu tiên 1–9999); form token server, Nginx; hành động phần mềm theo trạng thái; terminal mô phỏng không chạy lệnh |
| Vitest toàn bộ | `npx vitest run` | PASS: 188 test (14 file) |
| Luồng hạ tầng (demo) | `npx playwright test e2e/demo-infra.spec.ts` | PASS: 4 test — restart nginx → drawer job chạy tới "Đã xong" → job đứng đầu trang Tác vụ, trạng thái Thành công; tường lửa: cổng 99999 bị chặn, thêm rule → "1 thay đổi chưa áp dụng" → áp dụng 60 giây → đếm ngược giảm → "Giữ cấu hình mới" → đã xác nhận; thêm server srv-hcm-02 → lệnh join → agent kết nối → mở trang server → có trong danh sách; tạo compose project → trang chi tiết → Đang chạy |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 116 test (smoke 76 route + luồng lõi + hạ tầng + Design System + axe) |
| Lint | `pnpm lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 877 key, vi = en) |
| Build | `make build-demo` | PASS: build thường không chứa MSW; `dist-demo` có worker |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 các trang server, tường lửa, terminal, Docker, Nginx, Compose, Registry | Không tràn ngang ở 390px |

Phát hiện và sửa:

- Thanh mục của server đặt trên breadcrumb → thêm slot `nav` cho PageHeader/DetailPage, đặt dưới tiêu đề.
- Badge "drift" hiện nguyên văn tiếng Anh → thêm `drift`, `inSync` vào bảng trạng thái của StatusBadge.
- Toast job hiện mã loại job (`service.restart`) → dùng nhãn i18n ("Đã xong: Khởi động lại dịch vụ").
- Drawer job (modal) che nút xác nhận tường lửa trong lúc đếm ngược → tự đóng drawer khi bắt đầu đếm ngược.
- Danh sách server không có tham số lọc trạng thái trong contract → bỏ bộ lọc (không gửi tham số ngoài contract).
- Dữ liệu demo nằm trong bộ nhớ trình duyệt: tải lại trang thì làm mới. Test luồng điều hướng trong SPA; ghi chú trong runbook demo.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.3

- ✓ /servers, /servers/new (lệnh join + chờ agent giả lập), /servers/:id (Tổng quan, Dịch vụ, Tài nguyên, Agent, Accounts), nginx, php, software, firewall, docker, terminal; /compose-projects (+:id); /docker/registries
- ✓ Firewall safe-apply có đếm ngược và tự hoàn tác; terminal mô phỏng, ghi rõ chính sách
- ✓ Thao tác dịch vụ chạy JobProgress; Playwright restart dịch vụ → job xong

## 2026-11-20 — Phase 2 / Prompt 2.2 — nhánh `phase-2`

Môi trường: như 2.1. PostgreSQL không bật ở lần `make check` này.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: thêm `POST /api/v1/{admin,portal}/jobs/{id}:retry` (admin 210, portal 91 operation); file sinh khớp |
| API giả lập (đọc + ghi) | `npx vitest run src/demo` | PASS: 98 test — bảng ca ghi (login thiếu dữ liệu → 422, MFA `000000` → 422 `validation_failed`, mật khẩu < 12 ký tự → 422, thu hồi phiên hiện tại → 409, hủy/thử lại job → 202 `JobAccepted`) đều hợp lệ schema; job thử lại chạy tới `succeeded` và sinh audit; số trên dashboard bằng độ dài các danh sách với SUPER_ADMIN và ADMIN (Trần Minh) |
| Logic wizard cài đặt | `npx vitest run src/entries/admin/install` | PASS: 9 test (validate từng bước, chặn bước, cảnh báo allowlist rỗng/SSH mật khẩu, tách allowlist) |
| Tìm kiếm Ctrl+K | `src/entries/admin/__tests__/search.test.ts` | PASS: tìm theo username/domain, không phân biệt dấu (`quan tri` → "Quản trị hệ thống"), ≤ 5 kết quả/nhóm, ADMIN không có nhóm người dùng |
| Vitest toàn bộ | `make test-web` | PASS: 141 test (12 file) |
| Luồng lõi (demo) | `npx playwright test e2e/demo-core.spec.ts` | PASS: 6 test — số trên thẻ thống kê = số bản ghi API danh sách (SA và ADMIN); bấm server ở dashboard → trang chi tiết server; Ctrl+K "anphat" → mở chi tiết; đăng nhập → MFA (mã sai báo lỗi, mã đúng vào dashboard); wizard chặn bước khi thiếu mã, sang bước khi hợp lệ, quay lại được |
| Playwright toàn bộ | `make test-e2e` | PASS: 112 test (smoke 76 route + luồng lõi + Design System + axe) |
| Lint | `make lint-web` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 575 key, vi = en) |
| `make check` | `scripts/check-all.sh` | PASS: 20 PASS · 2 SKIP (test-api-pg: PostgreSQL không chạy; staticcheck chưa cài) · 0 FAIL, 197 giây |

Phát hiện và sửa:

- `test.use({ baseURL })` đặt trong module chung `e2e/demo.ts` chỉ áp cho file spec nạp đầu tiên mỗi worker (module được cache) → khi thêm spec thứ hai, vài smoke test chạy nhầm cổng 5173 và gặp 502. Chuyển sang fixture `baseURL` trong `test.extend`.
- Test ảnh drawer 390px chờ mọi animation của trang; dashboard mới có skeleton chạy vô hạn khi API không được giả lập → chỉ chờ animation trong drawer.
- Dashboard trả sớm trạng thái lỗi làm mất thẻ trạng thái hệ thống → hiện lỗi tại chỗ, phần còn lại vẫn hiển thị.
- 202 của contract là `JobAccepted` ở cấp gốc (không bọc `data`) → sửa mock.
- Tiêu đề dashboard đổi thành lời chào theo mockup → cập nhật App.test và test đổi ngôn ngữ.

**Chưa kiểm:** `test-api-pg` (không có thay đổi API Laravel), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.2

- ✓ Dashboard theo mockup; số liệu tính từ cùng dữ liệu với các danh sách (Vitest + Playwright)
- ✓ Luồng dashboard → server (Playwright)
- ✓ Jobs, chi tiết job (hủy/thử lại), Hồ sơ, Ctrl+K, Đăng nhập/MFA, wizard 10 bước; logic wizard và tìm kiếm có Vitest
- ✓ Chuỗi giao diện VI/EN đầy đủ

## 2026-11-20 — Phase 2 / Prompt 2.1 — nhánh `phase-2`

Môi trường: như 1.7 (Node 22, pnpm, Chromium Playwright có sẵn). PostgreSQL không bật ở lần `make check` này.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Dataset nhất quán | `python3 contracts/tools/check_demo.py` (bước 3 của `make contracts-check`) | PASS: khóa ngoại, số đếm tổng hợp (dashboard, usage, account_count, domains_count, portal_overview), uuid duy nhất; thử âm tính sửa `account_count` → lỗi |
| MSW theo OpenAPI | `npx vitest run src/demo` | PASS: 77 test — mọi handler (> 60) có operation trong OpenAPI; mọi GET trả < 300 và hợp lệ theo schema (ajv 2020, theo `$ref` vào `paths/…/responses` và `components/responses` của common.yaml); phân trang cursor, `q`, `limit=999` → 422 hợp lệ schema; ADMIN chỉ thấy phạm vi (lehoa thấy, account srv-hn-02 → 404) |
| Router, guard, breadcrumb | `npx vitest run src/entries src/shared` | PASS: `/` → `/dashboard`; route chưa làm hiện trang tạm có breadcrumb (crumb cha là link, crumb uuid rút gọn); sidebar active theo route; ADMIN vào `/settings` → 403; SA vào được; đường dẫn lạ → 404; portal không có link admin |
| ListPage URL state | `src/shared/page/__tests__/ListPage.test.tsx` | PASS: đọc `?q=&status=` từ URL và gửi theo tham số contract; gõ tìm kiếm cập nhật URL (giữ bộ lọc khác); "Xóa bộ lọc" làm sạch URL |
| Vitest toàn bộ | `make test-web` | PASS: 110 test (9 file) |
| Smoke mọi route (demo) | `npx playwright test e2e/demo-smoke.spec.ts` | PASS: 76 test — 58 route admin + 18 route portal (`pnpm dev:demo`, MSW bật), mỗi route có h1, không 404/403, không lỗi console, không request `/api` ≥ 400; ADMIN → `/settings` 403; điều hướng sidebar không tải lại trang; chuyển vai trò trên topbar áp guard ngay |
| Playwright toàn bộ | `make test-e2e` | PASS: 106 test; ảnh Design System 390px drawer lặp 2 lần ổn định |
| Build thường không có MSW | `make build-demo` (`scripts/check-demo-build.sh`) | PASS: `dist` không chứa `mockServiceWorker`, `X-Demo-User`, `setupWorker`, uuid kind 0xfe; `dist-demo` có worker và API giả lập |
| Lint | `make lint-web` | PASS: ESLint, Prettier, tsc, i18n (5 namespace, 278 key, vi = en) |
| `make check` | `scripts/check-all.sh` | PASS: 20 PASS · 2 SKIP (test-api-pg: PostgreSQL không chạy; staticcheck chưa cài) · 0 FAIL, 198 giây; repo sạch sau khi chạy |

Phát hiện và sửa:

- Contract: thao tác danh sách nhận `limit/sort/filter` nhưng chưa khai báo lỗi 422 → thêm 422 `ValidationFailed` cho mọi list (oas.py), mock trả 422 khi sort sai (trước là 400 không có trong contract).
- Handler MSW `*/api/*` bắt nhầm module Vite `/src/api/*.ts` → chỉ xử lý `/api/v1/`.
- Hai dev server (thường 5173, demo 5174) dùng chung cache deps của Vite → React bị nạp hai bản ("Invalid hook call") → demo dùng `cacheDir` riêng.
- Ứng dụng nhiều entry cần history fallback: `/admin/*` → `admin/index.html`, `/portal/*` → `portal/index.html` (plugin dev/preview; production là `try_files` của Nginx).
- Test ảnh drawer 390px mở menu khi router còn đang chuyển `/admin/` → `/admin/dashboard` (animation bị hủy) → chờ trang tải xong.
- `src/test/setup.ts` giả định jsdom → bỏ qua phần DOM khi test chạy môi trường node.

**Chưa kiểm:** `test-api-pg` (không bật PostgreSQL lần này; không có thay đổi API Laravel), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.1

- ✓ Mọi route trong sitemap tồn tại (58 admin, 18 portal); smoke test xanh
- ✓ Response MSW 100% hợp lệ theo OpenAPI (mọi GET đã mock); dataset nhất quán (check_demo.py)
- ✓ Build thường không chứa MSW (kiểm bằng grep `dist`, chạy trong `make check` và CI)

## 2026-11-20 — Phase 1 / Prompt 1.7 — nhánh `phase-1`

Môi trường: như 1.6; PostgreSQL 16 (cluster tạm `initdb`) và Redis 7 (`redis-server`) chạy cục bộ cho bước `test-api-pg`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Codegen TS | `make codegen` → `apps/web/src/api/generated/{admin,portal}/schema.ts` | PASS: `tsc` xanh, client openapi-fetch thay type viết tay; 26 test web vẫn xanh |
| Codegen Go | `contracts/tools/gen_go_types.py` → `agent/internal/contracts/types_gen.go` | PASS: `go vet`, `go test -race`; 3 test mới (mọi op đặc tả có Params/Result; 6 envelope mẫu decode chặt và mã hóa lại hợp lệ theo schema; kết quả `system.ping` có type hợp lệ) |
| Codegen check | `make codegen-check` | PASS; thử âm tính: sửa `admin/schema.ts`, `types_gen.go`, một schema nhúng → cả 3 lần exit ≠ 0 |
| Chặn Admin API ở portal | ESLint `no-restricted-imports` | PASS; thử âm tính: import `@/api/admin` trong `src/shared` → lỗi |
| Pest với PostgreSQL + Redis | `make test-api-pg` | PASS: 14 test; thử âm tính sai cổng PG → test trạng thái DB đỏ (xác nhận chạy trên PG thật) |
| Workflow CI | `python3 scripts/check-ci.py` | PASS: 7 job, 16 lệnh make có trong Makefile; thử âm tính target sai → lỗi. **actionlint chưa chạy** (máy cloud không cho tải) |
| `make check` | `scripts/check-all.sh` | PASS: 20 PASS · 1 SKIP (staticcheck chưa cài được) · 0 FAIL, 123 giây; thử âm tính codegen lệch → exit 2 |
| Clean clone | `git clone -b phase-1` → `make setup && make check` | PASS: 20 PASS · 1 SKIP · 0 FAIL; tổng 10 phút 54 giây (setup khoảng 8,5 phút vì Composer phải clone git; `make check` 134 giây); repo sạch sau khi chạy |

Phát hiện và sửa: ảnh Playwright thay đổi mỗi lần chạy làm bẩn repo → e2e ghi vào `test-results`, chỉ `make screenshots` cập nhật `docs/screenshots` (tắt animation, ảnh ổn định giữa các lần chạy); openapi-fetch giữ tham chiếu `fetch` lúc tạo client → truyền hàm gọi `globalThis.fetch` lúc request; test portal "không gọi `/admin/`" trước đó so chuỗi `[object Request]` (luôn đúng) → đọc `Request.url`.

**Chưa kiểm:** CI trên GitHub (chưa có remote), staticcheck và actionlint (không tải được ở máy cloud), `make services-up` (không có Docker).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.7 và Phase 1

- ✓ Tất cả acceptance 1.1–1.6 đạt
- ✓ `make check` xanh (0 FAIL) trên `phase-1` và clean clone; codegen không diff
- ✓ Không code nghiệp vụ, không thao tác hệ thống, không deploy, không push
- ✓ Báo cáo `docs/reports/phase-1.md`; PHASE_STATUS: Phase 1 ✓ chờ duyệt

## 2026-11-20 — Phase 1 / Prompt 1.6 — nhánh `phase-1`

Môi trường: như 1.5; thêm `@playwright/test` 1.63.0 (dùng Chromium có sẵn, không tải trình duyệt), `@axe-core/playwright` 4.14.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Token sinh tự động | `make tokens-check` (`gen-tokens.mjs --check`, nằm trong `make lint`) | PASS: `tokens.css` khớp `tokens.json` (45 màu × 2 theme) |
| Tương phản WCAG AA | `node design/tools/check-contrast.mjs` (trong `make tokens-check`) | PASS: 84/84 cặp (chữ ≥ 4.5:1, UI ≥ 3:1, light + dark). Lần đầu 4 cặp trượt → chỉnh màu `info`/`input` light, `danger`/`input` dark |
| Lint cấm màu hard-code | `make lint-web` (ESLint `no-restricted-syntax`) | PASS; thử âm tính: thêm `#ff0000`, `rgb()`, `bg-red-500`, `bg-[#123456]`… vào component → 6 lỗi |
| i18n | `pnpm i18n:check` (trong `make lint-web`) | PASS: 4 namespace, 187 key, 0 thiếu, VI = EN, biến `{{…}}` khớp |
| Vitest | `make test-web` | PASS: 26 test / 7 file: DataTable 5 (sắp xếp, lọc, chọn dòng, phân trang, card mobile), ConfirmDialog 4 (gõ đúng tên mới bật nút), FormField 3 (lỗi zod qua i18n), ThemeProvider 5 (đổi theme, `system` theo `prefers-color-scheme`, storage lỗi vẫn chạy), formatter VI/EN, 2 entry |
| Playwright | `make test-e2e` (`playwright test --trace off`, deviceScaleFactor 2) | PASS: 30 test: 12 ảnh (`/design`, AdminShell, PortalShell × 1440/390 × light/dark) + 2 ảnh drawer mở, không cuộn ngang ở mọi ảnh; không nháy theme (`.dark` có trước DOMContentLoaded); Ctrl+K; đổi theme/ngôn ngữ giữ sau khi tải lại; thu gọn sidebar; drawer nằm trên lớp phủ |
| axe-core | trong `make test-e2e` (WCAG 2.0/2.1/2.2 A, AA) | PASS: 0 lỗi critical/serious trên `/design`, AdminShell, PortalShell × light/dark × VI/EN (12 lần quét) |
| Build | `make build` | PASS: `dist/admin`, `dist/portal`, `theme-init.js`; không có `/design` trong `dist`. Cảnh báo: chunk chung 521 kB (gzip 164 kB) → tách theo route ở Phase 2 |
| Hồi quy 1.5 | `make test` + `make lint` | PASS: web 26, Pest 14 (63 assertion), Go `-race`, chặn exec, Pint, PHPStan 0 lỗi, gofmt/vet |
| Docs | `make docs-check` | PASS |

Phát hiện và sửa nhờ Playwright: drawer mobile bị lớp phủ che (token z-index `drawer` 50 < `overlay` 60 → đổi thành `overlay` 50 < `drawer` 60, thêm kiểm `elementFromPoint`); `/design` tràn ngang 104 px ở 390 px (Card thiếu `min-w-0` trong grid, tên op dài không xuống dòng); axe báo `label-content-name-mismatch` ở nút ngôn ngữ và user menu (`aria-label` khác chữ hiển thị → dùng `sr-only`). Prettier định dạng lại file sinh `tokens.css` làm `--check` lệch → loại file sinh khỏi Prettier.

**Chưa kiểm:** trình duyệt khác Chromium (Firefox, Safari).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.6

- ✓ Token light/dark sinh tự động, không màu hard-code trong component (lint rule, thử âm tính)
- ✓ 25 component nền (`src/ui`) + AdminShell, PortalShell, đúng ở 390 px và 1440 px
- ✓ 14 ảnh thật trong `docs/screenshots/design-system/`
- ✓ a11y (axe 0 critical/serious), tương phản 84/84, i18n 0 key thiếu

## 2026-11-20 — Phase 1 / Prompt 1.5 — nhánh `phase-1`

Môi trường: Node 22.23 + pnpm 10.28 (corepack), PHP 8.3.6, Composer 2.8.12, Laravel 13.43.0, Pest 4.7.8, PHPStan 2.3.7 + Larastan 3, Go 1.24.7; PostgreSQL 16 (cluster tạm `initdb`) và Redis 7 (`redis-server` cục bộ) chỉ để chạy thử trang trạng thái.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Web: Vitest render mỗi entry | `make test-web` | PASS: 3 test (admin: trạng thái OK + báo lỗi problem+json; portal: chỉ health, không gọi `/admin/`) |
| Web: lint | `make lint-web` (ESLint strict + `react/no-danger`, Prettier, `tsc`) | PASS; thử âm tính `dangerouslySetInnerHTML` → ESLint báo lỗi |
| Web: build | `make build` | PASS: `dist/admin`, `dist/portal` |
| API: Pest | `make test-api` | PASS: 14 test, 63 assertion: health/version/status khớp schema OpenAPI (validate bằng opis/json-schema từ `contracts/openapi`), 404/405/500 trả `application/problem+json` đúng schema Problem, 500 không lộ chi tiết, CORS tắt mặc định, AgentClient |
| API: rule cấm lệnh hệ thống | `tests/PHPStan/NoSystemCommandRuleTest` (trong Pest) | PASS: bắt đủ 12 vi phạm trong fixture (7 hàm kể cả `\EXEC`, backtick, 2 import, 2 lớp Process) |
| API: lint | `make lint-api` (Pint, PHPStan level 8 + Larastan + rule riêng) | PASS: 0 lỗi |
| Chặn exec (grep) | `make no-exec` (`scripts/check-no-exec.sh`) | PASS trên repo; âm tính: fixture PHP + Go có `os/exec`, `sh -c` → bắt 12 dòng, exit 1 |
| Agent: unit + race | `make test-agent` (`go test -race ./...`) | PASS: envelope 16 ca (op lạ → `unknown_op`, params thừa → `invalid_params`, ts lệch → `replay_rejected`, deadline…), registry (op ngoài catalog, op chưa hỗ trợ → `op_disabled`, cache theo `op_id`, nonce replay), result khớp `result.schema.json` + schema kết quả từng op, socket unix, TCP chỉ loopback, bản nhúng trùng `contracts/` |
| Agent: fuzz | `make test-fuzz` (30 giây) | PASS: 720 nghìn lượt (clean clone), 1,19 triệu lượt (lần đầu), không panic |
| Agent: lint | `make lint-agent` (gofmt, go vet) | PASS |
| Docs | `make structure` + `make docs-check` | PASS: 0 lỗi lint, 93 link, 8 khối Mermaid |
| Chạy thật | `make dev` + `curl` + Playwright | PASS: `/admin/` hiện API ok, Agent `ping mock 0.1.0-mock`, PostgreSQL OK, Redis OK; `/portal/` hiện API ok; `/admin` chuyển hướng `/admin/`; Ctrl+C/TERM dừng cả 3 tiến trình và xóa socket. Ảnh: `docs/screenshots/phase-1/1.5-*.png` |
| Clean clone | `git clone` → `make setup` → `make dev` → `make test` → `make lint` | PASS: setup 143 giây, dev sẵn sàng sau 1 giây, test và lint xanh, `git status` sạch sau khi chạy |

Phát hiện và sửa: `$!` của pipeline trỏ vào bộ lọc log nên Ctrl+C để sót tiến trình → đổi sang process substitution và dừng cả tiến trình con của `artisan serve`; context deadline của registry dùng đồng hồ thật thay vì đồng hồ của request → dùng thời lượng tương đối; lỗi tạm thời (`deadline_exceeded`) không còn bị cache theo `op_id`; Laravel mặc định trả `Access-Control-Allow-Origin: *` → tắt CORS, chỉ bật qua `ITSO_CORS_ORIGINS`.

**Ghi chú môi trường:** máy cloud chặn tải zip từ `codeload.github.com` nên Composer phải clone git (chậm) và gói `phpstan/phpstan` (chỉ có dist) được nạp sẵn vào cache Composer từ tag 2.3.7; `composer.lock` giữ nguyên nguồn chuẩn của Packagist. Thời gian 143 giây đo với cache Composer/pnpm/Go đã có; máy dev bình thường (tải zip trực tiếp) ước 3–6 phút, trong giới hạn 15 phút. Docker không chạy được trong máy cloud nên `make services-up` chưa chạy thử (`docker compose -f docker-compose.dev.yml config -q` PASS; PostgreSQL/Redis kiểm bằng bản cài trực tiếp).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.5

- ✓ Clean clone → `make setup && make dev` → `/admin` và `/portal` hiển thị health của API; ping mock agent hiển thị ở `/admin` (≤ 15 phút: đo 143 giây + 1 giây)
- ✓ `make test` và `make lint` xanh
- Lệch có chủ đích: ping agent chỉ hiện ở `/admin`, không ở `/portal` (thông tin agent là Admin-only, theo ranh giới realm của contracts). Endpoint version theo contract là `/api/v1/admin/system/version` (prompt ghi `/api/v1/system/version`), bật ở local/testing tới khi có auth.

## 2026-11-20 — Phase 1 / Prompt 1.4 — nhánh `phase-1`

Công cụ: `@redocly/cli` 2.71.0, `ajv-cli` 5.0.0 + `ajv-formats` 3.0.1 (draft 2020-12, strict), Python `jsonschema` 4.26 (Draft 2020-12 + FormatChecker).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Sinh lại không diff | `make contracts-check` bước 1 (so sha256 trước/sau khi sinh) | PASS |
| Redocly lint | `redocly lint --config contracts/redocly.yaml` (recommended-strict + rule riêng) | PASS: 0 lỗi, 0 cảnh báo (admin, portal, common) |
| Ngữ nghĩa | `python3 contracts/tools/check_contracts.py` | PASS: 298 operation (admin 208, portal 90), 101 operation trả 202 Job đều có Idempotency-Key + JobAccepted, mọi 4xx/5xx dùng Problem |
| Example khớp schema | trong `check_contracts.py` | PASS: 373 example; độ phủ **282/282 = 100%** operation có body (16 operation 204 không có body) |
| Portal ⊄ admin-only | trong `check_contracts.py` | PASS: không path/tag/schema admin-only, không `/api/provisioning` |
| Op trong Job ↔ catalog agent | trong `check_contracts.py` | PASS: 57 op đều có trong `catalog.json` |
| Mẫu ràng buộc OpenAPI = agent; RE2 | trong `check_contracts.py` | PASS: 10 mẫu trùng khớp; 48 pattern không lookahead/backreference |
| Agent schema | ajv compile strict + `check_schema` | PASS: 64 schema; 6 envelope mẫu hợp lệ, 10 envelope không hợp lệ bị từ chối (cả ajv và Python) |
| Evil inputs | trong `check_contracts.py` | PASS: **93 vector** (82 tầng schema cho kết quả đúng, 11 tầng nghiệp vụ để dành cho test Phase 3–6) |
| HTML docs | `make contracts-docs` | PASS: admin 657 KiB, portal 442 KiB (không commit) |
| Docs repo | `make structure` + `make docs-check` | PASS: lint 0 lỗi, 92 link, 8 khối Mermaid |
| Âm tính (7 ca, bản sao trong scratchpad) | sửa contract rồi chạy `check_contracts.py` | PASS: bắt đúng cả 7: example sai (username chữ hoa), path `/portal/servers`, bỏ Idempotency-Key, 404 không dùng Problem, đảo kỳ vọng vector, thêm `/api/provisioning`, pattern có lookahead |

Phát hiện và sửa trong quá trình làm: Redocly bắt 21 example PATCH thiếu trường bắt buộc → thêm schema `*Patch` (cập nhật một phần); pattern job type không cho chữ số (`fail2ban.update`) → sửa pattern; portal có DNS trái với sitemap → bỏ khỏi portal; thiếu `password:forgot/reset` cho trang quên mật khẩu → bổ sung.

**Chưa kiểm:** codegen TypeScript/PHP từ OpenAPI (Prompt 1.7); thực thi vector tầng nghiệp vụ (Phase 3–6).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.4

- ✓ 2 file OpenAPI + common lint 0 lỗi; 100% operation có body có example (yêu cầu ≥ 95%)
- ✓ Agent schemas validate (ajv strict); evil-inputs 93 vector (yêu cầu ≥ 60)
- ✓ `API.md` có mục 0 link tới contracts

## 2026-11-20 — Phase 1 / Prompt 1.3 — nhánh `phase-1`

Môi trường: PostgreSQL 16.15 (Ubuntu 24.04 package) chạy cluster tạm bằng `initdb`/`pg_ctl`; `@dbml/cli` 3.9.0; `@softwaretechnik/dbml-renderer` 1.0.31.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| DBML → SQL | `make db-schema` (gen_dbml.py → dbml2sql → postprocess) | PASS: 78 bảng, không lỗi |
| Sinh xác định | chạy `make db-schema` lần 2, `diff` với lần 1 (DBML và SQL) | PASS: không khác biệt |
| ERD | `make db-erd` | PASS: 9 SVG (`erd-full` + 8 nhóm) |
| Áp schema PG16 | `make db-verify` (itso.sql + extras.sql) | PASS: 78 bảng + 2 partition mặc định |
| Test SQL | `make db-verify` | **PASS: 41/41** (realm 10, hosting 11, domain 6, audit 7, purge 7) |
| Độ phủ migration plan | script so danh sách bảng trong `migration-plan.md` với `itso.sql` | PASS: 78/78, không thiếu, không thừa |
| Docs | `make structure` + `make docs-check` | PASS: lint 0 lỗi, 83 link, 8 khối Mermaid |
| Âm tính: bỏ trigger realm | bản sao repo, xóa `CREATE TRIGGER users_realm_immutable` → `db-verify.sh` | PASS: exit 1, báo đúng test "Đổi realm của user bị từ chối" |

Test SQL bắt buộc theo prompt, đều có trong 41 test: domain trùng bị từ chối và cho phép lại sau soft-delete; UPDATE/DELETE `audit_logs` bị từ chối; đổi realm bị từ chối; gán USER cho user realm admin bị từ chối; xóa hosting account còn website bị từ chối; UID trùng trên cùng server bị từ chối. Bổ sung: purge guard D-46 (đủ 6 điều kiện chặn + 1 trường hợp hợp lệ), chuỗi hash audit, partition theo tháng, package version bất biến, migration cùng server bị từ chối.

**Chưa kiểm:** chạy `db-verify` qua `DB_VERIFY_URL` với PostgreSQL trong docker compose (sẽ có ở Prompt 1.5).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.3

- ✓ DBML convert không lỗi; ERD SVG có trong repo (`database/docs/erd/`)
- ✓ `db-verify.sh` exit 0, 41/41 test SQL pass
- ✓ `DATABASE.md` có mục 0 link tới DBML, SQL, extras, ERD, tài liệu

## 2026-11-20 — Phase 1 / Prompt 1.2 — nhánh `phase-1`

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Markdown lint | `npx markdownlint-cli2@0.17.2` (41 file, trừ `docs/planning/` là bản lịch sử) | PASS: 0 lỗi |
| Link nội bộ | `node scripts/check-links.mjs .` | PASS: 58/58 link hợp lệ |
| Mermaid | `bash scripts/check-mermaid.sh` (mermaid-cli 11.4.2 + Chromium) | PASS: 6/6 khối render được |
| Tổng hợp | `make check` | PASS (structure + docs-check) |
| Âm tính: link hỏng | bản sao repo, thêm link tới file không tồn tại | PASS: exit 1, báo đúng file |
| Âm tính: Mermaid sai | bản sao repo, thêm khối `a -->\|( b` | PASS: exit 1 |
| Âm tính: lint | bản sao repo, thêm `#Sai heading` | PASS: báo 2 lỗi |
| Độ phủ sitemap | script đếm cột Module trong phần Admin | PASS: đủ 30/30 module |

Ghi chú: checker Mermaid đã bắt được 1 lỗi thật trong ARCHITECTURE.md (nhãn cạnh có `--` chưa đặt trong ngoặc kép) và đã sửa.

### Acceptance Prompt 1.2

- ✓ ≥ 10 ADR (10), mỗi ADR có Bối cảnh / Quyết định / Hệ quả / Trạng thái và mã D-xx
- ✓ Sitemap đủ 30 module (Admin) và portal USER
- ✓ Lint + link check + Mermaid check pass

## 2026-11-20 — Phase 1 / Prompt 1.1 — nhánh `phase-1`

Môi trường: Linux (container cloud), GNU Make 4.x, bash, git.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Danh sách lệnh | `make help` | PASS: in 10 target |
| Cấu trúc repo (dương tính) | `make structure` | PASS: exit 0, đủ 22 thư mục + 18 file bắt buộc |
| Cấu trúc repo (âm tính) | bản sao repo, xóa `LICENSE` + track `apps/web/.env` → `bash scripts/check-structure.sh` | PASS: exit 1, báo đúng 2 lỗi (thiếu LICENSE, .env bị track) |
| Git | `git log --oneline` / `git status` | PASS: 2 commit trên `main`, nhánh `phase-1` tạo từ đó; working tree sạch |
| Target chưa hiện thực | `make setup` … | In "chưa hiện thực — Prompt 1.x" (đúng thiết kế) |

**Chưa kiểm:** `scripts/dev.ps1` trên Windows thật (môi trường hiện tại là Linux) — cần chạy thử trên máy Windows có WSL2.
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.1

- ✓ Repo Git local, nhánh `phase-1`, working tree sạch
- ✓ 8 file kế hoạch ở gốc + `CLAUDE.md` + `README.md`
- ✓ `scripts/check-structure.sh` exit 0 (và exit 1 khi thiếu)
- ✓ `PHASE_STATUS.md` cập nhật
