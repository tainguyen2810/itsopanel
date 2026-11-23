# ADR 0056: Tách helper đặc quyền — đánh giá

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-111, D-13, `docs/planning/06-AGENT-SECURITY.md`

## Đánh giá

- Agent root có 160+ op; op thật sự cần root: tạo user/slice/quota, nginx/php-fpm/sshd/nftables, apt, restic toàn máy, cert vào `/etc`. Op dữ liệu account đã hạ quyền (`setresuid` sang UID account) từ Phase 6.
- Tách helper (agent không đặc quyền + helper root nhỏ qua socket riêng) là thay đổi kiến trúc lớn: mọi op phải phân loại lại, hai lớp xác thực, hai gói cập nhật.

## Quyết định

1. **v1.0 giữ một agent root**, siết thêm bằng systemd sandboxing trong unit `itso-agent.service`: `ProtectSystem=strict` + `ReadWritePaths` theo nhu cầu (`/etc/nginx /etc/php /etc/ssh/sshd_config.d /etc/nftables.d /etc/itso /home /var/lib/itso /var/log/itso /srv /etc/letsencrypt /etc/systemd/system` …), `ProtectKernelModules=yes`, `ProtectKernelTunables=` chỉ khi không cần sysctl, `ProtectClock=yes`, `ProtectHostname=yes`, `LockPersonality=yes`, `RestrictRealtime=yes`, `RestrictSUIDSGID=` (không bật: cần tạo file setgid cho thư mục site), `SystemCallArchitectures=native`, `SystemCallFilter=@system-service @mount @privileged` kèm `~@obsolete`.
2. Tiêu chí: `systemd-analyze security itso-agent` **≤ 5.0** (agent root quản trị máy không thể xuống mức dịch vụ thường). Policy op cục bộ (`/etc/itso/agent-policy.yaml`) giữ nguyên.

## Số liệu đo (12.4)

`systemd-analyze security --offline=yes` (systemd 255), kiểm tự động trong `make units-check`:

| Unit | Trước 12.4 | Sau 12.4 |
|---|---|---|
| `itso-agent.service` | 6.1 MEDIUM | **4.9 OK** |
| `itso-agent-node.service` | 6.1 MEDIUM | **4.9 OK** |

Đã thêm: `SystemCallFilter=~@reboot @swap @module @raw-io @clock @obsolete`, `CapabilityBoundingSet=~` 16 capability không op nào
cần (SYS_MODULE, SYS_BOOT, SYS_TIME, SYS_RAWIO, BPF, MKNOD…), `ProtectHostname`, `KeyringMode=private`. Không bật
`ProtectSystem=strict` ở v1.0: op `software.*` (apt) ghi `/usr`, `/var/lib/dpkg`; danh sách `ReadWritePaths` đủ cho apt gần
như bằng không bảo vệ. Giữ CAP_SYS_ADMIN (quota, mount), CAP_SYS_CHROOT (terminal jail), CAP_LINUX_IMMUTABLE (repo backup), CAP_NET_ADMIN (nftables).
Chạy thật mọi op trên VM với unit mới: chờ VM (`tests/vm/phase4–11.sh` + Gate 12.8).
3. Lộ trình v1.x: tách helper cho nhóm op hệ thống (apt, nftables, sshd) trước; ghi điểm tách trong `06-AGENT-SECURITY.md`.
