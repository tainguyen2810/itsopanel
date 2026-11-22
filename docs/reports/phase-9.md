# Báo cáo Phase 9: Multi-server & chuyển tài khoản

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM, **chờ duyệt**. Nhánh `phase-9`, merge `--no-ff` vào `main` ở Git local (không push, không remote). Phase 9 không có mốc phát hành (mốc kế tiếp `v0.5.0-beta` sau Phase 11). Tiêu chí cần 3 máy, tường lửa, systemd và WordPress thật được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`tests/vm/phase9.sh`).
- **Thời gian:** 2026-11-21 → 2026-11-22, chạy liền 9.0 → 9.8 theo yêu cầu ("xong hết parse 8 là tiếp 9").
- **Cách làm:** mockup trước (9.0, ảnh `docs/screenshots/phase-9/`) → ADR + contracts → CA + relay + agent node → installer → panel API → agent `migrate.*` → điều phối chuyển account → UI nối API thật → tích hợp. Container chạy **2 agent thật**: agent local (sandbox) + agent node sandbox nối qua `itso-relay` bằng mTLS loopback; restic 0.16.4 thật.
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Agent không có op chạy lệnh tùy ý, không `sh -c`; khóa CA chỉ ở agent local; node không mở cổng quản trị inbound. Bí mật chỉ qua tham chiếu, không vào job params/log/audit. Billing/WooCommerce/thanh toán: OUT OF SCOPE; Public Provisioning API: DEFERRED.
- **Quyết định đã duyệt cùng kế hoạch (2026-11-21):** D-88 (vai trò cài đặt), D-89 (`itso-relay` mTLS, node kết nối ra), D-90 (CA nội bộ), D-91 (job khi node mất kết nối), D-92 (năng lực + gợi ý server), D-93 (chuyển account qua repo restic). ADR 0034 → 0038.

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 9.0 Mockup | Server theo vai trò/kênh/kết nối, thêm node (token + ghim CA), node mất kết nối, thu hồi, gợi ý server, wizard chuyển 6 bước, khôi phục sang server khác | 7d94e0e |
| 9.1 Contracts | ADR 0034–0038; op `pki.sign_csr`, `agent.cert.rotate`, `http.check`, `migrate.*`, `account.remove`; 3 mã lỗi mới; OpenAPI enroll/migrate/revoke; DBML + migration Phase 9 | 611cfa4 |
| 9.2 CA + relay | `internal/pki`, `itso-relay` (TLS 1.3, mTLS, thu hồi, enroll có chữ ký + giới hạn tần suất), agent `--mode node`, `AgentClient::forServer` | 9670a98 |
| 9.3 Installer | `itso install --role all-in-one\|control-plane\|node`, join ghim CA, `itso pki`, `itso node status\|rejoin\|leave`, unit `itso-relay`, `itso-agent-node`, `itso-cert-rotate.timer` | 8d37f3a |
| 9.4 Panel API | Token join, enroll nội bộ, thu hồi, job theo server + `waiting_agent`, `itso:relay-sync`, `itso:certs-rotate`, gợi ý vị trí | bcbc762 |
| 9.5 Agent | `http.check`, `migrate.preflight/verify/cutover/rollback`, `account.remove` thật, khôi phục chéo server | fe309e5 |
| 9.6 Điều phối | `MigrationService` (preflight → sync → verifying → cutover → holding → cleanup; rollback; DNS tự động), khôi phục chéo server, `itso:migrations-cleanup` | 8dfa8c2 |
| 9.7 UI | Trang lượt chuyển, wizard khớp API thật, banner node mất kết nối, Portal "đang chuyển", MSW theo API | b2ef24d |
| 9.8 Tích hợp | e2e stack thật 2 agent qua relay (4 luồng), sửa 3 lỗi tìm ra nhờ e2e (§4), `tests/vm/phase9.sh` (3 VM, N0–N6), review bảo mật, `make check`, báo cáo | 45ebccd |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/internal/{pki,relay}/`, `agent/cmd/itso-relay/`, `agent/internal/ops/{pki,migrate,account_remove}.go`, `agent/internal/install/node.go` |
| Panel | `apps/api/app/Domain/Servers/{NodeEnrollment,RelaySync,CertRotation}.php`, `app/Domain/Migration/`, `Admin/{ServerController,AccountMigrationController}.php` |
| UI | `apps/web/src/entries/admin/hosting/{AccountMigratePage,MigrationsPage,Placement}.tsx`, `entries/admin/servers/` |
| E2E · test VM | `apps/web/e2e-real/phase9.spec.ts`, `tests/vm/phase9.sh`, `tests/vm/lib/panel_api.php` |
| Bảo mật · vận hành | `docs/security/multi-server-review.md`, `docs/runbooks/multi-server.md` |

## 3. Cách chạy thử

- Dev: `ITSO_ACME_EMAIL=ops@itso.local make dev` (thêm `itso-relay` + agent node sandbox ở `.dev/relay`, `.dev/node-sandbox`), seed `DemoSeeder`, rồi `make test-e2e-real`. Luồng Phase 9 tự join thêm một node sandbox qua UI (`.dev/e2e-node-*`).
- Demo không cần backend: `make dev-demo`.
- VM: 3 máy theo thứ tự trong đầu `tests/vm/phase9.sh` (`--prepare` → join → `--node` → `--panel-1` → `--seed-wp` → `--panel-2`), runbook `docs/runbooks/multi-server.md` §5.

## 4. Kết quả test

`make check` (2026-11-22, PostgreSQL 16 + Redis cục bộ, trên mã 9.8): **19 PASS · 1 SKIP (staticcheck) · 3 FAIL** lần đầu (1 143 s): `test-e2e` 548/549 (`demo-admin2` còn giả định không có ô "Máy chủ đích" mà Phase 9 thêm lại cho khôi phục sang server khác), `test-fuzz` (`FuzzFirewallRule` tìm comment chứa `;`, hợp lệ theo contract vì nằm trong chuỗi trích dẫn, làm bất biến của test sai), `git-clean` (corpus fuzz mới). Sửa test, chạy lại đúng mục: `demo-admin2` 3/3, `make test-fuzz` PASS, corpus được commit. Chi tiết ở `TEST_REPORT.md` (Prompt 9.8).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | 483/483 |
| Go (19 gói) + fuzz | PASS |
| Vitest | 562/562 |
| Playwright (demo MSW + Design System + mockup, gồm axe) | 548 PASS + 1 sửa test rồi chạy lại xanh |
| Playwright stack thật + 2 agent qua relay (`make test-e2e-real`, DB sạch) | 23/23 (4 luồng mới Phase 9) |
| Installer · unit systemd | PASS |
| pint, phpstan, ESLint, Prettier, tsc, i18n (2999 khóa, vi = en), gofmt, go vet, no-exec, docs-check, contracts/codegen/tokens, db-verify (98) | xanh |
| Script VM | `bash -n tests/vm/phase9.sh` OK; N0–N6 **chờ VM** |

E2E stack thật Phase 9 (`e2e-real/phase9.spec.ts`, 4 luồng, relay thật + 2 agent):

1. **Thêm node:** token một lần trên UI → pin CA sai bị từ chối (không gửi token) → `itso node rejoin` đúng pin → panel báo "đã kết nối" → dùng lại token bị từ chối → agent node chạy, `itso:relay-sync` → server online, tab Agent đúng kênh mTLS.
2. **Chuyển account qua wizard:** account trên node (site tĩnh + DB MariaDB) → kiểm tra trước → bắt đầu → "Kiểm tra dữ liệu" (file, ownership, DB, cron khớp) → account `migrating`, ghi cron → 409 → cutover (gõ username, step-up) → "Giữ nguồn": account ở server local, file ở đích đúng nội dung viết trên node, nguồn khóa chưa xóa, đo downtime.
3. **Hoàn tác:** lượt khác tới bước kiểm tra → hoàn tác → `rolled_back`, account vẫn ở node, active.
4. **Node mất kết nối và thu hồi:** dừng agent node → job `waiting_agent` (lọc được trên trang Tác vụ) → chạy lại node → job `succeeded`; thu hồi bị 409 khi còn account → chuyển nốt → thu hồi qua UI (gõ tên) → kết nối `revoked`, job mới bị từ chối.

**Lỗi tìm thấy nhờ e2e stack thật ở 9.8 (đã sửa, có test):**

- Account **chưa backup lần nào** không chuyển được: preflight ở đích báo chặn "không đọc được repo" vì repo chỉ được khởi tạo ở lượt backup đầu của chính lượt chuyển. Nay là cảnh báo (Pest `MigrationTest`).
- Chặng đích **vẫn dựng account khi `migrate.preflight` báo chặn** (op trả `ok:false` mà job đi tiếp). Thêm tham số `enforce` vào contract `migrate.preflight`: đầu chặng đích gửi `enforce=true`, còn mục chặn → `precondition_failed`, job dừng trước `account.ensure`, lượt chuyển `failed` (Go `TestMigratePreflight`, Pest).
- Trang **Tác vụ lọc `waiting_agent` → 422** (API thiếu trạng thái trong validate). Đã sửa (Pest `NodeTest`).
- Môi trường sandbox: chủ sở hữu file chấp nhận cả uid tiến trình (agent sandbox chạy root), kiểm HTTP bỏ qua khi không có nginx (`HTTPAddrs` nil); wizard chuyển cho chọn server bị loại vì đĩa (hiện lý do) vì container dev luôn dưới ngưỡng 15 %; `make dev` chép CA vào agent sandbox và đặt `ITSO_PKI_CA_FILE`, `ITSO_RELAY_PUBLIC_URL`.

## 5. Tiêu chí nghiệm thu Phase 9 (ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Quản lý 3 server | ✓ (2 agent trong container) · **chờ VM** | e2e: server local + node qua relay; **VM N0** 3 máy |
| Node không mở cổng quản trị inbound | ✓ (code) · **chờ VM** | Agent node chỉ quay ra; installer test không mở cổng; **VM N1** (`ss`, nmap) |
| Mất kết nối agent: job chờ hoặc timeout đúng | ✓ · **chờ VM** | Pest `NodeTest`, `MigrationTest`; e2e (dừng node → `waiting_agent` → chạy tiếp); **VM N2** (nftables, quá hạn → `agent_unreachable`) |
| Chuyển account xong site chạy ở server đích | ✓ · **chờ VM** | Go `migrate_test` với restic thật; e2e (nội dung file ở đích); **VM N4** (WordPress + DB, HTTP 200 cùng nội dung) |
| Downtime cutover ≤ 5 phút với 2 GB | **chờ VM** | Panel đo `downtime_sec`; **VM N4** với 2 GB |
| Rollback cutover | ✓ · **chờ VM** | Pest (DNS + hoàn tác sau cutover), Go, e2e (hoàn tác ở bước kiểm tra); **VM N5** |
| Xoay chứng chỉ / thu hồi node | ✓ · **chờ VM** | Go `relay_test`, Pest; e2e thu hồi; **VM N3, N6** |

## 6. Lệch so với kế hoạch

- Contract `migrate.preflight` thêm tham số tùy chọn `enforce` (9.8) để chặng đích dừng đúng lúc; không đổi hành vi preflight từ UI.
- Script VM gọi panel trong tiến trình (`artisan tinker` + `lib/panel_api.php`, khớp route → controller với Super Admin, bỏ qua middleware phiên/MFA) vì thao tác nhạy cảm không dùng được bằng API token; validate, phạm vi, job và audit vẫn như qua HTTP.
- E2e lượt hoàn tác dùng account không DB vì sandbox node và server local dùng chung một MariaDB (máy thật mỗi server một MariaDB; Pest + Go phủ hoàn tác có DB).

## 7. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 → 9 (Phase 9 cần 3 VM); dán kết quả vào mục 5.
- Relay là điểm tập trung (mất relay = mất quản lý node, website vẫn chạy); chưa có relay dự phòng.
- UID cấp theo server: chuyển account cần cùng UID + username trống ở đích.
- Chứng chỉ TLS website không chuyển theo (cấp lại ở đích sau khi DNS trỏ).
- Container dev có đĩa trống gần ngưỡng 15 %: gợi ý vị trí loại server local, e2e tạo account có thể hỏng nếu đĩa đầy (đã gặp ở 9.8, dọn đĩa scratch rồi chạy lại).
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 8. Bước tiếp theo

Dừng trước Phase 10, chờ duyệt Phase 9.
