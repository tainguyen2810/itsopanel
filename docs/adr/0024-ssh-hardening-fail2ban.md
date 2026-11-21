# ADR 0024: SSH hardening (safe-apply) và Fail2ban

- **Trạng thái:** Accepted (2026-11-21, cùng Phase 7)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-77, D-73, D-76

## Bối cảnh

Đổi cấu hình sshd sai (tắt mật khẩu khi chưa có khóa, đổi port chưa mở firewall) làm mất quyền vào máy. Khóa lũy tiến của panel chỉ bảo vệ tầng ứng dụng; dò mật khẩu SSH/FTP cần chặn ở tầng mạng.

## Quyết định

1. **sshd.config.apply** ghi `/etc/ssh/sshd_config.d/10-itso-hardening.conf` từ tập khóa cố định: `Port`, `PermitRootLogin` (`no`|`prohibit-password`), `PasswordAuthentication`, `MaxAuthTries` (1–10), `LoginGraceTime` (10–300 s), `X11Forwarding`, `AllowAgentForwarding`, `AllowGroups`. Không có ô cấu hình tự do. File Match của SFTP (ADR 0020) giữ nguyên.
2. Trình tự: ghi file tạm → `sshd -t` → đổi tên nguyên tử → `systemctl reload ssh` → hẹn hoàn tác như ADR 0023 (timer `itso-sshd-rollback`) → xác nhận bằng `sshd.config.confirm{apply_id, token}` qua request mới.
3. **Chặn tự khóa:** tắt mật khẩu bị từ chối (`would_lock_out`) nếu `admin_user` không có khóa trong `authorized_keys`; đổi port thì Laravel thêm rule mở port mới vào firewall và áp dụng trước, chỉ đóng port cũ sau khi xác nhận.
4. **Fail2ban:** `fail2ban.apply` sinh `/etc/fail2ban/jail.d/itso.conf` từ template với 3 jail cố định `sshd`, `itso-panel` (đọc `/var/log/itso/auth.log`; Laravel ghi một dòng cho mỗi lần đăng nhập sai kèm IP, không ghi email/mật khẩu) và `pure-ftpd`; `banaction = nftables` (bảng riêng của fail2ban); `ignoreip` = IP allowlist Admin. Tham số bantime 60 s–30 ngày, findtime 60 s–1 ngày, maxretry 1–100. `fail2ban.status`, `fail2ban.unban{jail, ip}`.

## Hệ quả

- Cùng một cơ chế xác nhận/hoàn tác cho firewall và SSH (`firewall_applies.target`).
- Kiểm thử: golden file sshd/jail, `sshd -t` giả lỗi → hoàn tác, tắt mật khẩu khi 0 khóa → từ chối; VM: SSH vẫn vào được sau apply, IP sai nhiều lần bị ban rồi unban.
