# 08 — Backup & Recovery

## 1. Engine: Restic (giữ nguyên đề xuất)
| Ưu | Nhược / cách xử lý |
|---|---|
| Mã hóa mặc định (AES-256 + Poly1305), dedupe, incremental, nhiều backend (local, SFTP, S3, rest-server), binary Go đơn | Không có immutability nội tại → dùng rest-server `--append-only` hoặc S3 Object Lock |
| `--stdin` cho DB dump không cần file tạm | `prune` tốn RAM/IO với repo lớn → chạy trong `itso-maintenance.slice`, lịch thưa |
| Restore chọn lọc theo path | Mỗi repo một mật khẩu → quản lý khóa cẩn thận |

Agent gọi binary `restic` (version pin, kèm trong release) với biến môi trường truyền qua file tạm 0600, không qua argv.

## 2. Tổ chức repository
- **Một repo restic cho mỗi (server, destination)**, phân biệt bằng tag: `server:<uuid>`, `account:<uuid>`, `website:<uuid>`, `db:<uuid>`, `type:files|db|config|volume`. Dedupe tốt hơn nhiều repo nhỏ.
- Mật khẩu repo mã hóa trong `backup_destinations.restic_password_encrypted` **và** in ra cho SA lưu offline khi tạo (wizard bắt buộc xác nhận đã lưu) — mất panel vẫn khôi phục được.
- USER chỉ thấy snapshot có tag account của mình (lọc ở panel; restore qua agent kiểm tra tag).

## 3. Phạm vi backup
| Loại | Cách lấy nhất quán |
|---|---|
| File website | `restic backup /home/<acct>/sites/<domain>` (đọc với quyền root qua agent, exclude cache/tmp) |
| MySQL/MariaDB | `mysqldump --single-transaction --routines --triggers --events` (InnoDB nhất quán, không khóa) → `restic backup --stdin --stdin-filename db/<name>.sql`; DB lớn (> vài GB): `mariadb-backup`/`xtrabackup` vào staging rồi backup (P1) |
| PostgreSQL | `pg_dump -Fc` (snapshot nhất quán) → stdin |
| Cấu hình server | `/etc/itso`, `/etc/nginx`, `/etc/php`, `/etc/ssh/sshd_config.d`, nft ruleset, crontabs/timers, danh sách package |
| Cấu hình panel | `pg_dump` cluster `itso` + `/etc/itso` + `/var/lib/itso/keys` (**mã hóa thêm** bằng khóa riêng do SA giữ) |
| Docker volume | (1) Hook ứng dụng nếu có (dump DB trong container); (2) nếu không: `docker compose stop` → backup volume → start (downtime ngắn, chọn được); (3) filesystem snapshot (LVM/ZFS) — P2 |

## 4. Nguyên tắc 3-2-1-1-0
| Số | Ý nghĩa | Thực hiện |
|---|---|---|
| 3 | 3 bản dữ liệu | Dữ liệu gốc + local repo + remote repo |
| 2 | 2 loại phương tiện | Disk local (khác phân vùng nếu có) + NAS/SFTP hoặc S3 |
| 1 | 1 bản off-site | S3-compatible hoặc NAS ở site khác |
| 1 | 1 bản immutable/offline | rest-server `--append-only` hoặc S3 Object Lock (Compliance mode, N ngày) |
| 0 | 0 lỗi khi kiểm chứng | `restic check --read-data-subset=5%` hàng tuần + **restore test tự động** hàng tháng (khôi phục 1 site + 1 DB vào sandbox, kiểm tra checksum/HTTP 200) |

Security Center hiển thị trạng thái 3-2-1-1-0 như một checklist.

## 5. Immutable — panel không thể xóa toàn bộ backup
- **Credential tách biệt:** panel/agent chỉ giữ credential **ghi** (append-only rest-server user, hoặc S3 key không có `s3:DeleteObject`/`PutBucketObjectLockConfiguration`, bucket bật Object Lock).
- **Prune/forget** chạy bằng một trong hai cách: (a) trên chính máy lưu trữ (rest-server host) bằng cron của admin lưu trữ; (b) credential prune lưu **ngoài panel** — SA nhập mỗi lần khi chạy `itso backup prune` trên server (không lưu). Với S3 Object Lock, ngay cả credential prune cũng không xóa được object trước hạn khóa.
- Retention trong panel = "mong muốn"; thực thi xóa nằm ngoài tầm panel → ransomware chiếm panel không xóa được backup.
- Local repo không immutable (chấp nhận, chỉ để restore nhanh).

## 6. Restore
| Loại | Luồng |
|---|---|
| Website | Restore vào `sites/<domain>.restore-<ts>` (staging) → kiểm tra → backup "pre-restore" bản hiện tại → swap nguyên tử (rename) → reload |
| Database | Mặc định restore vào **DB mới** `<name>_restore_<ts>`; ghi đè cần step-up MFA + pre-restore dump |
| File đơn lẻ | Browse snapshot (`restic ls`) → restore vào `backups/restore-<ts>/` |
| Cross-server | Snapshot trên destination dùng chung → agent server đích đọc repo (cần mật khẩu repo) → tạo account/site mới theo metadata trong snapshot (`itso-meta.json` được backup kèm) |
| Disaster recovery | Server mới → `install.sh --restore` → nhập destination + mật khẩu repo + khóa panel → khôi phục DB panel → `itso repair` re-apply desired state → restore dữ liệu từng account (song song có giới hạn) → runbook `docs/runbooks/disaster-recovery.md` |

## 7. Lịch & tài nguyên
- Mặc định: file hằng ngày, DB mỗi 6 giờ (tùy gói), config hằng ngày, check hàng tuần, restore test hàng tháng.
- Chạy trong `itso-maintenance.slice` (CPUQuota 50%, IOWeight 10) + jitter để không đồng loạt.
- Khóa: một backup/repo tại một thời điểm (restic lock + Redis lock).

## 8. Kiểm thử
- Integration trên VM: backup → xóa site → restore → so checksum; DB restore → so row count + checksum bảng.
- Mất mạng giữa chừng → snapshot không hoàn chỉnh không được ghi nhận; lần sau chạy tiếp.
- Thử xóa snapshot bằng credential của panel trên rest-server append-only → phải thất bại.
- Diễn tập DR đầy đủ là điều kiện nghiệm thu Phase 8.
