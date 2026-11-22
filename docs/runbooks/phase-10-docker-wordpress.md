# Runbook Phase 10: Docker, WordPress, Software

Vận hành Docker Manager, WordPress Toolkit và Software Manager (Phase 10, D-94 → D-100). Quyết định thiết kế ở ADR
0039–0045, review bảo mật ở `docs/security/docker-wordpress-review.md`.

## 1. Bật Docker trên một máy chủ

Docker tắt ở **hai lớp**, cần bật cả hai:

1. **Chính sách cục bộ của agent** (root, trên chính máy chủ đó; panel bị chiếm cũng không bật được):

   ```bash
   sudo itso policy set docker on
   sudo systemctl restart itso-agent        # node: itso-agent-node
   ```

   Chưa bật thì job "Bật Docker" lỗi `op_disabled` ("op docker.host.configure bị tắt bởi chính sách cục bộ").
2. **Trong panel:** Máy chủ → Docker → "Bật Docker" (SUPER_ADMIN + step-up). Job cài recipe `docker` (bản Ubuntu),
   ghi `/etc/docker/daemon.json` (log giới hạn, `no-new-privileges`, `userland-proxy=false`), gỡ mọi thành viên nhóm
   `docker`, dựng chuỗi `DOCKER-USER`.

Tắt lại: `sudo itso policy set docker off` + restart agent (container đang chạy vẫn chạy; panel không điều khiển được nữa).

## 2. Cổng và tường lửa

- Panel cấp cổng host trong dải `20000–29999`, chỉ bind `127.0.0.1`; website loại `docker` proxy tới cổng đó.
- Container ai đó chạy tay với `-p 0.0.0.0:…` bị `DOCKER-USER` chặn từ bên ngoài. Muốn mở thật: Máy chủ → Tường lửa →
  rule `scope=docker` (accept, in, tcp/udp, cổng) → "Đồng bộ tường lửa Docker".

## 3. WordPress

| Việc | Cách |
|---|---|
| Cài | WordPress → "Cài WordPress" (website PHP, panel tạo DB + user theo gói). Mật khẩu quản trị hiện **một lần** |
| Phát hiện site có sẵn | "Quét" (wp.detect theo docroot các website PHP). Site quét được chưa biết user admin nên không đổi mật khẩu được từ panel |
| Cập nhật | Chọn core/plugin/theme → "Cập nhật". Luôn snapshot `pre-wp-update` trước; lỗi thì tự khôi phục file + DB (lịch sử ghi `rolled_back`). Cần có đích backup; quota backup tạm dừng thì bị từ chối |
| Tự cập nhật | Tab Tổng quan: `off`/`minor`/`all` + cửa sổ giờ (giờ máy chủ, qua nửa đêm được). Scheduler chạy `itso:wordpress-auto-update` phút 05 mỗi giờ; làm mới thông tin `--refresh` lúc 01:37 |
| Staging | "Tạo bản staging" → `<sub>.<domain>`, tính vào hạn mức website + DB của gói, mặc định noindex. Basic auth **chưa có** |
| Hardening | Tab Bảo mật: 6 mục; chặn xmlrpc/PHP trong uploads áp ở vhost nginx, salt không hoàn tác được |

**Bản lỗi sau khôi phục:** `~/sites/<domain>.restore-<ts>` giữ để điều tra, xóa tay qua File Manager khi xong.

## 4. Software Manager

Máy chủ → Phần mềm (chỉ SUPER_ADMIN cài/gỡ). PHP nhiều bản song song (8.1–8.4; bản không có trong Ubuntu cài từ PPA
ondrej/php, khóa ghim). Gỡ bị chặn khi đang dùng (website dùng bản PHP đó, compose project khi gỡ Docker, phụ thuộc);
gói lõi không gỡ được. Tự cập nhật OS: chỉ bản bảo mật, **không tự reboot**.

## 5. Chạy thử

- Dev: `ITSO_ACME_EMAIL=ops@itso.local make dev` (sandbox tự thêm `docker: true` vào `.dev/agent-sandbox/policy.yaml`,
  Engine Docker giả, WP-CLI mô phỏng), seed `DemoSeeder`, rồi
  `pnpm -C apps/web exec playwright test -c playwright.real.config.ts e2e-real/phase10.spec.ts`.
  Lỗi giả lập bật qua file điều khiển dưới gốc sandbox (`var/lib/itso-sandbox/{wp,docker}-control.json`), chỉ sandbox đọc.
- VM: `tests/vm/phase10.sh` (V0–V6), xem `tests/vm/README.md`.
