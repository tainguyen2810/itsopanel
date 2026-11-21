# ADR 0011: Slice cho hosting account và phiên SSH

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 4; xác nhận bằng bảng test VM `tests/vm/`)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-12, D-64

## Bối cảnh

Giới hạn CPU, RAM, số tiến trình, IO của gói phải do kernel thực thi (cgroup v2), không chỉ đếm ở panel. Tiến trình của account đến từ ba nguồn: dịch vụ do panel tạo (PHP-FPM master riêng từ Phase 5, cron từ Phase 6, app từ Phase 10), phiên SSH/SFTP (do `pam_systemd` đặt vào `user-<uid>.slice`), và tiến trình con của chúng.

Kiểm trên container cloud của Phase 4: không có cgroup v2 (`/sys/fs/cgroup` là tmpfs, không có `cgroup.controllers`), systemd không phải PID 1, nên không áp được slice thật. `systemd-analyze verify` chạy được offline nên dùng để kiểm cú pháp unit/drop-in sinh ra.

## Quyết định

1. Cây slice cố định do installer tạo:

   ```text
   itso-hosting.slice        (giới hạn tổng cho hosting, chừa tài nguyên cho hệ thống)
   └── itso-acct-<uid>.slice (một slice cho mỗi account, đặt tên theo UID 20000–59999)
   ```

   Tên theo UID (không theo username) để tên slice không đổi khi đổi username và luôn khớp `^itso-acct-[0-9]{5}\.slice$`.

2. Op `account.limits.apply` (và bước slice trong `account.ensure`) ghi drop-in:

   ```ini
   # /etc/systemd/system/itso-acct-20001.slice.d/50-itso.conf  (root:root 0644, ghi atomic)
   [Unit]
   Description=ITSO hosting account anphat (uid 20001)
   [Slice]
   Slice=itso-hosting.slice
   CPUQuota=200%
   MemoryMax=1024M
   MemoryHigh=921M          # 90% MemoryMax: throttle trước khi OOM
   MemorySwapMax=0
   TasksMax=256
   IOWeight=100
   # IOReadBandwidthMax/IOWriteBandwidthMax chỉ ghi khi gói đặt io_read_bps/io_write_bps (theo thiết bị của /home)
   ```

   rồi chạy `systemctl daemon-reload` và `systemctl set-property --runtime` không cần (drop-in + daemon-reload đủ cho slice đang chạy). Nội dung giống hệt lần trước → không ghi, không reload (idempotent).

3. Phiên SSH/SFTP: phương án (a) của `07-HOSTING-ISOLATION.md` §3. Ghi drop-in tương tự cho `user-<uid>.slice` (`/etc/systemd/system/user-<uid>.slice.d/50-itso.conf`) với **50%** CPUQuota, MemoryMax, TasksMax của gói. Hai "xô" riêng, tổng tối đa 1,5 lần gói; chấp nhận cho v0.1 vì đơn giản và không phụ thuộc linger.

4. Suspend: `systemctl stop itso-acct-<uid>.slice` (dừng mọi unit trong slice) + khóa đăng nhập (`usermod -L`, group `itso-suspended`). Unsuspend: mở khóa và để unit của module (Phase 5+) tự khởi động lại khi reconcile.

## Phương án không chọn

- (b) Gom service của account vào `user-<uid>.slice` + `loginctl enable-linger`: một xô duy nhất nhưng phụ thuộc vòng đời logind; để đánh giá lại ở Phase 12.
- Đặt giới hạn bằng `systemd-run --scope` từng tiến trình: không bao phủ phiên SSH, khó reconcile.

## Kiểm chứng (bảng VM, `tests/vm/enforcement.sh`)

| Test | Lệnh | Kỳ vọng |
|---|---|---|
| CPU | `systemd-run --slice=itso-acct-<uid>.slice --uid=<uid> stress-ng --cpu 4 -t 20s` | `cpu.stat` có `nr_throttled > 0`, tổng ≈ CPUQuota |
| RAM | `stress-ng --vm 1 --vm-bytes 2G` trong slice MemoryMax=512M | OOM-kill trong slice, `memory.events` `oom_kill ≥ 1`, hệ thống không ảnh hưởng |
| Tiến trình | fork bomb có giới hạn thời gian trong slice | dừng ở TasksMax (`pids.max`) |
| SSH | đăng nhập SSH account rồi `cat /proc/self/cgroup` | nằm trong `user-<uid>.slice` có drop-in 50% |

## Hệ quả

- Tích cực: giới hạn do kernel thực thi; unit/drop-in là file văn bản, test được bằng golden test và `systemd-analyze verify`.
- Đánh đổi: phiên SSH có xô riêng; IOWeight có thể không hiệu lực với scheduler `none` trên NVMe (ghi trong báo cáo VM).
