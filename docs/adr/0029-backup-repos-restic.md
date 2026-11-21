# ADR 0029: Repo restic riêng theo account × đích, bộ khôi phục một lần

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng Phase 8)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-82, D-23, D-69, D-46

## Bối cảnh

D-23 chốt mỗi hosting account một repo restic riêng: xóa sạch được một account (purge D-46), khách không thể đọc dữ liệu của nhau kể cả khi lộ một mật khẩu repo. Đặc tả Phase 1 gắn `restic_password_encrypted` và `hosting_account_id` vào `backup_destinations`, nên một đích chỉ dùng được cho một account. Mất panel (máy chủ hỏng, ransomware) thì mật khẩu repo trong DB panel cũng mất theo.

## Quyết định

1. **Engine:** restic từ kho Ubuntu 24.04 (recipe `restic`, agent kiểm `restic version` ≥ 0.16 trước mỗi op, thiếu thì `dependency_unavailable`). Không tự build, không tải nhị phân ngoài.
2. **Tách đích và repo.** `backup_destinations` giữ loại, cấu hình không bí mật, credential ghi (ADR 0030). `backup_repositories` = đích × máy chủ × account (`scope_type=hosting_account`) hoặc đích × máy chủ (`scope_type=server`, cho cấu hình máy chủ và backup panel). Mỗi repo một mật khẩu 32 byte ngẫu nhiên (base64url), lưu `Crypt` trong `password_encrypted`; ràng buộc DB: một repo sống cho mỗi bộ (đích, máy chủ, account) và (đích, máy chủ) với repo server.
3. **Đường dẫn cố định:** `itso/<server_uuid>/acct-<account_uuid>` hoặc `itso/<server_uuid>/server` (CHECK trong DB + pattern `BackupRepoPath` ở agent-ops). Agent dựng URL repo từ đích kiểu hóa + đường dẫn này; không op nào nhận chuỗi repo restic tự do.
4. **Bí mật tới agent:** params job chỉ có tham chiếu `{"$secret": "backup_repo_password:<repo_uuid>"}` và `backup_dest_credential:<dest_uuid>:<khóa>`; JobRunner thay ngay trước khi gửi (D-69). Agent ghi mật khẩu vào file 0600 trong `/run/itso/backup/<op_uuid>/` và dùng `RESTIC_PASSWORD_FILE`, credential qua biến môi trường của tiến trình con; xóa thư mục khi xong. Không bí mật nào nằm trong argv, log job, audit.
5. **Tag và metadata:** tag theo danh sách cố định `itso`, `type:files|db|config|panel`, `account:<uuid>`, `website:<uuid>`, `db:<tên>`, `policy:<uuid>`, `manual`, `pre-restore`, `final` (pattern `BackupTag`). Mỗi snapshot files/db kèm `itso-meta.json` (phiên bản panel, server, account, website, DB, gói, manifest sha256 của file) để kiểm chứng (ADR 0033) và DR.
6. **Bộ khôi phục (recovery kit):** gồm cấu hình đích, đường dẫn + mật khẩu từng repo của đích, khóa age của panel (ADR 0031). `POST /backup-destinations/{id}:recovery-kit` lần đầu sau khi tạo đích trả không cần step-up (`first_view=true`); SA phải xác nhận đã lưu offline (`:recovery-kit-ack`, audit). Sau đó xem lại cần SUPER_ADMIN + step-up. Repo mới phát sinh (account mới) làm bộ khôi phục cũ thiếu mục: đích hiện "Chưa xác nhận bộ khôi phục" cho tới khi SA tải lại. Mật khẩu repo account không cần cho DR toàn máy vì nằm trong DB panel đã backup (mã hóa age); bộ khôi phục chỉ bắt buộc mật khẩu repo `server`.

## Hệ quả

- Purge account = `restic forget` toàn bộ + xóa repo account (từ CLI khi đích bất biến), không đụng account khác.
- Thêm bảng `backup_repositories`, `backup_policy_destinations`; bỏ `hosting_account_id`, `restic_password_encrypted` khỏi `backup_destinations` (chưa có dữ liệu thật: bảng backup chỉ được tạo ở migration Phase 8).
- Kiểm thử: pattern đường dẫn/tag/snapshot id (vector độc), ràng buộc DB (`database/tests/70_backup.sql`), golden argv/env không chứa bí mật (Phase 8.2).
