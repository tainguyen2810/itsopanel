# ADR 0013: Lớp nền tảng của agent (Runner, FS, sandbox)

- **Trạng thái:** Accepted (2026-11-21, cùng Phase 4)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-13, D-63

## Bối cảnh

Agent chạy root và là ranh giới đặc quyền duy nhất (`06-AGENT-SECURITY.md`). Op của Phase 4 phải gọi công cụ hệ thống (`useradd`, `usermod`, `systemctl`, `setquota`, `apt-get`…) và ghi file cấu hình. Cần: (1) một chỗ duy nhất kiểm soát lệnh nào được chạy và chạy thế nào; (2) test được mọi op mà không cần root, VM hay systemd (môi trường CI và container cloud không có).

## Quyết định

1. `internal/platform.Runner`: `Run(ctx, Cmd{Bin, Args, Stdin, Env})`.
   - `Bin` là **tên logic** tra trong bảng cố định → đường dẫn tuyệt đối (`useradd` → `/usr/sbin/useradd`); tên ngoài bảng bị từ chối. Bảng không có `sh`, `bash`, `dash`, `env`, `sudo`, `su`.
   - Argv truyền nguyên mảng cho `exec.CommandContext`, không qua shell; env tối giản (`PATH` cố định, `LANG=C.UTF-8`); timeout theo ctx; stdout/stderr giới hạn 1 MiB.
   - Giá trị argv đã qua `internal/validate` trước khi tới Runner; Runner kiểm lại không có NUL/xuống dòng.
2. `internal/platform.FS`: mọi đường dẫn hệ thống tính từ gốc cấu hình được (`--root`, mặc định `/`). Ghi file: file tạm cùng thư mục → `fsync` → `rename` (atomic), mở với `O_NOFOLLOW`; tạo thư mục, chown, chmod qua fd. Không bao giờ thao tác file trong home của account bằng quyền root theo đường dẫn do người dùng kiểm soát.
3. Hai bản: `ubuntu2404` (máy thật) và `fake` (ghi lại argv, trả kết quả lập trình sẵn, gốc là thư mục tạm). Test golden so sánh argv + file sinh ra. Agent thật có cờ `--sandbox` dùng `fake` để chạy stack dev/e2e với transport, HMAC, policy, audit thật.
4. `scripts/check-no-exec.sh` mở rộng: trong `agent/` chỉ `internal/platform` được import `os/exec`.

## Hệ quả

- Tích cực: mọi lệnh hệ thống nằm ở một bảng nhỏ để review bảo mật; op test được trên CI; chế độ sandbox cho e2e.
- Đánh đổi: golden test không chứng minh lệnh đúng trên máy thật → bảng test VM (`tests/vm/`) là bằng chứng bắt buộc trước khi cài lên server thật.
