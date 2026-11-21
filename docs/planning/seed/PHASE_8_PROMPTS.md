# Phase 8 — Backup & Restore: prompt chi tiết

> Viết ngày 2026-11-21, sau khi người dùng duyệt Phase 7 ("tiếp parse 8"). Nguồn: `ROADMAP.md` (Phase 8: repo restic riêng cho mỗi account, offsite immutable, DR all-in-one, mốc **v0.1.0-alpha**), `docs/planning/11-ROADMAP.md` §Phase 8, `08-BACKUP.md`, `12-PHASE-PROMPTS.md` (8.1–8.4), `DECISIONS.md` D-15, D-19, D-23, D-46, `contracts/agent-ops/catalog.json` (op `backup.*` đã `specified` từ Phase 1), OpenAPI `/backup-*`, `/backups`, `/restores*`, DBML nhóm `backup`, trang demo Backup Center (Phase 2).
> Nhánh `phase-8`. Làm hàng loạt 8.0 → 8.7, tự merge local, DỪNG trước Phase 9. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.
> Mockup trước khi code (từ Phase 7): Prompt 8.0 dựng màn hình và trạng thái mới trên bản demo (MSW), chụp ảnh vào `docs/screenshots/phase-8/`.

## Mục tiêu Phase 8

Hosting dùng thật được vì có backup khôi phục được: mỗi account có repo restic riêng (D-23), đích local + SFTP/NAS + S3-compatible + rest-server append-only, lịch theo policy, DB dump nhất quán, backup cấu hình máy chủ và panel, khôi phục website/database/file (vào bản mới hoặc ghi đè có bản trước khi khôi phục), kiểm chứng (`restic check` + restore test tự động), checklist 3-2-1-1-0, quota backup theo gói, và khôi phục toàn bộ khi mất máy (`install.sh --restore` + runbook). Panel bị chiếm không xóa được backup immutable (D-19).

## Ràng buộc môi trường

- Như Phase 4–7: container không có systemd/KVM. `restic` 0.16.4 (gói Ubuntu 24.04) **cài được trong container** nên agent được test với restic thật trên repo local (backup → xóa → khôi phục → so sha256). SFTP/S3/rest-server: argv/env golden + sandbox; chạy thật trên VM (`tests/vm/phase8.sh`) với rest-server `--append-only` và MinIO/Garage nếu có.
- Không chạy lệnh restic từ Laravel (cấm exec). Mọi thao tác qua op agent kiểu hóa; mật khẩu repo và credential đích chỉ đi qua tham chiếu bí mật (D-69), agent ghi ra file tạm 0600 rồi truyền `RESTIC_PASSWORD_FILE`/env file, **không bao giờ qua argv**.
- Diễn tập DR đầy đủ trên 2 VM là điều kiện nghiệm thu: script sẵn sàng, kết quả **chờ VM**.

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-82 | Repo và engine | restic từ kho Ubuntu (recipe `restic`, kiểm phiên bản ≥ 0.16). Tách **đích** (`backup_destinations`: loại, cấu hình, credential ghi) và **repo** (`backup_repositories`: đích × account, hoặc đích × server cho cấu hình/panel; mật khẩu restic riêng mỗi repo, sinh ngẫu nhiên 32 byte, mã hóa trong DB). Đường dẫn repo cố định do agent dựng: `<đích>/itso/<server_uuid>/acct-<account_uuid>` / `.../server`. Tag: `itso`, `account:<uuid>`, `website:<uuid>`, `db:<name>`, `type:files\|db\|config\|panel`. Mỗi snapshot kèm `itso-meta.json` (phiên bản panel, account, website, DB, gói). **Bộ khôi phục** (recovery kit): đích + mật khẩu repo + khóa panel hiện **một lần** khi tạo đích/repo, SA phải xác nhận đã lưu offline; tải lại cần SUPER_ADMIN + step-up | D-23 (xóa sạch một account được, khách không thấy dữ liệu nhau); mất panel vẫn khôi phục được |
| D-83 | Đích và immutable | `local` (`/var/backups/itso/repos`, root 0700, không immutable), `sftp` (khóa SSH riêng do agent sinh, host key ghim khi kiểm tra kết nối), `s3` (endpoint + bucket + key; phát hiện Object Lock), `rest` (rest-server, user append-only). Panel/agent chỉ giữ **credential ghi**. `backup.forget`/prune tắt mặc định bằng policy agent (`backup.forget=false`); retention trong panel là "mong muốn": với đích không immutable và policy bật thì panel chạy forget theo retention, còn lại SA chạy `itso backup prune` trên máy chủ, nhập credential prune tại chỗ (không lưu) | D-19: ransomware chiếm panel không xóa được backup immutable |
| D-84 | Nội dung và nhất quán | File: `restic backup` thư mục `sites/` + `backups/` + home (loại `tmp`, cache, session) do agent đọc bằng root, không theo symlink (`restic` lưu symlink như symlink), không qua thiết bị khác. DB: dump dưới uid account bằng danh tính chủ (D-71) — `mariadb-dump --single-transaction --routines --triggers --events` / `pg_dump -Fc` — pipe vào `restic backup --stdin --stdin-filename db/<name>.sql\|.dump`. Cấu hình máy chủ: `/etc/itso`, `/etc/nginx`, `/etc/php`, `/etc/ssh/sshd_config.d`, ruleset nft, unit `itso*`, danh sách gói. Panel: `pg_dump -Fc` DB `itso` + `/etc/itso` + khóa, **mã hóa thêm** bằng khóa công khai X25519 của panel (age); khóa riêng chỉ nằm trong bộ khôi phục của SA | Nhất quán không khóa bảng; panel backup tự động mà panel bị chiếm vẫn không đọc được bản cũ |
| D-85 | Khôi phục | Agent `restic restore` vào **staging root 0700** `/var/lib/itso/restore/<uuid>` (ngoài home), rồi helper uid account chép vào home qua `fsx` (như `fs.upload.commit`: bỏ setuid/thiết bị, không theo symlink, chủ = account). Website: vào `sites/<domain>.restore-<ts>` → kiểm → snapshot "pre-restore" bản hiện tại → đổi tên nguyên tử → reload. DB: mặc định DB mới `<name>_r<ts>`; ghi đè cần step-up + dump trước khi khôi phục. File lẻ: duyệt snapshot (`restic ls --json`) → khôi phục vào `backups/restore-<ts>/`. Khôi phục sang account khác cùng máy (nhân bản) được; sang máy khác: Phase 9 | Root không ghi thẳng vào home do account kiểm soát (tránh tấn công symlink lúc khôi phục) |
| D-86 | Lịch, tài nguyên, quota | Lịch trong panel: `itso:backup-due` mỗi 5 phút chọn policy đến hạn + jitter theo repo; mặc định file hằng ngày, DB 6 giờ, cấu hình hằng ngày. Agent chạy restic trong `itso-maint.slice` (CPUQuota 50%, IOWeight 10, Nice 10) bằng `systemd-run --wait`; một tác vụ một repo (khóa Redis + khóa restic). Quota backup theo gói (`backup_quota_mb`): dung lượng repo của account (từ `restic stats --mode raw-data`) vượt → cảnh báo, vượt 120 % → tạm dừng backup lịch (không xóa) | Không đồng loạt đè tải máy; quota minh bạch |
| D-87 | Kiểm chứng và DR | Hằng tuần `restic check --read-data-subset=5%`; hằng tháng restore test tự động (khôi phục 1 website + 1 DB vào staging, so sha256 với manifest trong `itso-meta.json`, DB nạp vào DB tạm rồi xóa). Checklist 3-2-1-1-0 tính từ dữ kiện thật (số bản, loại phương tiện, off-site, immutable, lần kiểm gần nhất). Purge account (D-46) bắt buộc snapshot cuối đã kiểm chứng. DR: `install.sh --restore` → wizard nhập đích + mật khẩu repo panel + khóa riêng → khôi phục DB panel → `itso repair` áp lại desired state → khôi phục từng account (song song có giới hạn); runbook `docs/runbooks/disaster-recovery.md` | "0 lỗi khi kiểm chứng"; diễn tập DR là tiêu chí nghiệm thu |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code; mọi thay đổi máy chủ đi qua job + audit; params job không chứa bí mật.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 8.0 | **Mockup:** màn hình/trạng thái Phase 8 trên bản demo, ảnh `docs/screenshots/phase-8/` 1440/390 × sáng/tối; OpenAPI mà màn mới cần thêm ngay | 0,5 ngày |
| 8.1 | ADR 0029–0033 (D-82…D-87); contracts agent-ops `backup.*` viết lại + op mới; OpenAPI rà lại; DBML + migration Phase 8 | 0,5 ngày |
| 8.2 | Agent: runner restic (env file, slice), đích local/SFTP/S3/rest, `backup.repo.init`, backup file/DB/cấu hình, `backup.snapshots`, `backup.browse`, `backup.stats`; sandbox + test với restic thật | 1,5 ngày |
| 8.3 | Agent: khôi phục (staging + helper), DB mới/ghi đè, `backup.check`, `backup.restore_test`, `backup.forget` (policy), backup panel mã hóa age, CLI `itso backup prune\|panel-restore` | 1,5 ngày |
| 8.4 | Panel: đích (+ kiểm tra, bộ khôi phục một lần), repo, policy + lịch, job backup, snapshot, duyệt/tải file, kiểm chứng, khôi phục, quota, 3-2-1-1-0, Portal, quyền, cổng purge | 1,5 ngày |
| 8.5 | DR: `install.sh --restore`, wizard khôi phục, `itso repair`, runbook DR | 1 ngày |
| 8.6 | UI nối API thật theo mockup 8.0 (Admin + Portal), MSW theo hành vi mới | 1 ngày |
| 8.7 | Tích hợp: e2e stack thật, `tests/vm/phase8.sh` (gồm DR 2 VM), review bảo mật, `make check`, báo cáo, release `v0.1.0-alpha` (tag local + release notes + hướng dẫn cài), merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p8)`, `test(p8)`, `docs(p8)`; đồng bộ bản sao lưu.

## Prompt 8.0 — Mockup

```
[ITSO Panel] Prompt 8.0 — Mockup Backup & Restore (trước khi code)
Phạm vi: chỉ bản demo (apps/web + src/demo + contracts/tools/demo.py), không đụng API/agent.
Màn hình và trạng thái:
- Admin Backup Center › Tổng quan: checklist 3-2-1-1-0 (đạt/chưa đạt + lý do), lần backup/kiểm chứng gần nhất,
  dung lượng theo đích, job đang chạy, cảnh báo quota.
- Đích: thêm đích local/SFTP/S3/rest-server (form theo loại, kiểm tra kết nối, immutable/append-only phát hiện được),
  hộp thoại **bộ khôi phục** hiện một lần (mật khẩu repo, khóa panel; tải xuống; ô xác nhận "đã lưu offline").
- Policy: phạm vi (account/website/DB/cấu hình máy chủ/panel), lịch, retention mong muốn, loại trừ, nhãn
  "đích immutable: panel không xóa snapshot".
- Snapshot: lọc theo account/loại/đích, chi tiết (tag, kích thước, đã kiểm chứng), duyệt cây file, tải file lẻ.
- Khôi phục wizard: chọn snapshot → mục (website/DB/file) → chế độ (bản mới / ghi đè + cảnh báo + step-up) → xác nhận;
  tiến trình job; kết quả (đường dẫn bản khôi phục, DB mới).
- Kiểm chứng: lịch sử check + restore test, báo lỗi.
- Account › Backup (Admin) và Portal › Backup: snapshot của account, quota backup, tạo backup ngay, khôi phục website/
  DB/file của mình (Portal không ghi đè DB khi chưa step-up).
- Purge account: chặn khi chưa có snapshot cuối đã kiểm chứng.
- Wizard cài đặt: nhánh "Khôi phục từ backup" (DR) — nhập đích, mật khẩu repo panel, khóa riêng.
Chụp: e2e/screenshots-phase8.spec.ts, make screenshots → docs/screenshots/phase-8.
Kiểm thử: Vitest/Playwright demo + axe xanh; i18n vi = en; check_demo.py.
```

## Prompt 8.1 — ADR và contracts

```
[ITSO Panel] Prompt 8.1 — ADR Backup & Restore, contracts Phase 8, migration
Phạm vi: docs/adr/0029-backup-repos-restic.md (D-82), 0030-backup-destinations-immutable.md (D-83),
0031-backup-content-consistency.md (D-84), 0032-restore-staging.md (D-85), 0033-backup-verify-dr.md (D-86, D-87).
Contracts agent-ops viết lại theo ADR: BackupRepo {repo_uuid, destination{type, config}, secret refs cho mật khẩu và
credential}, backup.repo.init, backup.run (files|db|config|panel, tags, meta), backup.snapshots, backup.browse,
backup.stats, backup.restore (staging + commit qua helper; db mode new|overwrite), backup.check,
backup.restore_test, backup.forget (critical, default_enabled=false), backup.destination.test. Lỗi mới nếu cần
(repo_locked, repo_not_initialized). Vector độc: đường dẫn browse/restore, tag, tên DB.
OpenAPI rà lại: đích (test, recovery-kit một lần), repo, policy, snapshot (browse, download-link, verify),
restores, /backup/status (3-2-1-1-0), portal /hosting-accounts/{id}/backups*, wizard restore.
DBML: backup_repositories mới, sửa backup_destinations (bỏ hosting_account_id/restic_password ở đích), cột job/
verification cần cho API; migration Phase 8; make db-verify.
make contracts, make codegen, codegen-check xanh.
```

## Prompt 8.2 — Agent: runner và backup

```
[ITSO Panel] Prompt 8.2 — Agent restic runner, đích, backup
Phạm vi: agent/internal/backup (runner): env file 0600 trong /run/itso/backup/<uuid>/, systemd-run --wait
--slice=itso-maint.slice, khóa theo repo; dựng URL repo từ tham số kiểu hóa (không nhận chuỗi repo tự do);
local/SFTP (khóa riêng 0600, StrictHostKeyChecking với known_hosts ghim)/S3/rest. Op: backup.destination.test,
backup.repo.init, backup.run (files: thư mục cố định của account, exclude cố định; db: dump dưới uid account →
--stdin; config: danh sách cố định; meta itso-meta.json), backup.snapshots (--json, lọc tag), backup.browse
(restic ls theo đường dẫn tương đối, giới hạn mục), backup.stats.
Sandbox: dùng restic thật nếu có trên máy dev (repo dưới gốc sandbox), mô phỏng SFTP/S3/rest.
Test: golden argv/env (không có bí mật trong argv), backup → snapshots → browse với restic thật, symlink trong home
không bị theo, đường dẫn độc bị từ chối.
```

## Prompt 8.3 — Agent: khôi phục, kiểm chứng, panel backup

```
[ITSO Panel] Prompt 8.3 — Agent restore, check, restore test, forget, panel backup
Phạm vi: backup.restore vào staging rồi helper uid account commit (website: thư mục .restore-<ts> + đổi tên nguyên
tử + snapshot pre-restore; file lẻ → backups/restore-<ts>/; DB: nạp vào DB mới dưới danh tính chủ, overwrite cần
cờ + dump trước); backup.check; backup.restore_test (khôi phục mẫu, so sha256 với manifest); backup.forget chỉ khi
policy bật; panel backup: pg_dump DB panel + /etc/itso + khóa → mã hóa age X25519 → restic --stdin; CLI
itso backup prune (credential nhập tại chỗ, không lưu), itso backup panel-restore (dùng ở DR).
Test với restic thật: backup → xóa site → restore → sha256 khớp; symlink do account đặt sẵn ở đích không bị ghi qua;
setuid bị bỏ; restore_test phát hiện file hỏng; forget bị chặn khi policy tắt.
```

## Prompt 8.4 — Panel

```
[ITSO Panel] Prompt 8.4 — Panel API Backup & Restore
Phạm vi: Domain/Backup: đích (CRUD, kiểm tra kết nối qua agent, credential mã hóa), repo (tạo khi policy đầu tiên
chạm account/server, init qua job), bộ khôi phục một lần (+ tải lại cần SUPER_ADMIN + step-up, audit), policy +
itso:backup-due (jitter, khóa Redis), job backup → backup_snapshots, snapshot list/browse/download-link (HMAC 5 phút),
verify (check/restore test) + itso:backup-verify lịch tuần/tháng, restores (website/DB/file, new/overwrite + step-up),
quota backup theo gói (cảnh báo/tạm dừng), retention mong muốn (forget chỉ khi đích không immutable + policy agent),
/backup/status 3-2-1-1-0, Portal (snapshot của account, backup ngay, khôi phục của mình), quyền backup.read/write/
restore, cổng purge (D-46) cần snapshot cuối đã kiểm chứng.
Test Pest: ma trận quyền, Portal chỉ thấy tag account mình, bí mật không vào job params/log/audit, lịch đến hạn,
quota, overwrite cần step-up, purge bị chặn.
```

## Prompt 8.5 — Disaster recovery

```
[ITSO Panel] Prompt 8.5 — DR: install.sh --restore, wizard khôi phục, itso repair
Phạm vi: install.sh --restore (cài như mới rồi vào chế độ khôi phục), wizard bước "Khôi phục từ backup": nhập đích +
mật khẩu repo panel + khóa riêng age → agent liệt kê snapshot panel → chọn → khôi phục DB panel + /etc/itso + khóa
→ itso repair áp lại desired state (account, website, PHP pool, cron, firewall) → danh sách account cần khôi phục dữ
liệu → khôi phục song song có giới hạn. Runbook docs/runbooks/disaster-recovery.md (RPO/RTO, thứ tự, kiểm tra).
Test: installer test --restore (fake), Pest wizard restore, Go panel-restore với restic thật.
```

## Prompt 8.6 — UI

```
[ITSO Panel] Prompt 8.6 — UI Backup & Restore nối API thật
Phạm vi: Admin Backup Center (tổng quan 3-2-1-1-0, đích + bộ khôi phục, policy, snapshot + duyệt, kiểm chứng,
khôi phục wizard), Account › Backup, Portal › Backup, purge bị chặn, wizard DR; MSW theo hành vi mới; i18n vi/en.
Test: Vitest + Playwright demo + axe.
```

## Prompt 8.7 — Tích hợp và báo cáo

```
[ITSO Panel] Prompt 8.7 — e2e, VM Phase 8, review bảo mật, release v0.1.0-alpha, merge, DỪNG
Phạm vi: apps/web/e2e-real/phase8.spec.ts (đích local → policy → backup ngay → snapshot → duyệt → xóa file → khôi phục
file/website/DB → so nội dung; Portal khôi phục của mình; bộ khôi phục hiện một lần), tests/vm/phase8.sh (B0 gói,
B1 backup → xóa site → restore → sha256 + HTTP 200, B2 DB row count + checksum bảng, B3 rest-server append-only:
forget bằng credential panel thất bại, B4 mất mạng giữa chừng → snapshot không ghi nhận, lần sau chạy tiếp,
B5 tải khi backup trong itso-maint.slice, B6 DR 2 VM theo runbook), docs/security/backup-review.md, make check,
docs/reports/phase-8.md, release notes + hướng dẫn cài v0.1.0-alpha, tag local v0.1.0-alpha, merge --no-ff main, DỪNG.
```
