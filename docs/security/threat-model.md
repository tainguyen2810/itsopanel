# Threat model — ITSO Panel

> Phạm vi nội bộ, có User Hosting Portal public. Bản rút gọn từ [06-AGENT-SECURITY.md](../planning/06-AGENT-SECURITY.md); cập nhật khi kiến trúc đổi.

## 1. Tài sản cần bảo vệ

| Tài sản | Vì sao quan trọng |
|---|---|
| Quyền root trên các server | Mất là mất toàn bộ |
| Dữ liệu website và database của từng account | Dữ liệu của người dùng |
| Backup (local, offsite, immutable) | Đường lui cuối cùng |
| Secret: master key panel, HMAC agent, CA nội bộ, mật khẩu repo restic, token DNS | Mở khóa các tài sản khác |
| Tài khoản admin panel | Điều khiển mọi server |
| Audit log | Bằng chứng điều tra |

## 2. Ranh giới tin cậy

1. Internet ↔ User Hosting Portal (public).
2. Mạng nội bộ/VPN ↔ Private Admin Panel.
3. Laravel (`itso`, không đặc quyền) ↔ itso-agent (root) qua unix socket hoặc mTLS.
4. itso-agent ↔ tiến trình của account (UID riêng, slice, sandbox).
5. Account A ↔ account B trên cùng server.
6. Control plane ↔ đích backup.

## 3. Tác nhân và kịch bản

| Tác nhân | Khả năng ban đầu | Mục tiêu | Biện pháp chính |
|---|---|---|---|
| Kẻ tấn công Internet | HTTP tới website và User Portal | Chiếm portal, chiếm site | WAF, rate limit, khóa lũy tiến, CAPTCHA, MFA, CSP, cập nhật bảo mật |
| Kẻ tấn công nhắm Admin | Không có (Admin sau allowlist/VPN) | Chiếm Admin | Allowlist/VPN, MFA bắt buộc, step-up, session ngắn |
| Website bị hack (webshell) | Code chạy dưới UID account | Đọc account khác, leo root, spam | UID + slice + sandbox, `ProtectProc`, egress per UID, FIM/malware |
| USER có ý xấu | Đăng nhập portal/SFTP/SSH của mình | Vượt quota, đọc dữ liệu người khác | Quota kernel, policy + global scope (trả 404), agent validate, chroot/jail |
| ADMIN bị chiếm | Quyền trong phạm vi được giao | Mở rộng phạm vi | `user_scopes` kiểm tra mọi query, MFA, audit, không đổi được policy agent |
| Laravel bị RCE | Quyền user `itso` | Root | Typed ops, không shell, policy cục bộ tắt op nguy hiểm, HMAC + `SO_PEERCRED`, audit cục bộ hash-chain |
| Kẻ trộm/ransomware nhắm backup | Truy cập đích backup hoặc panel | Đọc/xóa backup | Restic mã hóa, append-only / S3 Object Lock, credential prune không nằm trong panel |

## 4. Lớp tấn công và biện pháp

| Lớp | Biện pháp | Phase kiểm thử |
|---|---|---|
| Command injection | Không `sh -c`; argv tách; regex chặt; template escape; fuzz | 4–6 |
| Path traversal | `openat2(RESOLVE_BENEATH\|RESOLVE_NO_MAGICLINKS)` trong tiến trình đã hạ quyền | 6 |
| Symlink / TOCTOU | Không thao tác file account bằng root; `O_NOFOLLOW`, `AT_SYMLINK_NOFOLLOW`; Nginx `disable_symlinks if_not_owner` | 5–6 |
| Privilege escalation | Sandbox systemd, `NoNewPrivileges`, không setuid trong home, cập nhật OS | 4, 12 |
| SSRF | Chặn RFC1918, link-local, loopback; resolve rồi kiểm tra IP; timeout | 5, 10 |
| CSRF | Sanctum CSRF + `SameSite=Strict` + kiểm tra `Origin` | 3 |
| XSS | React escape; cấm `dangerouslySetInnerHTML`; CSP chặt; log hiển thị dạng text | 2–3 |
| Brute force / credential stuffing | Rate limit, khóa lũy tiến, CAPTCHA (portal), MFA, Fail2ban | 3, 7 |
| Docker | Chỉ admin; validator compose; bind `127.0.0.1`; `DOCKER-USER` | 10 |
| Tự khóa server | Safe-apply firewall/SSH có rollback hẹn giờ | 7 |
| Mất dữ liệu khi xóa | Purge sau 30 ngày, xác minh backup, xác nhận 2 bước (D-46) | 3, 8 |
| Supply chain | Pin version, checksum + chữ ký release, SBOM, audit dependency | 1, 4, 12 |

## 5. Rủi ro còn lại được chấp nhận

- Agent chạy root: bug trong agent là bug root. Giảm bằng typed ops, review bắt buộc cho mọi thay đổi agent, fuzz test; đánh giá tách helper ở Phase 12.
- Tài nguyên MySQL/PostgreSQL dùng chung không tính vào cgroup của account; chỉ giới hạn mềm (kết nối, thời gian câu lệnh).
- Người có root trên server nằm ngoài phạm vi bảo vệ; chỉ đảm bảo audit và backup off-site.

## 6. Kiểm chứng

Bộ test tấn công dùng chung `contracts/test-vectors/` (Prompt 1.4), test cách ly trên VM (Phase 4–6), ma trận quyền API (Phase 3), Production Gate G1–G8 (Phase 12), pentest độc lập trước khi bán cho khách bên ngoài (D-50).
