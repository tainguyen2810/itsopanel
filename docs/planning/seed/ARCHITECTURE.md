# ARCHITECTURE — ITSO Panel (phạm vi nội bộ, chốt 2026-11-20)

> Bản tổng hợp hiện hành. Chi tiết kỹ thuật vẫn nằm ở `docs/planning/02` (kiến trúc), `06` (agent security), `07` (cách ly), `08` (backup), `09` (docker), `10` (installer). Các phần về Customer, Subscription, Provisioning công khai và Billing trong `02 §11`, `14` và `15` đã **DEFERRED**.

## 1. Sơ đồ

```
           Nhân viên (IP allowlist/VPN)            USER được cấp tài khoản (Internet)
                     │ admin.<domain>                         │ my.<domain>
                     ▼                                        ▼
┌──────────────────────────── CONTROL PLANE ────────────────────────────────┐
│ itso-web (FrankenPHP/Caddy: TLS, SPA admin + portal, WAF/rate limit)      │
│   ├─ /api/v1/admin/*   guard "admin"  (SUPER_ADMIN, ADMIN)                │
│   ├─ /api/v1/portal/*  guard "portal" (USER)                              │
│   └─ /ws, /sse → itso-gateway (Go, không đặc quyền)                       │
│ Laravel: Hosting Provisioning Service · RBAC · Jobs · Audit · Scheduler   │
│ PostgreSQL "itso" · Redis riêng · Internal CA (cho node)                  │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ all-in-one: unix socket        │ multi-server: mTLS, agent kết nối ra
                ▼                               ▼
     ┌──────────────────────┐        ┌──────────────────────┐
     │ Server 1 (all-in-one)│        │ Server 2..N (node)   │
     │ itso-agent (root)    │        │ itso-agent (root)    │
     │ Nginx · PHP-FPM/acct │        │ Nginx · PHP-FPM/acct │
     │ MariaDB · PostgreSQL │        │ MariaDB · …          │
     │ quota · slice · sandbox       │ Docker (admin apps)  │
     └──────────────────────┘        └──────────────────────┘
                                           Backup: local + SFTP/NAS + S3 (Object Lock)
```

## 2. Thành phần (không đổi so với 02, có bổ sung)
| Thành phần | Ghi chú |
|---|---|
| Frontend | Một codebase React, **hai entry build**: `admin` (Private Admin Panel) và `portal` (User Hosting Portal), dùng chung design system và i18n |
| Laravel API | Hai guard theo **realm** (`admin`, `portal`) trên cùng bảng `users`. Realm của user không thay đổi được, nên user portal không thể đăng nhập vào khu admin |
| **Hosting Provisioning Service** | Domain service duy nhất cho vòng đời tài khoản: create, change-package, suspend, unsuspend, migrate, terminate, purge. Admin controller, CLI và job đều gọi qua đây. Đây là điểm mở rộng cho Public API sau này |
| Worker / Scheduler | Chạy jobs, backup theo lịch, drift check, thông báo |
| itso-gateway | Terminal, log stream, tiến độ job |
| Go Agent | Root, typed ops, policy cục bộ, audit cục bộ (xem 06) |
| CLI `itso` | Go; install / update / rollback / repair / uninstall / node join |

## 3. Topology
- **Mặc định all-in-one**: control plane và hosting nằm trên cùng một server, giao tiếp agent qua unix socket. Đây là trải nghiệm "một lệnh" giống aaPanel.
- **Multi-server** (Phase 9): thêm server bằng `install.sh --role node --join <token>`. Agent dùng mTLS và kết nối ra control plane. Có thể (không bắt buộc) chuyển control plane sang máy riêng bằng `--role control-plane`.
- Super Admin **chọn server** khi tạo tài khoản. Panel gợi ý server theo tài nguyên còn trống (gợi ý đơn giản, không tự động cấp).

## 4. Cách ly và quota (giữ nguyên đầy đủ)
UID/GID riêng cho mỗi account · PHP-FPM master riêng chạy dưới UID account · systemd slice với CPUQuota, MemoryHigh/Max, TasksMax, IO · user quota cho block và inode · DB user riêng theo tiền tố, không có quyền global · SFTP chroot · sandbox systemd (ProtectSystem, ProtectHome, ProtectProc, PrivateTmp, NoNewPrivileges) · egress per UID (chặn port 25, chặn dải nội bộ) · `/proc` hidepid. Chi tiết ở 07 và mục cách ly của 14.

## 5. Chuyển tài khoản giữa các server (mới, Phase 9)
Job `account.migrate` do Hosting Provisioning Service điều phối:
1. Preflight: server đích đủ tài nguyên, có cùng phiên bản PHP/DB engine, UID trống.
2. Tạo account ở server đích (cùng username, UID mới nếu cần), áp limits.
3. Đồng bộ file bằng rsync qua kênh agent-agent (mTLS) hoặc qua backup restic. Dump và import DB.
4. Sao chép cert, vhost, cron, SFTP.
5. **Cutover**: khóa ghi ở nguồn (suspend tạm), rsync lần cuối, đổi DNS (nếu dùng DNS provider) hoặc hướng dẫn đổi IP, rồi bật ở đích.
6. Giữ account nguồn ở trạng thái `migrated_source` N ngày, sau đó dọn có xác nhận.
7. Rollback: nếu cutover lỗi thì bật lại nguồn.

## 6. Vòng đời tài khoản (nội bộ, đơn giản)
`pending → provisioning → active ⇄ suspended → terminated (giữ dữ liệu N ngày) → purged`, cộng thêm các trạng thái `migrating` và `failed`. Suspend và unsuspend làm thủ công, có ghi lý do. Không có quá hạn thanh toán. Purge chạy 2 bước có xác nhận và để lại biên bản.

## 7. Bảo mật hai bề mặt
| | Admin Panel | User Hosting Portal |
|---|---|---|
| Mạng | IP allowlist / VPN | Public |
| Auth | MFA bắt buộc, session 8h | MFA khuyến khích (bắt buộc nếu có SSH/Terminal), session 12h, khóa lũy tiến, CAPTCHA |
| Bảo vệ | CSRF, CSP, rate limit | Như Admin, cộng WAF (CRS) trước portal |
| Truy cập dữ liệu USER | Impersonate cần ghi lý do, có banner, có audit | — |

## 8. Điểm mở rộng tương lai (DEFERRED)
Public Provisioning API (`/api/provisioning/v1`), Customer/Subscription, Billing Adapter, Placement Engine tự động, Docker Hosting trên VM. Thiết kế tham khảo ở `15-HOSTING-PROVIDER.md`.
