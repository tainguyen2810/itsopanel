# Runbook: Khôi phục thảm họa (DR)

Áp dụng khi máy chủ cài panel hỏng hẳn (mất đĩa, bị xâm nhập phải cài lại, chuyển nhà cung cấp) và cần dựng lại panel
cùng dữ liệu account trên **một máy Ubuntu 24.04 mới**. Quyết định: D-87, ADR 0033 §6. Diễn tập trên 2 VM là tiêu chí
nghiệm thu Phase 8 (**chờ VM**: `tests/vm/phase8.sh`).

## 0. Mục tiêu và giới hạn

| Chỉ số | Mục tiêu | Phụ thuộc |
|---|---|---|
| RPO (dữ liệu mất tối đa) | Khoảng cách giữa hai lần backup theo policy (mặc định hằng ngày, panel hằng ngày) | Lịch policy; backup panel phải chạy cùng lịch với account |
| RTO panel (đăng nhập lại được) | 30–60 phút | Tốc độ tải từ đích; kích thước DB panel (thường dưới 1 GB) |
| RTO toàn bộ account | Panel + (tổng dữ liệu account / băng thông tải) | 2 account khôi phục cùng lúc (`--parallel`) |

Không khôi phục được nếu thiếu **bộ khôi phục** (recovery kit: đích, đường dẫn + mật khẩu repo server, khóa riêng age
`AGE-SECRET-KEY-1…`). Bộ khôi phục chỉ tải được ở Backup Center → Đích → "Bộ khôi phục" và phải cất ngoài máy chủ
(két, trình quản lý mật khẩu của tổ chức). Không có cơ chế "quên mật khẩu".

## 1. Chuẩn bị trước sự cố (kiểm tra hằng quý)

1. Backup Center → Tổng quan: checklist 3-2-1-1-0 xanh; có ít nhất một đích off-site và một đích bất biến.
2. Policy có mục **panel** (DB panel + `/etc/itso`, mã hóa age) và **server config** chạy hằng ngày.
3. Bộ khôi phục đã tải lại sau lần thêm đích/repo server gần nhất (đích báo "chưa xác nhận" nếu bộ cũ thiếu mục).
4. Restore test hằng tháng đạt (Backup Center → Kiểm chứng).
5. Ghi lại: IP/DNS panel, IP các website, cổng panel, allowlist (để đổi DNS nhanh).

## 2. Dựng máy mới

1. Máy Ubuntu 24.04 sạch, cùng kiến trúc, đĩa ≥ dung lượng dữ liệu account cũ + 30%.
2. Nếu đích là `local` (`/var/backups/itso`): chép nguyên thư mục repo từ bản sao off-site vào cùng đường dẫn.
3. Cài panel ở chế độ khôi phục:

   ```bash
   curl -fsSLO https://<máy chủ phát hành>/install.sh
   sudo bash install.sh --restore
   ```

   Trình cài đặt kiểm chữ ký Ed25519 như cài mới, rồi in mã thiết lập kèm gợi ý "Khôi phục từ backup".
4. Mở URL panel in ra, nhập mã thiết lập. Wizard chọn sẵn **Khôi phục từ backup** (`restore_mode`).

## 3. Khôi phục panel (wizard)

> **Đích SFTP:** wizard không mở được (cần khóa SSH và host key ghim theo đích). Trên máy mới, sau bước cài:
> `sudo itso backup panel-restore --kit kit.txt --snapshot <id> --ssh-key id_ed25519` (kiểm đích, ghim host key, giải
> mã vào `/var/lib/itso/restore/panel-<thời điểm>`), rồi `sudo itso panel-restore-apply --dir <thư mục in ra>`; từ đó
> giống bước 4 bên dưới. Liệt kê snapshot panel: Backup Center của panel cũ hoặc `restic snapshots --tag type:panel`.

1. Chọn loại đích, nhập cấu hình + credential; **đường dẫn repo server** (`itso/<uuid>/server`), **mật khẩu repo
   server** và **khóa riêng age**, tất cả lấy từ bộ khôi phục.
2. "Mở repo" (`POST /admin/setup/restore:inspect`): agent liệt kê các bản backup panel (tag `type:panel`). Không có
   gì được lưu; sai mật khẩu → báo lỗi ở trường mật khẩu. Tối đa 10 lần thử / 10 phút / IP.
3. Chọn bản (thường là bản mới nhất) → "Bắt đầu khôi phục" (`POST /admin/setup/restore`, job `setup.restore`, op
   `panel.restore`). Bí mật của job chỉ nằm tạm trong Redis (mã hóa bằng APP_KEY của máy mới, hết hạn 2 giờ) và bị
   xóa ngay khi job kết thúc.
4. Agent tải bản backup, giải mã age vào `/var/lib/itso/restore/panel-<thời điểm>` (root 0700), rồi hẹn unit tạm
   `itso-panel-restore-*` chạy `itso panel-restore-apply` sau 10 giây. Thứ tự áp:
   1. Sao lưu DB + `/etc/itso` của máy mới vào `/var/backups/itso/pre-restore/<thời điểm>/`.
   2. `artisan down` → `systemctl stop itso.target`.
   3. `pg_restore --single-transaction --exit-on-error`: lỗi thì DB không đổi, dịch vụ được bật lại.
   4. `/etc/itso`: lấy từ backup, **trừ** `itso.env`, `agent.key`, `redis.conf`, `panel.json`, `tls/` (giữ bản của
      máy mới); trong `itso.env` chỉ thay `APP_KEY` bằng bản cũ để giải được dữ liệu đã mã hóa.
   5. Xóa bản rõ trong staging → `artisan migrate --force` → `systemctl start itso.target`.
   6. `artisan itso:reconcile` (áp lại desired state: user, home, vhost, PHP-FPM pool, cron, firewall).
   7. `artisan itso:dr-restore --start` → `artisan up`.
   Kết quả ghi ở `/var/lib/itso/restore/last-apply.json`.
5. Khoảng một phút sau, đăng nhập bằng **tài khoản cũ** (mật khẩu + MFA cũ). Phiên wizard cũ không còn.

## 4. Khôi phục dữ liệu account (tự động)

- `itso:dr-restore` chạy mỗi 5 phút (scheduler). Mỗi account `active`/`suspended`: chờ job đồng bộ của account xong,
  rồi một job `backup.restore` gồm các bước ghi đè: mỗi website (snapshot files mới nhất của account) và mỗi database
  (snapshot DB mới nhất chứa DB đó). Tối đa 2 account cùng lúc; đổi bằng tay:
  `sudo -u itso php /opt/itso/current/api/artisan itso:dr-restore --parallel=4`.
- Theo dõi: Backup Center → Khôi phục (mỗi account một dòng). Xem trước danh sách: `itso:dr-restore --dry-run`.
- Account không có snapshot: ghi "không có snapshot để khôi phục", bỏ qua. Account lỗi: dòng khôi phục `failed`, các
  bước đã xong vẫn giữ; khôi phục lại từng mục bằng tay ở Backup Center (overwrite + step-up).
- Xong hết: audit `dr.finished` (kèm số account lỗi).

## 5. Kiểm tra sau khôi phục

1. `sudo itso status` và `sudo itso repair` (không có `--fix`): mọi mục PASS.
2. Backup Center → Tổng quan: repo + snapshot cũ hiện đủ; chạy "Kiểm tra" một repo.
3. Mở thử 3 website ngẫu nhiên (qua `/etc/hosts` trước khi đổi DNS); đăng nhập một DB bằng tài khoản cũ.
4. Đổi DNS / IP nổi sang máy mới; cấp lại chứng chỉ nếu cần (`itso:certs-renew`).
5. Chạy backup ngay cho panel (policy panel → "Chạy ngay") để có điểm khôi phục mới trên máy mới.
6. Tải lại bộ khôi phục (server UUID mới không đổi vì DB panel cũ giữ bản ghi server; kiểm lại dòng "repo server").

## 6. Quay lui

- Áp thất bại trước khi đổi cấu hình: DB không đổi, panel trống chạy lại; sửa nguyên nhân (đọc `last-apply.json`,
  `journalctl -u 'itso-panel-restore-*'`) rồi chạy lại từ bước 3 với mã thiết lập mới (`sudo itso setup-code`).
- Muốn bỏ kết quả khôi phục: `pg_restore` bản trong `/var/backups/itso/pre-restore/<thời điểm>/itso.dump` và chép lại
  `etc/` tương ứng, theo đúng thứ tự ở bước 4 (dừng `itso.target` trước).

## 7. Giới hạn đã biết (Phase 8)

- Danh sách bản backup panel chưa hiện phiên bản panel và số account (nằm trong bản mã hóa age).
- Khôi phục sang máy có hostname/IP khác: website dùng IP cũ trong cấu hình phải sửa tay sau khi đổi IP.
- Chuyển từng account sang máy khác (không phải DR): Phase 9.
