# ROADMAP — ITSO Panel (phạm vi nội bộ, **APPROVED 2026-11-20**)

> 12 Phase, khoảng 50 prompt. Chi tiết task, API, DB và test của Phase 1–8 vẫn theo `docs/planning/11-ROADMAP.md` (các Phase 1–8 trong đó), **cộng các điều chỉnh** ghi trong cột "Thay đổi" dưới đây. Các Phase 9–12 trong file 11 và roadmap 15 Phase ở file 15 **không còn hiệu lực**. **Không tự chuyển Phase.**

## Tổng quan

| Phase | Tên | Thay đổi so với bản đầu | Mốc |
|---|---|---|---|
| 1 | Foundation, Architecture, Database, API Contracts, Design System | Git local trước (D-51); schema DBML được kiểm chứng trên PostgreSQL; OpenAPI admin/portal; agent schemas + mock agent; design tokens theo mockup, Light/Dark, i18n, component nền, app shell 2 entry. Chi tiết: `PHASE_1_PROMPTS.md` | **✓ Hoàn tất, chờ duyệt** (2026-11-20) · báo cáo `docs/reports/phase-1.md` |
| 2 | Complete UI Demo (**ưu tiên**) | Demo **hoàn chỉnh** Admin Panel + User Hosting Portal trên Design System của Phase 1; dữ liệu mẫu đầy đủ và nhất quán; Light/Dark; responsive 390–1440px; screenshot thật bằng Playwright trong `docs/screenshots/`. Không có trang mua hàng/thanh toán | `v0.0.1-demo` |
| 3 | Auth, RBAC, Users, Packages, Accounts, Jobs, Audit | Realm admin/portal; **Hosting Provisioning Service**; package version; vòng đời account | |
| 4 | Go Agent, Installer, CLI, cách ly và quota | Sandbox systemd, egress per UID, quota inode | |
| 5 | Website / Nginx / PHP / SSL / DNS | DNS provider API (Cloudflare) đưa vào đây | |
| 6 | Database / File Manager / FTP-SFTP / Cron / Terminal USER | Terminal cho USER (jail) đưa vào đây | |
| 7 | Security Center | Firewall nftables, Fail2ban, WAF, Malware, FIM, SSH hardening, bảo vệ User Portal | |
| 8 | Backup & Restore theo tài khoản | Repo restic riêng cho mỗi account, offsite immutable, DR all-in-one | **v0.1.0-alpha** (1 server, nội bộ) |
| 9 | Multi-server & chuyển tài khoản | Node join, mTLS, CA nội bộ, chọn server có gợi ý, `account.migrate`, restore chéo server | |
| 10 | Docker Manager, WordPress Toolkit, Software Manager | Docker chỉ cho SUPER_ADMIN/ADMIN; USER không có Docker | |
| 11 | Monitoring, Alerts, Notifications | Metrics per server và per account, kênh email/Telegram/webhook | **v0.5.0-beta** (multi-server nội bộ) |
| 12 | Production Hardening & Production Gate | Pentest, upgrade/DR drill, runbook, import từ panel khác | **v1.0.0** (production nội bộ) |

```text
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 ═► v0.1.0-alpha
                              └→ 9 → 10 → 11 ═► v0.5.0-beta → 12 ═► v1.0.0
```

## Phase 9–12 (viết lại cho phạm vi nội bộ)

### Phase 9 — Multi-server & chuyển tài khoản

- **Mục tiêu:** Quản lý nhiều server từ một panel và chuyển tài khoản giữa các server.
- **Phạm vi chuyển account (D-48):** website, database, SSL, cron, cấu hình nginx/php/sftp, ownership/UID; kiểm tra dữ liệu (checksum file, row count + checksum bảng, HTTP check); rollback.
- **Scope:** `install.sh --role node --join`, `--role control-plane` (tùy chọn), transport mTLS outbound, CA nội bộ, cert rotation, danh sách server, gợi ý server khi tạo account, `account.migrate` có cutover và rollback, restore backup sang server khác.
- **Database:** `agent_enrollment_tokens`, mở rộng `agents` (cert), `server_capacity`, `account_migrations`.
- **API:** `POST /admin/servers/enrollment-tokens`, `GET /admin/servers/{id}/capacity`, `GET /admin/placement/suggestions?package=`, `POST /admin/hosting-accounts/{id}:migrate`, `GET /admin/account-migrations/{id}`.
- **UI:** Thêm server (hiện lệnh join), Server list multi, wizard chuyển account.
- **Agent ops:** `agent.enroll`, `agent.cert.rotate`, `migrate.export|import|sync|cutover|cleanup`.
- **Tests:** 3 VM; mất kết nối agent thì job chờ hoặc timeout đúng; migrate 1 site WordPress và 1 DB rồi so checksum; rollback cutover.
- **Acceptance:** quản lý 3 server; node không mở port quản trị inbound; chuyển account xong site chạy ở server đích, downtime khi cutover ≤ 5 phút với 2 GB dữ liệu (đo trên VM tham chiếu).
- **Risks:** khác phiên bản PHP/DB giữa các server; DNS cache khi cutover.

### Phase 10 — Docker Manager, WordPress Toolkit, Software Manager

- **Scope:** theo `09-DOCKER.md` (chỉ cho SUPER_ADMIN/ADMIN, validator compose, `127.0.0.1` bind, DOCKER-USER, port allocation, reverse proxy, backup volume); WordPress Toolkit (WP-CLI chạy dưới UID account, cài đặt, cập nhật kèm backup trước, clone staging, hardening); mở rộng Software catalog.
- **Database:** các bảng docker_*, `compose_projects`, `compose_revisions`, `port_allocations`, `wordpress_sites`, `wordpress_components`.
- **Acceptance:** container publish trên `0.0.0.0` không lộ ra ngoài nếu chưa mở trong panel; USER không có đường nào tới Docker; WordPress cập nhật lỗi thì rollback được.

### Phase 11 — Monitoring, Alerts, Notifications

- **Scope:** metrics theo server và account (từ cgroup), lưu dữ liệu và rollup, uptime check, alert rule, kênh email/Telegram/webhook, thông báo cho USER (quota 80%/100%, cert sắp hết hạn, backup lỗi, tài khoản bị khóa).
- **Acceptance:** cảnh báo đến trong ≤ 2 phút khi server mất kết nối hoặc disk vượt 90%; dashboard hiển thị đúng usage của từng account.

### Phase 12 — Production Hardening & Production Gate

- **Pentest (D-50):** không bắt buộc cho Alpha nội bộ; **bắt buộc pentest độc lập + khắc phục High/Critical trước khi mở bán hosting cho khách bên ngoài**.
- **Scope:** security review nội bộ, CIS Ubuntu, cân nhắc RLS PostgreSQL, đánh giá tách helper đặc quyền của agent, test hiệu năng 200 account/server, chaos test (mất điện giữa lúc update), import từ aaPanel/HestiaCP/Nginx thuần, offline installer, runbook vận hành.
- **Production Gate** (bắt buộc đạt trước v1.0.0, D-47). Mỗi bài phải có tiêu chí đo được **và bằng chứng kiểm thử** (lệnh, log, kết quả, ảnh) lưu ở `docs/gate/G<n>.md`:

| # | Kiểm thử | Tiêu chí |
|---|---|---|
| G1 | Isolation | Account A không đọc, ghi hay liệt kê được file, tiến trình, DB, socket, backup của B, qua PHP, cron, SFTP, Terminal, File Manager. 100% pass trên ≥ 2 server |
| G2 | Quota | CPU/RAM/process/IO/disk/inode bị chặn đúng giới hạn, không ảnh hưởng account khác |
| G3 | Privilege escalation | Thử từ webshell, từ USER portal, và giả định Laravel bị RCE. Không còn lỗi High/Critical |
| G4 | Backup/Restore | Restore ngẫu nhiên 10 account, có ít nhất 1 lần sang server khác. Panel không xóa được backup immutable |
| G5 | Upgrade | Nâng cấp qua 3 phiên bản liên tiếp, rollback giữa chừng, site không gián đoạn |
| G6 | Disaster recovery | Dựng lại control plane từ backup; khôi phục toàn bộ một server sang server khác; đạt RTO/RPO đã đặt |
| G7 | Migration | Chuyển 5 account giữa các server không mất dữ liệu |
| G8 | Uninstall | Gỡ panel thì site vẫn chạy, `/home` và DB còn nguyên |

## Tiêu chí nghiệm thu `v0.1.0-alpha` (cuối Phase 8, phạm vi nội bộ)

R1 cài một lệnh trên VM sạch, ≤ 10 phút, hoàn tất bằng wizard · R2 không cần cài tay Laravel/Node/Composer/Go/PostgreSQL, không bắt buộc Docker · R3 SUPER_ADMIN tạo gói, ADMIN, USER, account; USER chỉ thấy tài nguyên được cấp (ma trận quyền 100%) · R4 quota có hiệu lực ở kernel · R5 USER tạo site PHP có HTTPS, DB, upload file, SFTP, cron dưới UID riêng · R6 bộ test tấn công bị chặn 100% · R7 firewall/SSH tự rollback, không tự khóa được · R8 backup theo account lên ≥ 2 đích (1 immutable), restore và DR thành công · R9 update → rollback → update; uninstall giữ dữ liệu · R10 cả Admin Panel và User Portal đều có VI/EN, Light/Dark, 1440/390px, screenshot thật · R11 User Portal: MFA, khóa lũy tiến, CAPTCHA, WAF hoạt động; Admin Panel không truy cập được từ IP ngoài allowlist.

## Bổ sung bắt buộc từ D-46 (vòng đời xóa tài khoản) — áp dụng ở Phase 3 (logic), Phase 8 (backup check), Phase 11 (thông báo)

Terminate → giữ dữ liệu **30 ngày** → purge. Trước purge: cảnh báo người dùng + admin (khi terminate, T-7, T-1); audit mọi bước; xác minh **backup cuối cùng hợp lệ** (`restic check` + restore thử vào sandbox); vẫn khôi phục được bất kỳ lúc nào trước purge; purge 2 bước (lên lịch → xác nhận) có biên bản; legal hold chặn purge. Acceptance: test tự động cho toàn bộ chuỗi + test "purge bị chặn khi backup cuối không hợp lệ".
