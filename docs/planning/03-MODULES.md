# 03 — Module breakdown (30 module)

**Ký hiệu ưu tiên:** P0 = bắt buộc cho v0.1.0-alpha · P1 = cần cho v0.2 · P2 = sau/ tùy chọn.
**Phân quyền:** SA = SUPER_ADMIN · AD = ADMIN (trong phạm vi được giao) · US = USER (chỉ tài nguyên của mình).
**Phase:** UI demo của mọi module thuộc Phase 2; cột Phase dưới đây là phase **chức năng thật**.

| # | Module | Ưu tiên | Phase thật |
|---|---|---|---|
| 1 | Dashboard & System Overview | P0 | 3 (dữ liệu panel) → 4 (metrics thật) |
| 2 | Server Management | P0 | 4 (local) → 11 (multi) |
| 3 | Website Management | P0 | 5 |
| 4 | Nginx Management | P0 | 5 |
| 5 | PHP Manager | P0 | 5 |
| 6 | Database Manager | P0 | 6 |
| 7 | File Manager | P0 | 6 |
| 8 | FTP/SFTP | P0 (SFTP) / P2 (FTP) | 6 |
| 9 | DNS & SSL | P0 (SSL) / P1 (DNS) | 5 (SSL) · 10 (DNS provider) |
| 10 | Security Center | P0 | 3 (MFA, audit) · 7 |
| 11 | Firewall & WAF | P0 (FW) / P1 (WAF) | 7 |
| 12 | Malware Scanner | P1 | 7 |
| 13 | Backup Center | P0 | 8 |
| 14 | Restore Center | P0 | 8 |
| 15 | Cron Jobs | P0 | 6 |
| 16 | Terminal & SSH | P1 | 7 |
| 17 | Software Manager | P0 (cơ bản) | 4 (cơ bản) · 10 |
| 18 | Docker Manager | P1 | 9 |
| 19 | Docker Compose | P1 | 9 |
| 20 | Docker Images/Volumes/Networks | P1 | 9 |
| 21 | WordPress Toolkit | P1 | 10 |
| 22 | Git Deployment | P2 | 10 |
| 23 | Monitoring & Alerts | P0 (cơ bản) / P1 | 4 (metrics) · 11 |
| 24 | Users & Roles | P0 | 3 |
| 25 | Hosting Packages | P0 | 3 (dữ liệu) · 4 (thực thi) |
| 26 | Hosting Accounts | P0 | 3 (dữ liệu) · 4 (thực thi) |
| 27 | Activity Logs & Audit | P0 | 3 |
| 28 | Notifications | P0 (in-app) / P1 (kênh) | 3 · 11 |
| 29 | Settings | P0 | 3 |
| 30 | Installation Wizard & CLI | P0 | 4 |

---

## 1. Dashboard & System Overview
- **Mục tiêu:** Một màn hình cho biết sức khỏe hệ thống và việc cần chú ý (theo mockup).
- **Chức năng:** thẻ đếm (server, website, DB, user, package); gauge CPU/RAM/Disk/Bandwidth; biểu đồ network; bảng server; hoạt động gần đây; cảnh báo bảo mật; phân bổ gói; chọn khoảng thời gian; auto refresh. USER thấy phiên bản thu gọn: quota của mình, site của mình.
- **Giao diện:** `/dashboard` — grid card, Recharts (area, donut, bar), skeleton loading.
- **API:** `GET /dashboard/summary`, `GET /metrics/servers/{id}?range=24h`, `GET /activity?limit=5`, `GET /security/alerts?limit=3`.
- **Database:** đọc từ các bảng khác + `metric_samples`, `metric_rollups`.
- **Agent ops:** `metrics.snapshot` (collector định kỳ).
- **Phân quyền:** SA toàn bộ; AD theo server/account được giao; US chỉ của mình.
- **Kiểm thử:** snapshot UI 4 biến thể; API test theo vai trò (USER không thấy server khác).
- **Phụ thuộc:** 2, 23, 24, 27.

## 2. Server Management
- **Mục tiêu:** Đăng ký, xem trạng thái, thao tác cơ bản với server.
- **Chức năng:** thông tin OS/kernel/uptime, services status (start/stop/restart allowlist), hostname, timezone, swap, reboot (MFA re-auth), gán ADMIN cho server, nhãn (Web/DB/Backup). Multi-server: thêm server bằng enrollment token.
- **Giao diện:** `/servers`, `/servers/{id}` (tab: Tổng quan, Dịch vụ, Thông số, Agent).
- **API:** `GET/POST /servers`, `GET/PATCH /servers/{id}`, `POST /servers/{id}/services/{name}:restart`, `POST /servers/{id}:reboot`, `POST /servers/enrollment-tokens`.
- **Database:** `servers`, `agents`, `server_admins`, `server_services`.
- **Agent ops:** `system.info`, `service.status`, `service.control{name∈allowlist, action}`, `system.reboot`, `system.hostname.set`.
- **Phân quyền:** SA đầy đủ; AD xem + restart dịch vụ trên server được giao; US không truy cập.
- **Kiểm thử:** service allowlist (từ chối `ssh` stop nếu là phiên duy nhất), enrollment token hết hạn/dùng lại.
- **Phụ thuộc:** Agent (Phase 4).

## 3. Website Management
- **Mục tiêu:** Vòng đời website: tạo, cấu hình, tạm ngưng, xóa.
- **Chức năng:** tạo site (domain chính + alias), loại (PHP, static, reverse proxy tới app/container), document root, PHP version, SSL, redirect, suspend/unsuspend (trang suspend), xóa (soft-delete + giữ dữ liệu N ngày), log truy cập/lỗi, thống kê dung lượng.
- **Giao diện:** `/websites` (table + filter), wizard tạo site, `/websites/{id}` (tab: Tổng quan, Domain, PHP, SSL, Nginx, Log, Backup).
- **API:** `GET/POST /websites`, `GET/PATCH/DELETE /websites/{id}`, `POST /websites/{id}:suspend|unsuspend`, `GET/POST/DELETE /websites/{id}/domains`, `GET /websites/{id}/logs?type=access`.
- **Database:** `websites`, `domains`, `website_settings`.
- **Agent ops:** `fs.site_layout.ensure`, `nginx.vhost.apply`, `nginx.vhost.remove`, `site.suspend`, `log.tail`.
- **Phân quyền:** US trên account của mình trong giới hạn gói; AD/SA trên phạm vi.
- **Kiểm thử:** domain validation (IDN, wildcard bị chặn với US), quota website/domain, tạo trùng domain toàn hệ thống, rollback khi `nginx -t` fail.
- **Phụ thuộc:** 4, 5, 26.

## 4. Nginx Management
- **Mục tiêu:** Sinh cấu hình Nginx an toàn từ template, cho chỉnh có kiểm soát.
- **Chức năng:** template theo loại site; tùy chọn an toàn (gzip/brotli, cache static, client_max_body_size, headers bảo mật, rate limit); **custom snippet** chỉ SA/AD (US không được nhập directive tự do); config test + reload + rollback tự động; xem cấu hình hiệu lực.
- **Giao diện:** tab Nginx trong site; `/nginx` (global settings, trạng thái).
- **API:** `GET/PATCH /websites/{id}/nginx`, `GET/PATCH /servers/{id}/nginx/global`.
- **Database:** `website_settings` (jsonb validated), `nginx_global_settings`.
- **Agent ops:** `nginx.vhost.apply` (render → ghi file tạm → `nginx -t` → atomic rename → reload; lỗi → khôi phục bản trước), `nginx.global.apply`, `nginx.inspect`.
- **Phân quyền:** US chỉ toggle tùy chọn an toàn; AD/SA snippet.
- **Kiểm thử:** golden-file test template; fuzz giá trị (chặn `;`, `{`, newline trong mọi field); rollback test.
- **Phụ thuộc:** Agent, 3.

## 5. PHP Manager
- **Mục tiêu:** Nhiều phiên bản PHP, cấu hình per-site.
- **Chức năng:** cài/gỡ phiên bản (8.1–8.4 từ `ondrej/php`), extension allowlist, `php.ini` per-site (giới hạn theo gói: memory_limit, upload, max_execution_time), `disable_functions` mặc định, OPcache, xem phpinfo (chỉ trong site).
- **Giao diện:** `/php` (phiên bản, extension), tab PHP trong site.
- **API:** `GET /servers/{id}/php/versions`, `POST /servers/{id}/php/versions` (job), `PATCH /websites/{id}/php`.
- **Database:** `php_versions` (observed), `website_settings.php`.
- **Agent ops:** `php.version.install|remove`, `php.ext.install`, `php.pool.apply` (per-account FPM instance), `php.pool.remove`.
- **Phân quyền:** cài phiên bản: SA (AD nếu được giao server); per-site: US trong giới hạn gói (`allowed_php_versions`).
- **Kiểm thử:** không cho gỡ phiên bản đang được site dùng; pool chạy đúng uid; `memory_limit` không vượt gói.
- **Phụ thuộc:** 17, 25.

## 6. Database Manager
- **Mục tiêu:** Tạo/quản lý DB MySQL/MariaDB và PostgreSQL cho account.
- **Chức năng:** tạo DB + user (prefix theo account), đổi mật khẩu, phân quyền DB-user, giới hạn kết nối (`MAX_USER_CONNECTIONS`), import/export (qua job, file trong home), xem kích thước, truy cập remote theo IP (tắt mặc định), công cụ quản trị web (Adminer qua SSO token ngắn hạn — P1).
- **Giao diện:** `/databases`, dialog tạo, tab Users.
- **API:** `GET/POST /databases`, `DELETE /databases/{id}`, `POST /databases/{id}:export|import`, `GET/POST /database-users`, `POST /database-users/{id}:rotate-password`.
- **Database:** `databases`, `database_users`, `database_grants` (mật khẩu không lưu plaintext; chỉ hiển thị một lần hoặc lưu mã hóa nếu cần cho WP toolkit).
- **Agent ops:** `db.mysql.create|drop|user.ensure|grant|dump|import|size`, `db.pg.*` tương tự. Agent dùng tài khoản quản trị DB cục bộ qua socket (auth_socket/peer), không truyền mật khẩu root qua panel.
- **Phân quyền:** US trong quota `database_limit`; AD/SA.
- **Kiểm thử:** tên DB injection (`a\`; DROP`), user A không grant được vào DB của B, import file ngoài home bị chặn.
- **Phụ thuộc:** 17, 26.

## 7. File Manager
- **Mục tiêu:** Quản lý file trong home của account qua web, an toàn với path traversal/symlink.
- **Chức năng:** duyệt, upload (chunked, resumable), download, tạo/sửa (CodeMirror), đổi tên, copy/move, xóa (thùng rác), nén/giải nén (zip/tar.gz, giới hạn kích thước giải nén — chống zip bomb), chmod (giới hạn: không setuid/setgid), tìm kiếm, xem quota.
- **Giao diện:** `/files?account=..&path=..` — 2 pane, editor modal.
- **API:** `GET /files/list`, `GET /files/content`, `PUT /files/content`, `POST /files/upload` (tus-like chunk), `POST /files:move|copy|delete|compress|extract|chmod`.
- **Database:** không lưu file; `file_operations` (audit), `upload_sessions`.
- **Agent ops:** `fs.list|stat|read|write|mkdir|move|copy|delete|chmod|archive|extract` — **mọi op chạy trong tiến trình con đã hạ quyền xuống uid của account**, mở đường dẫn bằng `openat2(RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS)` từ dirfd của home.
- **Phân quyền:** US chỉ home của mình; AD/SA truy cập home account trong phạm vi (có audit). Không ai duyệt `/` qua File Manager (SA dùng Terminal).
- **Kiểm thử:** `../../etc/passwd`, symlink tới `/etc/shadow`, symlink race (TOCTOU), zip slip, zip bomb, file > quota.
- **Phụ thuộc:** 26, Agent.

## 8. FTP/SFTP
- **Mục tiêu:** Truy cập file bằng client chuẩn.
- **Chức năng:** SFTP mặc định (OpenSSH `internal-sftp`, chroot vào home), nhiều tài khoản SFTP phụ per account (giới hạn thư mục con) — tài khoản phụ dùng cùng uid hoặc virtual user; FTPS (Pure-FTPd, TLS bắt buộc) tùy chọn; SSH key management.
- **Giao diện:** `/sftp`, tab trong account.
- **API:** `GET/POST/DELETE /sftp-accounts`, `POST /sftp-accounts/{id}:rotate-password`, `GET/POST /ssh-keys`.
- **Database:** `sftp_accounts`, `ssh_keys`.
- **Agent ops:** `sftp.account.apply`, `sshd.match.apply` (cấu hình Match Group + test `sshd -t`), `ftp.account.apply`.
- **Phân quyền:** US trong `ftp_limit`; SSH shell chỉ khi gói có `ssh_permission`.
- **Kiểm thử:** chroot escape, đăng nhập sau khi account suspend, `sshd -t` fail → rollback.
- **Phụ thuộc:** 26, 10.

## 9. DNS & SSL
- **Mục tiêu:** Chứng chỉ TLS tự động; quản lý DNS qua provider.
- **Chức năng SSL:** Let's Encrypt/ZeroSSL qua ACME (HTTP-01, DNS-01), tự gia hạn, upload cert riêng, force HTTPS, HSTS, cảnh báo hết hạn. **DNS:** kết nối provider (Cloudflare trước), CRUD record cho domain được sở hữu, kiểm tra trỏ domain trước khi cấp SSL.
- **Giao diện:** tab SSL trong site; `/dns` (zone list, record table).
- **API:** `POST /websites/{id}/certificates` (job), `GET /certificates`, `POST /certificates/{id}:renew`, `GET/POST /dns/providers`, `GET/POST/PATCH/DELETE /dns/zones/{id}/records`.
- **Database:** `certificates`, `acme_accounts`, `dns_providers` (token mã hóa), `dns_zones`, `dns_records`.
- **Agent ops:** `cert.issue` (lego nhúng, webroot challenge), `cert.install`, `cert.inspect`. DNS provider API gọi từ **worker** (không cần đặc quyền) hoặc agent nếu dùng DNS-01.
- **Phân quyền:** US cho domain của mình; provider credentials chỉ SA/AD.
- **Kiểm thử:** Pebble (ACME test server) trong CI; rate-limit LE; renew trước 30 ngày.
- **Phụ thuộc:** 3, 4.

## 10. Security Center
- **Mục tiêu:** Một nơi xem và điều chỉnh tư thế bảo mật.
- **Chức năng:** điểm bảo mật (checklist: SSH root login, password auth, firewall bật, MFA admin…), MFA (TOTP + recovery codes; WebAuthn P1), quản lý session, IP allowlist panel, rate limit login, SSH hardening (đổi port, tắt password, AllowGroups), Fail2ban jails, FIM, cảnh báo bảo mật, secret rotation.
- **Giao diện:** `/security` (tổng quan + các tab: Firewall, WAF, Malware, SSH, Fail2ban, FIM, Phiên đăng nhập).
- **API:** `GET /security/overview`, `GET/PATCH /security/ssh`, `GET/PATCH /security/fail2ban`, `GET /security/events`, `POST /auth/mfa/*`, `GET/DELETE /auth/sessions`.
- **Database:** `security_events`, `security_settings`, `mfa_credentials`, `sessions`, `ip_allowlist`.
- **Agent ops:** `sshd.config.apply` (luôn `sshd -t`, giữ phiên cũ, rollback hẹn giờ 120s nếu không xác nhận), `fail2ban.apply`, `fim.baseline|scan`, `security.audit` (kiểm tra checklist).
- **Phân quyền:** SA; AD xem trên server được giao; US: MFA và session của mình.
- **Kiểm thử:** lockout recovery (`itso security reset-allowlist` từ CLI), MFA bypass attempts.
- **Phụ thuộc:** 24, 27, 11.

## 11. Firewall & WAF
- **Mục tiêu:** Chặn truy cập không mong muốn ở tầng mạng và HTTP.
- **Chức năng:** rule mở port (allowlist), chặn IP/CIDR/quốc gia (GeoIP — P2), giới hạn tốc độ kết nối, rule panel port chỉ từ allowlist; WAF ModSecurity v3 + OWASP CRS 4 bật per-site, chế độ DetectionOnly/Blocking, paranoia level, rule exclusion per-site, log WAF.
- **Giao diện:** `/security/firewall`, `/security/waf`, tab WAF trong site.
- **API:** `GET/POST/DELETE /servers/{id}/firewall/rules`, `PATCH /websites/{id}/waf`, `GET /waf/events`.
- **Database:** `firewall_rules`, `waf_settings`, `waf_events` (tóm tắt).
- **Agent ops:** `firewall.apply` (render toàn bộ bảng `inet itso` → `nft -c` → `nft -f` nguyên tử; có "safe apply" tự rollback sau 60s nếu panel mất kết nối), `waf.site.apply`, `waf.crs.update`.
- **Phân quyền:** SA; AD trên server được giao; US bật/tắt WAF site mình (không sửa rule).
- **Kiểm thử:** không bao giờ tự khóa port SSH/panel hiện tại; tương tác với Docker (xem `09-DOCKER.md`); payload OWASP test.
- **Phụ thuộc:** 4, 18.

## 12. Malware Scanner
- **Mục tiêu:** Phát hiện webshell/malware trong web root.
- **Chức năng:** quét theo lịch/on-demand (ClamAV + YARA rules cho PHP webshell), quét file vừa upload (inotify — P2), cách ly (quarantine, chuyển file + chmod 000, ghi metadata), khôi phục từ quarantine, báo cáo per-site.
- **Giao diện:** `/security/malware`, tab trong site.
- **API:** `POST /websites/{id}/scans` (job), `GET /scans/{id}`, `GET /quarantine`, `POST /quarantine/{id}:restore|delete`.
- **Database:** `malware_scans`, `malware_findings`, `quarantine_items`.
- **Agent ops:** `malware.scan` (chạy dưới slice `itso-maintenance.slice` có giới hạn CPU/IO), `malware.quarantine`, `malware.restore`, `malware.signatures.update`.
- **Phân quyền:** SA/AD; US xem kết quả site mình và yêu cầu quét (giới hạn tần suất).
- **Kiểm thử:** EICAR, mẫu webshell YARA test, quét không làm nghẽn server.
- **Phụ thuộc:** 17, 10.

## 13. Backup Center
- **Mục tiêu:** Sao lưu đúng, mã hóa, có thể khôi phục, tuân thủ 3-2-1-1-0.
- **Chức năng:** đích lưu (local, SFTP/NAS, S3-compatible, rest-server append-only), policy (lịch, phạm vi: site/DB/cấu hình/Docker volume, retention), chạy ngay, theo dõi job, kiểm chứng (`restic check` + restore test định kỳ), quota backup per account.
- **Giao diện:** `/backups` (Đích lưu, Chính sách, Lịch sử, Kiểm chứng).
- **API:** `GET/POST /backup-destinations`, `GET/POST/PATCH /backup-policies`, `POST /backup-policies/{id}:run`, `GET /backup-snapshots`, `GET /backup-jobs`.
- **Database:** `backup_destinations`, `backup_policies`, `backup_jobs`, `backup_snapshots`, `backup_verifications`.
- **Agent ops:** `backup.run` (restic, DB qua stdin), `backup.snapshots.list`, `backup.check`, `backup.forget` (chỉ với credential prune riêng — xem `08-BACKUP.md`).
- **Phân quyền:** SA đầy đủ; AD trong phạm vi; US backup/restore site của mình trong quota, **không** xóa snapshot immutable.
- **Kiểm thử:** restore thật trong CI (VM), DB consistency, mất kết nối giữa chừng.
- **Phụ thuộc:** 3, 6, 26.

## 14. Restore Center
- **Mục tiêu:** Khôi phục nhanh, có chọn lọc, an toàn.
- **Chức năng:** restore site (file), DB (vào DB mới hoặc ghi đè có xác nhận), file đơn lẻ, cấu hình server, Docker volume, cross-server restore, DR (khôi phục toàn bộ panel + site lên server mới), restore dry-run, backup "pre-restore" tự động.
- **Giao diện:** `/restore` wizard: chọn snapshot → chọn phạm vi → đích → xác nhận.
- **API:** `POST /restores` (job), `GET /restores/{id}`, `GET /backup-snapshots/{id}/browse?path=`.
- **Database:** `restore_jobs`.
- **Agent ops:** `backup.restore` (vào thư mục staging, rồi swap nguyên tử), `backup.browse`.
- **Phân quyền:** như 13.
- **Kiểm thử:** restore vào account khác bị chặn với US; DR runbook diễn tập.
- **Phụ thuộc:** 13.

## 15. Cron Jobs
- **Mục tiêu:** Tác vụ định kỳ cho account, chịu giới hạn tài nguyên.
- **Chức năng:** tạo cron (biểu thức cron hoặc preset), lệnh chạy dưới user của account, timeout, log lần chạy gần nhất, bật/tắt, chạy ngay.
- **Giao diện:** `/cron`.
- **API:** `GET/POST/PATCH/DELETE /cron-jobs`, `POST /cron-jobs/{id}:run`, `GET /cron-jobs/{id}/runs`.
- **Database:** `cron_jobs`, `cron_runs` (tóm tắt).
- **Agent ops:** `cron.apply` → systemd timer + service `itso-cron-<id>` với `User=<acct>`, `Slice=itso-acct-<id>.slice`, `RuntimeMaxSec`.
- **Phân quyền:** US trong `cron_limit`; tần suất tối thiểu theo gói (vd ≥ 5 phút).
- **Kiểm thử:** lệnh không thoát được slice, account suspend → timer dừng.
- **Phụ thuộc:** 26.

## 16. Terminal & SSH
- **Mục tiêu:** Shell trên web khi cần.
- **Chức năng:** web terminal (xterm.js) cho USER dưới uid của mình (chỉ khi gói có `ssh_permission`), chạy trong slice của account; terminal root cho SA **tắt mặc định**, chỉ bật bằng CLI (`itso policy set root_terminal=true`) + MFA re-auth + ghi lại phiên (asciicast) vào audit; giới hạn thời lượng.
- **Giao diện:** `/terminal`.
- **API:** `POST /terminal/sessions` → trả ticket một lần cho gateway; `GET /terminal/sessions` (lịch sử).
- **Database:** `terminal_sessions`.
- **Agent ops:** `pty.open{uid, slice}` qua stream socket.
- **Phân quyền:** như trên.
- **Kiểm thử:** ticket dùng lại, ticket hết hạn, USER mở shell uid khác.
- **Phụ thuộc:** gateway, 10, 26.

## 17. Software Manager
- **Mục tiêu:** Cài/gỡ/cập nhật phần mềm server từ **catalog có kiểm soát**.
- **Chức năng:** catalog (Nginx, PHP x.y, MariaDB/MySQL, PostgreSQL, Redis, Fail2ban, ClamAV, Docker, Node.js runtime cho app…), trạng thái, version, cập nhật bảo mật OS (unattended-upgrades), xung đột (MySQL vs MariaDB).
- **Giao diện:** `/software` (dạng app store nội bộ).
- **API:** `GET /servers/{id}/software`, `POST /servers/{id}/software/{key}:install|remove|upgrade`.
- **Database:** `software_catalog` (seed), `server_software` (observed).
- **Agent ops:** `software.install{recipe_key}` — recipe định nghĩa sẵn trong agent (không nhận tên package tùy ý).
- **Phân quyền:** SA; AD trên server được giao.
- **Kiểm thử:** cài lại idempotent, gỡ khi đang được dùng bị chặn.
- **Phụ thuộc:** Agent.

## 18. Docker Manager · 19. Docker Compose · 20. Images/Volumes/Networks
Chi tiết ở `09-DOCKER.md`. Tóm tắt:
- **Chức năng:** container (list/start/stop/restart/logs/stats/exec qua gateway), compose project (từ YAML đã validate hoặc template), images (pull, prune, update check), volumes, networks, registries (credential mã hóa), reverse proxy + SSL qua Nginx, backup/restore volume.
- **API:** `/servers/{id}/docker/containers|images|volumes|networks`, `/compose-projects`, `/registries`.
- **Database:** `docker_hosts`, `compose_projects`, `compose_revisions`, `containers` (observed cache), `registries`.
- **Agent ops:** `docker.*` qua Docker Engine API trên socket (chỉ agent truy cập), `compose.validate|up|down|pull`.
- **Phân quyền:** SA/AD; US chỉ "managed apps" (Phase sau) khi gói có `docker_permission`.
- **Ưu tiên:** P1 · Phase 9.

## 21. WordPress Toolkit
- **Mục tiêu:** Cài và vận hành WordPress nhanh, an toàn.
- **Chức năng:** cài 1-click (WP-CLI chạy dưới user account), danh sách site WP, cập nhật core/plugin/theme, staging clone, bật/tắt maintenance, hardening (tắt file edit, chặn xmlrpc), đổi mật khẩu admin, kiểm tra plugin có lỗ hổng (nguồn dữ liệu cần chọn — P2).
- **API:** `POST /websites/{id}/wordpress:install`, `GET /wordpress/sites`, `POST /wordpress/sites/{id}:update|clone|harden`.
- **Database:** `wordpress_sites`, `wordpress_components`.
- **Agent ops:** `wp.cli{subcommand∈allowlist, args typed}` chạy dưới uid account.
- **Phân quyền:** US trên site của mình.
- **Phụ thuộc:** 3, 5, 6, 13 (backup trước update).

## 22. Git Deployment
- **Mục tiêu:** Deploy từ Git repository.
- **Chức năng:** kết nối repo (deploy key per site), branch, webhook (secret HMAC), script build/deploy chạy dưới user account trong slice, zero-downtime bằng releases + symlink, rollback.
- **API:** `GET/POST /websites/{id}/git`, `POST /websites/{id}/deployments`, `POST /hooks/git/{token}`.
- **Database:** `git_repositories`, `deployments`.
- **Agent ops:** `git.deploy` (dưới uid account).
- **Phân quyền:** US nếu gói cho phép.
- **Phụ thuộc:** 3, 15.

## 23. Monitoring & Alerts
- **Mục tiêu:** Biết trước khi người dùng phàn nàn.
- **Chức năng:** metrics server (CPU, RAM, disk, IO, network, load), per-account (từ cgroup: cpu.stat, memory.current, io.stat), service health, uptime check HTTP cho site, ngưỡng cảnh báo, kênh (email, Telegram, webhook), lưu 1 phút × 7 ngày, rollup 1 giờ × 90 ngày.
- **API:** `GET /metrics/*`, `GET/POST/PATCH /alert-rules`, `GET /alerts`.
- **Database:** `metric_samples` (partition theo ngày), `metric_rollups`, `alert_rules`, `alerts`, `uptime_checks`.
- **Agent ops:** `metrics.snapshot`, `metrics.cgroup`.
- **Phụ thuộc:** 2, 28.

## 24. Users & Roles
- **Mục tiêu:** Quản lý người dùng panel và phân quyền.
- **Chức năng:** CRUD user, vai trò (SA/AD/US) + permission chi tiết, gán ADMIN cho server/account, khóa/mở, buộc đổi mật khẩu, MFA bắt buộc cho SA/AD, impersonate (SA → có audit, banner rõ ràng), API token có scope.
- **API:** `GET/POST/PATCH/DELETE /users`, `POST /users/{id}:lock|unlock|impersonate`, `GET /roles`, `GET/POST /api-tokens`.
- **Database:** `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_scopes`, `api_tokens`.
- **Phân quyền:** SA quản lý tất cả; AD tạo/quản lý USER trong phạm vi; US chỉ hồ sơ mình.
- **Kiểm thử:** ma trận quyền tự động (mọi endpoint × mọi vai trò).

## 25. Hosting Packages
- **Mục tiêu:** Định nghĩa gói tài nguyên.
- **Chức năng:** các giới hạn: disk, CPU, RAM, tasks, IO weight, website, database, domain, FTP/SFTP, backup quota + retention, SSH, Docker, PHP versions + ini limits, cron limit + tần suất; clone gói; thay đổi gói áp dụng lại cho mọi account (job hàng loạt).
- **API:** `GET/POST/PATCH/DELETE /hosting-packages`.
- **Database:** `hosting_packages` (limits jsonb có schema + cột chính cho truy vấn).
- **Agent ops:** gián tiếp qua account (`account.limits.apply`).
- **Phân quyền:** SA; AD tạo gói con không vượt gói được giao (P1) hoặc chỉ dùng gói có sẵn (v0.1).

## 26. Hosting Accounts
- **Mục tiêu:** Đơn vị cô lập tài nguyên = Linux user.
- **Chức năng:** tạo account (chọn server, gói, chủ sở hữu USER), suspend/unsuspend, đổi gói, xóa (giữ dữ liệu 30 ngày rồi purge có xác nhận), xem usage thực tế so với quota.
- **API:** `GET/POST/PATCH/DELETE /hosting-accounts`, `POST /hosting-accounts/{id}:suspend|unsuspend|change-package`, `GET /hosting-accounts/{id}/usage`.
- **Database:** `hosting_accounts`, `account_usage_snapshots`.
- **Agent ops:** `account.ensure` (user/group/home/ACL), `account.limits.apply` (slice + quota), `account.suspend` (dừng FPM, timers, khóa SFTP/SSH, vhost → trang suspend), `account.remove`.
- **Phân quyền:** SA/AD tạo; US xem.
- **Kiểm thử:** quota thật (dd vượt disk → EDQUOT), stress CPU/RAM bị giới hạn, fork bomb bị TasksMax chặn.

## 27. Activity Logs & Audit
- **Mục tiêu:** Ai làm gì, khi nào, từ đâu, kết quả.
- **Chức năng:** audit mọi mutation (actor, impersonator, IP, UA, resource, before/after đã che secret, job_id), activity feed thân thiện, lọc/xuất CSV, **append-only** (DB trigger chặn UPDATE/DELETE; hash chain `prev_hash`), đồng bộ với audit cục bộ của agent, retention.
- **API:** `GET /audit-logs`, `GET /activity`.
- **Database:** `audit_logs` (partition theo tháng).
- **Phân quyền:** SA tất cả; AD trong phạm vi; US hoạt động của mình.

## 28. Notifications
- **Mục tiêu:** Đưa thông tin đúng người.
- **Chức năng:** in-app (chuông), email (SMTP cấu hình), Telegram, webhook; tùy chọn theo user; sự kiện: job xong/lỗi, cert sắp hết hạn, backup lỗi, cảnh báo bảo mật, quota 80/100%.
- **API:** `GET /notifications`, `POST /notifications/{id}:read`, `GET/PATCH /notification-preferences`, `GET/POST /notification-channels`.
- **Database:** `notifications`, `notification_preferences`, `notification_channels`.

## 29. Settings
- **Mục tiêu:** Cấu hình panel.
- **Chức năng:** tên/branding, ngôn ngữ mặc định, múi giờ, panel domain + SSL, port, đường dẫn "entrance" bí mật, SMTP, chính sách mật khẩu/MFA, session timeout, IP allowlist, cập nhật (kênh stable/beta), thông tin phiên bản.
- **API:** `GET/PATCH /settings/{group}`.
- **Database:** `settings` (key, value jsonb, encrypted flag).

## 30. Installation Wizard & CLI
Chi tiết ở `10-INSTALLER.md`. Wizard: tạo SA + MFA, domain panel + SSL, chọn stack (Nginx/PHP/DB), firewall cơ bản, SMTP, xác nhận. CLI: `itso status|install|update|rollback|repair|uninstall|admin reset-password|policy|backup|logs|doctor`.
