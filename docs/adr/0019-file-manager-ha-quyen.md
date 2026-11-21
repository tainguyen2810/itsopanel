# ADR 0019: File Manager chạy dưới uid account, openat2 và nén/giải nén an toàn

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 6)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-72, D-63, 06 §5

## Bối cảnh

File Manager là bề mặt tấn công lớn nhất của panel (11-ROADMAP): người dùng chọn đường dẫn, tạo symlink, tải lên file nén tùy ý. Agent chạy root; một lỗi resolve đường dẫn là đọc/ghi được `/etc/shadow` hay file của account khác. Các lớp tấn công: path traversal (`../`, đường dẫn tuyệt đối, NUL), symlink trỏ ra ngoài, symlink đổi giữa lúc kiểm và lúc dùng (TOCTOU), zip slip, zip bomb, file nén chứa symlink/hardlink/thiết bị/setuid.

## Quyết định

1. **Không bao giờ thao tác file trong home bằng root.** Mọi op `fs.*` (và phần file của `db.*.dump/import`) chạy trong **tiến trình helper**: agent exec lại chính nó (`/proc/self/exe fs-helper`) với `SysProcAttr.Credential{Uid, Gid, Groups: []}` của account, `Setsid`, env rỗng; helper bật `PR_SET_NO_NEW_PRIVS` rồi mới xử lý. Yêu cầu/kết quả là một JSON qua stdin/stdout. Tiến trình root chỉ chuẩn bị tham số đã validate.
2. **Resolve đường dẫn bằng kernel:** helper mở home (`/home/<user>`) với `O_PATH|O_DIRECTORY|O_NOFOLLOW`, kiểm owner/uid khớp, rồi mọi đường dẫn mở bằng `openat2(home_fd, rel, RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)`. Symlink bên trong home được đi theo nếu đích vẫn trong home; thoát ra ngoài → `EXDEV` → `path_outside_home`. Kernel thiếu `openat2` (< 5.6) → op từ chối (Ubuntu 24.04: 6.8). Đường dẫn còn được validate trước theo `RelPath` (không tuyệt đối, không `..`, không ký tự điều khiển).
3. **Thao tác trên fd:** đổi tên/xóa dùng `renameat2`/`unlinkat` trên fd thư mục cha đã mở bằng `openat2`; thành phần cuối không đi theo symlink (`O_NOFOLLOW`, `AT_SYMLINK_NOFOLLOW`) — xóa symlink là xóa link, không xóa đích. Ghi file: tạo file tạm trong cùng thư mục (`O_CREAT|O_EXCL`), ghi, `fsync`, `renameat`. `if_sha256` khác nội dung hiện tại → `precondition_failed` (409 ở API). `chmod` chỉ nhận `0[0-7]{3}` và không bao giờ đặt bit setuid/setgid/sticky.
4. **Nén/giải nén viết bằng Go** (`archive/zip`, `archive/tar` + `compress/gzip`), không gọi `unzip`/`tar` hệ thống:
   - chỉ tạo file thường và thư mục; bỏ qua symlink, hardlink, thiết bị, FIFO (đếm vào `skipped`);
   - mode giữ 0o777 & mode (xóa setuid/setgid/sticky);
   - mỗi mục ghi qua `openat2` dưới thư mục đích → zip slip không thoát được dù tên có `../`;
   - giới hạn `max_entries`, `max_total_bytes` đếm theo byte **thực sự giải ra** (không tin header), tỉ lệ nén tối đa 100:1 mỗi mục;
   - giải nén vào thư mục tạm `.itso-extract-<rand>` trong thư mục đích, thành công mới đổi tên từng mục; lỗi thì xóa thư mục tạm.
5. **Upload resumable (kiểu tus):** Laravel nhận chunk ≤ 8 MiB (PATCH, `Content-Range` phải bắt đầu đúng tại `received`, sai → 409) vào staging `/var/lib/itso/uploads/<upload_uuid>.part` (user `itso`, 0700; phiên 24 giờ, dọn bằng scheduler). Chunk cuối tạo job `file.upload` → op `fs.upload.commit`: agent mở file staging bằng `O_RDONLY|O_NOFOLLOW` trong thư mục staging cố định, kiểm kích thước, truyền fd cho helper (ExtraFiles); helper ghi vào home như mục 3 và trả sha256. Quota kernel áp đúng uid vì helper là người ghi.
6. **Tải về:** `fs.read` có `offset`; Laravel stream từng khúc 1 MiB (URL ký số hạn 5 phút + phiên đăng nhập). Editor mở file ≤ 2 MiB, ETag = sha256 cả file.
7. **Nhật ký:** mỗi thao tác ghi `file_operations` (op, đường dẫn, kết quả) và audit; không ghi nội dung file.

## Hệ quả

- Lỗi logic trong panel hay agent vẫn bị kernel chặn ở hai lớp: uid của helper (quyền Unix) và `RESOLVE_BENEATH`.
- Test tấn công chạy thật trên kernel container (openat2 có sẵn) với thư mục tạm; phần đổi uid thật và quota: VM.
- Cần review bảo mật riêng (`docs/security/file-manager-review.md`, Prompt 6.6).
