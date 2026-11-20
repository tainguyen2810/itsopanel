# Sitemap UI — Admin Panel và User Hosting Portal

> Đầu vào cho Phase 2 (demo UI hoàn chỉnh). Số module theo [03-MODULES.md](../planning/03-MODULES.md). Vai trò: SA = SUPER_ADMIN, AD = ADMIN (trong phạm vi được giao), US = USER.
> Thành phần dùng các component của Design System (Prompt 1.6): DataTable, StatCard, Gauge, Tabs, FormField, Dialog, ConfirmDialog, Drawer, JobProgress, Chart.

## A. Private Admin Panel (`admin.<domain>`)

### Chung

| Route | Vai trò | Module | Thành phần chính |
|---|---|---|---|
| `/login` | SA, AD | 24 | Form đăng nhập, thông báo IP allowlist |
| `/login/mfa` | SA, AD | 10 | Nhập TOTP / recovery code |
| `/install` | (chưa có admin) | 30 | Wizard 10 bước: mã thiết lập, ngôn ngữ, Super Admin + MFA, truy cập panel, stack, bảo mật, quota, backup, SMTP, tổng kết |
| `/dashboard` | SA, AD | 1 | StatCard (server, website, DB, user, gói), Gauge CPU/RAM/disk/băng thông, Area chart network, bảng server, hoạt động gần đây, cảnh báo bảo mật, Donut phân bổ gói, Bar số website |
| `/jobs`, `/jobs/:id` | SA, AD | — | DataTable job, JobProgress với các bước, log |
| `/profile` | SA, AD | 24 | Hồ sơ, đổi mật khẩu, MFA, phiên đăng nhập |
| `/search` (Ctrl+K) | SA, AD | — | Command palette: server, account, website, user |

### Hạ tầng

| Route | Vai trò | Module | Thành phần chính |
|---|---|---|---|
| `/servers` | SA, AD | 2 | DataTable server (trạng thái, CPU/RAM/disk), nút thêm server |
| `/servers/new` | SA | 2 | Hiển thị lệnh `install.sh --role node --join <token>`, chờ agent kết nối |
| `/servers/:id` | SA, AD | 2 | Tabs: Tổng quan, Dịch vụ, Tài nguyên, Agent, Accounts |
| `/servers/:id/nginx` | SA, AD | 4 | Cấu hình global, trạng thái, xem cấu hình hiệu lực |
| `/servers/:id/php` | SA, AD | 5 | Phiên bản PHP, extension, số site dùng |
| `/servers/:id/software` | SA, AD | 17 | Catalog dạng thẻ, cài/gỡ/nâng cấp (job) |
| `/servers/:id/firewall` | SA, AD | 11 | Bảng rule, safe-apply có đếm ngược rollback |
| `/servers/:id/docker` | SA, AD | 18 | Tabs: Containers, Images, Volumes, Networks |
| `/servers/:id/terminal` | SA | 16 | xterm.js, cảnh báo policy root terminal |
| `/compose-projects`, `/compose-projects/:id` | SA, AD | 19 | Danh sách project, editor YAML, báo cáo validator, revision |
| `/docker/registries` | SA, AD | 20 | Danh sách registry |

### Hosting

| Route | Vai trò | Module | Thành phần chính |
|---|---|---|---|
| `/hosting-packages` | SA | 25 | DataTable gói, so sánh giới hạn |
| `/hosting-packages/new`, `/:id` | SA | 25 | Form giới hạn (CPU, RAM, disk, inode, process, website, DB, domain, FTP, cron, backup, SSH, PHP), lịch sử version |
| `/hosting-accounts` | SA, AD | 26 | DataTable account (server, gói, chủ, usage, trạng thái vòng đời) |
| `/hosting-accounts/new` | SA, AD | 26 | Wizard: chọn user, gói, server (có gợi ý), username |
| `/hosting-accounts/:id` | SA, AD | 26 | Tabs: Tổng quan + usage, Websites, Databases, SFTP, Cron, Backup, Vòng đời; hành động khóa/mở, đổi gói, chuyển server, xóa |
| `/hosting-accounts/:id/migrate` | SA | 26 | Wizard chuyển server: preflight, sync, kiểm tra, cutover, rollback |
| `/hosting-accounts/terminated` | SA | 26 | Danh sách chờ purge, đếm ngược 30 ngày, trạng thái backup đã xác minh, xác nhận purge 2 bước |
| `/websites`, `/websites/:id` | SA, AD | 3 | DataTable; Tabs: Tổng quan, Domain, PHP, SSL, Nginx, WAF, Log, Backup |
| `/databases` | SA, AD | 6 | DataTable DB và DB user |
| `/files` | SA, AD | 7 | File Manager 2 pane trong home của account (chọn account trước) |
| `/sftp` | SA, AD | 8 | Tài khoản SFTP/FTPS, SSH key |
| `/ssl` | SA, AD | 9 | Chứng chỉ, ngày hết hạn, gia hạn |
| `/dns` | SA, AD | 9 | Provider, zone, bảng record |
| `/cron` | SA, AD | 15 | Cron theo account, lịch sử chạy |
| `/wordpress` | SA, AD | 21 | Danh sách site WP, cập nhật, clone staging, hardening |
| `/git-deployments` | SA, AD | 22 | Repo, webhook, lịch sử deploy (P2, demo đơn giản) |

### Bảo mật và sao lưu

| Route | Vai trò | Module | Thành phần chính |
|---|---|---|---|
| `/security` | SA, AD | 10 | Điểm bảo mật, checklist, sự kiện |
| `/security/waf` | SA, AD | 11 | Trạng thái per-site, sự kiện bị chặn |
| `/security/malware` | SA, AD | 12 | Lịch quét, kết quả, quarantine |
| `/security/ssh` | SA | 10 | SSH hardening, safe-apply |
| `/security/fail2ban` | SA | 10 | Jails, IP bị chặn |
| `/security/fim` | SA | 10 | Thay đổi file hệ thống |
| `/security/allowlist` | SA | 10 | IP allowlist cho Admin Panel |
| `/backups` | SA, AD | 13 | Tabs: Đích lưu, Chính sách, Lịch sử, Kiểm chứng, checklist 3-2-1-1-0 |
| `/restores`, `/restores/new` | SA, AD | 14 | Wizard: snapshot → phạm vi → đích (kể cả server khác) → xác nhận |

### Quản trị

| Route | Vai trò | Module | Thành phần chính |
|---|---|---|---|
| `/users`, `/users/:id` | SA, AD | 24 | DataTable user (realm, vai trò, MFA, trạng thái); phạm vi ADMIN; impersonate có lý do |
| `/roles` | SA | 24 | Ma trận quyền (chỉ xem ở v0.x) |
| `/monitoring` | SA, AD | 23 | Biểu đồ theo server/account, uptime check |
| `/monitoring/alerts` | SA, AD | 23 | Alert rule, lịch sử cảnh báo |
| `/audit-logs` | SA, AD | 27 | DataTable có lọc, xem chi tiết thay đổi, xuất CSV |
| `/notifications` | SA, AD | 28 | Danh sách thông báo, kênh |
| `/settings` | SA | 29 | Tabs: Chung, Thương hiệu, Truy cập, SMTP, Bảo mật, Cập nhật, Thông tin phiên bản |

## B. User Hosting Portal (`my.<domain>`)

| Route | Vai trò | Module | Thành phần chính |
|---|---|---|---|
| `/login`, `/login/mfa`, `/forgot-password` | US | 24, 10 | Form, CAPTCHA sau khi sai nhiều lần |
| `/` (Tổng quan) | US | 1, 26 | Usage so với quota (disk, inode, CPU, RAM, website, DB), cảnh báo, cert sắp hết hạn |
| `/accounts/:id` | US | 26 | Thông tin gói (chỉ đọc), usage chi tiết |
| `/websites`, `/websites/new`, `/websites/:id` | US | 3, 5, 9 | Danh sách site, tạo site, Tabs: Tổng quan, Domain, PHP (trong phạm vi gói), SSL, Log |
| `/databases` | US | 6 | DB, DB user, export/import |
| `/files` | US | 7 | File Manager trong home của mình, upload, editor |
| `/sftp` | US | 8 | Tài khoản SFTP, SSH key |
| `/cron` | US | 15 | Cron, lịch sử chạy |
| `/backups` | US | 13, 14 | Snapshot của mình, tạo backup, khôi phục, link tải |
| `/wordpress` | US | 21 | Cài đặt, cập nhật, hardening |
| `/terminal` | US (gói có SSH) | 16 | Terminal trong jail |
| `/jobs/:id` | US | — | Tiến độ thao tác |
| `/notifications` | US | 28 | Thông báo quota, SSL, backup, khóa tài khoản |
| `/profile` | US | 24 | Hồ sơ, mật khẩu, MFA, phiên đăng nhập |

Portal **không có**: server, gói (chỉ xem gói của mình), user, firewall, Docker, phần mềm, cài đặt hệ thống, mua hàng, thanh toán.

## C. Yêu cầu chung cho mọi trang

- VI mặc định, EN; Light/Dark; 390px đến 1440px không tràn ngang.
- Trạng thái rỗng, đang tải (skeleton), lỗi, và không có quyền.
- Thao tác chạm Linux hiển thị JobProgress; thao tác nguy hiểm dùng ConfirmDialog gõ tên để xác nhận.
- Dữ liệu demo nhất quán giữa các trang (Phase 2).
