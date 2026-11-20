# 12 — Prompt triển khai cho Claude Code & cơ chế lưu tiến độ

## 1. Cơ chế lưu tiến độ (chống mất phiên / mất điện)

| File (gốc repo) | Vai trò | Ai cập nhật, khi nào |
|---|---|---|
| `PROJECT_PLAN.md` | Mục tiêu, phạm vi, nguyên tắc, link tới docs/planning | Hiếm khi; chỉ khi bạn duyệt thay đổi phạm vi |
| `ARCHITECTURE.md` | Kiến trúc hiện hành (không phải kế hoạch) | Khi kiến trúc đổi (kèm ADR) |
| `ROADMAP.md` | 12 Phase, trạng thái tổng | Cuối mỗi Phase |
| `PHASE_STATUS.md` | **Nguồn sự thật cho "đang ở đâu"**: Phase hiện tại, prompt hiện tại, checklist task (✓/✱/○), commit cuối, việc tiếp theo, blocker | **Sau mỗi task hoàn thành** (commit cùng code) |
| `DECISIONS.md` | Danh sách quyết định D-xx (trạng thái: Proposed/Accepted/Superseded) | Khi có quyết định mới |
| `TEST_REPORT.md` | Kết quả test mới nhất mỗi Phase, lệnh chạy, số liệu | Cuối mỗi prompt và cuối Phase |
| `CLAUDE.md` | Quy tắc làm việc cho Claude Code (đọc tự động mỗi phiên) | Khi quy tắc đổi |

**Quy trình phiên mới (ghi trong `CLAUDE.md`):**
1. Đọc `PHASE_STATUS.md` → biết Phase/prompt/task hiện tại.
2. Chạy `git status` + `git log -5` → đối chiếu commit cuối ghi trong `PHASE_STATUS.md`. Nếu có thay đổi chưa commit: xem lại, chạy test, rồi commit hoặc hoàn tác (hỏi người dùng nếu không chắc).
3. Tiếp tục task đang `✱`. Không bắt đầu task ngoài prompt hiện tại.

**Quy tắc chống mất việc:** commit nhỏ sau mỗi task (Conventional Commits, `feat(p3): …`), push lên nhánh `phase-N/<prompt-id>`; mỗi prompt = 1 PR; merge vào `main` khi bạn duyệt. Mất điện giữa task chỉ mất phần chưa commit của một task.

## 2. Mẫu prompt chuẩn (mọi prompt đều theo khung này)

```
[ITSO Panel] Prompt <P>.<n> — <tên>

Bối cảnh: Đọc CLAUDE.md, PHASE_STATUS.md, ARCHITECTURE.md và docs/planning/<file liên quan>.
Phase hiện tại: <P>. Chỉ làm phạm vi dưới đây. Không chuyển Phase.

Phạm vi:
- ...
Ngoài phạm vi:
- ...
Ràng buộc:
- Không phá test/chức năng của Phase trước.
- Cập nhật contracts trước code.
- Laravel không được chạy lệnh hệ thống.
Tiêu chí hoàn thành:
- ...
Kiểm thử bắt buộc:
- ...
Tài liệu:
- ...
Hướng dẫn chạy thử: tạo/cập nhật docs/runbooks/phase-<P>-demo.md
Kết thúc:
- Cập nhật PHASE_STATUS.md, TEST_REPORT.md (và DECISIONS.md nếu có).
- Báo cáo: đã làm, file chính, cách chạy thử, kết quả test, rủi ro/việc còn lại.
- DỪNG và chờ duyệt.
```

## 3. Danh sách prompt theo Phase

> **Cập nhật 2026-11-20:** theo roadmap 15 Phase (`15-HOSTING-PROVIDER.md` §12), tổng khoảng **60 prompt**. Prompt Phase 1 bên dưới vẫn giữ, bổ sung: 1.3 phải tạo thêm `contracts/openapi/itso-provisioning-v1.yaml` (khung) và tách route `admin`/`portal`. Bảng dưới đây là bản cũ cho Phase 2–12, sẽ được đánh số lại khi viết chi tiết.

| Phase | Prompt | Nội dung chính |
|---|---|---|
| 1 | 1.1 | Repo skeleton, file tiến độ, CLAUDE.md, ADR đầu tiên |
| 1 | 1.2 | `apps/web` + `apps/api` scaffold, dev env, health endpoint |
| 1 | 1.3 | `agent/` mock agent, `contracts/`, codegen, CI |
| 2 | 2.1 | Design tokens, theme, i18n, app shell, router, role switcher demo |
| 2 | 2.2 | Component chung (DataTable, Form, Dialog, JobProgress, Charts) + Dashboard theo mockup |
| 2 | 2.3 | Trang module nhóm Hosting (Website, DB, File, FTP, DNS/SSL, Cron, PHP, Nginx, WordPress, Git) |
| 2 | 2.4 | Trang module nhóm Hệ thống (Server, Security*, Backup/Restore, Software, Docker*, Monitoring, Terminal) |
| 2 | 2.5 | Trang Quản trị (Users, Packages, Accounts, Audit, Notifications, Settings, Wizard) + MSW + demo dataset |
| 2 | 2.6 | Playwright screenshots 4 biến thể, a11y, báo cáo |
| 3 | 3.1 | Schema identity + Auth (login, MFA, sessions, reset) |
| 3 | 3.2 | RBAC, scopes, Policies, Users API, test ma trận quyền |
| 3 | 3.3 | Packages + Accounts API, quota phía panel |
| 3 | 3.4 | Jobs framework, AgentClient (mock), idempotency, audit append-only, notifications in-app, settings |
| 3 | 3.5 | Nối UI vào API thật, DemoSeeder, Playwright e2e |
| 4 | 4.1 | Spike cgroup/slice/quota trên VM → ADR |
| 4 | 4.2 | Agent core: transport, HMAC+peercred, registry, policy, audit cục bộ |
| 4 | 4.3 | Ops system/service/account/quota/metrics/software (recipe) |
| 4 | 4.4 | `itso` CLI + release packaging + ký + `install.sh` |
| 4 | 4.5 | Runtime FrankenPHP + systemd units + Wizard + nối Server/Dashboard thật |
| 4 | 4.6 | VM test harness, test enforcement, update/rollback/uninstall test |
| 5 | 5.1 | Recipes Nginx/PHP + wizard bước stack |
| 5 | 5.2 | Website + Nginx vhost (template, test, rollback) |
| 5 | 5.3 | PHP-FPM per account + PHP Manager |
| 5 | 5.4 | SSL ACME (lego) + renew + Pebble CI |
| 6 | 6.1 | Database Manager (MySQL/MariaDB/PG) |
| 6 | 6.2 | File Manager (agent fs hạ quyền + openat2) |
| 6 | 6.3 | File Manager UI (upload resumable, editor, archive) |
| 6 | 6.4 | SFTP/SSH keys + Cron (systemd timers) |
| 7 | 7.1 | Firewall nftables safe-apply + IP allowlist |
| 7 | 7.2 | SSH hardening + Fail2ban |
| 7 | 7.3 | WAF (xác minh package) |
| 7 | 7.4 | Malware (ClamAV/YARA/quarantine) + FIM |
| 7 | 7.5 | Gateway + Terminal + security score/events |
| 8 | 8.1 | Destinations + restic runner + policies |
| 8 | 8.2 | DB/config/panel backup + verification |
| 8 | 8.3 | Restore (site/DB/file) + Restore wizard |
| 8 | 8.4 | Cross-server restore + DR runbook + `--restore` + release v0.1.0-alpha |
| 9 | 9.1 | Docker install recipe, daemon.json, DOCKER-USER, port allocation |
| 9 | 9.2 | Containers/images/volumes/networks/registries |
| 9 | 9.3 | Compose validator + projects + reverse proxy + volume backup |
| 10 | 10.1 | WordPress Toolkit |
| 10 | 10.2 | Software catalog mở rộng + app runtime |
| 10 | 10.3 | DNS provider + Git deployment |
| 11 | 11.1 | Metrics storage/rollup + alerts + kênh thông báo |
| 11 | 11.2 | mTLS transport, CA nội bộ, enrollment, rotation |
| 11 | 11.3 | Multi-server UI/flows + test 3 VM |
| 12 | 12.1 | Security review/pentest + fix |
| 12 | 12.2 | Performance + chaos (update/mất điện) |
| 12 | 12.3 | Import/migration + offline installer + tài liệu vận hành |

| 9 (mới) | 9.1–9.5 | Customer portal & sub-users · Support access & abuse cases · Wizard tạo khách hàng thủ công & nhắc hạn hợp đồng · Branding & thông báo khách · Pentest độc lập & sửa lỗi |

(Phase 9–12 trong bảng trên trở thành 10–13.)

**Tổng: ~51 prompt.** Prompt chi tiết của Phase 2 trở đi sẽ được viết đầy đủ (theo mẫu §2) **khi Phase trước được duyệt**, vì nội dung phụ thuộc kết quả thực tế. Dưới đây là prompt đầy đủ cho Phase 1.

---

## 4. Prompt Phase 1 (đầy đủ)

> **Đã thay thế (2026-11-20):** dùng `seed/PHASE_1_PROMPTS.md` (7 prompt theo phạm vi Phase 1 đã duyệt). Ba prompt dưới đây chỉ là lịch sử.

### Prompt 1.1 — Repository skeleton & cơ chế tiến độ

```
[ITSO Panel] Prompt 1.1 — Repository skeleton & cơ chế tiến độ

Bối cảnh: Repository mới cho ITSO Panel. Kế hoạch đã duyệt nằm ở docs/planning/
(đặc biệt 02-ARCHITECTURE.md §7, 11-ROADMAP.md, 12-PHASE-PROMPTS.md §1).
Phase hiện tại: 1 (Foundation). Chỉ làm phạm vi dưới đây. Không chuyển Phase.

Phạm vi:
- Tạo cây thư mục: apps/web, apps/api, agent, contracts/openapi, contracts/agent-ops,
  contracts/test-vectors, installer, packaging, demo, docs/{adr,runbooks,screenshots,ui}
  (thư mục rỗng có README.md ngắn mô tả mục đích).
- Tạo ở gốc: PROJECT_PLAN.md, ARCHITECTURE.md, ROADMAP.md, PHASE_STATUS.md,
  DECISIONS.md, TEST_REPORT.md — khởi tạo từ docs/planning/seed/ và docs/planning/.
- CLAUDE.md: quy trình phiên mới, quy tắc commit, cấm Laravel chạy lệnh hệ thống,
  "không chuyển Phase", "contracts trước code", lệnh test của từng phần.
- .editorconfig, .gitignore (node, php, go, env, build), .gitattributes (LF).
- docs/adr/0001-record-architecture-decisions.md và 0002-monorepo-layout.md.
- Makefile gốc với target giữ chỗ: help, dev, test, lint, build (in "chưa có" nếu phần đó chưa tồn tại).
Ngoài phạm vi: scaffold Laravel/React/Go (prompt 1.2, 1.3), cài dependency.
Tiêu chí hoàn thành:
- `make help` chạy được trên Ubuntu và WSL2.
- PHASE_STATUS.md thể hiện Phase 1, prompt 1.1 ✓, 1.2 ○, 1.3 ○.
Kiểm thử: chạy `make help`; kiểm tra markdown lint (nếu có markdownlint qua npx thì dùng, không bắt buộc).
Tài liệu: README.md gốc (giới thiệu, cấu trúc, trạng thái alpha, link docs).
Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG chờ duyệt.
```

### Prompt 1.2 — Scaffold Web & API, môi trường dev

```
[ITSO Panel] Prompt 1.2 — Scaffold apps/web, apps/api và môi trường dev

Bối cảnh: Đọc CLAUDE.md, PHASE_STATUS.md, docs/planning/01 và 02.
Phase hiện tại: 1. Chỉ làm phạm vi dưới đây.

Phạm vi:
- apps/web: Vite + React + TypeScript (strict) + Tailwind CSS + shadcn/ui init + Lucide;
  cài sẵn (chưa dùng nhiều): TanStack Query, TanStack Router (hoặc React Router — theo D-05),
  i18next, react-hook-form, zod, Recharts. ESLint (cấm dangerouslySetInnerHTML), Prettier, Vitest.
  Một trang "ITSO Panel — Foundation" gọi GET /api/v1/system/health và hiển thị kết quả.
- apps/api: Laravel (bản ổn định mới nhất hỗ trợ PHP 8.3+), cấu hình pgsql + redis qua .env,
  route /api/v1/system/health và /api/v1/system/version (JSON), Pest, Larastan level 6+,
  Pint, rule CI cấm exec/shell_exec/proc_open/system/passthru/backtick trong app/.
  Định dạng lỗi RFC 9457 (handler cơ bản).
- docker-compose.dev.yml: PostgreSQL 16 + Redis 7 (CHỈ dev, ghi rõ trong README).
- docs/runbooks/dev-setup.md: Ubuntu 24.04 và Windows (WSL2), không dùng Docker cũng được
  (cài PG/Redis native).
- Makefile: dev (chạy web + api), test, lint cho 2 phần.
Ngoài phạm vi: auth, DB schema nghiệp vụ, UI thật (Phase 2/3), agent.
Tiêu chí hoàn thành:
- `make dev` → mở web thấy health "ok" từ API.
- `make test` và `make lint` xanh cho web và api.
Kiểm thử: Vitest 1 test component; Pest test health/version; test handler problem+json cho 404.
Tài liệu: README trong apps/web, apps/api; cập nhật dev-setup.md.
Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG chờ duyệt.
```

### Prompt 1.3 — Contracts, Mock Agent, Codegen, CI

```
[ITSO Panel] Prompt 1.3 — Contracts, Mock Agent, codegen và CI

Bối cảnh: Đọc CLAUDE.md, PHASE_STATUS.md, docs/planning/02 §9, 05, 06 §2–3.
Phase hiện tại: 1. Chỉ làm phạm vi dưới đây.

Phạm vi:
- contracts/openapi/itso-api-v1.yaml (OpenAPI 3.1): info, servers, security schemes
  (cookie + bearer), components chung (Problem, Pagination, Job, JobStep), path system/health,
  system/version. Lint bằng Redocly hoặc Spectral.
- contracts/agent-ops/: envelope.schema.json ({op, op_id, version, params, deadline,
  requested_by, trace_id}), result.schema.json, và schema cho system.ping, system.info.
- contracts/test-vectors/evil-inputs.json: domain, username, path độc hại (dùng ở Phase sau).
- agent/: Go module; internal/transport (HTTP JSON trên unix socket ở Linux, TCP 127.0.0.1
  ở Windows — chỉ cho mock), internal/ops/registry (đăng ký op + validate schema),
  cmd/itso-mock-agent phục vụ system.ping, system.info (dữ liệu giả từ demo/),
  từ chối op không đăng ký với lỗi typed. KHÔNG có op nào chạy lệnh hệ thống.
- Codegen: script sinh TS types (apps/web/src/api/generated) và Go structs từ schema;
  `make codegen`; CI kiểm tra không diff.
- apps/api: AgentClient interface + MockAgentClient gọi mock agent; test tích hợp ping.
- .github/workflows/ci.yml: jobs web (lint, test, build), api (pint, larastan, pest với
  service PG+Redis), agent (go vet, staticcheck, go test -race), contracts (lint, codegen diff).
Ngoài phạm vi: agent thật, op đặc quyền, auth.
Tiêu chí hoàn thành:
- `make dev` chạy thêm mock agent; trang Foundation hiển thị cả health API và ping agent.
- CI xanh trên nhánh.
Kiểm thử: go test registry (op lạ bị từ chối, schema sai bị từ chối); fuzz test nhỏ cho
  envelope parser; Pest test AgentClient với mock.
Tài liệu: agent/README.md (kiến trúc mock, cách thêm op), contracts/README.md.
Kết thúc: cập nhật PHASE_STATUS.md (Phase 1 hoàn tất, chờ duyệt), TEST_REPORT.md,
  ROADMAP.md; viết báo cáo cuối Phase 1 (docs/reports/phase-1.md); DỪNG chờ duyệt.
```

## 5. Mẫu báo cáo cuối Phase (`docs/reports/phase-N.md`)
```
# Báo cáo Phase N — <tên>
- Ngày, commit/tag
- Mục tiêu & phạm vi đã làm / chưa làm (lý do)
- Thay đổi chính: DB, API, UI, Agent ops
- Kết quả test (bảng: bộ test, số test, pass/fail, coverage)
- Acceptance criteria: từng tiêu chí ✓/✗ + bằng chứng (lệnh, screenshot)
- Quyết định mới (D-xx), rủi ro mới, nợ kỹ thuật
- Hướng dẫn chạy thử
- Đề xuất cho Phase tiếp theo (không tự bắt đầu)
```
