# ADR 0020: SFTP (OpenSSH chroot), tài khoản FTPS phụ (Pure-FTPd) và SSH key

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 6)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-73, D-16, D-21, D-64, 07 §2, §5, §7

## Bối cảnh

Khách cần đưa file lên bằng client quen thuộc. 07 §2 đã chọn group `itso-sftp` (internal-sftp + chroot) và `itso-ssh` (shell). Home của account do root sở hữu (07 §5) nên đáp ứng `ChrootDirectory`. Nhu cầu "nhiều tài khoản FTP cho một account, giới hạn thư mục con" (03-MODULES) không làm được bằng OpenSSH chroot vì thư mục con thuộc account, không thuộc root.

## Quyết định

1. **SFTP = user Linux của account.** `sftp.user.ensure{account, ssh_access, password}`: thêm user vào `itso-sftp` (hoặc `itso-ssh` khi gói `ssh_allowed`), bỏ khỏi group còn lại; đặt mật khẩu bằng `chpasswd` (stdin `user:pass`), `password: null` giữ nguyên. `sftp.user.remove` bỏ khỏi cả hai group và khóa mật khẩu. Một bản ghi `sftp_accounts` protocol `sftp` cho mỗi account (username = username account, `root_path = .`).
2. **Cấu hình sshd:** op `sshd.match.apply` ghi `/etc/ssh/sshd_config.d/50-itso.conf` từ template cố định:
   - `DenyGroups itso-suspended`
   - `Match Group itso-sftp` → `ChrootDirectory %h`, `ForceCommand internal-sftp -d /`, `AllowTcpForwarding no`, `X11Forwarding no`, `PermitTunnel no`, `AllowAgentForwarding no`
   - `Match Group itso-ssh` → `AllowTcpForwarding no`, `X11Forwarding no`, `PermitTunnel no`
   - `Match Group itso-sftp,itso-ssh` → `AuthorizedKeysFile /etc/itso/ssh/authorized_keys/%u`, `PasswordAuthentication <theo tham số>`
   Áp dụng: lưu bản cũ → ghi → `sshd -t` → lỗi thì khôi phục, trả `config_test_failed`, không reload → đúng thì `systemctl reload ssh`. Hardening sshd toàn cục (port, root login, cipher) thuộc Phase 7 (`sshd.config.apply`).
3. **SSH key do panel quản lý:** `ssh.keys.apply{account, keys}` ghi `/etc/itso/ssh/authorized_keys/<user>` (root:root 0644, thư mục 0755) — user không sửa được, không có symlink trong home để lợi dụng. Key chỉ nhận dạng `ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa <base64> [comment]` (không có option như `command=`); panel tính fingerprint SHA256, trùng trong account → 409. Gói không có SSH vẫn dùng key cho SFTP.
4. **FTPS phụ = virtual user Pure-FTPd** (recipe `pure-ftpd`): `TLS 2` (bắt buộc TLS, FTP thuần tắt — D-16), `ChrootEveryone yes`, passive port 30000–30100, PureDB `/etc/pure-ftpd/pureftpd.pdb`. `ftp.user.ensure{account, username, root_path, enabled, password}` → `pure-pw useradd|usermod <username> -u <uid> -g <gid> -d /home/<user>/<root_path> -m` (mật khẩu qua stdin hai lần), `enabled=false` → agent đặt mật khẩu ngẫu nhiên không ai biết (panel giữ mật khẩu thật đã mã hóa và đặt lại khi bật). `ftp.user.remove` → `pure-pw userdel -m`. Username bắt buộc tiền tố `<username>_`, `root_path` phải là thư mục có sẵn trong home (helper kiểm qua `fs.stat`). File do FTP phụ tạo thuộc **uid account** → quota, PHP và File Manager nhất quán.
5. **Quota gói:** `ftp_limit` đếm tài khoản FTPS phụ (không tính user SFTP chính).
6. **Tạm khóa:** account vào `itso-suspended` (đã có từ Phase 4, `DenyGroups` ở mục 2 có hiệu lực từ Phase 6); FTP phụ `enabled=false`; mở khóa làm ngược lại.

## Hệ quả

- Chroot SFTP đúng yêu cầu OpenSSH; FTP phụ giới hạn thư mục con mà vẫn ghi dưới uid account.
- Không có user Linux trùng uid, không có bind mount.
- Kiểm thử thật (chroot escape, TLS bắt buộc): VM (`tests/vm/phase6.sh`).
