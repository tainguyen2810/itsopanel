# Báo cáo Phase 8: Backup & Restore → v0.1.0-alpha

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM, **chờ duyệt**. Nhánh `phase-8`, merge `--no-ff` vào `main` ở Git local (không push, không remote), tag local `v0.1.0-alpha`. Tiêu chí cần kernel/systemd/dịch vụ thật hoặc 2 máy được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`tests/vm/phase8.sh`).
- **Thời gian:** 2026-11-21.
- **Cách làm:** như Phase 7, **mockup trước khi code** (8.0, ảnh `docs/screenshots/phase-8/`), rồi contracts → agent → panel API → DR → UI nối API thật → tích hợp. Agent được test với **restic 0.16.4 thật** trên repo local (sandbox), đích từ xa (SFTP/S3/rest) bằng argv/env golden; stack cloud thật (PostgreSQL 16 + Redis + Laravel + Vite + agent sandbox + gateway).
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Agent không có op chạy lệnh tùy ý, không `sh -c`; dump/import DB và chép dữ liệu khôi phục chạy dưới uid account. Mật khẩu repo và credential đích chỉ qua tham chiếu bí mật, không vào job params, log, audit hay argv. Billing/WooCommerce/thanh toán: OUT OF SCOPE.
- **Quyết định đề xuất chờ duyệt:** D-82 (repo restic + bộ khôi phục), D-83 (đích + immutable), D-84 (nội dung + nhất quán), D-85 (khôi phục qua staging), D-86 (lịch, tài nguyên, quota), D-87 (kiểm chứng + DR). ADR 0029 → 0033.

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 8.0 Mockup | Backup Center 5 tab, bộ khôi phục, policy, snapshot + duyệt, wizard khôi phục, kiểm chứng, Account/Portal Backup, purge bị chặn, wizard DR; 84 ảnh light/dark/390 px | 9c28641 |
| 8.1 Contracts | ADR 0029–0033; op `backup.*` viết lại + 5 op mới, 4 mã lỗi, 43 vector độc; DBML + migration 9 bảng | 1af5ef4 |
| 8.2 Agent (1) | `internal/backup` (URL repo, file bí mật 0600, `itso-maint.slice`, phân loại lỗi restic, khóa SFTP + ghim host key, Object Lock, append-only), `backup.destination.test/repo.init/run/snapshots/browse/stats` | f658fa3 |
| 8.3 Agent (2) | `backup.restore` qua staging root 0700 + helper uid account, `backup.check`, `backup.restore_test`, `backup.forget`, backup panel mã hóa age, CLI `itso backup prune\|panel-restore` | 5be9317 |
| 8.4 Panel API | Đích, repo, bộ khôi phục, policy + `itso:backup-due`, snapshot/duyệt/tải file, kiểm chứng, khôi phục new/overwrite, quota, retention, 3-2-1-1-0, Portal, quyền `backups.*`, cổng purge D-46 | ba32a6d |
| 8.5 DR | `install.sh --restore`, `/setup/restore:inspect` + `/setup/restore` (op `panel.restore`), `itso panel-restore-apply`, `itso:dr-restore`, runbook DR | 4050012 |
| 8.6 UI | UI khớp hành vi API thật (DB theo `snapshot.databases`, ghi đè một mục, kit có `destination_uuid`, purge, DR); MSW theo API; ảnh chụp lại | a8ce9bc |
| 8.7 Tích hợp | e2e stack thật Phase 8 (2 luồng), sửa đích local + retention theo contract (§4), `tests/vm/phase8.sh` B0–B6, review bảo mật, release notes + hướng dẫn cài, tag `v0.1.0-alpha` | (commit 8.7) |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/internal/backup/`, `agent/internal/ops/{backup,backup_run,backup_restore,panel_restore}.go`, `agent/internal/install/restore.go` |
| Panel | `apps/api/app/Domain/Backup/`, `app/Http/Controllers/Api/V1/{Admin/BackupAdminController,Shared/BackupController}.php`, `app/Console/Commands/{BackupDue,BackupVerify,DrRestore}Command.php` |
| UI | `apps/web/src/entries/admin/backups/` (gồm `RestoreNewPage`, `RestoresPage`), `entries/admin/install/DrRestore.tsx`, `entries/portal/pages/BackupsPage.tsx` |
| Test VM | `tests/vm/phase8.sh` |
| E2E | `apps/web/e2e-real/phase8.spec.ts`, `apps/web/e2e/demo-backup8.spec.ts` |
| Bảo mật · vận hành · phát hành | `docs/security/backup-review.md`, `docs/runbooks/disaster-recovery.md`, `docs/releases/v0.1.0-alpha.md`, `docs/releases/install-v0.1.0-alpha.md` |

## 3. Cách chạy thử

- Dev: `make dev` (agent sandbox dùng restic thật dưới `.dev/agent-sandbox/root`), seed `DemoSeeder`, rồi `make test-e2e-real`. Reset DB thì xóa luôn `.dev/agent-sandbox/root`.
- Demo không cần backend: `make dev-demo` (MSW).
- VM: sau `run-all.sh --no-uninstall`, chạy `bash tests/vm/phase8.sh`; DR: `--dr-source` trên VM1, `--dr-target <kit.tar>` trên VM2 (xem hướng dẫn cài §8).

## 4. Kết quả test

`make check` (2026-11-21, PostgreSQL 16 + Redis cục bộ, trên mã 8.7): **20 PASS · 1 SKIP (staticcheck) · 2 FAIL** lần đầu (1 533 s): `lint-web` (Prettier: `e2e-real/phase8.spec.ts` chưa định dạng), `test-e2e` (14/493: `demo-admin2.spec.ts` 2 test còn chọn mục "Cấu hình account" và máy chủ khác mà 8.6 đã bỏ; ảnh mockup `recovery-kit` còn nhập đường dẫn đích local; `snapshot-detail`/`browse-file` tìm snapshot đã sang trang 2). Sửa test theo hành vi mới, chạy lại đúng các mục: `make lint-web` PASS, `demo-admin2.spec.ts` 3/3, 12 ảnh chụp lại 12/12. Chi tiết ở `TEST_REPORT.md` (Prompt 8.7).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | 462/462 |
| Go (race, 17 package) + fuzz | PASS (76 539 lần chạy fuzz) |
| Vitest | 559/559 |
| Playwright (demo MSW + Design System + mockup, gồm axe) | 479 PASS + 14 sửa test rồi chạy lại xanh (15/15) |
| Playwright stack thật + agent sandbox + gateway (`make test-e2e-real`) | 19/19 (2 luồng mới Phase 8, restic thật) |
| Installer · unit systemd | PASS |
| pint, phpstan, ESLint, Prettier, tsc, i18n (2900 khóa, vi = en), gofmt, go vet, no-exec, docs-check, contracts/codegen/tokens, db-verify (78) | xanh |
| Script VM | `bash -n tests/vm/phase8.sh` OK; B0–B6 **chờ VM** |

E2E stack thật Phase 8 (`e2e-real/phase8.spec.ts`, 2 luồng, restic thật):

1. **Admin:** tạo website tĩnh + DB có dữ liệu mẫu → thêm đích "Ổ đĩa máy chủ" qua UI (đường dẫn cố định `/var/backups/itso`) → bộ khôi phục phải xác nhận, gọi lần 2 không còn hiện lại → policy (retention `last: 5`) → chạy ngay → job xong, repo có trên đĩa → snapshot files + DB, lịch sử Backup Center hiện id → duyệt cây `sites` có domain → phá dữ liệu (xóa file, sửa `index.html`, nạp dữ liệu khác vào DB) → khôi phục file ra bản mới (`backups/restore-*`) → ghi đè website qua wizard (gõ username) → `index.html` về bản gốc → ghi đè DB → export chứa dữ liệu cũ, không còn dữ liệu sau khi phá → danh sách khôi phục `succeeded` → `itso:backup-verify`.
2. **Portal:** chỉ thấy snapshot của account mình, trang Backup có quota → khôi phục bị 403 khi chưa MFA → bật TOTP → step-up → khôi phục thành công; snapshot của account khác bị từ chối.

**Lỗi tìm thấy nhờ chạy UI với API thật (8.6–8.7, đã sửa, có test):** kit thiếu `destination_uuid`; đường dẫn dump DB `db/<tên>.sql|.dump` khác cây UI dựng; UI cho ghi đè nhiều mục, chọn máy chủ khác, mục "config" mà API từ chối; đích local cho nhập đường dẫn trong khi API chỉ nhận `/var/backups/itso`; khóa retention lệch giữa contract/UI (`keep_*`) và API (`last/daily/…`), sửa contract trước rồi API + UI + DBML theo; ngữ nghĩa purge trong demo khác API.

## 5. Tiêu chí nghiệm thu Phase 8 (11-ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| RPO ≤ 24 giờ (file) / 6 giờ (DB) mặc định | ✓ | Policy mặc định file hằng ngày, DB 6 giờ; `itso:backup-due` mỗi 5 phút (Pest: lịch đến hạn, jitter, khóa) |
| Restore 1 site ≤ 15 phút cho 5 GB | **chờ VM** | Cần VM tham chiếu; `phase8.sh` B1 đo thời gian khôi phục với dữ liệu nhỏ, chạy lại với 5 GB khi có VM |
| DR toàn bộ thành công theo runbook | ✓ (từng phần) · **chờ VM** | Pest wizard + `itso:dr-restore`, Go `panel_restore` với restic thật, installer test `--restore`; diễn tập 2 VM: `phase8.sh --dr-source/--dr-target` (B6) |
| Panel bị chiếm không xóa được backup immutable | ✓ (code) · **chờ VM** | Policy agent `backup.forget=false` mặc định, panel không xóa snapshot trên đích bất biến (Pest), chỉ credential ghi; VM B3: forget bằng credential panel thất bại trên rest-server `--append-only` |
| Test: backup → xóa → restore → checksum | ✓ · **chờ VM** | Go với restic thật (sha256), e2e stack thật (nội dung file + DB về bản gốc); VM B1 (sha256 toàn cây + HTTP 200), B2 (số dòng + CHECKSUM TABLE MariaDB thật) |
| Test: append-only chặn xóa | **chờ VM** | VM B3 |
| Test: diễn tập DR trên 2 VM | **chờ VM** | VM B6 |
| DoD: tag `v0.1.0-alpha`, release notes, hướng dẫn cài | ✓ | Tag local; `docs/releases/` |

## 6. Lệch so với kế hoạch (đã ghi trong ADR/PHASE_STATUS)

- DR dùng `itso:reconcile` (áp lại desired state từ DB panel) thay vì `itso repair` như bản kế hoạch; `itso repair` vẫn dùng để kiểm tra sau khôi phục.
- Đích local cố định `/var/backups/itso` (không cho chọn đường dẫn) để giữ quyền root 0700 và đường dẫn trong bộ khôi phục.
- DR với đích SFTP chỉ qua CLI (cần khóa SSH + ghim lại host key trên máy mới).
- Khôi phục sang máy chủ khác (không phải DR): Phase 9.
- Mặc định phiên bản agent/CLI/`make release` đổi `0.4.0-dev` → `0.1.0-alpha` cho khớp mốc.

## 7. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 → 8 và diễn tập DR 2 VM; dán kết quả vào mục 5.
- Agent thật chưa có op `account.remove` (purge bước cuối mới có ở mock agent).
- Danh sách bản backup panel chưa hiện phiên bản panel và số account.
- Đích không bất biến vẫn bị xóa được nếu root máy chủ bị chiếm (review §4).
- Còn từ Phase 6–7: `itso:uploads-prune`, reconcile DB lạ, trusted proxy, xoay vòng bản ghi phiên terminal.
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 8. Bước tiếp theo

Chờ duyệt Phase 8, D-82 → D-87 và mốc `v0.1.0-alpha`. **Không** bắt đầu Phase 9 khi chưa được duyệt.
