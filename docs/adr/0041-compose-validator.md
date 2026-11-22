# ADR 0041: Validator compose và override của Super Admin

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 10)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-96, D-97, D-94

## Quyết định

1. **Nguồn sự thật là validator Go trong agent** (op `compose.validate`, chỉ đọc). Panel gọi đồng bộ khi bấm Kiểm tra (`POST /compose-projects:validate`) và gọi lại trong job trước khi apply; không có đường chạy YAML chưa qua validator.
2. **Rule chặn** (mã rule ổn định, `overridable` cố định trong agent):
   - SA được ghi đè: `privileged`, `cap_add` (ngoài NET_BIND_SERVICE, CHOWN, SETUID, SETGID), `devices`, `bind_mount` (thư mục host thường).
   - Không ghi đè: `host_network`, `host_pid`, `host_ipc`, `host_userns`, `security_opt` (tắt seccomp/apparmor), `docker_socket`, `bind_mount_system` (`/`, `/etc`, `/proc`, `/sys`, `/root`, `/boot`, `/dev`, `/var/lib/docker`; `/home` với ADMIN), `build`, `services`, `yaml`, `reserved_port` (22, 80, 443, cổng panel).
3. **Viết lại** (`rewrites`): `ports` → `127.0.0.1:<cổng cấp>:<cổng container>` (ADR 0042); thiếu `mem_limit`/`cpus`/`pids_limit` → thêm mặc định server; thêm nhãn `io.itso.project=<uuid>`. Cảnh báo (`warning`) không chặn.
4. **Override:** chỉ SUPER_ADMIN, từng rule, lý do 10–300 ký tự, lưu cùng revision (`overrides[]` có người và thời điểm) và ghi audit `compose.override`. ADMIN gửi override → 403.
5. **Revision bất biến:** mỗi lần lưu tạo revision mới (YAML gốc, YAML đã validate, số lỗi/override, người tạo). Apply = ghi YAML đã validate + `compose up -d --remove-orphans`. Panel hiển thị diff giữa revision.

## Hệ quả

- Lỗi trả `compose_rejected` kèm danh sách finding; panel trả 422 khi tạo/sửa còn lỗi chặn.
- Vector độc mới trong `contracts/agent-ops/evil-inputs` (privileged, host network, bind `/`, tên project/volume/image lạ).
