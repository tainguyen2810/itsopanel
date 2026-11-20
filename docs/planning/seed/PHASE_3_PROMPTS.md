# Phase 3 — Auth, RBAC, Users, Packages, Accounts, Jobs, Audit: prompt chi tiết

> Viết ngày 2026-11-20, sau khi Phase 2 hoàn tất và người dùng yêu cầu "merge, lên kế hoạch Phase 3 và thực hiện". Nguồn: `ROADMAP.md` (dòng Phase 3), `docs/planning/11-ROADMAP.md` §Phase 3, `DATABASE.md` + `database/schema/itso.dbml` + `extras.sql`, `database/docs/{lifecycle,ownership,migration-plan}.md`, `contracts/openapi/*`, `contracts/agent-ops/*`, hành vi demo `apps/web/src/demo/handlers/*` (đặc tả sống của Phase 2).
> Nhánh `phase-3`. Không thao tác hệ thống thật: agent là **mock agent** (Phase 4 mới có agent thật). Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.

## Mục tiêu Phase 3

Backend thật (Laravel 13 + PostgreSQL 16 + Redis 7) cho danh tính, phân quyền, người dùng, gói, tài khoản hosting (mức dữ liệu + job tới mock agent), khung Job, Audit, thông báo in-app, cài đặt. Giao diện Admin/Portal chạy với API thật cho các module này (bản build thường, không MSW); module của Phase sau vẫn chạy ở chế độ demo.

## Quyết định kỹ thuật dùng trong Phase 3 (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-58 | Xác thực SPA | Session cookie cùng origin (guard `session` của Laravel, driver database trên bảng `sessions` theo DBML, thêm cột `realm`, `mfa_verified_at`), CSRF double-submit (`GET /auth/csrf` → cookie `XSRF-TOKEN`, client gửi `X-XSRF-TOKEN`). Không cài Sanctum. API token nội bộ (`api_tokens`, SHA-256, scopes, CIDR) qua guard riêng | Admin và Portal cùng origin; bớt một dependency (container chặn codeload GitHub); bảng `sessions`/`api_tokens` đã chốt trong DBML |
| D-58 | MFA | TOTP RFC 6238 tự viết (HMAC-SHA1, 30 s, 6 số, lệch ±1 bước, chống dùng lại mã trong cùng bước), secret mã hóa bằng `Crypt` (APP_KEY), 10 mã khôi phục băm argon2id; kiểm bằng test vector RFC 6238 | Không thêm thư viện; dễ kiểm |
| D-59 | Test backend | Pest chạy trên **PostgreSQL 16** (bỏ SQLite) vì schema dùng trigger, `citext`, `inet`, `jsonb`, partial index, partition; `make test-api` cần PG (`make services-up` hoặc cluster cục bộ), lỗi rõ ràng nếu không có | Test đúng với production; không giả lập schema hai lần |
| D-60 | Job runner | Bảng `jobs`/`job_steps`/`job_logs`; `JobRunner` chạy từng bước gọi `AgentClient` (op có kiểu theo `contracts/agent-ops`), qua queue Redis (`php artisan queue:work`); test dùng queue sync + fake agent; tiến độ xem bằng polling `GET /jobs/{id}` và `GET /jobs/{id}/events?after=` (SSE để Phase 11) | Khớp contract hiện có; chạy được không cần agent thật |

Giữ nguyên: Laravel **không** chạy lệnh hệ thống (`check-no-exec`), mọi thao tác Linux là op agent có kiểu; Hosting Provisioning Service là điểm vào duy nhất cho account (D-49); contract trước code (`make contracts` → `make codegen`).

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 3.1 | Schema Phase 3 bằng Laravel migrations (26 bảng + trigger/CHECK của extras.sql), model, factory, Pest trên PostgreSQL, so khớp schema với đặc tả | 1 ngày |
| 3.2 | Auth: CSRF, đăng nhập theo realm, khóa lũy tiến, MFA TOTP + mã khôi phục, step-up, phiên, đổi/quên/đặt lại mật khẩu, IP allowlist Admin, API token | 1 ngày |
| 3.3 | RBAC + phạm vi + Policies, Users API (lock/unlock/reset MFA, scopes, impersonate có lý do), roles, ma trận quyền | 1 ngày |
| 3.4 | Jobs framework + mock agent op account/quota, idempotency, audit append-only (hash chain) + xuất CSV, thông báo in-app, settings, servers (đọc, seed local), dashboard summary | 1 ngày |
| 3.5 | Gói + phiên bản bất biến, tài khoản hosting qua Hosting Provisioning Service (provision/suspend/unsuspend/terminate/đổi gói), UID, quota phía panel, API Portal (account, overview, profile, job, thông báo) | 1 ngày |
| 3.6 | Nối UI vào API thật, DemoSeeder, Playwright e2e trên stack thật, `make check`, báo cáo Phase 3, merge | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit Conventional Commits `feat(p3)`, `test(p3)`, `docs(p3)`; đồng bộ bản sao lưu.

---

## Prompt 3.1 — Schema và nền backend

```
[ITSO Panel] Prompt 3.1 — Migrations Phase 3, model, Pest trên PostgreSQL
Phạm vi: migrations cho 26 bảng Phase 3 theo database/docs/migration-plan.md (identity, servers, agents,
hosting_packages, hosting_package_versions, hosting_accounts, account_lifecycle_events, uid_allocations,
jobs, job_steps, job_logs, audit_logs (partition tháng), notifications, settings, impersonation_sessions,
tos_acceptances); phần extras.sql của các bảng này (trigger realm bất biến, role đúng realm, package
version bất biến, audit append-only + hash chain, CHECK vòng đời/purge_after ≥ 30 ngày); model Eloquent
(uuid public, cast), factory; Pest chạy trên PostgreSQL 16 (D-59), RefreshDatabase.
Kiểm thử: so khớp schema migrate với itso.sql + extras.sql cho 26 bảng (script so sánh cột, kiểu, null,
default, index, constraint, trigger); chạy lại database/tests liên quan trên DB đã migrate; Pest
model/trigger (đổi realm bị chặn, sửa audit bị chặn, sửa package version bị chặn).
```

## Prompt 3.2 — Xác thực

```
[ITSO Panel] Prompt 3.2 — Auth theo realm, MFA, phiên, mật khẩu, API token
Phạm vi: /auth/csrf, /auth/login (realm theo đường vào: /admin chỉ user realm admin, /portal chỉ realm
portal; sai realm trả lỗi như sai mật khẩu), khóa lũy tiến theo email + IP (login_attempts), argon2id,
/auth/logout, /auth/me (user, quyền, phạm vi, mfa), MFA TOTP enroll/confirm/verify + mã khôi phục,
SUPER_ADMIN bắt buộc MFA trước mọi thao tác, /auth/step-up (thao tác nhạy cảm), /auth/sessions
(list, thu hồi), password change/forgot/reset (mail driver log, token một lần, hết hạn 60 phút),
IP allowlist chặn realm admin (bảng ip_allowlist), guard API token (SHA-256, scopes, CIDR, hết hạn).
Kiểm thử: Pest mọi endpoint auth khớp OpenAPI (response validate bằng schema); test vector TOTP
RFC 6238; khóa sau N lần sai; phiên realm admin không gọi được API portal và ngược lại; CSRF thiếu → 419.
```

## Prompt 3.3 — Phân quyền và người dùng

```
[ITSO Panel] Prompt 3.3 — RBAC, phạm vi ADMIN, Policies, Users API
Phạm vi: seed roles/permissions (SUPER_ADMIN *, ADMIN theo phạm vi, USER own.*), Policies cho mọi
model Phase 3, global scope Portal (owner_user_id = user hiện tại), phạm vi ADMIN (server |
hosting_account qua user_scopes); /users (list lọc, tạo, sửa, lock/unlock, reset MFA, scopes PUT),
/roles; /users/{id}:impersonate (chỉ SA, lý do bắt buộc, chỉ USER portal đang hoạt động,
impersonation_sessions, audit); luôn còn ít nhất một SUPER_ADMIN; ADMIN chỉ tạo/sửa user portal trong phạm vi.
Kiểm thử: ma trận quyền tự động (mọi endpoint Phase 3 × SA/AD-trong-phạm-vi/AD-ngoài/US-chủ/US-khác):
USER đọc tài nguyên người khác → 404, ADMIN ngoài phạm vi → 404, thiếu quyền → 403.
```

## Prompt 3.4 — Job, agent mock, audit, thông báo, cài đặt

```
[ITSO Panel] Prompt 3.4 — Jobs framework, idempotency, audit, notifications, settings
Phạm vi: JobRunner (D-60): job nhiều bước, mỗi bước một op agent có kiểu, retry/cancel/timeout,
job_logs; mock agent (Go) thêm op account.ensure/suspend/unsuspend/remove, quota.apply/report
(validate theo schema, kết quả theo struct sinh); /jobs (list, chi tiết, logs, events?after=, cancel,
retry) cho admin và portal (portal chỉ job của account mình); middleware Idempotency-Key (cùng key +
cùng body → trả lại kết quả cũ; khác body → 422); audit middleware + service (append-only, hash chain,
không ghi secret), /audit-logs lọc + /audit-logs/export CSV (chống chèn công thức); notifications in-app
(list, read, read-all); /settings/{group} (chỉ SA, không trả secret); /servers (đọc, server local seed
từ cấu hình) và /dashboard/summary phần dữ liệu panel.
Kiểm thử: Pest job thành công/lỗi/retry/cancel với fake agent; Go test op mock theo schema; idempotency;
audit không sửa/xóa được và chuỗi hash hợp lệ; CSV; notifications theo user.
```

## Prompt 3.5 — Gói và tài khoản hosting

```
[ITSO Panel] Prompt 3.5 — Packages, Hosting Provisioning Service, Accounts, API Portal
Phạm vi: /hosting-packages (CRUD, mỗi lần sửa giới hạn tạo phiên bản mới bất biến, /versions,
migrate-accounts sang phiên bản mới qua job); Hosting Provisioning Service (D-49): tạo account (kiểm
username, server nhận account, cấp UID không tái dùng 90 ngày, job account.ensure + quota.apply),
suspend (lý do bắt buộc) / unsuspend / terminate (purge_after = terminated_at + retention ≥ 30 ngày,
legal_hold) / khôi phục trong thời gian giữ / change-package; account_lifecycle_events; /features
(D-57), /usage (đếm phía panel + số đo gần nhất), /lifecycle-events; quota phía panel (QuotaService:
vượt giới hạn → 422 code quota_exceeded, dùng lại ở Phase 5–6); API Portal: hosting-accounts,
overview, profile, jobs, notifications. schedule/confirm purge và migrate: trả 501 có mã rõ ràng
(Phase 8/9) — không giả vờ thành công.
Kiểm thử: Pest state machine (chuyển hợp lệ/không hợp lệ), job provision với fake agent → active,
lỗi → failed → retry, quota 422, phiên bản gói bất biến, portal chỉ account của mình.
```

## Prompt 3.6 — Nối giao diện, e2e, báo cáo

```
[ITSO Panel] Prompt 3.6 — UI với API thật, DemoSeeder, e2e, báo cáo Phase 3
Phạm vi: client gửi CSRF + xử lý 401/419 (về trang đăng nhập đúng realm), session thật thay persona
demo ở bản build thường; DemoSeeder nạp dataset demo cho các bảng Phase 3 (người dùng mẫu có mật khẩu
dev, MFA tắt trừ SA dùng secret dev ghi trong runbook); `make dev` chạy web + api + queue + mock agent;
module Phase sau hiện trạng thái "chưa có ở bản này" thay vì lỗi khi chạy với API thật.
Kiểm thử: Playwright trên stack thật (Laravel + PG + Redis + mock agent): đăng nhập Admin có MFA,
tạo user portal, tạo gói, tạo account → job → active, khóa/mở; đăng nhập Portal → chỉ thấy account của
mình; sai realm bị từ chối. `make check` xanh; docs/reports/phase-3.md; runbook phase-3-demo.md;
merge phase-3 → main (local); DỪNG trước Phase 4.
Tiêu chí nghiệm thu Phase 3 (11-ROADMAP): USER không đọc được tài nguyên người khác (404) qua bất kỳ
endpoint nào; ADMIN chỉ thấy phạm vi; SA bắt buộc MFA; vượt quota bị từ chối 422; job retry/cancel
hoạt động với mock; coverage backend module Phase 3 ≥ 80% (đo bằng pcov/xdebug nếu cài được trong
môi trường; nếu không, ghi rõ trong báo cáo và thay bằng danh sách endpoint/nhánh đã có test).
```
