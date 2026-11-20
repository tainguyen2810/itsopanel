# TEST_REPORT — ITSO Panel

> Cập nhật cuối mỗi prompt và cuối mỗi Phase. Ghi lệnh chạy thật và kết quả thật.

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
