# ADR 0031: Nội dung backup, dump DB nhất quán, backup panel mã hóa age

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng Phase 8)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-84, D-71, D-15

## Quyết định

1. **File (`kind=files`):** agent chạy `restic backup` bằng root trên danh sách cố định trong home account: `sites/`, `backups/`, các file/thư mục còn lại của home trừ loại trừ cố định (`tmp/`, `.cache/`, `**/cache/`, session PHP, `logs/` cũ, `.trash/`) cộng `excludes` của policy (≤ 50 mẫu tương đối, `BackupExclude`; truyền dạng `--exclude=<mẫu>`). `--one-file-system`, restic lưu symlink như symlink (không theo). `kind=files` + `site_dir` = chỉ một website.
2. **Database (`kind=db`):** dump dưới uid account bằng danh tính chủ DB (D-71): MariaDB `mariadb-dump --single-transaction --routines --triggers --events --hex-blob`, PostgreSQL `pg_dump -Fc`. Stdout pipe thẳng vào `restic backup --stdin --stdin-filename db/<tên>.sql|.dump` (không ghi file tạm). Dump lỗi → op lỗi, không tạo snapshot dở (agent hủy restic khi dump trả mã khác 0).
3. **Cấu hình máy chủ (`kind=config`, repo server):** `/etc/itso`, `/etc/nginx`, `/etc/php`, `/etc/ssh/sshd_config.d`, `/etc/nftables.d/itso*`, unit `/etc/systemd/system/itso*`, `/etc/pure-ftpd`, cộng danh sách gói (`dpkg-query`) ghi vào `itso-meta.json`.
4. **Panel (`kind=panel`, repo server):** `pg_dump -Fc itso` + `/etc/itso` (gồm khóa ký, khóa HMAC agent) → tar → **mã hóa age** tới khóa công khai X25519 của panel (`age_recipient`) → `restic backup --stdin --stdin-filename panel/itso-panel.tar.age`. Khóa riêng age sinh lúc tạo đích đầu tiên, **không lưu ở máy chủ**: chỉ nằm trong bộ khôi phục (ADR 0029). Thư viện `filippo.io/age` trong agent, không gọi lệnh ngoài.
5. **Tài nguyên:** mọi tiến trình restic/dump chạy bằng `systemd-run --wait --pipe --collect --slice=itso-maint.slice -p CPUQuota=50% -p IOWeight=10 -p Nice=10` (ở sandbox chạy trực tiếp).

## Hệ quả

- DB nhất quán không khóa bảng (InnoDB/MVCC); bảng MyISAM chỉ nhất quán từng bảng (ghi trong runbook).
- Panel bị chiếm vẫn tạo được backup panel mới nhưng **không đọc được bản cũ** (không có khóa riêng).
- Mất bộ khôi phục = mất khả năng khôi phục panel từ backup (account vẫn khôi phục được bằng mật khẩu repo trong bộ khôi phục nếu SA lưu đủ).
