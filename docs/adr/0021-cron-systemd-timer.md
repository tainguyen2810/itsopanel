# ADR 0021: Cron bằng systemd timer trong slice của account

- **Trạng thái:** Accepted (2026-11-21, cùng Phase 6)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-74, D-64, 07 §3

## Bối cảnh

Cron của khách phải chạy dưới uid account và bị giới hạn bởi slice `itso-acct-<uid>.slice` (CPU/RAM/Tasks). Crontab của user (`cron` daemon) chạy trong `cron.service`, ngoài slice account, và lệnh nằm thẳng trong file crontab mà người dùng tạo được. Nhúng chuỗi lệnh vào unit systemd cần escape `%`, `\`, `$`, dấu nháy: dễ sai và là đường chèn.

## Quyết định

1. Mỗi cron job một cặp unit sinh từ template Go:
   - `/etc/systemd/system/itso-cron-<uuid>.service`: `Type=oneshot`, `User=<user>`, `Group=<user>`, `Slice=itso-acct-<uid>.slice`, `WorkingDirectory=/home/<user>/<working_dir>`, `ExecStart=/bin/bash /etc/itso-cron/<user>/<uuid>.sh`, `RuntimeMaxSec=<timeout_sec>`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `Nice=10`, `IOSchedulingClass=idle`, `StandardOutput=journal`, `SyslogIdentifier=itso-cron-<uuid>`.
   - `/etc/systemd/system/itso-cron-<uuid>.timer`: `OnCalendar=<chuyển đổi>`, `Persistent=false`, `AccuracySec=1s`, `RandomizedDelaySec=0`.
   - Lệnh người dùng nằm trong `/etc/itso-cron/<user>/<uuid>.sh` (root:`<group account>` 0640, thư mục `root:<group account>` 0750, nằm ngoài `/etc/itso` vì thư mục đó 0750 `root:itso` và bash đọc script dưới uid account): `#!/bin/bash` + một dòng lệnh. Không escape vào unit; account đọc được nhưng không sửa được, account khác không đọc được.
2. **Chuyển cron → OnCalendar** trong agent: 5 trường số với `*`, danh sách, khoảng `a-b`, bước `*/n` và `a-b/n`; miền phút 0–59, giờ 0–23, ngày 1–31, tháng 1–12, thứ 0–7 (0 và 7 = CN). Ví dụ `*/15 2-5 * * 1-5` → `Mon..Fri *-*-* 02..05:00/15:00`. **DOM và DOW cùng bị giới hạn → từ chối** (`invalid_params`): cron hiểu là OR, systemd hiểu là AND. Lịch không bao giờ xảy ra (31/2) → từ chối (kiểm bằng cách tìm lần chạy kế tiếp trong 4 năm).
3. `cron.apply{account, entries}` là desired state theo account: tạo/cập nhật unit của job `enabled`, dừng + xóa unit/script của job không còn hoặc `enabled=false`, `systemctl daemon-reload`, `enable --now` timer. Idempotent theo sha256 nội dung.
4. `cron.inspect{account, uuids}` đọc `systemctl show itso-cron-<uuid>.service -p ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainStatus,Result` → panel ghi `cron_runs` (trigger `schedule`) và `last_run_at/last_status` (lệnh `itso:cron-sync` mỗi 5 phút).
5. `cron.run_once` (Chạy ngay): `systemd-run --wait --pipe --collect --uid=<uid> --gid=<gid> --slice=itso-acct-<uid>.slice -p RuntimeMaxSec=<≤900> -p NoNewPrivileges=yes --working-directory=… /bin/bash /etc/itso-cron/<user>/<uuid>.run.sh` (script riêng cho lần chạy tay, xóa sau khi chạy); trả mã thoát + 8 KiB output cuối; panel ghi `cron_runs` (trigger `manual`).
6. Panel kiểm: `cron_limit` theo gói, khoảng tối thiểu `cron_min_interval_min` (tính khoảng ngắn nhất giữa hai lần chạy trong 1 ngày mẫu), `working_dir` trong home. Tạm khóa account: `cron.apply` với mọi entry `enabled=false`.

## Hệ quả

- Cron nằm trong slice account (giới hạn thật) và chạy đúng uid; log ở journal theo unit.
- Không hỗ trợ `@reboot`, tên thứ/tháng, và tổ hợp DOM+DOW (thông báo rõ ở API).
- Kiểm thử: golden unit + bảng chuyển đổi; VM kiểm `systemctl show` thấy slice/uid thật.
