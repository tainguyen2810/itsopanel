# Báo cáo Phase 2 — Complete UI Demo (Admin Panel + User Hosting Portal)

- **Trạng thái:** ✓ hoàn tất. Nhánh `phase-2`, merge `--no-ff` vào `main` ở Git local (không push, không remote).
- **Thời gian:** 2026-11-20.
- **Phạm vi giữ đúng:** giao diện chạy trên API giả lập (MSW) theo đúng OpenAPI; Laravel không có code nghiệp vụ mới; không thao tác hệ thống thật, không deploy. Không có trang mua hàng/thanh toán (OUT OF SCOPE); Public Provisioning API: DEFERRED.

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 2.1 Nền demo | Dữ liệu demo mở rộng và kiểm nhất quán (`check_demo`), API giả lập MSW theo OpenAPI (validate response bằng ajv trong test), router TanStack theo sitemap, nút Demo đổi vai trò, khung trang (`ListPage`, `DetailPage`, `FormDialog`, wizard), `make dev-demo` / `build-demo` | 820114e, 87c2fe0, 69f6b18 |
| 2.2 Admin chung | Dashboard, Jobs (drawer theo dõi job), Hồ sơ, Ctrl+K, đăng nhập/MFA, wizard cài đặt | 2b71414 |
| 2.3 Hạ tầng | Server (+ chi tiết, dịch vụ, tường lửa tự hoàn tác), Docker, Compose, Registry | 63b40ab |
| 2.4 Hosting I | Gói (phiên bản bất biến, so sánh), tài khoản hosting (vòng đời, terminate → purge 2 người, chuyển server) | be4a5a0 |
| 2.5 Hosting II | Website, database, File Manager, SFTP/SSH, SSL, DNS, cron, WordPress, Git deploy (D-56) | 01e004e, b067733, 3887735 |
| 2.6 Quản trị | Bảo mật (WAF, mã độc, SSH, fail2ban, FIM, IP được phép), sao lưu 3-2-1-1-0, khôi phục (wizard), người dùng/phạm vi/impersonate, vai trò, giám sát, audit (CSV), thông báo, cài đặt | 715bebf, 957f0f8 |
| 2.7 User Portal | 18 route mục B sitemap; trang dùng chung với Admin qua `shared/api/realm.ts`; chỉ dữ liệu của user đang đăng nhập; tính năng gói (D-57) | 3ab0fe1 |
| 2.8 Kiểm tra tổng | Kiểm mọi route (axe, 390px, EN), số liệu nhất quán, 56 ảnh trang chính, bản demo tĩnh, báo cáo này | (commit 2.8) |

Tổng: Admin 56 trang (58 route, 2 route chuyển hướng), Portal 18 trang, mọi mục sidebar mở trang có nội dung thật (không "coming soon").

## 2. File chính

| Phần | Vị trí |
|---|---|
| API giả lập (MSW, theo OpenAPI) | `apps/web/src/demo/` (`handlers/*.ts`, `router.ts`, `scope.ts`) |
| Route + trang Admin | `apps/web/src/entries/admin/` (`routes.ts`, `pages.ts`, thư mục theo nhóm) |
| Route + trang Portal | `apps/web/src/entries/portal/` |
| Trang dùng chung Admin/Portal | `apps/web/src/shared/hosting/pages/`, `apps/web/src/shared/pages/` |
| Lớp API theo realm | `apps/web/src/shared/api/{core,realm,useAction}.ts` |
| Khung trang | `apps/web/src/shared/page/` |
| Ảnh | `docs/screenshots/phase-2/` (14 trang × 1440/390 × light/dark), `docs/screenshots/design-system/` |
| Runbook | `docs/runbooks/demo.md` |

## 3. Cách chạy thử

```bash
make dev-demo        # http://127.0.0.1:5173/admin/ và /portal/ (không cần Laravel/PostgreSQL/agent)
make build-demo      # bản tĩnh ở apps/web/dist-demo (kiểm build thường không chứa MSW)
make screenshots     # chụp lại ảnh Design System + trang chính Phase 2
```

Bản `dist-demo` chạy trên server tĩnh bất kỳ (đã thử `python3 -m http.server`: mở `/admin/`, `/portal/`, điều hướng sidebar, dữ liệu giả lập hiện đúng). Tải lại trực tiếp một đường dẫn sâu (vd. `/admin/websites`) cần server trả `index.html` của entry tương ứng (Nginx `try_files $uri /admin/index.html`), như mọi SPA.

Dữ liệu demo nằm trong bộ nhớ trình duyệt: tải lại trang thì về dữ liệu gốc. Nút **Demo** trên topbar đổi người dùng mẫu (Admin: 2 Super Admin, 1 Admin có phạm vi; Portal: 3 user).

## 4. Kết quả test

`make check` (2026-11-20, PostgreSQL 16 + Redis 7 chạy cục bộ):

| # | Bước | Kết quả | Ghi chú |
|---|---|---|---|
| 1 | structure | PASS | |
| 2 | docs-check | PASS (chạy lại) | lần đầu FAIL: bảng TEST_REPORT có dấu gạch đứng trong code span → sửa, chạy lại PASS |
| 3 | check-ci | PASS | 7 job |
| 4 | db-verify | PASS | 41 test SQL |
| 5 | contracts-check | PASS | admin 220 op, portal 101 op |
| 6 | codegen-check | PASS | |
| 7 | tokens-check | PASS | 84/84 cặp tương phản AA |
| 8 | lint-web | PASS | ESLint (ranh giới realm), Prettier, tsc, i18n 2476 key vi = en |
| 9 | test-web | PASS | Vitest 457 test |
| 10 | build-web | PASS | |
| 11 | build-demo | PASS | build thường không có MSW |
| 12 | test-e2e | PASS | Playwright 259 test |
| 13 | lint-api | PASS | pint, phpstan |
| 14 | test-api | PASS | Pest 14 test |
| 15 | test-api-pg | PASS (chạy lại) | lần đầu FAIL vì chưa tạo database `itso_test` trên cluster tạm → tạo, chạy lại 14/14 PASS |
| 16 | no-exec | PASS | |
| 17 | lint-agent | PASS | |
| 18 | staticcheck | SKIP | chưa cài được trong container (như Phase 1) |
| 19–21 | test-agent, test-fuzz, build-agent | PASS | fuzz 212.940 lần |
| 22 | git-clean | PASS | không phát sinh thay đổi |

Playwright 259 gồm: smoke 74 route; kiểm tra tổng 74 route (axe light + dark 0 lỗi critical/serious, không tràn ngang 390px, giao diện EN không lẫn tiếng Việt ngoài dữ liệu); luồng nghiệp vụ demo (tạo account/website, File Manager, DNS, cron, Git, wizard khôi phục, audit CSV, đổi user Portal); 56 ảnh trang chính; Design System.

Vitest 457 gồm: API giả lập theo OpenAPI cho mọi operation đã đăng ký; cô lập dữ liệu Portal; số liệu nhất quán; Portal không gọi `/admin/`; form/zod; thư viện cron, DNS, đường dẫn file, CSV, quyền.

## 5. Tiêu chí nghiệm thu Phase 2

| Tiêu chí | Kết quả | Bằng chứng |
|---|---|---|
| Mọi mục sidebar mở trang có nội dung thật | ✓ | `e2e/demo-smoke.spec.ts` (74 route có H1, không 404/403, không lỗi console/API) |
| Đổi VI/EN không còn chuỗi cứng | ✓ | `e2e/demo-audit.spec.ts` (EN trên 74 route); `check-i18n` vi = en |
| Dark/Light đúng | ✓ | axe light + dark 74 route; ảnh `docs/screenshots/phase-2/*-dark.png` |
| Không tràn ngang 390px | ✓ | `e2e/demo-audit.spec.ts` (74 route) |
| Số liệu nhất quán giữa các trang | ✓ | `src/demo/__tests__/consistency.test.ts`: dashboard = tổng danh sách; số account theo server/gói; usage = số website/DB/SFTP/cron; Portal = Admin; tạo website → usage, dashboard, danh sách cùng tăng |
| Screenshot trong repo | ✓ | 56 ảnh `docs/screenshots/phase-2/`, 14 ảnh Design System |
| Bản demo tĩnh build được | ✓ | `make build-demo` + thử trên server tĩnh |
| Báo cáo | ✓ | file này |

## 6. Lỗi tìm thấy ở 2.8 và đã sửa

- Đổi người dùng demo chỉ xóa cache, trang đang mở vẫn hiện dữ liệu người trước → tải lại ngay (`resetQueries`).
- Chuông thông báo là số cố định → đếm từ dữ liệu thật.
- axe: nút "Đã đọc" và link trạng thái khôi phục có nhãn không chứa chữ hiển thị; bộ lọc Thông báo dùng tab không có panel (`aria-controls` sai) → nhóm nút `aria-pressed`; link "Quên mật khẩu"/"Quay lại đăng nhập" thiếu tương phản ở dark và vùng bấm < 24px.
- Select đổi uncontrolled → controlled ở 4 trang.

## 7. Quyết định mới (ĐỀ XUẤT, chờ duyệt)

- **D-56** — Đặc tả sớm Git deploy (bảng `git_repositories`, `git_deployments`, API `/git-repositories*`, op `git.deploy`/`git.rollback`) để có giao diện demo; hiện thực ở Phase 10.
- **D-57** — `GET /hosting-accounts/{id}/features` (admin + portal): tập con an toàn của giới hạn gói hiện hành cho Portal (PHP, worker, SSH, chu kỳ cron, quota/retention backup), không lộ `PackageLimits` đầy đủ.

## 8. Rủi ro và việc còn lại

- Giao diện mới chạy trên API giả lập; Phase 3 nối dần sang Laravel thật (auth, RBAC, user, gói, account, job, audit). Hành vi demo (`src/demo/handlers`) là đặc tả sống cho backend, cần giữ đồng bộ với contract.
- `staticcheck`/`actionlint` chưa chạy được trong container; CI GitHub chưa chạy lần nào (chưa có remote, D-51).
- Đếm thông báo chưa đọc trên topbar lấy trang đầu (tối đa 200) của danh sách; Phase 11 nên có endpoint đếm riêng.
- Ảnh trang chính lớn (≈ 13,5 MB, PNG 2x); có thể giảm khi kết nối GitHub (LFS hoặc 1x).

## 9. Đề xuất Phase 3

Theo `ROADMAP.md`: Auth (session SPA, MFA TOTP, khóa lũy tiến), RBAC + phạm vi + Policies, Users, Packages + phiên bản, Hosting Accounts + Hosting Provisioning Service (job gọi mock agent), Jobs framework, idempotency, audit append-only, thông báo in-app, settings; nối UI các module này vào API thật. Kế hoạch chi tiết: `docs/planning/seed/PHASE_3_PROMPTS.md`.
