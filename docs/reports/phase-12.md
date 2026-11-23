# Báo cáo Phase 12: Production Hardening & Production Gate → v1.0.0-rc.1

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM, **chờ duyệt**. Nhánh `phase-12`, merge `--no-ff` vào `main`, đẩy `main` và `phase-12` lên `github`; tag `v1.0.0-rc.1` chỉ ở local (proxy môi trường cloud chặn đẩy tag, HTTP 403). Cả 8 bài Production Gate G1–G8 đang **`pending_vm`**: đã có tiêu chí đo được, phần kiểm tự động trong container và bộ script chạy trên VM (`tests/vm/gate.sh`), nhưng chưa có bằng chứng VM nên **chưa được phát hành `v1.0.0`** (D-47, ADR 0060).
- **Thời gian:** 2026-11-23, chạy liền 12.0 → 12.8 theo yêu cầu "merge và làm tiếp parse 12"; tên bản phát hành `v1.0.0-rc.1` theo lựa chọn của người dùng (D-115).
- **Cách làm:** mockup trước (12.0, ảnh `docs/screenshots/phase-12/`) → ADR + contracts + migration → agent (import, CIS, journal cập nhật + `itso repair`) → panel import → hardening (ASVS L2, ma trận quyền, CIS, systemd) → hiệu năng 200 account → offline installer + vòng cập nhật/chaos → API Sẵn sàng production + sổ tay vận hành → tích hợp (e2e, Gate, release).
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Agent không có op chạy lệnh tùy ý, không `sh -c`; import chỉ đọc dưới gốc web của panel nguồn, sao chép dưới UID account, bỏ symlink/hardlink/thiết bị. Params job và nội dung thông báo không chứa bí mật (mật khẩu DB khi import có test chống lộ). Billing/WooCommerce/thanh toán: OUT OF SCOPE; Public Provisioning API: DEFERRED. Pentest độc lập (D-50) vẫn bắt buộc trước khi mở cho khách bên ngoài.
- **Quyết định:** D-108 → D-115, ADR 0053 → 0060 (Accepted ở 12.1).

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 12.0 Mockup | Import (quét, kế hoạch, chạy, cutover, rollback), CIS, Cập nhật (journal, lịch sử, repair), Sẵn sàng production; 10 cảnh × 4 = 40 ảnh | c94bf8c |
| 12.1 Contracts | ADR 0053–0060; op `import.scan/copy/cutover/rollback`, `cis.audit` có schema + 14 vector độc; migration Phase 12; sửa lỗi có từ trước: CHECK regex chặn traversal Phase 10/11 sai do generator | daaeb8b |
| 12.2 Agent | `import.scan` (aaPanel, HestiaCP, nginx thuần, parser tối thiểu có fuzz), `import.copy` dưới UID account, cutover/rollback vhost nguồn, `cis.audit` chỉ đọc, journal cập nhật + `itso repair` (crash sau từng bước có test) | 8423982 |
| 12.3 Panel import | API (chỉ SUPER_ADMIN, step-up), kế hoạch lỗi theo từng mục, job `import.run` (op mới `import.db_dump`), cutover + ACME, rollback, `partially_failed` | 8929075 |
| 12.4 Hardening | `docs/security/asvs-l2.md` (V1–V14), header bảo mật, giới hạn body 413, cookie Secure, ma trận quyền sinh từ route (> 250 route `{id}`), CIS API + `cis_l1` trong điểm, số liệu RLS (ADR 0055), unit agent 6.1 → 4.9 | be1bc5c |
| 12.5 Hiệu năng | `PerfSeeder` (200 account × 3 site × 2 DB, 7 ngày metrics, 10 000 job, 100 000 audit), `itso:bench`, chỉ mục `audit_logs (at, id)`, bỏ N+1 ở 7 danh sách; mọi mục tiêu D-112 đạt | 3884297 |
| 12.6 Offline + chaos | `make release-offline` (bundle `.deb` khóa phiên bản, manifest ký), `install.sh --offline`, `itso install --offline`, ACME tắt khi offline; `tests/vm/upgrade-loop.sh` (20 vòng + kill -9 + reboot), `docs/security/update-policy.md` | 28862ce |
| 12.7 UI + vận hành | `GET /admin/system/readiness` (11 kiểm + Gate G1–G8), `itso:gate-record`, `docs/runbooks/operations-handbook.md` | 16d82cf |
| 12.8 Tích hợp | e2e stack thật Phase 12 (3 luồng), lỗi import khi gói không có PHP đã cài (sửa + test), `tests/vm/gate.sh` + `docs/gate/G1–G8.md`, `make check`, release `v1.0.0-rc.1` (online + offline) | xem `git log` |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/internal/ops/{import,cis}*.go`, `agent/internal/fsx/` (`SourceTar`), `agent/internal/install/` (journal, repair, offline) |
| Panel | `apps/api/app/Domain/Imports/`, `app/Domain/System/ProductionReadiness.php`, `Admin/{ImportController,ReadinessController}`, middleware `SecurityHeaders`, `LimitRequestBody`, lệnh `itso:bench`, `itso:gate-record`, `database/seeders/PerfSeeder.php` |
| UI | `apps/web/src/entries/admin/imports/{ImportsPage,ImportDetailPage}.tsx`, `apps/web/src/entries/admin/security/CisPage.tsx`, `entries/admin/system/{UpdatesPage,ReadinessPage}.tsx` |
| Cài đặt | `packaging/install.sh.in` (`--offline`), `scripts/release-offline.sh`, `packaging/offline-packages.{list,lock}` |
| E2E · VM · Gate | `apps/web/e2e-real/phase12.spec.ts`, `tests/vm/upgrade-loop.sh`, `tests/vm/gate.sh`, `docs/gate/` |
| Bảo mật · hiệu năng · vận hành | `docs/security/{asvs-l2,update-policy}.md`, `docs/perf/phase-12.md`, `docs/runbooks/operations-handbook.md` |
| Phát hành | `docs/releases/v1.0.0-rc.1.md` |

## 3. Cách chạy thử

- Dev: `ITSO_ACME_EMAIL=ops@itso.local make dev`, `php artisan migrate:fresh --seed`, `db:seed --class=DemoSeeder`. E2E: `make test-e2e-real` (spec Phase 11 cần IP `10.99.0.1` trên `lo`).
- Hiệu năng: `php artisan db:seed --class=PerfSeeder` rồi `php artisan itso:bench --n=30` (chỉ local/testing, nên dùng DB riêng).
- Offline: `VERSION=1.0.0-rc.1 make release-offline` (trên máy build Ubuntu 24.04 có mạng chạy thêm `scripts/release-offline.sh --update-lock` để lock có `.deb` thật), rồi `sudo bash install.sh --offline itso-1.0.0-rc.1-offline.tar`.
- Gate trên VM: `sudo bash tests/vm/gate.sh --release ... --release2 ... --release3 ... --record` (xem đầu file); ghi tay: `php artisan itso:gate-record G<n> pass --note "..."`.

## 4. Kết quả test

`make check` (2026-11-23, PostgreSQL 16 + Redis cục bộ): **19 PASS · 1 SKIP (staticcheck) · 3 FAIL** (1 631 s). Cả 3 lỗi đã sửa và chạy lại xanh: (1) `docs-check`: `check-links.mjs` đi vào `.dev/agent-sandbox` và gặp symlink hỏng do e2e import tạo → bỏ qua `.dev`/`.cache`/`build`, dùng `lstat` không theo symlink; chạy lại PASS (159 link). (2) `test-api` 554/555: `SystemTest` thấy `0.5.0-beta` vì `ITSO_VERSION` trong `.env.example` (và `.env` dev) chưa nâng → nâng `1.0.0-rc.1`; Pest toàn bộ chạy lại **555/555**. (3) `git-clean`: chỉ là hai sửa ở trên cộng `PHASE_STATUS.md` do tôi sửa trong lúc `make check` chạy, không phải file do `make check` sinh ra. Chi tiết ở `TEST_REPORT.md` (Prompt 12.8).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | **555/555** (Phase 12: `Phase12/*` gồm Import 8, Readiness, RouteMatrix 3, Hardening 3, QueryCount, OfflineAcme) |
| Go (agent) + fuzz | PASS (fuzz parser nginx import, đường dẫn import) |
| Vitest | 638/638 |
| Playwright (demo MSW + Design System + mockup, gồm axe) | 758/758 |
| Playwright stack thật (`make test-e2e-real`, DB sạch) | **35/35**: lượt toàn bộ 30 PASS (21,8 phút); spec Phase 11 lỗi ở `beforeAll` vì máy chưa có IP `10.99.0.1` (thiếu điều kiện môi trường, 1 lỗi + 4 không chạy) → thêm IP, chạy lại spec Phase 11 trên DB sạch **5/5** (3,9 phút) |
| db-verify · contracts · codegen · lint · no-exec · installer (20/20) · unit systemd | xanh |
| `make release` | `build/release/1.0.0-rc.1` ký Ed25519 (khóa DEV tạm), SBOM; thiếu `frankenphp` như các bản trước |
| `make release-offline` | `itso-1.0.0-rc.1-offline.tar` 53 MB, 0 `.deb` (lock rỗng, có CẢNH BÁO) |
| Script VM / Gate | `bash -n tests/vm/gate.sh tests/vm/upgrade-loop.sh` OK; G1–G8 **pending_vm** |

E2E stack thật Phase 12 (`e2e-real/phase12.spec.ts`, agent sandbox):

1. **Import:** quét lần lượt aaPanel → HestiaCP → nginx trên sandbox, chọn mục đầu tiên chọn được, lập kế hoạch (username mới, USER mới) → chạy → lượt `completed`, mục `done`, account `ready` → cutover → `cut_over` → rollback → `rolled_back`.
2. **CIS:** chạy kiểm `cis.audit` → có điểm, hướng dẫn sửa, không còn "chưa quét".
3. **Sẵn sàng production:** API trả 11 kiểm + 8 Gate (`pending_vm`), `ready=false`; trang hiển thị đúng.

**Lỗi e2e tìm ra (đã sửa, có test hồi quy):** chạy import với gói chỉ cho phép phiên bản PHP chưa cài trên server làm job `import.run` thất bại giữa chừng → kiểm trước khi chạy, trả 422 `items.N.package` kèm lý do (test mới trong `ImportTest`). Lỗi trong công cụ kiểm link và `ITSO_VERSION` ở trên do `make check` bắt được.

## 5. Tiêu chí nghiệm thu Phase 12 (ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Security review nội bộ | ✓ | `docs/security/asvs-l2.md` (không còn High/Critical mở), ma trận quyền tự động, review từng Phase 4–11 |
| CIS Ubuntu | ✓ · **chờ VM** | op `cis.audit` + API + điểm (Go test, Pest, e2e); điểm trên máy thật: **VM** |
| Cân nhắc RLS, tách helper đặc quyền | ✓ | ADR 0055 (số liệu đo), ADR 0056 (unit 4.9) |
| Hiệu năng 200 account/server | ✓ | `docs/perf/phase-12.md`, `QueryCountTest`; qua Caddy/FPM + tải song song: **VM** |
| Chaos (mất điện giữa lúc update) | ✓ · **chờ VM** | crash sau 6 bước × `itso repair --fix` (Go test); kill -9 / reboot thật: `tests/vm/upgrade-loop.sh` |
| Import aaPanel / HestiaCP / nginx | ✓ · **chờ VM** | Go test + fuzz, Pest 8/8, e2e (quét → chạy → cutover → rollback trên sandbox); panel cài thật: **VM** |
| Offline installer | ✓ · **chờ VM** | `make test-installer` 20/20, bundle thật + `--dry-run`; lock `.deb` thật và cài trên VM không mạng: **VM** |
| Runbook vận hành | ✓ | `docs/runbooks/operations-handbook.md` |
| Production Gate G1–G8 | **pending_vm** | `docs/gate/G1–G8.md`, `tests/vm/gate.sh`; trang Sẵn sàng production hiện `ready=false` |

## 6. Lệch so với kế hoạch

- Phát hành `v1.0.0-rc.1` thay cho `v1.0.0` (D-115): `v1.0.0` chỉ khi cả 8 bài Gate có bằng chứng VM `pass`.
- `packaging/offline-packages.lock` đang rỗng (container không có apt Ubuntu 24.04 có mạng): bundle offline của rc.1 chưa chứa `.deb` và in CẢNH BÁO; phải chạy `--update-lock` trên máy build.
- Bench đo qua HTTP kernel nội bộ (không qua Caddy/PHP-FPM, không song song); đo đầu-cuối thuộc bài Gate trên VM.
- Thêm `itso:bench`, `itso:gate-record`, op `import.db_dump` (không có tên trong kế hoạch).

## 7. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 → 11 và `tests/vm/gate.sh` (G1–G8, ≥ 2 server, 3 bản phát hành liên tiếp cho G5); ghi kết quả bằng `itso:gate-record`.
- **Pentest độc lập** trước khi mở cho khách bên ngoài (D-50).
- Khóa ký release vẫn là khóa DEV tạm; cần khóa thật lưu ngoài repo trước `v1.0.0`.
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 8. Bước tiếp theo

Dừng sau Phase 12, chờ duyệt Phase 12 và bản `v1.0.0-rc.1`. Phase tiếp theo không có trong kế hoạch hiện tại: việc còn lại là chạy Gate trên VM rồi phát hành `v1.0.0`.
