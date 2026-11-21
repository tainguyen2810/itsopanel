# Review bảo mật File Manager (Phase 6, Prompt 6.6)

- **Ngày:** 2026-11-21 · **Phạm vi:** File Manager của account hosting (Laravel `FileService`/`FileController`, agent `fs.*`, `itso-fs-helper`/`internal/fsx`), upload resumable, link tải xuống, nén/giải nén, và các đường gián tiếp tới file của account (import/export DB, FTP phụ, SFTP, cron, terminal).
- **Quyết định liên quan:** D-72 (File Manager hạ quyền), D-73 (SFTP/FTPS), D-74 (cron), D-75 (terminal), ADR 0019–0022, threat model `docs/security/threat-model.md`.
- **Cách review:** đọc code theo từng đường vào; đối chiếu với test tự động hiện có; ghi phần **chờ VM** cho những gì chỉ kernel thật kiểm được (`tests/vm/phase6.sh`).

## 1. Kiến trúc và ranh giới tin cậy

```text
Trình duyệt ──HTTPS──► Laravel (user itso, không chạy lệnh) ──HMAC/unix socket──► itso-agent (root)
                                                                                     │ fork itso-fs-helper
                                                                                     ▼ setuid/setgid = uid account
                                                                         internal/fsx: openat2 từ fd của home
```

1. **Laravel** chỉ nhận đường dẫn tương đối (`DataSpec::relPath`: không rỗng, không `/` đầu/cuối, không `.`/`..`, không ký tự điều khiển, UTF-8, ≤ 4096 byte, mỗi đoạn ≤ 255). Phạm vi account: admin theo quyền `files.*` + phạm vi server/account, portal chỉ account của chủ (404 nếu không thấy).
2. **Agent** validate lại params bằng JSON Schema (`RelPath`) rồi gọi helper; không có op chạy lệnh tùy ý, không `sh -c`.
3. **Helper** chạy dưới **uid/gid của account** (không phải root). Mọi đường dẫn được kernel resolve bằng `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)` từ fd `O_PATH` của home. Thành phần cuối mở `O_NOFOLLOW` khi đổi tên/xóa/chmod. Ghi file qua file tạm `O_CREAT|O_EXCL|O_NOFOLLOW` rồi `renameat`.

Hai lớp độc lập: kể cả khi `fsx` có lỗi resolve, tiến trình vẫn chỉ có quyền của account (không đọc được `/etc/shadow`, home account khác 0750 root:<group riêng>).

## 2. Các mối đe dọa và biện pháp

| # | Tấn công | Biện pháp | Kiểm bằng |
|---|---|---|---|
| T1 | `../`, đường dẫn tuyệt đối, NUL/ký tự điều khiển trong `path` | `relPath` (Laravel) → `RelPath` schema (agent) → `openat2 RESOLVE_BENEATH` (kernel) | Pest `Phase6/DataTest` (422), Go `fsx_test`, evil-inputs 155 vector; e2e Portal `../../etc` → 422; **VM S1** |
| T2 | Symlink do account tự tạo trỏ ra `/etc` hoặc home account khác (đọc, liệt kê, ghi qua thư mục symlink, chmod qua symlink) | `RESOLVE_BENEATH` chặn symlink tuyệt đối/thoát gốc; `O_NOFOLLOW` ở thành phần cuối; uid account | Go `fsx_test` (symlink ngoài, symlink đổi giữa chừng); **VM S1** |
| T3 | Đổi symlink giữa lúc kiểm và lúc mở (TOCTOU) | Không có bước "kiểm rồi mở": mỗi lần mở là một `openat2` từ fd gốc; `EAGAIN` khi rename đồng thời → thử lại có giới hạn | Go `fsx_test` |
| T4 | Hardlink tới file nhạy cảm rồi đọc qua File Manager | `fs.protected_hardlinks=1` (mặc định Ubuntu) + uid account không có quyền đọc file đích | **VM S1** |
| T5 | Zip slip (`../` hoặc tên tuyệt đối trong archive), symlink/hardlink/thiết bị trong archive, zip bomb | `cleanName` từ chối tên xấu; chỉ giải file thường + thư mục; `MaxRatio` cho mỗi mục; `max_total_bytes` (mặc định 4 GiB) + `max_entries`; giải vào thư mục tạm trong target rồi mới đổi tên | Go `archive` test; **VM S1** (archive có `../../../tmp/…` và symlink tới `/etc/shadow`) |
| T6 | Nén để đọc file ngoài home (đưa symlink vào archive) | `Archive` bỏ qua symlink, mở mục bằng `O_NOFOLLOW` | Go `archive` test |
| T7 | Upload ghi đè file của người khác / phiên upload của người khác | Phiên gắn **account + user tạo** (404 nếu khác); `overwrite` phải bật rõ; commit qua helper uid account | Pest `DataTest` (phiên của user khác → 404) |
| T8 | Staging upload bị thay bằng symlink/thiết bị (đọc file root khi commit) | Agent (root) mở `/var/lib/itso/uploads/<uuid>.part` với `O_NOFOLLOW`, phải là file thường đúng kích thước, rồi chuyển fd cho helper; thư mục staging 0700 của panel | Go `fs` test; **VM S5** |
| T9 | Chunk sai thứ tự, gửi lặp, vượt kích thước | Content-Range bắt buộc; sai offset → 409 kèm `errors.received`; vượt `size` → 422; quota đĩa kiểm khi tạo phiên | Pest `DataTest`, Vitest `upload.test.ts`, e2e stack thật (gửi lặp → 409, gửi tiếp → completed) |
| T10 | Link tải xuống bị dùng lại/chia sẻ | HMAC-SHA256 (`app.key`) trên account + path + hạn + **user id**, hạn 5 phút, so sánh `hash_equals`; vẫn cần phiên đăng nhập của realm; audit `file.download` | Pest `DataTest`; e2e (chữ ký sai → 403) |
| T11 | XSS/MIME sniffing qua file tải về | `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` (tên an toàn + fallback ASCII), `Cache-Control: no-store` | Pest `DataTest` |
| T12 | Sửa file đè thay đổi của người khác | ETag (sha256) + `If-Match`; khác → 412; giới hạn sửa trực tuyến 2 MiB | Pest `DataTest`, e2e (sửa → nội dung khớp) |
| T13 | Vượt quota bằng giải nén / FTP / import | Quota đĩa + inode của account áp ở kernel (Phase 4), file luôn thuộc uid account (FTP phụ ghi bằng uid account, export DB qua helper) | **VM S3, S5, S6**; Phase 4 enforcement |
| T14 | Đọc file account khác qua đường gián tiếp: import DB từ đường dẫn, cron, terminal | Import đọc nguồn bằng helper uid account (`cat`), chạy `mariadb --user=<account>` dưới uid account (grant chỉ `prefix\_%`); cron/terminal chạy uid account trong slice, terminal trong jail `ProtectSystem=strict`, `ProtectHome=tmpfs` + bind home | Pest; Go golden argv; **VM S4, S6, S7** |
| T15 | Lộ bí mật qua job/log | Params job chỉ giữ `{"$secret": …}`; `AuditLogger::redact` che khóa bí mật | Pest; **đã sửa ở 6.6:** `null` bị đổi thành chuỗi `[REDACTED]` và gửi cho agent làm mật khẩu (xem §4) |

## 3. Kết quả

- Không tìm thấy đường đọc/ghi ra ngoài home trong code. Hai lớp (resolve trong kernel + uid account) đều có test tự động ở tầng Go với filesystem thật của container (không cần root cho phần `openat2`).
- Những gì **chỉ kernel thật kiểm được** (hardlink protection, quyền home 0750 giữa hai account thật, slice systemd, chroot OpenSSH, TLS Pure-FTPd, jail `systemd-run`) nằm trong `tests/vm/phase6.sh` S1–S7: **chờ VM**.

## 4. Lỗi tìm thấy khi review và e2e (đã sửa ở 6.6)

| Lỗi | Ảnh hưởng | Sửa |
|---|---|---|
| `AuditLogger::redact` đổi giá trị `null` của khóa bí mật (`password`) thành chuỗi `[REDACTED]`; JobRunner gửi bản đã che cho agent | Tạm khóa account có FTP phụ: `ftp.user.ensure` nhận mật khẩu "[REDACTED]" → job lỗi (schema yêu cầu ≥ 12 ký tự). Nếu schema cho phép, FTP phụ sẽ có mật khẩu ai cũng đoán được | Bỏ qua `null` khi che; Pest kiểm agent nhận `password: null` |
| Laravel nhận khóa SSH base64 thiếu padding (PHP `base64_decode` strict vẫn chấp nhận), agent (Go `StdEncoding`) từ chối | Khóa lưu ở panel nhưng job lỗi, bản ghi bị gỡ | So khớp `base64_encode(decode) === input` |
| Uploader báo "Xong" trước khi job `fs.upload.commit` ghi file | Người dùng thấy xong nhưng file chưa có / commit lỗi không được báo | Chờ trạng thái `completed`, lỗi commit hiện thông báo riêng |

## 5. Rủi ro còn lại / đề xuất

1. **MariaDB `GRANT ALL ON prefix\_%`:** owner account tạo được DB mới khớp prefix ngoài panel → vượt `db_limit` (không vượt quyền sang account khác). Đề xuất Phase 7: `itso:reconcile` phát hiện DB lạ + cảnh báo.
2. **Phiên terminal ghi nhận gần đúng** tới khi có op `pty.list` (Phase 7); agent vẫn giới hạn 2 phiên/account.
3. **Staging upload** nằm trên cùng filesystem với `/var/lib/itso`: upload đồng thời lớn có thể đầy đĩa panel trước khi quota account áp. Phiên hết hạn sau 24 giờ (không nhận chunk nữa) và mỗi user chỉ có số phiên đang mở giới hạn, nhưng **chưa có lệnh dọn file staging của phiên hết hạn hoặc bị bỏ dở**. Đề xuất Phase 7: `itso:uploads-prune` hằng giờ + giới hạn tổng dung lượng staging.
4. Kiểm thử trên kernel thật (S1–S7) **chưa chạy** vì container cloud không có KVM/systemd.
