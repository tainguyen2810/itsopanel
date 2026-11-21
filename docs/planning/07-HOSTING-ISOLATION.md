# 07 — Hosting Packages, Users và thực thi giới hạn thật trên Linux

## 1. Mô hình vai trò

| Vai trò | Phạm vi | Có thể |
|---|---|---|
| SUPER_ADMIN | Toàn hệ thống | Mọi thứ, gồm servers, packages, policy (trừ policy cục bộ agent — cần root CLI) |
| ADMIN | `user_scopes`: danh sách server và/hoặc hosting account | Tạo USER + account trên server được giao, dùng gói được phép, quản lý site/DB/backup trong phạm vi |
| USER | Hosting account mình sở hữu (có thể >1) | Quản lý site, DB, file, cron, SFTP, backup trong giới hạn gói |

Một USER có thể có nhiều hosting account (vd trên 2 server). Giới hạn nằm ở **account**, không ở user.

## 2. Ánh xạ giới hạn gói → cơ chế Linux

| Giới hạn | Cơ chế thực thi | Ghi chú |
|---|---|---|
| **CPU quota** | cgroup v2 `cpu.max` qua `CPUQuota=` trên `itso-acct-<id>.slice` (vd 200% = 2 core) | Áp dụng cho mọi tiến trình trong slice |
| **RAM quota** | `MemoryMax=` (cứng, OOM trong slice) + `MemoryHigh=` ≈ 90% (throttle trước) + `MemorySwapMax=` | OOM chỉ giết tiến trình của account |
| **Tiến trình** | `TasksMax=` | Chặn fork bomb |
| **IO** | `IOWeight=` (cần scheduler bfq hoặc io.cost); `IOReadBandwidthMax/IOWriteBandwidthMax` theo device (tùy chọn) | Trên NVMe với `none` scheduler, IOWeight có thể không hiệu lực → ghi chú trong spike |
| **Disk quota** | Kernel **user quota** (ext4 `quota` feature hoặc XFS `uquota`) theo uid account: block + inode, soft/hard | Xem §4 |
| **Website/DB/Domain/FTP/Cron limit** | Đếm trong panel (transaction + `SELECT … FOR UPDATE` trên account) | Logic panel, agent không cần biết |
| **Backup quota** | Panel tính tổng `raw size` snapshot của account; vượt → chặn backup mới thủ công, cảnh báo | Restic dedupe → dùng "restore size" để công bằng, ghi rõ |
| **Backup retention** | Policy restic `forget --keep-*` chạy bởi tiến trình prune (xem `08-BACKUP.md`) | |
| **SSH permission** | Group `itso-ssh` (shell `/bin/bash`) vs `itso-sftp` (`internal-sftp` + chroot) trong `sshd_config.d/itso.conf` | |
| **Docker permission** | Cờ cho phép "managed apps" (Phase 9+); **không bao giờ** thêm vào group `docker` | |
| **PHP permissions** | `allowed_php_versions`, giới hạn `memory_limit` ≤ RAM gói, `max_execution_time`, `upload_max_filesize`, extension allowlist; `php_admin_value` trong pool (user không ghi đè được) | |
| **DB resource** | MySQL: `MAX_USER_CONNECTIONS`, `MAX_QUERIES_PER_HOUR` (tùy chọn); PostgreSQL: `CONNECTION LIMIT` | **CPU/RAM của mysqld/postgres không tính vào slice account** — giới hạn mềm |

## 3. Cấu trúc systemd slice

> Cập nhật Phase 4 (D-64, ADR 0011): systemd suy ra slice cha **từ tên** (dấu `-`), không dùng được `Slice=` trong unit `.slice`
> (`systemd-analyze verify` báo "Failed to assign slice"). Vì vậy slice account `itso-acct-<uid>.slice` nằm dưới `itso-acct.slice`
> → `itso.slice`; slice của panel đổi thành `itso-panel.slice` để không chứa hosting.

```
-.slice
├── system.slice           (nginx, mysqld, postgresql, itso-agent)
└── itso.slice             (gốc ITSO, không đặt giới hạn riêng)
    ├── itso-panel.slice   (panel: itso-web, workers — MemoryMax bảo vệ panel)
    ├── itso-maint.slice   (malware scan, backup: CPUQuota thấp, IOWeight thấp)
    └── itso-acct.slice    (giới hạn tổng cho toàn bộ hosting, chừa tài nguyên cho hệ thống)
        ├── itso-acct-20012.slice
        │   ├── itso-php@8.3-acct12.service   (php-fpm master riêng, User=acct12)
        │   ├── itso-cron-341.service         (từ timer)
        │   └── itso-app-77.service           (managed app/Node, Phase 10)
        └── itso-acct-20013.slice …
user.slice
└── user-20012.slice       (phiên SSH của acct12 — logind tạo)
```

**Vấn đề cần spike (Phase 4):** phiên SSH/SFTP do `pam_systemd` đặt vào `user-<uid>.slice`, không vào `itso-acct-<id>.slice`. Hai phương án:
- (a) Áp cùng giới hạn lên `user-<uid>.slice` qua drop-in `/etc/systemd/system/user-<uid>.slice.d/itso.conf` → hai "xô" riêng, tổng có thể gấp đôi. Đơn giản.
- (b) Đặt service của account vào chính `user-<uid>.slice` để gom về một xô. Gọn hơn nhưng phụ thuộc vòng đời logind (slice bị dừng khi user logout nếu không bật linger) → cần `loginctl enable-linger`. 
- **Khuyến nghị sơ bộ:** (a) cho v0.1, giới hạn SSH thấp hơn (vd 50% gói); xác nhận bằng spike.

## 4. Disk quota

| Trường hợp filesystem | Cách bật | Installer làm gì |
|---|---|---|
| ext4 (mặc định Ubuntu) | `tune2fs -O quota` **cần unmount** → không làm được online trên `/` | Nếu `/home` là phân vùng riêng & chưa có dữ liệu: bật được. Nếu không: dùng mount option journaled quota `usrjquota=aquota.user,jqfmt=vfsv1` + `quotacheck` (cần remount, khuyến nghị reboot một lần) |
| XFS | mount option `uquota` (với `/` cần `rootflags=uquota` trên kernel cmdline + reboot) | Hướng dẫn rõ ràng trong wizard |
| Btrfs/ZFS | qgroups / dataset quota | Ngoài phạm vi v0.1 |
| Không bật được | Chế độ "soft enforcement": đo `du` định kỳ, vượt → chặn upload qua File Manager/SFTP (đổi quyền ghi), cảnh báo | Wizard hiển thị cảnh báo đỏ: "Disk quota không được thực thi bởi kernel" |

File mà account tạo đều mang uid của account → user quota phản ánh đúng. Ngoại lệ: dữ liệu MySQL/PostgreSQL (uid `mysql`/`postgres`) — tính riêng bằng `information_schema`/`pg_database_size` và cộng vào usage hiển thị; vượt → cảnh báo + không cho tạo DB mới (không khóa ghi để tránh hỏng site).

## 5. Bố cục home và quyền

```
/home/acct12/                 root:acct12   0750  + ACL u:www-data:--x
├── sites/example.com/
│   ├── public/               acct12:acct12 0750 + ACL u:www-data:r-x (default ACL kế thừa)
│   └── tmp/                  acct12        0700  (upload_tmp_dir, session.save_path)
├── backups/                  acct12        0700  (export DB, file tạm restore)
├── .ssh/                     acct12        0700
└── .itso/                    root          0755  (metadata, không cho account sửa)
```
- Log Nginx của site: `/var/log/itso/sites/acct12/example.com/` root:acct12 0750 (ngoài home, xem ADR 0014 mục Sửa đổi: account không đổi được thành symlink).
- Home do root sở hữu → đáp ứng yêu cầu `ChrootDirectory` của SFTP.
- Account không liệt kê được home người khác (0750 + group riêng).
- `/proc` mount `hidepid=invisible,gid=itso-proc` (agent và giám sát trong group `itso-proc`).
- Nginx: `disable_symlinks if_not_owner from=$document_root;`.

## 6. PHP-FPM: master per account (D-12)

Một php-fpm master dùng nhiều pool với các user khác nhau **không thể** đặt từng pool vào cgroup riêng (worker kế thừa cgroup của master). Vì vậy:
- Unit template `itso-php@.service` (instance `8.3-acct12`): chạy `php-fpm8.3 --nodaemonize --fpm-config /etc/itso/php/8.3/acct12.conf`, `User=` không dùng (master cần root để bind socket rồi hạ quyền) **hoặc** master chạy trực tiếp dưới `User=acct12` với socket trong `/run/itso/php/acct12.sock` (owner acct12, ACL cho www-data). Chọn phương án master chạy dưới uid account (không cần root) → an toàn hơn.
- `pm = ondemand`, `pm.max_children` suy ra từ RAM gói, `pm.process_idle_timeout=30s` → account ít truy cập gần như không tốn RAM.
- Chi phí: ~15–30 MB/master khi có traffic. Với ≤ 200 account/server chấp nhận được.

## 7. Suspend / Unsuspend
`account.suspend`: dừng & disable `itso-php@*-acctN`, timers cron, managed apps; khóa mật khẩu (`usermod -L`) + chặn SSH/SFTP qua group `itso-suspended` (`DenyGroups`); vhost trỏ trang suspend; DB user `ACCOUNT LOCK`. Dữ liệu giữ nguyên. Unsuspend làm ngược lại và reconcile toàn bộ desired state.

## 8. Thay đổi gói
Đổi `hosting_packages` → job `package.reapply` fan-out `account.limits.apply` cho mọi account dùng gói (theo lô, có giới hạn đồng thời). Giảm quota xuống dưới usage hiện tại: cho phép nhưng cảnh báo; disk soft limit = usage, hard = usage+5% tạm thời.

## 9. Kiểm thử chấp nhận cho enforcement (Phase 4)
| Test | Kỳ vọng |
|---|---|
| `stress-ng --cpu 8` trong account CPU 100% | `cpu.stat` throttled, tổng ≤ ~1 core |
| Cấp phát RAM vượt `MemoryMax` | Tiến trình bị OOM-kill trong slice, hệ thống và account khác không ảnh hưởng |
| Fork bomb | Dừng ở `TasksMax` |
| `dd` ghi vượt disk hard | `EDQUOT` |
| Account A `ls /home/B` | Permission denied |
| PHP account A `file_get_contents('/home/B/...')` | Thất bại |
| `ps aux` từ account A | Chỉ thấy tiến trình của A |
