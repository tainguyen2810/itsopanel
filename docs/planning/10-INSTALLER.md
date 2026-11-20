# 10 — Installer, Installation Wizard, CLI và vòng đời

## 1. Mục tiêu trải nghiệm
```bash
curl -fsSLo install.sh https://install.itso.vn/install.sh   # URL minh họa
sudo bash install.sh
```
→ 5–10 phút sau màn hình in:
```
ITSO Panel v0.1.0-alpha đã cài đặt thành công
URL:        https://203.0.113.10:28443/a8f3k2/      (entrance path ngẫu nhiên)
Mã thiết lập: 7H4K-Q2PZ-9XWM (hết hạn sau 60 phút, chỉ dùng một lần)
Chứng chỉ:  self-signed, fingerprint SHA256: AB:CD:…
Lệnh quản trị: itso status | itso help
```

## 2. Kiến trúc installer
| Tầng | Nội dung | Lý do |
|---|---|---|
| `install.sh` (Bash, ~200 dòng) | Kiểm tra root, OS, arch; tải **manifest release đã ký** + `itso` binary; xác minh SHA256 + chữ ký (minisign public key nhúng trong script); chạy `itso install` | Bash khó test → giữ tối thiểu |
| `itso install` (Go) | Toàn bộ logic: preflight, cài package, giải nén release, tạo user/dir, cấu hình DB/Redis/systemd/TLS, khởi tạo, in kết quả | Test được, idempotent, chạy lại được khi lỗi giữa chừng (checkpoint trong `/var/lib/itso/install-state.json`) |
| Wizard web | Bước cấu hình cần người quyết định | Không hỏi tương tác trong terminal (trừ khi `--interactive`) |

Tùy chọn: `--version`, `--channel stable|beta`, `--port`, `--no-firewall`, `--offline <bundle.tar>`, `--restore` (DR), `--yes`, `--dry-run` (chỉ preflight).

## 3. Preflight (dừng nếu FAIL, hỏi nếu WARN)
| Kiểm tra | FAIL | WARN |
|---|---|---|
| OS | khác Ubuntu 24.04 (v0.1) | — |
| Arch | khác amd64/arm64 | arm64 (ít kiểm thử hơn) |
| cgroups v2 unified | không | — |
| systemd | không phải PID 1 (container) | — |
| CPU / RAM | < 1 vCPU / < 1 GB | < 2 vCPU / < 2 GB (khuyến nghị 4 GB nếu bật ClamAV) |
| Disk trống | < 10 GB | < 20 GB |
| Port 80, 443, panel port | đang bị chương trình lạ chiếm | — |
| Panel khác đã cài | phát hiện aaPanel/CyberPanel/cPanel/HestiaCP | — |
| Web server có sẵn | — | Apache/Nginx đang chạy có site → đề nghị import (Phase 12) |
| Filesystem quota | — | `/home` không hỗ trợ quota → hiển thị cách bật |
| Internet / DNS / thời gian | không tới được release server | lệch đồng hồ > 30s |
| Hostname FQDN | — | không có |

## 4. Các bước `itso install`
1. Tạo user hệ thống: `itso`, `itso-gw`, `itso-redis`; group `itso-agent-clients`, `itso-proc`, `itso-ssh`, `itso-sftp`, `itso-suspended`.
2. Cài package tối thiểu từ apt (pin): `postgresql-16`, `redis-server` (instance riêng), `nftables`, `acl`, `quota`, `ca-certificates`. **Chưa** cài Nginx/PHP/MySQL — để wizard chọn.
3. Giải nén release vào `/opt/itso/releases/<ver>`, symlink `current`. Release chứa: Laravel đã `composer install --no-dev` + optimize, `web/dist`, `frankenphp`, `itso-agent`, `itso-gateway`, `itso`, `restic`, templates.
4. Tạo cluster `pg_createcluster 16 itso -- --auth-local=peer` (chỉ socket), DB + roles; Redis instance `itso-redis` (socket, ACL, `requirepass`).
5. Sinh secret: master key, `APP_KEY`, HMAC agent key, mật khẩu Redis → `/etc/itso` & `/var/lib/itso/keys` với quyền tối thiểu.
6. Chạy migrations + `ProductionSeeder`.
7. Sinh cert self-signed cho panel (hoặc ACME nếu `--domain` có DNS trỏ đúng).
8. Cài và enable `itso.target` (agent, web, workers, scheduler, gateway).
9. Firewall cơ bản (trừ `--no-firewall`): mở SSH port hiện tại (phát hiện từ `sshd -T` + phiên đang dùng), panel port, 80/443; **safe-apply** có rollback.
10. Health check toàn bộ (`itso doctor`), sinh **mã thiết lập một lần**, in URL.

## 5. Installation Wizard (web)
| Bước | Nội dung |
|---|---|
| 0 | Nhập mã thiết lập (chống người lạ chiếm wizard trước admin) |
| 1 | Ngôn ngữ (VI/EN), múi giờ |
| 2 | Tạo SUPER_ADMIN: email, mật khẩu mạnh, **bắt buộc enroll TOTP** + lưu recovery codes |
| 3 | Panel access: domain panel (tùy chọn) + ACME, đổi port, entrance path, IP allowlist |
| 4 | Chọn stack hosting: Nginx (nguồn), PHP versions, MariaDB **hoặc** MySQL, PostgreSQL (tùy chọn), Redis (tùy chọn) → tạo job cài đặt, hiển thị tiến độ |
| 5 | Bảo mật cơ bản: SSH hardening đề xuất (tắt root password login…), Fail2ban, cập nhật tự động |
| 6 | Disk quota: trạng thái + hướng dẫn nếu cần reboot |
| 7 | Backup: đích lưu đầu tiên (khuyến nghị) + hiển thị mật khẩu repo để lưu offline |
| 8 | SMTP thông báo (tùy chọn) |
| 9 | Tổng kết → vào Dashboard. Wizard khóa vĩnh viễn (`settings.installed_at`) |

## 6. CLI `itso`
| Lệnh | Mô tả |
|---|---|
| `itso status` | Trạng thái dịch vụ, phiên bản, URL |
| `itso doctor` | Health check sâu: services, DB, Redis, agent socket, cert, disk, quota, time |
| `itso url` / `itso setup-code` | In lại URL / sinh mã thiết lập mới (khi wizard chưa xong) |
| `itso admin reset-password <email>` / `reset-mfa` | Khôi phục truy cập |
| `itso security reset-allowlist` / `firewall safe-mode` | Mở lại truy cập khi tự khóa |
| `itso policy get|set <key>` | Policy cục bộ agent (root terminal, docker, backup.forget…) |
| `itso update [--version]` | Cập nhật có checkpoint |
| `itso rollback` | Về bản trước |
| `itso repair [--reapply-all]` | Sửa cài đặt panel; re-apply desired state |
| `itso backup panel` / `restore panel` | Backup/restore riêng dữ liệu panel |
| `itso logs [service]` | Xem log |
| `itso uninstall [--purge-panel-data]` | Gỡ panel, **không đụng** dữ liệu hosting |
| `itso import <aapanel|hestia|plain-nginx>` | Migration/import (Phase 12) |

## 7. Update & Rollback
1. Tải manifest mới → kiểm chữ ký → kiểm tra tương thích (`min_from_version`).
2. Preflight (disk, services healthy).
3. `pg_dump` panel DB → `/var/backups/itso/pre-update/<old>.dump`; backup `/etc/itso`.
4. Giải nén vào `releases/<new>` (bản cũ giữ nguyên).
5. Bật maintenance mode (API trả 503 có thông báo; hosting **không bị ảnh hưởng**).
6. Chạy migrations (expand-only — tương thích với code cũ).
7. Đổi symlink `current` → restart `itso.target` → health check 60s.
8. Lỗi → tự động `rollback`: symlink về bản cũ, restart; vì migration chỉ expand nên code cũ chạy được; nếu migration không tương thích (hiếm, đánh dấu `breaking_db` trong manifest) → restore dump.
9. Giữ 3 release gần nhất. Agent update cùng release; agent mới phải hiểu op cũ (version trong envelope).

## 8. Repair
`itso repair`: kiểm tra file release (checksum), quyền thư mục, unit systemd, cluster DB, Redis, cert panel, socket agent → sửa những gì sai. `--reapply-all`: đọc desired state từ DB → re-apply cho mọi account/site (nginx, php pools, slices, cron, firewall).

## 9. Uninstall
- Dừng và gỡ `itso.target`, unit, binary, `/opt/itso`.
- **Giữ**: `/home/*`, DB hosting (`/var/lib/mysql`, cluster `main`), cấu hình Nginx/PHP đang phục vụ site (site vẫn chạy được, chỉ mất panel), backup.
- Hỏi về `/etc/itso` và cluster `itso`: mặc định **giữ** và đổi tên (`/etc/itso.removed-<ts>`); xóa chỉ khi `--purge-panel-data` + gõ xác nhận.
- Cài lại sau uninstall phát hiện dữ liệu cũ → đề nghị khôi phục.

## 10. Phân phối & build
- CI build release: `apps/web` (Vite build), `apps/api` (composer `--no-dev`, `artisan optimize`), Go binaries (CGO tắt, `-trimpath`), FrankenPHP build tùy biến, restic pin. Đóng gói `itso-<ver>-linux-<arch>.tar.zst` + `manifest.json` + chữ ký minisign + SBOM.
- Server phát hành: static hosting (S3/R2/Nginx) tại `install.itso.vn`. Giai đoạn sau có thể chuyển sang `.deb` + apt repo ký GPG.
- Offline bundle cho server không có Internet (P2).
