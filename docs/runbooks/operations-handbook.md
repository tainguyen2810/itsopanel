# Sổ tay vận hành ITSO Panel

> Dành cho đội vận hành máy chủ (Prompt 12.7). Gom các việc thường ngày và trỏ tới runbook chi tiết của từng Phase.
> Áp dụng từ `v1.0.0-rc.1`, Ubuntu 24.04 LTS. Mọi lệnh `itso` chạy bằng root (`sudo`) trên máy đã cài, trừ khi ghi khác.

## 0. Nguyên tắc

- **Không sửa tay cấu hình do panel sinh** (`/etc/nginx/sites-*/itso-*`, pool PHP-FPM, `/etc/itso/*`, bảng nftables `inet itso`).
  Sửa qua panel hoặc lệnh `itso`; sửa tay sẽ bị ghi đè ở lần áp dụng sau.
- Mọi thao tác ghi đi qua job và audit log. Khi có sự cố, xem **Jobs** và **Audit log** của panel trước khi vào máy.
- Trước thao tác lớn (cập nhật, chuyển account, import): kiểm trang **Hệ thống › Sẵn sàng production** và `itso doctor`.
- Không chép bí mật (mật khẩu DB, token, khóa) vào ticket, chat hay ảnh chụp màn hình.

## 1. Bản đồ tài liệu

| Việc | Tài liệu |
|---|---|
| Cài đặt và kiểm thử VM | `docs/planning/10-INSTALLER.md`, `docs/runbooks/phase-4-vm-test.md`, `tests/vm/README.md` |
| Website, Nginx, PHP, SSL, DNS | `docs/runbooks/phase-5-websites.md` |
| Database, File Manager, SFTP/FTPS, Cron, Terminal | `docs/runbooks/phase-6-hosting-data.md` |
| Tường lửa, SSH, Fail2ban, WAF, mã độc, FIM, allowlist | `docs/runbooks/phase-7-security-center.md` |
| Backup, khôi phục, DR | `docs/runbooks/disaster-recovery.md` |
| Nhiều server, chuyển account | `docs/runbooks/multi-server.md` |
| Docker, WordPress, phần mềm | `docs/runbooks/phase-10-docker-wordpress.md` |
| Giám sát, cảnh báo, thông báo | `docs/runbooks/phase-11-monitoring.md` |
| Chính sách cập nhật, thời hạn vá, xoay khóa ký | `docs/security/update-policy.md` |
| Hiệu năng (200 account/server) | `docs/perf/phase-12.md` |

## 2. Cài đặt

**Có mạng:**

```bash
curl -fsSLO https://<máy chủ phát hành nội bộ>/releases/<ver>/install.sh
sudo bash install.sh                       # kiểm chữ ký manifest + sha256, rồi chạy itso install
sudo itso url && sudo itso setup-code      # mở URL, nhập mã thiết lập, chạy Wizard
```

**Không có mạng (D-113):** chép `itso-<ver>-offline.tar` và `install.sh` của cùng bản vào máy, rồi:

```bash
sudo bash install.sh --offline itso-<ver>-offline.tar            # repo apt tạm, xóa sau cài; ACME tắt
sudo bash install.sh --offline itso-<ver>-offline.tar --keep-offline-repo   # giữ repo để Wizard cài nginx/PHP/MariaDB
```

Máy offline không cấp được chứng chỉ ACME: tải chứng chỉ lên (SSL tùy chỉnh) cho từng website.

**Sau khi cài:** bật MFA cho mọi quản trị viên, thêm IP allowlist Admin, thêm đích backup bất biến, kênh thông báo ngoài
panel (email/Telegram/webhook), chạy kiểm CIS. Trang **Sẵn sàng production** liệt kê những việc còn thiếu.

Node trong cụm nhiều server: `docs/runbooks/multi-server.md` §2 (`install.sh --role node --join … --token … --ca-sha256 …`).

## 3. Nâng cấp và quay lại

1. Đọc `docs/releases/<ver>.md`; nếu `breaking_db` thì `itso backup` trước.
2. `sudo itso doctor` phải sạch; trang **Hệ thống › Cập nhật** không có journal dở.
3. `sudo itso update --release-dir <thư mục bản mới>` (bản offline: thư mục giải nén từ `itso-<ver>-offline.tar`).
4. Kiểm: `itso version`, `itso doctor`, trang Sẵn sàng production, vài site account.
5. Có lỗi: `sudo itso rollback` (về bản ngay trước). Site của account không gián đoạn khi cập nhật panel.

**Mất điện hoặc bị ngắt giữa chừng:** `itso doctor` và trang Cập nhật báo journal dở kèm bước. Chạy `sudo itso repair --fix`:
trước bước `migrated` thì dọn bản dở và giữ bản cũ; từ `migrated` thì hoàn tất hoặc quay lại nếu kiểm sức khỏe lỗi (ADR 0059).
Lịch sử mọi lượt update/rollback/repair hiện ở trang Cập nhật.

## 4. Sao lưu và khôi phục (DR)

- Chính sách mặc định: snapshot hằng ngày mỗi account, giữ theo chính sách; ít nhất một đích **bất biến** (append-only hoặc
  object lock). Kiểm hằng tuần: trang Backup không có account thiếu snapshot 24 giờ; restore test thành công trong 7 ngày.
- Khôi phục account/website/DB: trang Backup của account (ghi đè cần step-up).
- Mất cả máy control plane: `docs/runbooks/disaster-recovery.md` (cài máy mới bằng `install.sh --restore`, kit khôi phục
  in giấy cất két, `itso backup panel-restore` rồi Wizard khôi phục).
- Bộ khôi phục (kit) phải tạo lại sau mỗi lần đổi đích backup hoặc mật khẩu repo.

## 5. Sự cố thường gặp

| Triệu chứng | Kiểm | Xử lý |
|---|---|---|
| Không vào được Admin Panel vì IP đổi | `itso url`, log Caddy | `sudo itso allowlist reset` (ghi audit), đăng nhập rồi thêm lại dải đúng |
| Quên mật khẩu / mất thiết bị MFA của quản trị viên | Danh tính người yêu cầu | `sudo itso admin reset-password <email>` / `reset-mfa <email>` (ghi audit) |
| Panel báo agent mất kết nối | `itso status`, `itso logs agent` | `systemctl restart itso-agent`; node: `docs/runbooks/multi-server.md` §4 |
| Job kẹt ở `running` | Trang Jobs (bước, log), `itso logs worker` | Hủy job (nếu bước cho phép) rồi chạy lại; queue chết: `systemctl restart 'itso-worker@*'` |
| Website 502 | Trang website › Nhật ký, pool PHP-FPM của account | Áp lại cấu hình website (job `website.update`); account vượt RAM/tasks: xem quota |
| Chứng chỉ không gia hạn | Cảnh báo "Chứng chỉ sắp hết hạn", job `cert.renew` | DNS trỏ đúng, cổng 80 mở; máy offline thì tải chứng chỉ mới lên |
| Đĩa > 90 % | Cảnh báo disk, trang Giám sát | Dọn backup cục bộ/log, tăng đĩa; không xóa trong `/home/*` bằng tay |
| Cập nhật dở dang | Trang Cập nhật, `itso doctor` | `sudo itso repair --fix` (§3) |
| Điểm bảo mật / CIS giảm | Security Center, trang CIS (hướng dẫn sửa từng mục) | Làm theo hướng dẫn; mục không áp dụng ghi lý do vào ticket |

Thu thập thông tin khi cần hỗ trợ: `itso version`, `itso doctor`, `itso logs <agent|web|worker|scheduler|redis> -n 500`, mã
job/uuid liên quan. **Không** gửi `/etc/itso/*` hoặc `itso.env`.

## 6. Xoay khóa và bí mật

| Bí mật | Khi nào | Cách |
|---|---|---|
| Khóa ký bản phát hành | 2 năm/lần, đổi người giữ, nghi lộ | `docs/security/update-policy.md` §4 (bản cầu nối; lộ khóa: cập nhật thủ công có đối chiếu sha256) |
| Chứng chỉ node (mTLS) | Tự động khi qua 2/3 hạn | `itso-cert-rotate.timer`; node lỗi: `itso node rejoin` với token mới (`docs/runbooks/multi-server.md`) |
| CA nội bộ của cụm | Nghi lộ | `itso pki init` trên control plane mới + `itso node rejoin` từng node (dừng cụm theo lịch) |
| Khóa HMAC agent `/etc/itso/agent.key` | Nghi lộ | Chưa có lệnh riêng (lộ trình v1.x): `sudo sh -c 'umask 027; openssl rand -base64 48 > /etc/itso/agent.key'`, giữ chủ `root:itso` và quyền `0640`, rồi `sudo systemctl restart itso.target` |
| Mật khẩu repo backup | Nghi lộ hoặc nhân sự nghỉ | Tạo repo mới trên đích mới, chạy backup đầy đủ, tạo lại kit khôi phục, giữ repo cũ tới hết hạn lưu |
| Mật khẩu DB/FTP/SFTP của account | Theo yêu cầu USER, nghi lộ | Trang account (đổi mật khẩu; panel không lưu bản rõ) |
| Token API | Hết hạn hoặc nghi lộ | Thu hồi ở **Cài đặt › Token API**, tạo token mới với phạm vi tối thiểu |

## 7. Thêm, bớt server

- Thêm node: `docs/runbooks/multi-server.md` §2 (token join một lần, pin CA).
- Chuyển account giữa server (trước khi bỏ server): trang account › Chuyển server (`docs/runbooks/multi-server.md` §3).
- Bỏ node: chuyển hết account đi (kiểm trang server không còn account/website) → **Thu hồi** server trong panel (hủy
  chứng chỉ mTLS, agent không kết nối lại được) → `itso node leave --yes` trên node.

## 8. Import từ panel khác (aaPanel, HestiaCP, nginx thuần)

Chỉ SUPER_ADMIN, trên **cùng máy** với panel nguồn. Máy nguồn không bị sửa cho tới bước cutover.

1. **Import › Tạo lượt quét**: chọn server và nguồn. Job `import.scan` chỉ đọc.
2. Xem kế hoạch: site, domain, docroot, PHP, SSL, DB, cron, cảnh báo (`php_missing`, `ssl_expired`, `symlink_outside`,
   `domain_exists`, `db_large`). Bỏ chọn mục không cần.
3. Map từng mục sang username ITSO, gói và USER (có sẵn hoặc mới). Lỗi quota/trùng hiện theo từng dòng.
4. **Chạy** (step-up): mỗi account một job `import.run` (tạo account → copy file dưới UID account → PHP/vhost → dump và
  nạp DB). Cron tạo ở trạng thái **tắt**: bật lại sau khi kiểm.
5. Kiểm site bằng file hosts trỏ tạm hoặc domain thử; xem báo cáo khác biệt (file, byte, bảng, mục bỏ qua).
6. **Cutover** (step-up): tắt vhost của panel nguồn, nginx của ITSO phục vụ domain; cấp ACME nếu nguồn có SSL.
7. Có vấn đề: **Quay lại** (step-up) bật lại vhost nguồn; account ITSO giữ nguyên để làm lại.

## 9. Gỡ cài đặt

```bash
sudo itso uninstall                                   # gỡ dịch vụ panel; GIỮ /home, website, DB của account, cấu hình chuyển sang /etc/itso.removed-*
sudo itso uninstall --purge-panel-data --confirm-hostname "$(hostname)"   # xóa cả dữ liệu panel (/etc/itso, cluster 16/itso)
```

Trước khi gỡ: backup panel và kit khôi phục còn hạn. Site của account vẫn chạy bằng nginx/PHP-FPM sau khi gỡ panel
(kiểm ở Gate G8).

## 10. Lịch kiểm định kỳ

| Tần suất | Việc |
|---|---|
| Hằng ngày | Cảnh báo đang mở, job lỗi, backup lỗi |
| Hằng tuần | Trang Sẵn sàng production, restore test, bản vá bảo mật chờ |
| Hằng tháng | Kiểm CIS mọi server, rà audit log thao tác SUPER_ADMIN, rà token API và allowlist |
| Hằng quý | Diễn tập DR theo `docs/runbooks/disaster-recovery.md` §1, kiểm kit khôi phục |
| Mỗi bản phát hành | `docs/security/update-policy.md` §7 |

## 11. Liên hệ và trách nhiệm

Điền theo tổ chức (không ghi số điện thoại cá nhân vào repo; lưu ở sổ liên lạc nội bộ):

| Vai trò | Trách nhiệm |
|---|---|
| Chủ hệ thống ITSO Panel | Duyệt phát hành, giữ khóa ký (cùng một người thứ hai), quyết định khi sự cố Critical |
| Trực vận hành | Theo dõi cảnh báo, xử lý §5, mở ticket |
| Quản trị bảo mật | Nhận báo cáo lỗ hổng (`docs/security/update-policy.md` §6), rà audit log, CIS |
| Quản trị backup | Đích backup, kit khôi phục, diễn tập DR |
| Bộ phận sử dụng Hosting (USER) | Báo lỗi website của mình qua kênh hỗ trợ nội bộ, giữ mật khẩu/MFA |
