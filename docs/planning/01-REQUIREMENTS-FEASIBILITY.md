# 01 — Phân tích yêu cầu, tính khả thi và đánh giá stack

> Trạng thái: DRAFT chờ duyệt · Ngày: 2026-11-20 · Phạm vi: chỉ lập kế hoạch, chưa có code.

## 1. Tóm tắt yêu cầu

ITSO Panel (`itso-panel`) là web hosting control panel **nội bộ** cho Ubuntu, mục tiêu:

| Nhóm | Yêu cầu cốt lõi |
|---|---|
| Cài đặt | 1 lệnh `install.sh` kiểu aaPanel → Web Installation Wizard. Không bắt người dùng cài Laravel/Node/Composer/Go/PostgreSQL. Không bắt buộc Docker. |
| Kiến trúc | Dashboard → Laravel API → Job Queue → Go Agent → Linux. Chỉ Agent có đặc quyền. Sẵn sàng multi-server. |
| Multi-tenant | 3 vai trò SUPER_ADMIN / ADMIN / USER, Hosting Packages với giới hạn **thực thi thật** (cgroups v2, quota). |
| Bảo mật | Nhiều lớp: firewall, Fail2ban, WAF, ClamAV/YARA, FIM, MFA, RBAC, audit, mTLS, isolation. |
| Backup | Restic, 3-2-1-1-0, immutable, restore từng site/DB, cross-server. |
| Docker | Module tùy chọn, không cấp socket cho USER, không phá firewall. |
| UI | React + shadcn/ui, Light/Dark, VI mặc định + EN, responsive, demo hoàn chỉnh trước khi có Agent thật. |
| Vòng đời | Update, rollback, repair, uninstall không mất dữ liệu website. |

**Ngoài phạm vi (xác nhận lại):** license server, billing, reseller billing, marketplace, affiliate. **Email server (Postfix/Dovecot) không có trong danh sách module** — kế hoạch coi là ngoài phạm vi v0.x (xem D-17).

## 2. Đánh giá tính khả thi

**Kết luận: Khả thi, nhưng phạm vi "tương đương aaPanel Pro + phân quyền cPanel" là rất lớn.** aaPanel và cPanel là sản phẩm hàng chục người-năm. Với 1 người + Claude Code, cần cắt theo milestone và chấp nhận rằng v0.1.0-alpha chỉ là lõi hosting an toàn trên **một máy chủ**.

| Khía cạnh | Đánh giá | Ghi chú |
|---|---|---|
| Kỹ thuật lõi (site/Nginx/PHP/SSL/DB) | Cao | Bài toán đã được giải nhiều lần; rủi ro chủ yếu ở chất lượng template và rollback cấu hình. |
| Giới hạn tài nguyên thật | Trung bình | cgroups v2 tốt cho CPU/RAM/IO của tiến trình; **không** áp được cho MySQL/PostgreSQL dùng chung; disk quota phụ thuộc filesystem. Cần spike ở Phase 4. |
| Bảo mật đa người dùng | Trung bình | Isolation giữa site là phần khó nhất và dễ sai nhất (permission, symlink, /proc, PHP-FPM). |
| Docker cho USER | Thấp–Trung bình | Docker socket = root. Chỉ khả thi dưới dạng "managed apps" qua policy, hoặc rootless per-user (nặng). |
| Immutable backup | Trung bình | Restic không tự có immutability → cần rest-server `--append-only` hoặc S3 Object Lock với credential tách biệt. |
| Installer kiểu aaPanel | Cao | Cần pipeline build artifact đã đóng gói sẵn (không build trên server). |
| Multi-server | Trung bình | Thiết kế `server_id` từ đầu; giao thức agent tách transport → khả thi ở Phase 11. |

**Ước lượng thô (đoán, chưa có dữ liệu thực tế):** Phase 1–2: 3–5 tuần; Phase 3–8 (tới v0.1.0-alpha): 4–6 tháng; Phase 9–12: thêm 3–5 tháng. Phụ thuộc mạnh vào thời gian review/test thật trên VM.

## 3. Đánh giá technology stack

Nguyên tắc: **giữ stack người dùng đề xuất**, chỉ bổ sung/điều chỉnh khi có lý do kỹ thuật rõ ràng. Các điều chỉnh đều là *quyết định cần xác nhận* trong `DECISIONS.md`.

### 3.1 Frontend — React, TypeScript, Vite, Tailwind, shadcn/ui, Lucide, Recharts, TanStack Query

| Ưu | Nhược / Lưu ý |
|---|---|
| Hệ sinh thái lớn, shadcn/ui cho UI chuyên nghiệp nhanh, phù hợp mockup dashboard tối. | shadcn/ui là copy-in component → phải tự bảo trì. |
| TanStack Query hợp với mô hình Job (polling/invalidate). | Cần thêm: **router** (TanStack Router hoặc React Router), **i18n** (i18next), **form** (react-hook-form + zod), **table** (TanStack Table), **terminal** (xterm.js), **editor** (CodeMirror 6 cho File Manager), **MSW** cho mock API. |
| SPA build tĩnh → installer chỉ copy `dist/`. | Không giữ nguyên trạng thái realtime → cần kênh push (SSE/WebSocket) cho job progress, log, terminal. |

**Giữ nguyên.** Bổ sung danh sách thư viện trên (D-05).

### 3.2 Backend — Laravel REST API, PostgreSQL, Redis Queue

| Ưu | Nhược / Lưu ý |
|---|---|
| Auth (Sanctum/Fortify), Policies, Queue/Horizon, Migrations, Scheduler có sẵn → nhanh cho CRUD + RBAC + jobs. | **Xung đột runtime:** panel chạy bằng PHP trong khi PHP Manager cũng quản lý PHP của hosting. Nếu admin gỡ/nâng PHP, panel có thể chết. |
| Cộng đồng lớn, Claude Code viết Laravel tốt. | **Xung đột web server:** nếu panel dùng chung Nginx của hosting, một vhost lỗi có thể làm panel không truy cập được. |
| | Laravel không phù hợp giữ WebSocket dài (terminal, log stream) — cần thành phần riêng. |

**Đề xuất điều chỉnh (D-01):** Panel dùng **runtime riêng, cô lập khỏi hosting**:
- **Lựa chọn A (khuyến nghị):** **FrankenPHP** (binary tĩnh, nhúng PHP + Caddy) chạy Laravel Octane tại `/opt/itso/runtime/frankenphp`. Panel phục vụ trên port riêng, tự quản TLS, **không phụ thuộc Nginx/PHP của hosting**. Rủi ro: extension cần build tùy biến (pgsql, redis, intl, sodium…), Octane yêu cầu code không giữ state giữa request.
- **Lựa chọn B (dự phòng):** PHP-FPM version cố định + Nginx instance riêng `itso-nginx.service` (cấu hình tách biệt `/etc/itso/nginx`). Quen thuộc hơn nhưng nhiều thành phần hơn.

**PostgreSQL:** giữ. Nhưng panel dùng **cluster riêng** (`pg_createcluster 16 itso`, chỉ unix socket, data ở `/var/lib/itso/postgresql`) để không lẫn với PostgreSQL mà USER tạo database (D-02).

**Redis:** giữ cho queue/cache/lock, nhưng **instance riêng** `itso-redis.service` (unix socket, ACL, `maxmemory`) tách khỏi Redis/Valkey phục vụ website (D-03). *Phương án tối giản:* Laravel queue driver `database` trên PostgreSQL để bớt một dịch vụ — kém hơn ở throughput nhưng đủ cho nội bộ. Khuyến nghị vẫn dùng Redis.

**Bổ sung:** cấm hoàn toàn `exec/shell_exec/proc_open/system/passthru` trong code Laravel (PHPStan rule + `disable_functions` trong runtime panel). Laravel **không bao giờ** chạy lệnh hệ thống.

### 3.3 Server Agent — Go, systemd, typed operations, secure communication

| Ưu | Nhược / Lưu ý |
|---|---|
| Binary tĩnh, không phụ thuộc runtime, dễ đóng gói. | Agent chạy root (hoặc có capability rộng) → mọi bug là bug root. Cần thiết kế rất chặt (xem `06-AGENT-SECURITY.md`). |
| Thư viện tốt: `golang.org/x/sys/unix` (openat2, setresuid), `go-acme/lego` (ACME), `gopsutil` (metrics), `coreos/go-systemd` (D-Bus), `creack/pty`. | |
| Có thể dùng chung codebase cho **CLI `itso`** và **mock agent**. | |

**Giữ nguyên, bổ sung:** CLI `itso` viết bằng Go (cùng module) để `itso repair` hoạt động **ngay cả khi Laravel hỏng** (D-06). Thêm thành phần **`itso-gateway`** (Go, không đặc quyền) cho WebSocket/SSE: terminal, log tail, job progress (D-07).

### 3.4 Hosting runtime — Nginx, PHP-FPM multi-version, MySQL/MariaDB, PostgreSQL, Redis/Valkey, Docker

| Thành phần | Nguồn đề xuất | Lưu ý |
|---|---|---|
| Nginx | Repo nginx.org (stable) hoặc Ubuntu | Ubuntu 24.04 có Nginx 1.24; nginx.org mới hơn, có HTTP/3. Quyết định D-08. |
| PHP multi-version | PPA `ondrej/php` | Chuẩn de-facto nhưng là bên thứ ba; cần pin và kiểm thử nâng cấp. |
| MySQL/MariaDB | Chọn **một** mặc định (MariaDB 10.11 từ Ubuntu hoặc MySQL 8.0/8.4) | Không cho cài cả hai cùng lúc trên một server (xung đột port/socket). D-09. |
| PostgreSQL (hosting) | `postgresql-16` cluster `main` | Tách khỏi cluster `itso` của panel. |
| Redis/Valkey | Redis 7 từ Ubuntu; Valkey khi có package ổn định | Per-site Redis instance là tính năng nâng cao (Phase 10). |
| Docker | Repo chính thức Docker | Docker ghi rule iptables vượt qua UFW → xử lý ở `09-DOCKER.md`. |
| Firewall | **nftables trực tiếp** (bảng `inet itso`) | UFW trên 24.04 cũng chạy nft backend; quản lý hai lớp dễ xung đột. D-10. |
| WAF | ModSecurity v3 (nay do OWASP duy trì) + OWASP CRS 4; dự phòng Coraza | **Cần xác minh** khả năng có module Nginx đóng gói sẵn cho 24.04 ở Phase 7. |
| FTP | Ưu tiên **SFTP (OpenSSH chroot)**; FTP(S) qua Pure-FTPd là tùy chọn | FTP thuần không mã hóa — không bật mặc định. |
| DNS | Tích hợp DNS provider API (Cloudflare… ) trước; PowerDNS nội bộ sau | D-11. |
| SSL | ACME qua thư viện `lego` nhúng trong Agent | Không cần certbot; hỗ trợ HTTP-01 và DNS-01. |
| Malware | ClamAV + YARA | `clamd` cần ~1–1.5 GB RAM → mặc định on-demand `clamscan`, daemon là tùy chọn. |

### 3.5 Hệ điều hành
Ubuntu 24.04 LTS (kernel 6.8, cgroups v2 unified mặc định, systemd 255) — rất phù hợp. Để sẵn sàng đa distro: mọi thao tác OS đi qua interface `platform` trong Agent (package manager, đường dẫn service, tên user web) — chỉ hiện thực `ubuntu2404` ở v0.x.

### 3.6 Môi trường phát triển
- Windows: khuyến nghị **WSL2 Ubuntu 24.04** để chạy backend/agent giống production. Mock Agent chạy được trên Windows thuần.
- Docker Compose **chỉ dùng cho dev** (PostgreSQL, Redis) — không mâu thuẫn với "production không bắt buộc Docker".
- Kiểm thử Agent thật: VM Ubuntu 24.04 dùng một lần (Multipass/Hyper-V/VirtualBox hoặc VPS test). **Không bao giờ** test Agent thật trên máy dev chính.

## 4. Các điểm cần làm rõ trong yêu cầu

1. "Tương đương aaPanel Pro" — đề xuất danh sách tính năng có/không ở `03-MODULES.md` thay vì so sánh 1-1.
2. Quy mô mục tiêu: bao nhiêu server, bao nhiêu hosting account mỗi server? (Kế hoạch giả định ≤ 10 server, ≤ 200 account/server.)
3. ADMIN được "quản lý tài nguyên được giao": giao theo **server**, theo **hosting account**, hay cả hai? (Kế hoạch: cả hai.)
4. USER có cần Docker không, hay chỉ ADMIN? (Kế hoạch: v0.x chỉ SUPER_ADMIN/ADMIN; USER dùng "managed apps" ở giai đoạn sau.)
5. v0.1.0-alpha kết thúc ở Phase nào? (Đề xuất: sau Phase 8 — hosting không có backup thì chưa nên dùng thật.)
