# Báo cáo Phase 10: Docker Manager, WordPress Toolkit, Software Manager

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM, **chờ duyệt**. Nhánh `phase-10`, merge `--no-ff` vào `main` ở Git local (không push, không remote). Phase 10 không có mốc phát hành (mốc kế tiếp `v0.5.0-beta` sau Phase 11). Tiêu chí cần Docker daemon, iptables, PHP/MariaDB và WordPress thật được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`tests/vm/phase10.sh`, V0–V6).
- **Thời gian:** 2026-11-22, chạy liền 10.0 → 10.8 theo lựa chọn "Bắt đầu Phase 10".
- **Cách làm:** mockup trước (10.0, ảnh `docs/screenshots/phase-10/`) → ADR + contracts → Software Manager → agent Docker → panel Docker → agent WordPress → panel WordPress → UI nối API thật → tích hợp. Container không có Docker daemon, PHP và WordPress thật: agent sandbox dùng Engine Docker giả (theo API 1.43) và WP-CLI mô phỏng, còn restic 0.16.4 là thật.
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Agent không có op chạy lệnh tùy ý, không `sh -c`; WP-CLI chạy dưới uid account trong slice của account; chỉ agent nói chuyện với Docker socket, nhóm `docker` luôn rỗng; Docker tắt mặc định ở chính sách cục bộ của agent. Bí mật (mật khẩu registry, env compose, mật khẩu admin WordPress) chỉ qua tham chiếu, không vào job params/log/audit. USER không có đường nào tới Docker. Billing/WooCommerce/thanh toán: OUT OF SCOPE; Public Provisioning API: DEFERRED.
- **Quyết định:** D-94 → D-100, ADR 0039 → 0045 (Accepted ở 10.1).

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 10.0 Mockup | Software catalog theo nhóm (xung đột, phụ thuộc, gỡ bị chặn kèm lý do, PPA), Docker host/image/volume, compose với validator mô phỏng + override chỉ SA + revision/diff, website `docker`, registry, backup volume, trang chi tiết WordPress dùng chung Admin/Portal; 68 ảnh | 9549752 |
| 10.1 Contracts | ADR 0039–0045; 41 op agent Phase 10 có schema, 5 mã lỗi, 69 vector độc; OpenAPI; DBML 12 bảng + migration Phase 10 | 8b59ac4 |
| 10.2 Software | Catalog agent 22 recipe, PPA ondrej/php khóa ghim, wp-cli sha512, upgrade, unattended-upgrades không reboot; panel chặn xung đột/phụ thuộc/đang dùng | eff7652 |
| 10.3 Agent Docker | Client Engine API qua unix socket, validator compose (D-96), viết lại cổng `127.0.0.1:20000–29999`, DOCKER-USER qua iptables-restore, validate → apply theo sha256, cập nhật image có rollback tự động, backup/khôi phục volume bằng restic | 536d6d4 |
| 10.4 Panel Docker | Quyền `docker.read/write/manage`, bật Docker (step-up), compose project + revision, cấp cổng trong transaction, override chỉ SA kèm lý do, registry (Crypt + tham chiếu), website loại docker, firewall `scope=docker`, backup volume | bad264f |
| 10.5 Agent WordPress | 8 op `wp.*` dưới uid + slice account, allowlist lệnh, cấm cờ nguy hiểm, chặn symlink; `wp.update` snapshot restic → update → verify + HTTP → lỗi thì tự khôi phục file + DB; clone, harden 6 mục | fdd210f |
| 10.6 Panel WordPress | Cài (mật khẩu admin trả một lần), quét, chi tiết, cập nhật an toàn (cần đích backup), staging theo hạn mức gói, hardening, bảo trì, đổi mật khẩu (step-up), tự cập nhật theo cửa sổ giờ; API Admin + Portal | 6a7e374 |
| 10.7 UI | Hộp thoại mật khẩu quản trị một lần, basic auth staging tắt kèm lý do, MSW theo hành vi API thật, registry chỉ SA | 18ea187 |
| 10.8 Tích hợp | e2e stack thật Phase 10 (4 luồng), file điều khiển sandbox để mô phỏng lỗi, `tests/vm/phase10.sh` (V0–V6), review bảo mật, runbook, `make check`, báo cáo | f1e0602 |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/internal/{docker,compose}/`, `agent/internal/ops/{docker,compose,software,wordpress}.go`, sandbox `ops/sandbox_{docker,wp}.go` |
| Panel | `apps/api/app/Domain/{Docker,WordPress}/`, `app/Domain/Servers/SoftwareService.php`, `Shared/WordPressController.php`, các controller Docker trong `Admin/` |
| UI | `apps/web/src/entries/admin/{docker,software}/`, trang WordPress dùng chung Admin/Portal |
| E2E · test VM | `apps/web/e2e-real/phase10.spec.ts`, `tests/vm/phase10.sh` |
| Bảo mật · vận hành | `docs/security/docker-wordpress-review.md`, `docs/runbooks/phase-10-docker-wordpress.md` |

## 3. Cách chạy thử

- Dev: `ITSO_ACME_EMAIL=ops@itso.local make dev` (policy agent sandbox có `docker: true`), `php artisan migrate:fresh --seed`, rồi `db:seed --class=DemoSeeder` khi queue đã chạy, sau đó `make test-e2e-real`. Luồng Phase 10 mô phỏng lỗi bằng `.dev/agent-sandbox/root/var/lib/itso-sandbox/{docker,wp}-control.json`.
- Demo không cần backend: `make dev-demo`.
- VM: `tests/vm/phase10.sh` trên Ubuntu 24.04 có Docker; thứ tự và cách đọc kết quả ở runbook `docs/runbooks/phase-10-docker-wordpress.md`.
- Máy thật phải bật thêm Docker ở chính sách agent: `itso policy set docker on` (chủ ý, xem §7).

## 4. Kết quả test

`make check` (2026-11-22, PostgreSQL 16 + Redis cục bộ, trên mã 10.8, commit f1e0602): **22 PASS · 1 SKIP (staticcheck) · 0 FAIL** ngay lần đầu (1 304 s). Chi tiết ở `TEST_REPORT.md` (Prompt 10.8).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | 505/505 (Phase 10: Docker 10, Software 5, WordPress 7) |
| Go (21 gói) + fuzz | PASS (fuzz 56 990 lượt) |
| Vitest | 593/593 |
| Playwright (demo MSW + Design System + mockup, gồm axe) | 622/622 |
| Playwright stack thật (`make test-e2e-real`, DB sạch) | 26/27 lượt đầu, luồng lỗi do môi trường chạy lại xanh (xem dưới); 4 luồng mới Phase 10 xanh |
| Installer · unit systemd | PASS |
| pint, phpstan, ESLint, Prettier, tsc, i18n (3282 khóa, vi = en), gofmt, go vet, no-exec, docs-check, contracts/codegen/tokens, db-verify (142) | xanh |
| Script VM | `bash -n tests/vm/phase10.sh` OK; V0–V6 **chờ VM** |

E2E stack thật Phase 10 (`e2e-real/phase10.spec.ts`, 4 luồng, Engine Docker giả + WP-CLI mô phỏng + restic thật):

1. **Software:** cài PHP 8.3 và 8.2 song song → đổi PHP của website sang 8.2 → gỡ PHP đang dùng bị 409.
2. **Docker:** bật Docker (step-up) → compose có `privileged` bị 422 → sửa → apply, cổng nằm trong dải 20000–29999 bind 127.0.0.1 → website loại docker → image mới unhealthy tự quay về (`rolled_back`) → registry + kiểm đăng nhập (không lộ token) → policy backup volume.
3. **WordPress:** cài → mật khẩu admin trả một lần, job không chứa secret → cập nhật plugin lỗi → snapshot restic thật được khôi phục (`rolled_back`) → staging → hardening.
4. **USER:** mọi đường `/portal/...` tới Docker là 404, menu không có Docker; vẫn thấy WordPress của mình.

**Lượt chạy toàn bộ trên DB sạch:** 26/27 PASS (19,4 phút). Lỗi duy nhất là luồng tạo account của Phase 3 do môi trường: đĩa container còn dưới 15 % sau khi cấp nên server local bị loại (đã gặp ở Phase 9). Dọn 8,5 GB cache rồi chạy lại luồng đó: PASS. Hai luồng Portal của Phase 3 chỉ xanh khi chạy đúng thứ tự trên DB sạch (luồng Phase 8 bật MFA cho user portal), nên khi chạy lại riêng lẻ chúng dừng ở màn MFA; đây là phụ thuộc thứ tự giữa các spec, không phải lỗi mới.

## 5. Tiêu chí nghiệm thu Phase 10 (ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Container publish `0.0.0.0` không lộ ra ngoài nếu chưa mở trong panel | ✓ (code) · **chờ VM** | Go (`docker.firewall.sync`, daemon.json `userland-proxy=false`, viết lại cổng), Pest (rule `scope=docker`), e2e (cổng trong dải); **VM V1** quét từ máy ngoài |
| USER không có đường nào tới Docker | ✓ | Pest (mọi route), e2e (portal 404, phiên portal gọi admin bị từ chối, menu), review quyền socket/nhóm `docker` |
| WordPress cập nhật lỗi thì rollback được | ✓ · **chờ VM** | Go `TestWPUpdateFailureRestoresSnapshot` (restic thật), Pest, e2e (`rolled_back`); **VM V5** với WordPress thật |
| Compose không qua validator thì không chạy | ✓ | Go (vector độc + fuzz, apply chỉ nhận sha256 đã validate), Pest (422, không apply), e2e (privileged → 422) |
| Cập nhật image lỗi thì quay về image cũ | ✓ · **chờ VM** | Go `ops/docker_test`, e2e (Engine giả: unhealthy → `rolled_back`); **VM V3** |
| PHP nhiều bản song song | ✓ · **chờ VM** | Go `ops/software_test`, e2e (8.3 + 8.2, đổi PHP website); **VM V6** |

## 6. Lệch so với kế hoạch

- **Log container realtime qua gateway** hoãn; hiện dùng tail (10.3).
- **Basic auth cho staging** chưa có: API trả 422, UI hiện công tắc tắt kèm lý do; staging chỉ có `noindex` (10.6, 10.7).
- Sandbox thêm file điều khiển (`docker-control.json`, `wp-control.json`) để e2e mô phỏng image mới unhealthy và cập nhật WordPress lỗi; chỉ có trong chế độ `--sandbox`, có test Go riêng.
- `make dev` bật `docker: true` trong policy của agent sandbox; máy thật vẫn mặc định tắt.

## 7. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 → 10 (Phase 10: V0–V6 cần Docker thật, iptables, PHP/MariaDB, WordPress); dán kết quả vào mục 5.
- Docker phải bật thêm ở chính sách agent trên từng máy (`itso policy set docker on`); chưa bật thì job "Bật Docker" lỗi `op_disabled` kèm thông báo rõ. Đây là chủ ý để quyền root không phụ thuộc panel.
- `update_available` của image luôn `false` (chưa so digest với registry); người dùng bấm "Cập nhật image" để kiểm.
- Kiểm tra registry chạy trên server đầu tiên có Docker bật.
- Xóa registry không xóa credential đã lưu trên node (`/etc/itso/docker-client/config.json`, root 0600) cho tới lần đăng nhập/đổi tiếp theo.
- Bản lỗi sau khôi phục WordPress (`sites/<domain>.restore-<ts>`) giữ lại để điều tra, chưa dọn tự động.
- Plugin premium không có trên wordpress.org thì không có checksum (bỏ qua, không tính lỗi verify).
- Menu Registry vẫn hiện với ADMIN (trang trả 403 rõ ràng; shell chưa lọc menu theo quyền).
- Engine Docker giả có thể khác Docker thật; client ghim theo API 1.43, xác minh ở VM V0–V4.
- Container dev có đĩa trống gần ngưỡng 15 %: e2e tạo account có thể hỏng nếu đĩa đầy (đã gặp lại ở 10.8).
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 8. Bước tiếp theo

Dừng trước Phase 11, chờ duyệt Phase 10.
