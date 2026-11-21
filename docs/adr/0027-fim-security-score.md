# ADR 0027: FIM trong agent, điểm bảo mật và sự kiện

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 7)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-80

## Bối cảnh

Mục tiêu Phase 7: máy chủ cài xong có điểm bảo mật mặc định ≥ 80/100. Điểm phải minh bạch và kiểm được bằng test. Nếu panel bị chiếm, kẻ tấn công không được sửa được baseline toàn vẹn file.

## Quyết định

1. **FIM** viết bằng Go trong agent. Danh sách đường dẫn cố định (không cấu hình từ panel): `/etc/ssh`, `/etc/nginx`, `/etc/itso`, `/etc/sudoers`, `/etc/sudoers.d`, `/etc/passwd`, `/etc/group`, `/etc/systemd/system/itso*`, `/opt/itso/current/bin`, `/opt/itso/current/share`, `/usr/local/bin`. Bỏ qua thư mục agent tự đổi theo thao tác hợp lệ: `/etc/itso/{certs,waf,ssh}`, `/etc/ssh/itso_authorized_keys`, `/etc/nginx/sites-enabled` (vhost đã có kiểm drift ở `nginx.vhost.inspect`). Tối đa 20 000 đường dẫn; không theo symlink (băm đích của symlink); file > 256 MB băm theo kích thước + mtime. Baseline (sha256, mode, owner) lưu ở `/var/lib/itso/fim/baseline.json` (root 0600); `fim.baseline` chụp lại (Admin + step-up), `fim.check` so với baseline của agent và trả thay đổi `added|modified|removed|metadata`. Bản sao trong `fim_baselines`/`fim_changes` chỉ để hiển thị.
2. **security.audit** thu dữ kiện: `sshd -T` (port, PermitRootLogin, PasswordAuthentication, MaxAuthTries), `nft list table inet itso` (có bảng, policy), fail2ban (đang chạy, số jail), unattended-upgrades, số gói bảo mật chờ, `/var/run/reboot-required`, gói WAF/ClamAV/YARA, trạng thái FIM.
3. **Điểm** do Laravel tính theo bảng trọng số công khai trong code (`SecurityScore::WEIGHTS`, tổng 100): SSH mật khẩu tắt 15, root login 10, firewall policy drop 15, fail2ban 10, MFA mọi quản trị viên 15, WAF coverage 10, cập nhật bảo mật 10, FIM sạch 5, IP allowlist Admin 10. `warn` được nửa điểm. Hạng A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, còn lại F. API `GET /security/score` trả từng mục.
4. **Sự kiện:** `security_events` mức high/critical (rollback firewall/SSH, malware, FIM thay đổi, WAF chặn dồn dập) → thông báo trong panel cho SUPER_ADMIN/ADMIN trong phạm vi. Email/Telegram: Phase 11.

## Hệ quả

- Điểm tái lập được từ dữ kiện; test Pest kiểm từng mục.
- Kiểm thử: FIM với gốc FS tạm (thêm/sửa/xóa/chmod), baseline bị panel gửi giả không có tác dụng (không có op ghi baseline từ dữ liệu panel).
