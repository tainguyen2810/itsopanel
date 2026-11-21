# ADR 0012: Disk quota cho hosting account

- **Trạng thái:** Accepted (2026-11-21, cùng Phase 4; bảng test VM `tests/vm/` vẫn chờ chạy)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-64

## Bối cảnh

Gói giới hạn `disk_mb` và `inode_limit`. Mọi file account tạo đều mang UID của account nên **user quota** của kernel phản ánh đúng. Ubuntu 24.04 mặc định ext4 trên `/`, bật quota cần tính năng `quota` (cần unmount) hoặc mount option journaled quota (cần remount, khuyến nghị reboot một lần). Container cloud Phase 4 không có công cụ quota (`setquota`, `repquota`) và không remount được, nên chỉ kiểm được argv sinh ra.

## Quyết định

1. Chế độ `quota_mode` do agent phát hiện và báo trong `system.info`:
   - `kernel`: filesystem chứa `/home` đang bật user quota (`quotaon -p` báo "user quota on", hoặc mount option `usrquota`/`usrjquota`/`uquota`).
   - `soft`: không bật được. Agent vẫn đo bằng `du`-tương đương (duyệt cây thư mục với `fstatat`, không theo symlink) trong `quota.report`; panel cảnh báo và chặn tạo mới khi vượt. Wizard bước 6 hiện cảnh báo đỏ "Disk quota không được thực thi bởi kernel" kèm hướng dẫn.
2. `quota.apply` ở chế độ `kernel`:

   ```text
   /usr/sbin/setquota -u <uid> <block_soft> <block_hard> <inode_soft> <inode_hard> <mount_home>
   ```

   block tính theo KiB (`disk_mb × 1024`), soft = 95% hard; inode soft = 95% hard. Ở chế độ `soft`: trả `{"applied": false, "mode": "soft"}` (không lỗi).
3. `quota.report`: `kernel` → `/usr/sbin/repquota -u -n -p -O csv <mount>` (một lệnh cho mọi account, lọc theo UID của request); `soft` → đo cây thư mục.
4. Installer (4.4): cài `quota`; nếu `/home` là phân vùng riêng chưa có dữ liệu → thêm `usrjquota=aquota.user,jqfmt=vfsv1` vào fstab, remount, `quotacheck -cum`, `quotaon`; nếu là `/` → in hướng dẫn cần reboot, không tự reboot.
5. Dữ liệu MySQL/PostgreSQL (UID dịch vụ) tính riêng ở Phase 6, không nằm trong user quota.

## Phương án không chọn

- Project quota (XFS/ext4 project ID theo thư mục home): chính xác theo thư mục nhưng cần cấu hình phức tạp hơn và không phổ biến trên ext4 mặc định; xem lại nếu cần quota theo website.
- Chỉ đo `du` cho mọi trường hợp: không ngăn được ghi vượt.

## Kiểm chứng (bảng VM)

| Test | Kỳ vọng |
|---|---|
| `dd if=/dev/zero of=~/big bs=1M count=<hard+10>` dưới UID account | `EDQUOT` ("Disk quota exceeded") |
| tạo file vượt inode hard | `EDQUOT` |
| `quota.report` sau khi ghi | `disk_mb` khớp `repquota` ±1 MB |

## Hệ quả

- Tích cực: kernel chặn ghi vượt; báo cáo rẻ (một lệnh `repquota`).
- Đánh đổi: máy chỉ có `/` ext4 cần một lần reboot để bật quota; trước đó chạy chế độ `soft` và hiển thị rõ.
