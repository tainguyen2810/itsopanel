# Hướng dẫn cài ITSO Panel v0.1.0-alpha (nội bộ)

Cho đội vận hành nội bộ. Bản alpha chỉ cài trên **VM hoặc máy thử dùng một lần**, không cài lên máy đang chạy dịch vụ khác.

## 1. Yêu cầu

| Mục | Tối thiểu | Khuyến nghị |
|---|---|---|
| Hệ điều hành | Ubuntu 24.04 LTS sạch, amd64 | |
| CPU / RAM | 1 vCPU, 1 GB | 2 vCPU, 2 GB trở lên |
| Đĩa trống | 10 GB | 20 GB + dung lượng website + backup local |
| Hệ thống | systemd, cgroup v2 (mặc định của Ubuntu 24.04), quyền root | |
| Mạng | Cổng 80/443 cho website, cổng panel (mặc định 28443), SSH | Tên miền trỏ về máy nếu cần HTTPS thật |

Installer chạy preflight và dừng khi thiếu mục bắt buộc (`sudo itso preflight` để xem trước).

## 2. Đóng gói bản phát hành (máy build)

```bash
git checkout v0.1.0-alpha
make setup
ITSO_RELEASE_KEY=/đường/dẫn/khóa-ed25519.pem make release   # VERSION mặc định 0.1.0-alpha
make units-check && make test-installer
```

Kết quả ở `build/release/0.1.0-alpha/`: tarball `itso-0.1.0-alpha-linux-amd64.tar.gz`, `itso`, `install.sh` (khóa công khai nhúng sẵn), `manifest.json` + `manifest.sig`, `sbom.json`.

- Không đặt `ITSO_RELEASE_KEY` thì `make release` sinh **khóa dev tạm** (`build/release-key/`), chỉ dùng thử. Khóa phát hành thật giữ ngoài repo, không commit.
- Thiếu FrankenPHP thì manifest ghi `missing`: tải bản upstream rồi đóng gói lại trước khi cài.

## 3. Cài

Chép cả thư mục `build/release/0.1.0-alpha/` lên máy cần cài (hoặc đặt trên máy chủ phát hành nội bộ HTTPS), rồi:

```bash
# Cài offline từ thư mục đã chép
sudo ITSO_RELEASE_DIR=/root/itso-0.1.0-alpha bash /root/itso-0.1.0-alpha/install.sh

# Hoặc tải từ máy chủ phát hành nội bộ
curl -fsSLO https://<máy chủ phát hành>/0.1.0-alpha/install.sh
sudo ITSO_RELEASE_URL=https://<máy chủ phát hành> bash install.sh --version 0.1.0-alpha
```

Tùy chọn hay dùng của `itso install` (truyền sau `install.sh`): `--port <1024–65535>` (cổng panel), `--no-firewall`, `--yes` (chấp nhận cảnh báo preflight), `--dry-run`, `--restore` (khôi phục thảm họa, xem mục 6).

`install.sh` kiểm chữ ký Ed25519 của manifest và SHA-256 từng file trước khi chạy `itso install`. Cài lỗi giữa chừng: chạy lại lệnh cài, installer tiếp từ bước hỏng.

## 4. Thiết lập lần đầu

1. Cuối bước cài, installer in **URL panel** và **mã thiết lập** (xem lại: `sudo itso url`, tạo mã mới: `sudo itso setup-code`).
2. Mở URL, nhập mã thiết lập, chạy wizard: tài khoản SUPER_ADMIN + MFA, thông tin máy chủ, stack web (Nginx, PHP, DB), tường lửa nền (safe-apply, xác nhận trong thời hạn).
3. Kiểm tra: `sudo itso status`, `sudo itso doctor`. Mọi mục PASS.

## 5. Bật backup (bắt buộc trước khi tạo account thật)

1. Backup Center → **Đích**: thêm ít nhất một đích off-site (SFTP, S3 hoặc rest-server) và, nếu có, một đích bất biến (S3 Object Lock hoặc rest-server `--append-only`). Đích "Ổ đĩa máy chủ" luôn ở `/var/backups/itso`, không tính là off-site.
2. **Bộ khôi phục** hiện một lần sau khi tạo đích: tải về, cất ngoài máy chủ (két, trình quản lý mật khẩu của tổ chức), tick xác nhận. Mất bộ khôi phục thì không khôi phục được khi mất máy.
3. Backup Center → **Policy**: một policy cho account (file hằng ngày, DB 6 giờ), một policy **panel** và một policy **cấu hình máy chủ** chạy hằng ngày.
4. Backup Center → **Tổng quan**: checklist 3-2-1-1-0 xanh. Restore test hằng tháng đạt (tab Kiểm chứng).

Chi tiết vận hành và khôi phục: `docs/runbooks/disaster-recovery.md`.

## 6. Khôi phục khi mất máy (tóm tắt)

```bash
sudo bash install.sh --restore     # trên máy Ubuntu 24.04 mới
```

Mở URL panel, nhập mã thiết lập; wizard chọn sẵn **Khôi phục từ backup**: nhập đích, đường dẫn + mật khẩu repo server, khóa riêng age (từ bộ khôi phục) → chọn bản backup panel → khôi phục. Panel tự áp lại cấu hình và khôi phục dữ liệu từng account. Đích SFTP: dùng CLI `itso backup panel-restore`. Làm đúng theo runbook DR.

## 7. Cập nhật, gỡ cài

- Cập nhật: `sudo itso update` (bản mới ký cùng khóa), quay lại: `sudo itso rollback`.
- Gỡ: `sudo itso uninstall` (giữ `/home`, cấu hình chuyển sang `/etc/itso.removed-*`). `/var/backups/itso` được giữ nguyên.
- VM đã cài bản dev `0.4.0-dev` trước đây: cài lại VM mới (phiên bản alpha nhỏ hơn về semver).

## 8. Kiểm thử trên VM

Sau khi cài (`tests/vm/run-all.sh --no-uninstall`), chạy theo thứ tự: `tests/vm/phase5.sh`, `phase6.sh`, `phase7.sh --client-ip <IP>`, `phase8.sh`. Diễn tập DR: `phase8.sh --dr-source` trên VM1, chép `/root/itso-dr-kit.tar` sang VM2 vừa `install.sh --restore`, rồi `phase8.sh --dr-target /root/itso-dr-kit.tar`. Gửi các báo cáo `/root/itso-vm-*.md` để ghi vào `TEST_REPORT.md`.

## 9. Hỗ trợ

Nhật ký: `sudo itso logs`, `journalctl -u 'itso*'`. Sửa cấu hình lệch: `sudo itso repair` (xem trước), `sudo itso repair --fix`. Phạm vi: dùng nội bộ; billing/thanh toán không có trong sản phẩm.
