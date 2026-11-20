# 11 — Roadmap chi tiết (12 Phase)

> **Phạm vi chốt 2026-11-20 (nội bộ):** bản tổng hợp hiện hành nằm ở `seed/ROADMAP.md`. File này vẫn là chi tiết kỹ thuật; phần nào mâu thuẫn thì theo `seed/ROADMAP.md`.

> **Cập nhật 2026-11-20:** panel phục vụ cả khách hàng → thêm **Phase 9 Customer Readiness**, tổng **13 Phase**; Phase 9–12 cũ dịch thành 10–13. Xem `14-CUSTOMER-MULTI-TENANT.md` §9. Nội dung bên dưới là bản 12 Phase gốc, các bổ sung cho khách hàng ở file 14.

> Nguồn cho `ROADMAP.md`. **Không tự chuyển Phase**: cuối mỗi Phase, Claude Code dừng, cập nhật `PHASE_STATUS.md` + `TEST_REPORT.md`, chờ duyệt.

## ⚠ Cập nhật 2026-11-20: Roadmap 3 giai đoạn, 15 Phase (bản hiện hành)

| Giai đoạn | Phase | Tên | Mốc |
|---|---|---|---|
| **A. Internal Alpha** | 1 | Foundation (contracts gồm cả Admin, Portal, Provisioning) | |
| | 2 | Complete UI Demo: Admin Panel + Customer Portal | |
| | 3 | Identity staff/customer, RBAC, Customer, Package version, Service, Subscription, Account, Lifecycle engine, Jobs, Audit, Outbox | |
| | 4 | Go Agent, Installer all-in-one, CLI, cách ly (UID, slice, quota, sandbox, egress) | |
| | 5 | Website / Nginx / PHP / SSL | |
| | 6 | Database / File Manager / SFTP / Cron | |
| | 7 | Security Center | |
| | 8 | Backup per account, offsite immutable, restore, DR cơ bản | **v0.1.0-alpha** (chỉ dùng nội bộ) |
| **B. Hosting Provider Beta** | 9 | Multi-server, control plane riêng, node join, mTLS, Placement Engine | |
| | 10 | Customer Portal đầy đủ, Service Lifecycle (quá hạn, retention, purge), Support Access, PDPD | |
| | 11 | Provisioning API, webhook outbox, SSO, Billing Adapter WooCommerce | |
| | 12 | Abuse & Compliance, monitoring cho provider, Beta Gate | **v0.5.0-beta** (khách thử nghiệm, chưa thu phí) |
| **C. Production Release** | 13 | WordPress Toolkit, Software, DNS, Git | |
| | 14 | Docker cho app do admin quản lý + thiết kế Docker Hosting trên VM | |
| | 15 | Production Hardening + **Paid Customer Gate** | **v1.0.0** (mở bán trả phí) |

Chi tiết từng Phase mới, Paid Customer Gate và lý do sắp xếp: `15-HOSTING-PROVIDER.md` §12–13. **Ánh xạ từ bản cũ:** Phase 1–8 giữ nguyên tên và nội dung bên dưới, cộng thêm phần bổ sung trong file 15. Phase 9 Docker cũ chuyển thành 14. Phase 10 WP/Software/DNS/Git cũ chuyển thành 13. Phần multi-server của Phase 11 cũ chuyển thành 9. Phase 12 Hardening cũ chuyển thành 15. Các mô tả Phase 9–12 bên dưới là **bản cũ**, chỉ giữ để tham khảo nội dung kỹ thuật.

---

## (Bản cũ) Tổng quan và điều chỉnh thứ tự

Giữ nguyên thứ tự 12 Phase của bạn, với 4 điều chỉnh có lý do kỹ thuật:

1. **Hợp đồng Agent (schema + mock agent) đưa vào Phase 1**, không đợi Phase 4 — để Phase 2–3 xây trên đúng giao diện mà agent thật sẽ dùng.
2. **Jobs framework + Audit log vào Phase 3** — mọi module sau đều phụ thuộc.
3. **Thực thi giới hạn gói (slice, quota) vào Phase 4**, cùng lúc với agent thật; Phase 3 chỉ có dữ liệu + kiểm tra quota phía panel.
4. **Bảo mật nền tảng là xuyên suốt** (auth, MFA, CSRF, validation, agent hardening có từ Phase 3–4). Phase 7 là *Security Center* (firewall, WAF, malware, FIM, terminal).

Thêm: **Cron + SFTP vào Phase 6**, **Terminal vào Phase 7** (rủi ro cao, đi cùng bảo mật), **DNS provider + Git vào Phase 10**.

| Phase | Tên | Milestone | Ước lượng (đoán) |
|---|---|---|---|
| 1 | Foundation | — | 1–2 tuần |
| 2 | Complete UI Demo | `v0.0.1-demo` | 2–3 tuần |
| 3 | Auth, RBAC, Users, Hosting Packages & Accounts, Jobs, Audit | `v0.0.2` | 3–4 tuần |
| 4 | Go Agent, Installer, CLI, Account enforcement | `v0.0.3` (cài được thật) | 4–6 tuần |
| 5 | Website / Nginx / PHP / SSL | `v0.0.4` | 3–4 tuần |
| 6 | Database / File Manager / SFTP / Cron | `v0.0.5` | 3–4 tuần |
| 7 | Security Center (Firewall, Fail2ban, WAF, Malware, FIM, SSH, Terminal) | `v0.0.6` | 3–5 tuần |
| 8 | Backup & Restore | **`v0.1.0-alpha`** | 3–4 tuần |
| 9 | Docker | `v0.2.0-alpha` | 3–4 tuần |
| 10 | WordPress / Software / DNS / Git | `v0.3.0-alpha` | 3–4 tuần |
| 11 | Monitoring, Alerts, Notifications, Multi-server | `v0.4.0-beta` | 4–5 tuần |
| 12 | Production Hardening, Import, Pentest | `v1.0.0-rc` | 3–5 tuần |

```
P1 ─► P2 ─► P3 ─► P4 ─► P5 ─► P6 ─► P7 ─► P8 ═► v0.1.0-alpha
                          │                  └─► P9 ─► P10 ─► P11 ─► P12
                          └─ (P2 UI được nối dần vào API thật từ P3 trở đi)
```

---

## Phase 1 — Foundation
- **Mục tiêu:** Repository, công cụ, quy ước, hợp đồng (contracts) và cơ chế lưu tiến độ, đủ để mọi Phase sau làm việc độc lập.
- **Scope:** monorepo skeleton; CI; lint/format/test runner cho 3 ngôn ngữ; `contracts/` (OpenAPI khung + JSON Schema agent envelope và 5 op mẫu); mock agent Go chạy được; các file tiến độ; `CLAUDE.md`. **Không** có tính năng nghiệp vụ.
- **Tasks:** (1) cấu trúc thư mục theo `02-ARCHITECTURE.md` §7; (2) `apps/web`: Vite + React + TS + Tailwind + shadcn/ui init, trang "Hello ITSO" (không UI thật); (3) `apps/api`: Laravel mới, cấu hình PostgreSQL/Redis qua `.env`, endpoint `GET /api/v1/system/health`; (4) `agent/`: Go module, `cmd/itso-mock-agent` phục vụ unix socket (Linux) / TCP localhost (Windows) với op `system.info`, `system.ping`; (5) `contracts/`: OpenAPI 3.1 khung, `agent-envelope.schema.json`, codegen script (TS types, Go structs); (6) dev env: `docker-compose.dev.yml` (PostgreSQL 16, Redis) chỉ cho dev + hướng dẫn WSL2; (7) CI GitHub Actions: lint + test 3 phần; (8) tạo `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `PHASE_STATUS.md`, `DECISIONS.md`, `TEST_REPORT.md`, `CLAUDE.md`, `docs/adr/0001-*.md`.
- **Deliverables:** repo build xanh trên CI; `make dev` (hoặc script tương đương Windows) chạy được web + api + mock agent.
- **Database changes:** chỉ migration mặc định Laravel (có thể xóa bảng users mặc định để Phase 3 thiết kế lại).
- **API endpoints:** `GET /api/v1/system/health`, `GET /api/v1/system/version`.
- **UI pages:** trang placeholder.
- **Agent operations:** mock `system.ping`, `system.info`.
- **Tests:** 1 test mỗi phần (Vitest, Pest, `go test`); contract test: mock agent trả đúng schema.
- **Acceptance criteria:** clone mới → làm theo README → chạy được trong ≤ 15 phút trên Windows(WSL2) và Ubuntu; CI xanh; codegen chạy lại không tạo diff.
- **Dependencies:** quyết định D-01…D-05, D-14 được duyệt.
- **Risks:** chọn sai công cụ sớm (monorepo tool) → giữ đơn giản (Makefile + pnpm workspace + composer + go).
- **Definition of Done:** mọi mục trên + `PHASE_STATUS.md` cập nhật + báo cáo cuối Phase.

## Phase 2 — Complete UI Demo
- **Mục tiêu:** Giao diện hoàn chỉnh cho **cả 30 module** với dữ liệu demo nhất quán, chạy không cần backend.
- **Scope:** design system (token màu theo mockup, Light/Dark), layout (sidebar, topbar, search Ctrl+K, chuông, đổi ngôn ngữ, user menu), i18n VI mặc định + EN, responsive 390px→1440px+, các trang list/detail/form/modal của mọi module, mô phỏng job progress, MSW mock API **theo OpenAPI**, dữ liệu demo trong `demo/*.json`, Playwright screenshots.
- **Tasks:** (1) design tokens + theme switcher; (2) app shell + routing + guard theo vai trò (giả lập SA/AD/US qua switcher demo); (3) component chung: DataTable (TanStack Table), Form (RHF+zod), ConfirmDialog (gõ tên để xác nhận), JobProgress drawer, EmptyState, StatCard, Chart wrappers; (4) Dashboard theo mockup; (5) trang từng module (nhóm theo sidebar); (6) i18n toàn bộ chuỗi; (7) MSW handlers + demo dataset có quan hệ đúng (account→sites→DB…); (8) Playwright: chụp 4 biến thể (1440/390 × light/dark) cho các trang chính → `docs/screenshots/`; (9) a11y cơ bản (axe).
- **Deliverables:** `pnpm dev:demo` chạy demo đầy đủ; bộ screenshot; `docs/ui/sitemap.md`.
- **Database changes:** không (dataset JSON, đồng thời là nguồn cho `DemoSeeder` Phase 3).
- **API endpoints:** mock của toàn bộ `/api/v1` cần cho UI (cập nhật OpenAPI).
- **UI pages:** ~45 trang (danh sách trong `docs/ui/sitemap.md`).
- **Agent operations:** không.
- **Tests:** Vitest component; Playwright smoke mọi route (không lỗi console); screenshot; axe không lỗi critical.
- **Acceptance criteria:** mọi mục sidebar mở được trang có nội dung thật (không "coming soon"); đổi VI/EN không còn chuỗi cứng; dark/light đúng; không tràn ngang ở 390px; số liệu nhất quán giữa các trang (vd dashboard "20 website" = list 20 dòng).
- **Dependencies:** Phase 1.
- **Risks:** UI trôi khỏi API thật → bắt buộc MSW theo OpenAPI; phạm vi UI phình → giới hạn mỗi module ở list + detail + form chính.
- **DoD:** screenshot trong repo, demo build tĩnh deploy được (artifact), báo cáo.

## Phase 3 — Authentication, RBAC, Users, Hosting Packages & Accounts, Jobs, Audit
- **Mục tiêu:** Backend thật cho danh tính, phân quyền, gói/tài khoản (mức dữ liệu), khung Job và Audit; frontend chuyển từ MSW sang API thật cho các module này.
- **Scope:** schema §3.1, 3.3 (packages/accounts), 3.6, 3.7 (audit, notifications in-app, settings); Sanctum SPA; MFA TOTP; RBAC + scopes; Policies; Jobs + AgentClient gọi **mock agent**; audit append-only; DemoSeeder.
- **Tasks:** migrations; auth flow (login, MFA, logout, reset, sessions); RBAC seed; Users CRUD + scopes; Packages CRUD; Accounts CRUD (job `account.provision` gọi mock agent); Jobs API + SSE tạm qua polling; idempotency middleware; audit middleware + trigger; settings; notifications in-app; ma trận quyền test; nối UI.
- **Deliverables:** đăng nhập thật, quản lý user/gói/account thật trên DB; job hiển thị tiến độ từ mock agent.
- **Database changes:** users, roles, permissions, role_permissions, user_roles, user_scopes, mfa_credentials, sessions, api_tokens, login_attempts, ip_allowlist, servers, agents, hosting_packages, hosting_accounts, jobs, job_steps, job_logs, audit_logs, notifications, settings.
- **API endpoints:** `/auth/*`, `/users*`, `/roles`, `/api-tokens`, `/hosting-packages*`, `/hosting-accounts*`, `/jobs*`, `/audit-logs`, `/activity`, `/notifications*`, `/settings/*`, `/servers` (read, server local seed), `/dashboard/summary` (phần dữ liệu panel).
- **UI pages:** Login, MFA, Users, Packages, Accounts, Jobs, Audit, Settings, Profile/Security cá nhân.
- **Agent operations:** (mock) `account.ensure`, `account.limits.apply`, `account.suspend`.
- **Tests:** Pest feature cho mọi endpoint; dataset ma trận quyền (endpoint × SA/AD/US × own/other); idempotency; audit không sửa được; Playwright login + tạo account.
- **Acceptance criteria:** USER không đọc được tài nguyên người khác (trả 404) qua bất kỳ endpoint nào; ADMIN chỉ thấy phạm vi; SA bắt buộc MFA; vượt quota website/domain bị từ chối 422; job retry/cancel hoạt động với mock.
- **Dependencies:** Phase 1, 2.
- **Risks:** thiết kế quyền sai từ đầu → review riêng tài liệu RBAC trước khi code.
- **DoD:** coverage backend ≥ 80% cho module Phase 3; báo cáo.

## Phase 4 — Go Agent, Installer, CLI, Account enforcement
- **Mục tiêu:** Agent thật trên Ubuntu 24.04, cài được panel bằng 1 lệnh, giới hạn gói được kernel thực thi.
- **Scope:** agent core (transport socket + HMAC + peercred, registry, policy file, audit cục bộ, platform ubuntu2404); ops account/slice/quota/system/service/software(cơ bản)/metrics; `itso` CLI (install, status, doctor, update/rollback khung, repair khung, uninstall, admin reset); `install.sh`; release build pipeline; wizard (bước 0–3, 6, 9; bước cài stack ở Phase 5); FrankenPHP runtime; spike slice/SSH và quota.
- **Tasks:** spike cgroup/quota (báo cáo trong `docs/adr/`); agent skeleton; ops; systemd units; release packaging + ký; installer; wizard; nối Server Management + Dashboard metrics thật; VM test harness (Multipass/Vagrant script).
- **Deliverables:** `sudo bash install.sh` trên VM sạch → panel chạy HTTPS → wizard → tạo account → giới hạn có hiệu lực.
- **Database changes:** agent_enrollment_tokens, server_services, software_catalog, server_software, account_usage_snapshots, metric_samples (cơ bản).
- **API endpoints:** `/servers/{id}` đầy đủ, services, software (cơ bản), `/hosting-accounts/{id}/usage`, `/metrics/servers/{id}`, `/system/updates`.
- **UI pages:** Wizard, Server detail, Account usage thật.
- **Agent operations:** `system.info|ping|reboot|hostname.set`, `service.status|control`, `account.ensure|limits.apply|suspend|unsuspend|remove`, `quota.set|report`, `metrics.snapshot|cgroup`, `software.install|remove (recipe)`, `audit.tail`.
- **Tests:** Go unit + fuzz validators; integration trên VM (test bảng `07-HOSTING-ISOLATION.md` §9); installer chạy 2 lần (idempotent); uninstall giữ `/home`; update→rollback.
- **Acceptance criteria:** cài sạch ≤ 10 phút trên VM 2 vCPU/2 GB; tất cả test enforcement đạt; Laravel không có quyền root (kiểm tra `sudo -l -U itso` rỗng); agent từ chối op không có trong registry và tham số sai.
- **Dependencies:** Phase 3; D-01, D-10, D-12, D-13.
- **Risks:** quota trên ext4 root cần reboot; FrankenPHP extension; agent bugs có quyền root → review bảo mật bắt buộc trước merge.
- **DoD:** báo cáo spike + bảng test VM + báo cáo cuối Phase.

## Phase 5 — Website / Nginx / PHP / SSL
- **Mục tiêu:** Tạo và phục vụ website PHP/static/proxy có HTTPS.
- **Scope:** wizard bước cài stack; Software recipes Nginx/PHP; vhost templates; PHP-FPM per account; ACME (lego) + renew; domain/alias/redirect; suspend page; log viewer.
- **Database changes:** websites, domains, website_settings, certificates, acme_accounts, php_versions.
- **API endpoints:** `/websites*`, `/certificates*`, `/servers/{id}/php/*`, `/servers/{id}/nginx/global`.
- **UI pages:** Websites list/detail (tabs), PHP Manager, Nginx global, SSL.
- **Agent operations:** `fs.site_layout.ensure`, `nginx.vhost.apply|remove|global.apply|inspect`, `php.version.install|remove`, `php.ext.install`, `php.pool.apply|remove`, `cert.issue|install|inspect`, `site.suspend`, `log.tail`.
- **Tests:** golden template; fuzz; Pebble ACME trong CI; VM: tạo 20 site, `nginx -t` fail → rollback; isolation PHP giữa 2 account.
- **Acceptance criteria:** site PHP hiển thị `phpinfo` đúng uid; HTTPS hợp lệ (Pebble/LE staging); cert renew tự động; xóa site không để lại cấu hình rác; 1 vhost lỗi không làm hỏng các site khác.
- **Dependencies:** Phase 4. **Risks:** template sai → lỗ hổng; PPA ondrej thay đổi.
- **DoD:** như chung.

## Phase 6 — Database / File Manager / SFTP / Cron
- **Database changes:** databases, database_users, database_grants, sftp_accounts, ssh_keys, cron_jobs, cron_runs, upload_sessions, file_operations.
- **API endpoints:** `/databases*`, `/database-users*`, `/hosting-accounts/{id}/files*`, `/sftp-accounts*`, `/ssh-keys*`, `/cron-jobs*`.
- **UI pages:** Databases, File Manager (2 pane + editor + upload), SFTP, Cron.
- **Agent operations:** `db.mysql.*`, `db.pg.*`, `fs.*` (hạ quyền + openat2), `sftp.account.apply`, `sshd.match.apply`, `cron.apply|remove|run`.
- **Tests:** evil inputs (traversal, symlink race, zip slip, zip bomb); SQL identifier injection; chroot escape; cron trong slice.
- **Acceptance criteria:** tất cả test tấn công đều bị chặn; upload 1 GB resumable; DB import/export qua job; cron chạy dưới uid account, bị giới hạn slice.
- **Dependencies:** Phase 4, 5. **Risks:** File Manager là bề mặt tấn công lớn nhất → review bảo mật riêng.

## Phase 7 — Security Center
- **Scope:** firewall nftables (safe-apply), Fail2ban (sshd, panel, ftp), SSH hardening (safe-apply), WAF ModSecurity+CRS (xác minh package; fallback Coraza), ClamAV + YARA + quarantine, FIM, security score, IP allowlist panel, Terminal (USER + root-by-policy, ghi phiên), security events + cảnh báo.
- **Database changes:** firewall_rules, security_events, waf_settings, waf_events, malware_scans, malware_findings, quarantine_items, fim_baselines, terminal_sessions.
- **API endpoints:** `/security/*`, `/servers/{id}/firewall/*`, `/websites/{id}/waf`, `/websites/{id}/scans`, `/quarantine*`, `/terminal/sessions`.
- **UI pages:** Security overview + tabs, Terminal.
- **Agent operations:** `firewall.apply`, `fail2ban.apply`, `sshd.config.apply`, `waf.*`, `malware.*`, `fim.*`, `security.audit`, `pty.open`.
- **Tests:** không tự khóa SSH/panel (mô phỏng mất kết nối → rollback); OWASP payload bị WAF chặn; EICAR; ticket terminal dùng lại bị từ chối; root terminal bị từ chối khi policy tắt dù panel yêu cầu.
- **Acceptance criteria:** điểm bảo mật mặc định sau cài ≥ 80/100; mọi thay đổi firewall/SSH có rollback tự động; malware scan không đẩy load > ngưỡng.
- **Dependencies:** Phase 4–6. **Risks:** tự khóa server; WAF false positive làm hỏng site (mặc định DetectionOnly 7 ngày).

## Phase 8 — Backup & Restore → `v0.1.0-alpha`
- **Scope:** destinations (local, SFTP, S3, rest-server append-only), policies, restic runner, DB dump nhất quán, config backup, panel backup, restore (site/DB/file), cross-server restore (cùng destination), DR runbook + `install.sh --restore`, verification (check + restore test), 3-2-1-1-0 checklist, quota backup.
- **Database changes:** backup_destinations, backup_policies, backup_jobs, backup_snapshots, backup_verifications, restore_jobs.
- **API endpoints:** `/backup-*`, `/restores*`.
- **UI pages:** Backup Center, Restore wizard.
- **Agent operations:** `backup.run|snapshots.list|browse|restore|check`, `backup.forget` (policy-gated).
- **Tests:** backup→xóa→restore→checksum; append-only chặn xóa; diễn tập DR trên 2 VM.
- **Acceptance criteria:** RPO ≤ 24h (file) / 6h (DB) mặc định; restore 1 site ≤ 15 phút cho 5 GB (đo trên VM tham chiếu); DR toàn bộ thành công theo runbook; panel bị chiếm không xóa được backup immutable.
- **Dependencies:** Phase 5, 6. **Risks:** mất mật khẩu repo → bắt buộc lưu offline trong wizard.
- **DoD bổ sung:** tag `v0.1.0-alpha`, release notes, hướng dẫn cài cho nội bộ.

## Phase 9 — Docker
- **Scope:** theo `09-DOCKER.md`: containers, compose (validator), images/volumes/networks, registries, port allocation, DOCKER-USER sync, reverse proxy site loại docker, volume backup; USER managed compose (9b, nếu được duyệt).
- **Database changes:** docker_hosts, registries, compose_projects, compose_revisions, containers, docker_volumes, docker_networks, docker_images, port_allocations.
- **Agent ops:** `docker.*`, `compose.validate|up|down|pull`, `firewall.docker_user.apply`.
- **Tests:** validator evil compose; publish 0.0.0.0 không lộ ra ngoài; xung đột port; backup/restore volume.
- **Acceptance criteria:** không có cách nào (qua panel) để USER mount `/` hay lấy socket; firewall giữ hiệu lực với container.
- **Risks:** Docker thay đổi hành vi iptables/nftables giữa các bản.

## Phase 10 — WordPress / Software / DNS / Git
- **Scope:** WP Toolkit (WP-CLI as uid, install, update với backup trước, clone staging, harden); Software catalog mở rộng (Redis per site, Node.js app runtime, Memcached…); DNS provider Cloudflare; Git deployment (deploy key, webhook HMAC, releases + rollback).
- **Database changes:** wordpress_sites, wordpress_components, dns_providers, dns_zones, dns_records, git_repositories, deployments.
- **Agent ops:** `wp.cli`, `git.deploy`, `software.install` (recipe mới), `app.service.apply`.
- **Tests:** WP install/update/rollback; webhook giả mạo bị từ chối; SSRF qua git URL bị chặn.

## Phase 11 — Monitoring, Alerts, Notifications, Multi-server
- **Scope:** metrics lưu + rollup, per-account cgroup metrics, uptime check, alert rules, kênh email/Telegram/webhook; **multi-server**: transport mTLS outbound, CA nội bộ, enrollment, cert rotation, chọn server khi tạo account, cross-server restore đầy đủ.
- **Database changes:** metric_rollups, alert_rules, alerts, uptime_checks, notification_channels, notification_preferences; mở rộng agents.
- **Agent ops:** transport mới (không đổi op), `agent.enroll`, `agent.cert.rotate`.
- **Tests:** mất kết nối agent → job chờ/timeout đúng; cert hết hạn → tự xoay; 3 VM.
- **Acceptance criteria:** quản lý 3 server từ 1 panel; agent remote không mở port inbound.

## Phase 12 — Production Hardening
- **Scope:** pentest nội bộ (ASVS L2), CIS benchmark, RLS PostgreSQL (nếu duyệt), đánh giá tách helper đặc quyền, performance (200 account/server), import từ aaPanel/HestiaCP/Nginx thuần, offline installer, tài liệu vận hành/runbook, chính sách cập nhật bảo mật, SBOM + ký release hoàn chỉnh, chaos test (mất điện giữa update).
- **Acceptance criteria:** không còn lỗ hổng High/Critical mở; update/rollback thành công 20 lần liên tiếp trong CI VM; tài liệu đầy đủ → `v1.0.0-rc`.

---

## Quy tắc chung cho mọi Phase (Definition of Done chung)
1. CI xanh (lint, type-check, test, build).
2. Không phá Phase trước: toàn bộ test cũ vẫn xanh; screenshot Phase 2 chụp lại không vỡ layout.
3. OpenAPI/agent schema cập nhật trước code; codegen không diff.
4. Tài liệu: README module, cập nhật `ARCHITECTURE.md` nếu đổi, ADR cho quyết định mới.
5. Hướng dẫn chạy thử (`docs/runbooks/phase-N-demo.md`).
6. `PHASE_STATUS.md`, `TEST_REPORT.md` cập nhật; báo cáo cuối Phase theo mẫu.
7. Không có thao tác hệ thống trong Laravel (grep CI: `exec(`, `shell_exec`, `proc_open`, `system(`, `passthru`, `` ` ``).
8. Dừng và chờ duyệt.
