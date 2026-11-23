# ADR 0053: Import từ aaPanel, HestiaCP, Nginx thuần

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-108, ADR 0034–0038 (chuyển account Phase 9)

## Bối cảnh

Máy chủ nội bộ đang chạy aaPanel/HestiaCP hoặc nginx cấu hình tay cần đưa website vào ITSO mà không dựng lại từ đầu và không làm gián đoạn site đang chạy.

## Quyết định

1. **Chỉ import trên cùng máy** đang cài ITSO. Import từ máy khác: DEFERRED (import tại chỗ rồi dùng chuyển account Phase 9).
2. Op agent `import.scan` **chỉ đọc**: nguồn `aapanel` (`/www/server/panel/vhost/nginx/*.conf`, `/www/wwwroot`), `hestia` (`/usr/local/hestia/data/users/*/web.conf`, `/home/<u>/web/<d>/public_html`), `nginx` (`/etc/nginx/sites-enabled`). Parser nginx tối thiểu: giới hạn kích thước file 256 KB, không theo `include` ra ngoài `/etc/nginx`, tối đa 500 site; fuzz. Kết quả là **kế hoạch** (site, alias, docroot, PHP, SSL, DB, cron, cảnh báo), không thay đổi máy.
3. Panel lưu kế hoạch (`imports`, `import_items`); SA chọn mục, map sang username/gói/USER (có sẵn hoặc tạo mới). Kiểm trùng domain, username, hạn mức gói trước khi chạy.
4. `import.run`: mỗi account một job — `account.ensure` → `import.copy` (đọc nguồn bằng `O_NOFOLLOW`, bỏ symlink/hardlink trỏ ra ngoài docroot, socket, device; ghi **dưới UID account**; giới hạn `max_bytes`; trả số file/bytes/bỏ qua) → `db.mysql.dump` (socket) → `db.mysql.import` vào DB mới (mật khẩu do panel sinh, không vào params job) → vhost + chứng chỉ (dùng lại nếu hợp lệ, không thì ACME) → cron.
5. **Máy nguồn không bị sửa** cho tới **cutover**: `import.cutover` đổi tên vhost nguồn `.conf → .itso-disabled` (chỉ file trong danh sách kế hoạch), `nginx -t` rồi reload; lỗi thì tự hoàn tác. `import.rollback` làm ngược lại; account ITSO được giữ.
6. Chỉ SUPER_ADMIN; chạy/cutover/rollback cần step-up; mọi bước có audit.

## Ghi chú hiện thực (12.2)

- Vhost nguồn theo từng loại: aaPanel `/www/server/panel/vhost/nginx/*.conf`, HestiaCP `/etc/nginx/conf.d/domains/<d>.conf` (kèm `<d>.ssl.conf` nếu có), nginx thuần `/etc/nginx/conf.d/*.conf` và `/etc/nginx/sites-enabled/*` (không bắt buộc đuôi `.conf`; symlink chỉ được trỏ vào `sites-available`). Vhost `itso-*` luôn bị từ chối.
- Cutover: thư mục được include bằng `*.conf` → đổi tên thêm `.itso-disabled`; `sites-enabled` (include `*`) → chuyển nguyên file/symlink sang `/etc/nginx/itso-disabled/<import>/` cùng filesystem. Idempotent; `nginx -t` hoặc reload lỗi → hoàn tác mọi đổi tên.
- aaPanel chạy nginx riêng (`/www/server/nginx`) dưới cùng unit `nginx.service`; trước cutover máy phải dùng nginx của ITSO (sổ tay vận hành 12.7 ghi bước chuyển). Op chỉ reload `nginx.service`, không chạy binary của aaPanel.
- `import.copy`: root đọc nguồn bằng `openat(O_NOFOLLOW)` từng thành phần (`fsx.SourceTar`), helper uid account giải bằng `restore_tar` vào đích mới (đích đã có → `already_exists`, vượt `max_bytes` → `quota_exceeded`, không để lại thư mục dở). Hardlink (nlink > 1) bị bỏ vì có thể trỏ tới file ngoài docroot.
- DB/cron của HestiaCP gắn theo user: chỉ gán vào site khi user có đúng một website; còn lại SA map tay. aaPanel lưu DB/cron trong SQLite của panel: chưa đọc (SA map tay).

## Hệ quả

- Tái dùng op có sẵn (account, db, vhost, cert), bề mặt mới chỉ là đọc cấu hình nguồn và copy file có kiểm soát.
- Không import user hệ thống/mật khẩu FTP/email của panel nguồn (ngoài phạm vi).
