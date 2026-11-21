# ADR 0015: PHP-FPM master riêng cho từng account, pool theo website

- **Trạng thái:** Accepted (2026-11-21, cùng Phase 5)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-68, D-12, D-64

## Bối cảnh

Giới hạn CPU/RAM của account thực thi bằng slice cgroup (D-64). Worker PHP kế thừa cgroup của master, nên một master chung cho nhiều account không giới hạn được theo account (07 §6). PHP 8.3 là bản duy nhất trong kho Ubuntu 24.04; bản khác cần PPA bên thứ ba.

## Quyết định

1. Unit template `itso-php@.service`, instance `<ver>-<user>` (ví dụ `itso-php@8.3-anphat`): `User=<user>`, `Group=<user>`, `Slice=itso-acct-<uid>.slice`, `ExecStart=/usr/sbin/php-fpm<ver> --nodaemonize --fpm-config /etc/itso/php/<ver>/<user>/php-fpm.conf`, hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/home/<user> /run/itso/php`, `PrivateTmp`).
2. Mỗi website một pool trong `/etc/itso/php/<ver>/<user>/pool.d/<hex8>.conf` (hex8 = 8 ký tự hex đầu của website_uuid). Socket `/run/itso/php/<user>-<hex8>.sock`, chủ `<user>`, ACL cho `www-data` (rw) để Nginx kết nối.
3. Pool: `pm = ondemand`, `pm.max_children` từ gói (≤ 64), `pm.process_idle_timeout = 30s`, `php_admin_value[open_basedir] = /home/<user>/sites/<site_dir>/:/home/<user>/sites/<site_dir>/tmp/`, `upload_tmp_dir` và `session.save_path` trong `tmp/` của site, `memory_limit`, `max_execution_time`, `upload_max_filesize`, `disable_functions` — đều là `php_admin_value` nên code của user không ghi đè được.
4. Op: `php.pool.apply` (ghi pool + cấu hình master, kiểm `php-fpm<ver> -t` với file của account, lỗi → khôi phục; đúng → `systemctl enable --now` hoặc `reload` instance), `php.pool.remove` (xóa pool; account hết pool → dừng và disable instance). `php.version.install/remove`, `php.ext.install` (allowlist extension → gói `php<ver>-<ext>`).
5. Phase 5 chỉ hỗ trợ **8.3** (kho Ubuntu). Phiên bản khác → `precondition_failed`; mở rộng qua PPA cần quyết định riêng (Phase 10).

## Ghi chú hiện thực (Prompt 5.2)

- Unit `packaging/systemd/itso-php@.service` không có `User=`/`ExecStart=` thật (mặc định `/bin/false`): chỉ chạy khi có drop-in do agent sinh, nên không bao giờ có master chạy root. `ExecStartPre=+install -d -m 1733 /run/itso/php` tạo lại thư mục socket sau reboot.
- Socket: `listen.acl_users = www-data`, `listen.mode = 0600` (master là chủ socket nên tự đặt được ACL).
- `php-fpm8.3 -t` chạy dưới uid account (setresuid trong tiến trình con, không su/sudo); lỗi → khôi phục pool cũ, `config_test_failed`, không reload.
- Đổi drop-in → `daemon-reload` + `restart`; chỉ đổi pool → `reload` (USR2). Hết pool → `disable --now`, xóa cấu hình master và drop-in.
- Pool trùng 8 hex đầu với website khác của cùng account → `already_exists` (không ghi đè).

## Hệ quả

- CPU/RAM của PHP tính vào slice account; account ít truy cập gần như không tốn RAM nhờ `ondemand`.
- Mỗi account có thêm một tiến trình master khi có traffic (~15–30 MB).
- Cách ly PHP giữa 2 account kiểm trên VM (phpinfo đúng uid, A không đọc được file B).
