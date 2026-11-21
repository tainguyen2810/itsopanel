# Runbook Phase 6: Database, File Manager, SFTP/FTPS, Cron, Terminal

Runbook cho người vận hành panel nội bộ. Áp dụng cho bản Phase 6 (Ubuntu 24.04, MariaDB/PostgreSQL từ kho Ubuntu, OpenSSH `internal-sftp`, Pure-FTPd, systemd timer cho cron, `itso-gateway` cho terminal web).

## 1. Chuẩn bị

| Việc | Cách làm |
|---|---|
| Cài phần mềm | Máy chủ → Phần mềm: recipe `mariadb` (hoặc `postgresql`) cho database, `pure-ftpd` cho FTPS phụ. SFTP dùng OpenSSH có sẵn |
| Cổng | SFTP: 22. FTPS: 21 + passive 30000–30100 (FTP thuần **tắt**, TLS bắt buộc). Terminal đi qua HTTPS của panel (`/gateway/terminal`), `itso-gateway` chỉ nghe `127.0.0.1:7811` |
| Gói hosting | `db_limit`, `ftp_limit`, `cron_limit` + khoảng cách cron tối thiểu, `ssh_allowed` (terminal và shell SSH). Đổi gói tạo phiên bản mới (D-43) |
| Dịch vụ | `systemctl status itso-agent itso-gateway`; socket `/run/itso/agent.sock` (panel) và `/run/itso/agent-stream.sock` (chỉ uid `itso-gw`) |

## 2. Database

- **Tạo:** Cơ sở dữ liệu → Thêm database. Tên bắt buộc tiền tố `<username>_`. "Tạo user cùng tên" bật sẵn: mật khẩu do panel sinh **hiện một lần** trong hộp thoại, panel chỉ giữ bản mã hóa. Quên thì dùng "Đổi mật khẩu".
- **Quyền:** tab User database → Sửa quyền: chỉ database cùng account và cùng hệ quản trị.
- **Export:** Thao tác → Xuất ra file `.sql.gz`. File nằm trong home account `backups/<db>-<thời điểm>.sql.gz` (thuộc uid account, tính vào quota), tải về bằng File Manager.
- **Import:** API `POST /databases/{id}:import {path}` với file trong home (upload trước bằng File Manager). Import chạy dưới uid account bằng danh tính chủ của account: chỉ chạm được database có tiền tố của account.
- **Xóa:** gõ tên database + step-up TOTP. Panel sao lưu trước khi xóa.

## 3. File Manager

| Việc | Ghi chú |
|---|---|
| Duyệt/sửa | Mọi thao tác chạy dưới uid account, không ra ngoài home (kernel `openat2 RESOLVE_BENEATH`). Sửa trực tuyến tối đa 2 MiB; người khác sửa cùng lúc → "File đã thay đổi" (412), mở lại rồi sửa |
| Upload | Kéo thả nhiều file; chia khúc 8 MiB, tạm dừng / tiếp tục / hủy được, mất mạng thì bấm "Tiếp tục" để gửi tiếp từ chỗ server đã nhận. "Đang ghi vào thư mục" = job `file.upload` đang chép file vào home |
| Tải về | Link ký 5 phút, gắn với người tạo link |
| Nén/giải nén | zip, tar.gz. Giải nén tối đa 4 GiB (`ITSO_EXTRACT_MAX_BYTES`), bỏ qua symlink/thiết bị, từ chối tên `../` |
| Staging upload | `/var/lib/itso/uploads` (panel ghi, agent đọc khi commit). Phiên hết hạn sau 24 giờ. **Chưa có lệnh dọn tự động** file `.part` của phiên bỏ dở: kiểm `du -sh /var/lib/itso/uploads` khi đĩa panel đầy, xóa file `.part` cũ hơn 1 ngày |

## 4. SFTP, FTPS phụ, khóa SSH

- **SFTP account chính:** chroot vào home (`Match Group itso-sftp`, `ForceCommand internal-sftp`). Gói có `ssh_allowed` → group `itso-ssh` (shell bash trong slice của account).
- **FTPS phụ:** SFTP/FTP → Thêm tài khoản, giao thức FTPS, thư mục gốc là thư mục con có sẵn trong home. Mật khẩu để trống → panel sinh và hiện một lần; "Đổi mật khẩu" tạo mật khẩu mới. File tạo qua FTP thuộc uid account.
- **Khóa SSH:** tab SSH key, chỉ nhận `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa` ≥ 2048 bit, không option. Trùng fingerprint → 409.
- **Tạm khóa account:** khóa DB user, tắt timer cron, vô hiệu FTPS phụ (đặt mật khẩu ngẫu nhiên). Mở khóa áp lại mật khẩu thật.

## 5. Cron

- Mỗi cron là một systemd timer `itso-cron-<uuid>.timer` chạy dưới uid account trong `itso-acct-<uid>.slice` (giới hạn CPU/RAM của gói). Lịch 5 trường theo giờ máy chủ (Asia/Ho_Chi_Minh), khoảng cách tối thiểu theo gói.
- "Chạy ngay" tạo job `cron_job.run`, kết quả (mã thoát, 8 KiB output cuối) ở "Lịch sử chạy".
- `itso:cron-sync` (5 phút) đồng bộ lần chạy theo lịch từ journal. Kiểm tay: `systemctl list-timers 'itso-cron-*'`, `journalctl -t itso-cron-<uuid>`.

## 6. Terminal web

- Chỉ khi gói có SSH và account đang hoạt động. Mở terminal cần nhập lại mã TOTP (step-up); ticket một lần, hết hạn 30 giây.
- Shell chạy bằng `systemd-run --pty` dưới uid account, `ProtectSystem=strict`, chỉ thấy home của mình; tối đa 2 phiên/account, đóng sau 15 phút không thao tác hoặc 12 giờ.
- `itso:terminal-reap` (mỗi giờ) đóng bản ghi phiên quá 12 giờ.

| Triệu chứng | Kiểm |
|---|---|
| "Không kết nối được máy chủ terminal" | `systemctl status itso-gateway`; Caddy phải có `handle /gateway/*`; agent bật socket stream (`--stream-listen`) |
| "Ticket không hợp lệ hoặc đã dùng" | Ticket chỉ dùng một lần: bấm Ngắt kết nối rồi mở phiên mới |
| 409 "Đã đủ phiên" | Đã có 2 phiên của account; đóng bớt tab terminal |

## 7. Kiểm thử trên VM

Xem `tests/vm/README.md`, mục Dữ liệu hosting. VM Ubuntu 24.04 dùng một lần, đã cài ITSO:

```bash
bash tests/vm/phase6.sh        # bảng kết quả ở /root/itso-vm-phase6.md
```

## 8. Sự cố thường gặp

| Triệu chứng | Kiểm |
|---|---|
| Job database lỗi `dependency_unavailable` | `systemctl status mariadb`; recipe `mariadb` đã cài chưa |
| Upload xong nhưng báo "Không ghi được file vào thư mục" | Drawer job `Tải file lên`: thường do quota đĩa của gói hoặc file đã tồn tại (bật ghi đè) |
| FTPS client báo lỗi TLS | Client phải dùng "FTP qua TLS tường minh" (FTPES), mở passive 30000–30100 trên firewall |
| Cron không chạy | `systemctl status itso-cron-<uuid>.timer`; account bị tạm khóa thì timer tắt |
