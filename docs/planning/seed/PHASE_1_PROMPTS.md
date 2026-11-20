# PHASE 1 PROMPTS — Foundation, Architecture, Database, API Contracts, Design System

> Đã duyệt theo kế hoạch ngày 2026-11-20 (D-51, D-52). **Chỉ bắt đầu khi người dùng ra lệnh.** Chạy từng prompt theo thứ tự. Cuối mỗi prompt: cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`, commit, báo cáo và **DỪNG chờ duyệt**.

## Mục tiêu Phase 1
Có một repository chạy được trên Windows (WSL2) và Ubuntu, gồm:
- Tài liệu kiến trúc và quyết định nằm ngay trong repo.
- Database schema ở mức đặc tả, đã kiểm chứng trên PostgreSQL thật.
- API contracts (Admin, Portal, Agent) là nguồn sự thật, có lint và codegen.
- Khung web/api/agent, mock agent.
- **Design System** đủ để Phase 2 dựng toàn bộ demo UI.
- CI chạy tất cả kiểm tra trên.

**Không có** trong Phase 1: tính năng nghiệp vụ, auth thật, migrations nghiệp vụ, agent thật, installer, bất kỳ thao tác nào trên máy chủ thật.

## Quy tắc chung cho mọi prompt Phase 1
- Đọc `CLAUDE.md` (sau khi 1.1 tạo ra), `PHASE_STATUS.md`, `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `DECISIONS.md` trước khi làm.
- Chỉ làm đúng phạm vi của prompt; không bắt đầu prompt kế tiếp.
- Commit nhỏ theo Conventional Commits (`chore(p1): …`, `feat(p1): …`); làm trên nhánh `phase-1`.
- Không chạy lệnh thay đổi cấu hình máy chủ; không cài gì ngoài dependency của dự án trong thư mục repo (và PostgreSQL/Redis dev nếu prompt cho phép).
- Mọi test phải chạy thật; ghi lệnh và kết quả vào `TEST_REPORT.md`. Không skip test để "cho xanh".
- Báo cáo cuối prompt theo mẫu ở cuối file.

---

## Prompt 1.1 — Git local, cấu trúc repository, file tiến độ, CLAUDE.md

```
[ITSO Panel] Prompt 1.1 — Git local, cấu trúc repository, file tiến độ, CLAUDE.md
Phase 1. Chỉ làm phạm vi dưới đây. Không viết code ứng dụng.

Bối cảnh: Bộ kế hoạch đã duyệt nằm trong thư mục docs/planning (01–15 và seed/).
GitHub chưa bắt buộc: khởi tạo Git local (D-51).

Phạm vi:
1. `git init` (nhánh mặc định main), tạo nhánh phase-1.
2. Cây thư mục:
   apps/web, apps/api, agent, contracts/{openapi,agent-ops,test-vectors},
   database/{schema,docs}, design/{tokens,docs}, installer, packaging, demo,
   docs/{planning,adr,runbooks,screenshots,ui,gate,reports}
   Mỗi thư mục rỗng có README.md 3–5 dòng nêu mục đích và Phase sẽ dùng.
3. Copy docs/planning/* vào docs/planning/ của repo (giữ nguyên).
   Đặt ở gốc repo: PROJECT_PLAN.md, ARCHITECTURE.md, ROADMAP.md, DECISIONS.md,
   PHASE_STATUS.md, TEST_REPORT.md (từ seed/), DATABASE.md, API.md (từ seed/).
4. CLAUDE.md gồm: quy trình mở phiên mới (đọc PHASE_STATUS → git status/log →
   tiếp tục task ✱), quy tắc "không tự chuyển Phase", "contracts trước code",
   "Laravel không chạy lệnh hệ thống", quy ước commit/nhánh, lệnh test từng phần
   (điền dần), danh sách đường dẫn tài liệu.
5. .editorconfig, .gitattributes (LF, *.sh eol=lf), .gitignore (node, php/vendor,
   go, .env*, build, coverage, playwright report), LICENSE nội bộ (Proprietary — ITSO).
6. Makefile gốc với target: help, setup, dev, test, lint, build, codegen, check
   (target chưa có hiện thực thì in "chưa hiện thực — Prompt 1.x").
   Kèm scripts/dev.ps1 tương đương tối thiểu cho Windows (gọi qua WSL).
7. README.md gốc: giới thiệu, trạng thái "Phase 1 — đang xây dựng", cấu trúc,
   cách đọc tài liệu.

Ngoài phạm vi: scaffold framework, cài npm/composer/go deps, CI.

Kiểm thử:
- `make help` chạy trên Ubuntu/WSL2.
- Script kiểm tra cấu trúc: scripts/check-structure.sh xác nhận đủ thư mục và
  file bắt buộc (exit 0); chạy được trong CI sau này.
- `git log` có ≥ 2 commit sạch; `git status` sạch.

Tiêu chí nghiệm thu:
- [ ] Repo Git local, nhánh phase-1, working tree sạch.
- [ ] 8 file kế hoạch ở gốc + CLAUDE.md + README.md.
- [ ] scripts/check-structure.sh exit 0.
- [ ] PHASE_STATUS.md: 1.1 ✓, phần còn lại ○, ghi commit cuối.

Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG.
```

## Prompt 1.2 — Architecture & ADR trong repository

```
[ITSO Panel] Prompt 1.2 — Architecture & ADR
Phase 1. Chỉ tài liệu, không code.

Phạm vi:
1. ARCHITECTURE.md (gốc): hoàn thiện từ seed + 02/06/07, gồm sơ đồ thành phần
   dạng Mermaid (render được trên GitHub): control plane, Admin/Portal, gateway,
   agent, node; luồng tạo website (sequence diagram); desired/observed/job;
   bố cục filesystem; systemd units; ranh giới đặc quyền.
2. docs/adr/: ADR theo mẫu MADR cho các quyết định APPROVED và các quyết định
   kỹ thuật Phase 1 dựa vào: 0001 ghi ADR, 0002 monorepo, 0003 contracts-first (D-14),
   0004 realm admin/portal (D-25/D-40), 0005 Hosting Provisioning Service (D-49),
   0006 vòng đời & purge 30 ngày (D-46), 0007 Production Gate (D-47),
   0008 chuyển account (D-48), 0009 pentest (D-50), 0010 Git local (D-51).
   Quyết định còn Proposed ghi trạng thái Proposed, không tự đổi.
3. docs/security/threat-model.md: rút gọn từ 06 + bổ sung User Portal public.
4. docs/ui/sitemap.md: danh sách trang Admin Panel và User Hosting Portal
   (đầu vào cho Phase 2), mỗi trang: route, vai trò, module, thành phần chính.

Kiểm thử:
- markdownlint (npx markdownlint-cli2) không lỗi; kiểm tra link nội bộ
  (npx markdown-link-check hoặc lychee offline) không link hỏng.
- Mermaid render được (npx @mermaid-js/mermaid-cli kiểm tra cú pháp từng khối).

Tiêu chí nghiệm thu:
- [ ] ≥ 10 ADR, mỗi ADR có Context/Decision/Consequences/Status và link D-xx.
- [ ] Sitemap liệt kê đủ trang cho 30 module (Admin) và portal USER.
- [ ] Lint + link check + mermaid check pass.

Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG.
```

## Prompt 1.3 — Database schema (đặc tả) và kiểm chứng trên PostgreSQL

```
[ITSO Panel] Prompt 1.3 — Database schema spec
Phase 1. Chưa viết Laravel migrations nghiệp vụ (để Phase 3).

Phạm vi:
1. database/schema/itso.dbml: toàn bộ bảng theo DATABASE.md + 04-DATABASE.md
   cho phạm vi nội bộ (identity với realm, servers/agents/capacity, packages +
   versions, hosting_accounts + lifecycle + uid_allocations + purge_records,
   websites/domains/certs, databases, sftp/ssh/cron, backup (repo theo account),
   account_migrations, jobs, audit_logs, security, docker, monitoring,
   notifications, settings). Khóa, FK, unique, partial unique, index, CHECK.
   Ghi chú desired/observed trên từng bảng tài nguyên.
2. Sinh SQL từ DBML (@dbml/cli dbml2sql --postgres) → database/schema/itso.sql.
3. database/schema/extras.sql: những gì DBML không biểu diễn: trigger chặn
   UPDATE/DELETE audit_logs, trigger realm bất biến, CHECK role↔realm,
   partition audit_logs theo tháng, metric_samples theo ngày, extension citext/pg_trgm.
4. database/docs/: ERD (dbml-renderer → SVG), ownership.md (chuỗi sở hữu và
   global scope), lifecycle.md (sơ đồ trạng thái account + quy trình purge D-46),
   migration-plan.md (bảng nào ở Phase nào, nguyên tắc expand/contract).
5. scripts/db-verify.sh: dựng PostgreSQL 16 tạm (docker compose dev hoặc
   pg_ctl trong thư mục tạm), áp itso.sql + extras.sql, chạy test SQL.

Kiểm thử (database/tests/*.sql, chạy bằng psql hoặc pgTAP):
- Schema áp dụng không lỗi trên PostgreSQL 16.
- INSERT trùng domain (khi deleted_at null) bị từ chối; sau soft-delete thì cho phép.
- UPDATE/DELETE audit_logs bị từ chối.
- Đổi realm user bị từ chối; USER với realm admin bị từ chối.
- Xóa hosting_account còn website bị từ chối (RESTRICT).
- uid trùng trên cùng server bị từ chối.

Tiêu chí nghiệm thu:
- [ ] DBML lint/convert không lỗi; ERD SVG có trong repo.
- [ ] db-verify.sh exit 0, tất cả test SQL pass (ghi số test vào TEST_REPORT).
- [ ] DATABASE.md cập nhật link tới DBML/ERD.

Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG.
```

## Prompt 1.4 — API Contracts

```
[ITSO Panel] Prompt 1.4 — API Contracts (Admin, Portal, Agent)
Phase 1. Chỉ contracts + công cụ kiểm tra, chưa hiện thực endpoint.

Phạm vi:
1. contracts/openapi/itso-admin-v1.yaml và itso-portal-v1.yaml (OpenAPI 3.1):
   - components chung tách file common.yaml: Problem (RFC 9457), CursorPage,
     Job, JobStep, Error codes, Idempotency-Key header, ETag, security schemes
     (cookie session + CSRF; bearer token nội bộ cho admin).
   - Paths đủ cho Phase 2 (demo) và Phase 3: auth, users, roles, servers,
     hosting-packages (+versions), hosting-accounts (+:suspend/:unsuspend/
     :change-package/:migrate/:terminate/:schedule-purge/:confirm-purge, usage,
     lifecycle-events), websites, domains, databases, files, sftp, cron, ssl,
     dns, backups/restores, security (overview, firewall, waf, malware), docker,
     wordpress, monitoring, notifications, audit, jobs, settings, terminal.
     Portal chỉ chứa endpoint của USER theo API.md §4.
   - Mỗi schema có example nhất quán với demo dataset (sẽ dùng ở Phase 2).
   - /api/provisioning/* KHÔNG có trong contract (DEFERRED).
2. contracts/agent-ops/: envelope.schema.json, result.schema.json, error codes,
   và schema cho các op Phase 4–6 ở mức khai báo (system.*, account.*, quota.*,
   nginx.vhost.apply, php.pool.apply, fs.*, db.*, cert.*, backup.*, migrate.*).
3. contracts/test-vectors/evil-inputs.json: domain, username, path, DB name,
   cron expression, nginx value độc hại + kết quả mong đợi (reject/accept).
4. Công cụ: Redocly CLI (hoặc Spectral) với ruleset riêng: operationId bắt buộc,
   mọi POST tạo job phải có Idempotency-Key và response 202 Job, mọi error dùng
   Problem, không endpoint admin nào xuất hiện trong portal.
5. Tài liệu: contracts/README.md; build HTML docs (redocly build-docs) vào
   docs/api/ (không commit file build nếu lớn — ghi lệnh tạo).

Kiểm thử:
- Lint pass với ruleset; validate JSON Schema agent-ops (ajv-cli).
- Test script: so khớp mọi example với schema (ajv/redocly).
- Test "portal ⊄ admin-only": script kiểm tra không path admin-only trong portal.

Tiêu chí nghiệm thu:
- [ ] 2 file OpenAPI + common lint 0 lỗi; ≥ 95% operation có example.
- [ ] Agent schemas validate; evil-inputs có ≥ 60 vector.
- [ ] API.md cập nhật link tới contracts.

Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG.
```

## Prompt 1.5 — Scaffold web / api / agent, mock agent, môi trường dev

```
[ITSO Panel] Prompt 1.5 — Scaffold và môi trường dev
Phase 1.

Phạm vi:
1. apps/web: pnpm workspace; Vite + React + TypeScript strict + Tailwind CSS
   + shadcn/ui init + Lucide; hai entry: admin (src/entries/admin) và portal
   (src/entries/portal), dev server phục vụ /admin và /portal; ESLint (cấm
   dangerouslySetInnerHTML), Prettier, Vitest. Chưa có UI thật.
2. apps/api: Laravel bản ổn định mới nhất (PHP 8.3+); cấu hình pgsql + redis qua
   .env.example; routes /api/v1/system/health, /api/v1/system/version; handler lỗi
   RFC 9457; Pest; Larastan; Pint; rule cấm exec/shell_exec/proc_open/system/
   passthru/backtick trong app/ (script grep + Larastan rule).
   Thư mục app/Domain/Hosting/ chứa interface ProvisioningService (rỗng,
   có docblock D-49) — chưa hiện thực.
3. agent/: Go module; cmd/itso-mock-agent: HTTP JSON trên unix socket (Linux)
   hoặc 127.0.0.1 (Windows), validate envelope bằng schema từ contracts,
   op system.ping và system.info (dữ liệu giả từ demo/), từ chối op lạ.
   Không có op nào chạy lệnh hệ thống.
4. docker-compose.dev.yml (PostgreSQL 16, Redis 7) — chỉ cho dev, ghi rõ;
   docs/runbooks/dev-setup.md cho Ubuntu 24.04 và Windows/WSL2 (kể cả cách
   không dùng Docker).
5. Makefile: setup, dev (web + api + mock agent), test, lint.

Kiểm thử:
- Vitest: 1 test render cho mỗi entry.
- Pest: health/version trả JSON đúng schema OpenAPI; 404 trả problem+json.
- Go: go test -race; test registry từ chối op lạ và envelope sai; fuzz test
  envelope parser (go test -fuzz, chạy 30s trong CI).
- Script grep cấm lệnh hệ thống trong apps/api/app pass.

Tiêu chí nghiệm thu:
- [ ] Clone sạch → `make setup && make dev` → /admin và /portal hiển thị trạng
      thái health của API và ping của mock agent; thời gian setup ≤ 15 phút.
- [ ] `make test` và `make lint` xanh.

Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG.
```

## Prompt 1.6 — Design System

```
[ITSO Panel] Prompt 1.6 — Design System
Phase 1. Nền tảng UI cho Phase 2; chưa dựng trang module.

Tham chiếu: mockup dashboard ITSO (dark navy, accent xanh dương, xanh lá, tím,
vàng; font Be Vietnam Pro), file docs/ui/sitemap.md.

Phạm vi:
1. design/tokens/tokens.json (nguồn): màu (bg, surface, border, fg, muted,
   primary, success, warning, danger, info, chart-1..8), radius, spacing, shadow,
   typography (Be Vietnam Pro, fallback system), z-index — cho Light và Dark.
   Script sinh CSS variables + preset Tailwind; kiểm tra tương phản WCAG AA cho
   các cặp fg/bg (script tự động).
2. Theme: ThemeProvider (light/dark/system), lưu lựa chọn (try/catch storage),
   không nháy sai theme khi tải trang.
3. i18n: i18next, VI mặc định + EN, namespace theo module, format số/ngày/
   dung lượng theo locale, script phát hiện key thiếu giữa vi/en.
4. Component nền (packages/ui hoặc apps/web/src/ui), dựa trên shadcn/ui:
   Button, Input, Select, Checkbox, Switch, Textarea, Badge/StatusBadge (trạng
   thái desired/observed), Card, StatCard, Gauge (vòng tròn như mockup),
   ProgressBar, Tabs, Dialog, ConfirmDialog (gõ tên để xác nhận), Drawer,
   DropdownMenu, Tooltip, Toast, Alert, EmptyState, Skeleton, Breadcrumb,
   Pagination, DataTable (TanStack Table: sort, filter, chọn dòng, responsive
   thành card ở mobile), FormField (RHF + zod), CodeBlock, JobProgress,
   chart wrappers (Recharts: Area, Bar, Donut) dùng token màu.
5. App shell cho 2 entry: AdminShell (sidebar theo mockup, topbar: tìm kiếm
   Ctrl+K, đổi theme, đổi ngôn ngữ, chuông, user menu) và PortalShell (gọn hơn,
   chỉ menu USER); sidebar thu gọn và drawer ở 390px.
6. Trang /design (chỉ dev) hiển thị toàn bộ component ở light/dark, VI/EN —
   dùng cho kiểm thử trực quan (thay Storybook để giảm phụ thuộc).
7. design/docs/README.md: nguyên tắc dùng màu, spacing, trạng thái, a11y.

Kiểm thử:
- Vitest + Testing Library cho component có logic (DataTable, ConfirmDialog,
  ThemeProvider, FormField).
- Playwright: chụp /design và 2 shell ở 1440px và 390px × light/dark →
  docs/screenshots/design-system/ (8+ ảnh, deviceScaleFactor 2), chạy --trace off.
- axe-core trên /design: 0 lỗi critical/serious.
- Script tương phản AA pass; script key i18n thiếu = 0.

Tiêu chí nghiệm thu:
- [ ] Token light/dark sinh tự động, không màu hard-code trong component (lint rule).
- [ ] ≥ 25 component nền + 2 shell, hiển thị đúng ở 390px và 1440px.
- [ ] Screenshot thật trong docs/screenshots/design-system/.
- [ ] a11y, contrast, i18n check pass.

Kết thúc: cập nhật PHASE_STATUS.md, TEST_REPORT.md; báo cáo; DỪNG.
```

## Prompt 1.7 — CI, codegen, kiểm tra tổng và báo cáo Phase 1

```
[ITSO Panel] Prompt 1.7 — CI, codegen, báo cáo Phase 1
Phase 1.

Phạm vi:
1. Codegen: TS types + API client từ OpenAPI (openapi-typescript hoặc orval)
   → apps/web/src/api/generated/{admin,portal}; Go structs từ agent schemas;
   `make codegen`; `make codegen-check` báo lỗi nếu có diff.
2. CI (.github/workflows/ci.yml, chạy được khi repo được đẩy lên GitHub; chạy
   local tương đương bằng `make check`): jobs structure, docs (markdownlint,
   link, mermaid), database (db-verify), contracts (lint, examples, codegen-check),
   web (lint, typecheck, vitest, build, playwright design screenshots), api
   (pint, larastan, pest với service PG + Redis, grep cấm lệnh hệ thống),
   agent (vet, staticcheck, test -race, fuzz 30s).
3. `make check` chạy toàn bộ pipeline local, in bảng kết quả.
4. docs/reports/phase-1.md theo mẫu báo cáo; cập nhật ROADMAP.md (Phase 1 hoàn
   tất chờ duyệt), PHASE_STATUS.md, TEST_REPORT.md (số test từng bộ).
5. Hướng dẫn kết nối GitHub sau này (docs/runbooks/connect-github.md): thêm
   remote, push nhánh, bật Actions — KHÔNG tự tạo repo hay push.

Kiểm thử: `make check` exit 0 trên WSL2/Ubuntu sạch.

Tiêu chí nghiệm thu Phase 1 (Definition of Done):
- [ ] Tất cả acceptance của 1.1–1.6 đạt.
- [ ] `make check` xanh; codegen không diff.
- [ ] Không có code nghiệp vụ, không có thao tác hệ thống, không deploy.
- [ ] Báo cáo Phase 1 đầy đủ; PHASE_STATUS: Phase 1 ✓ (chờ duyệt).

Kết thúc: báo cáo Phase 1; DỪNG. Không bắt đầu Phase 2.
```

---

## Mẫu báo cáo cuối mỗi prompt
```
## Báo cáo Prompt 1.x — <tên>
- Đã làm: …
- File chính: …
- Cách chạy thử: lệnh từng bước
- Kết quả test: bảng (bộ test · lệnh · pass/fail · số lượng)
- Tiêu chí nghiệm thu: ✓/✗ từng mục + bằng chứng
- Quyết định/giả định mới (nếu có, ghi vào DECISIONS.md là Proposed)
- Rủi ro / việc còn lại
- Commit cuối: <sha>
```

## Ước lượng (đoán): 1.1–1.2: 0.5 ngày · 1.3: 1 ngày · 1.4: 1.5 ngày · 1.5: 1 ngày · 1.6: 2 ngày · 1.7: 0.5 ngày.
