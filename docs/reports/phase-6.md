# Báo cáo Phase 6: Database, File Manager, SFTP/FTPS, Cron, Terminal USER

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM. Nhánh `phase-6`, merge `--no-ff` vào `main` ở Git local (không push, không remote). Tiêu chí cần kernel/systemd thật được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`tests/vm/phase6.sh`).
- **Thời gian:** 2026-11-21.
- **Cách làm:** như Phase 4–5 ("Làm trước, VM test sau"). Code và test chạy với runner giả, agent `--sandbox` (ký HMAC; MariaDB/pure-ftpd/sshd mô phỏng ở tầng lệnh, file thật dưới gốc sandbox, shell giả cho terminal) và stack cloud thật (PostgreSQL 16 + Redis + Laravel + Vite + itso-gateway).
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Agent không có op chạy lệnh tùy ý, không `sh -c`; thao tác dữ liệu của account chạy dưới uid account (helper hạ quyền, `systemd-run` cho cron/terminal). Billing/WooCommerce/thanh toán: OUT OF SCOPE.
- **Quyết định đề xuất chờ duyệt:** D-71 (database), D-72 (File Manager hạ quyền), D-73 (SFTP/FTPS/SSH key), D-74 (cron = systemd timer), D-75 (terminal USER). ADR 0018 → 0022.

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 6.1 Contracts | ADR 0018–0022, contracts op `db.*`, `fs.*`, `sftp.*`/`ftp.*`/`ssh.*`, `cron.*`, `pty.open`; OpenAPI database/file/SFTP/cron/terminal; migration | fa49a30 |
| 6.2 Agent | Helper File Manager dưới uid account (`openat2 RESOLVE_BENEATH`), nén/giải nén bằng Go có giới hạn, MariaDB/PostgreSQL (danh tính chủ theo account), SFTP chroot + FTPS Pure-FTPd + khóa SSH, cron systemd timer trong slice account | 2edbc0c |
| 6.3 API | Database/user/quyền/export/import, SFTP/FTPS + khóa SSH, cron (+ `itso:cron-sync`), File Manager (ETag, thao tác qua job, upload tus 8 MiB, link tải HMAC 5 phút); mật khẩu sinh trả một lần; tạm khóa account khóa DB/cron/FTPS | 95d2e4c |
| 6.4 Terminal | `pty.open` (ticket 32 byte, 30 giây, một lần, ≤ 2 phiên/account), socket stream peercred `itso-gw`, `cmd/itso-gateway`, jail `systemd-run --pty`, `/terminal/sessions` + step-up, `itso:terminal-reap` | f7f654a |
| 6.5 UI | Upload tiếp tục được (tạm dừng/tiếp tục/hủy, đồng bộ khi 409), terminal xterm.js, mật khẩu DB/SFTP hiện một lần + đổi mật khẩu SFTP, tải về bằng link ký; MSW theo hành vi mới | 612a8e6 |
| 6.6 Tích hợp | Playwright stack thật Phase 6 (4 luồng); sửa 6 lỗi (§4); `tests/vm/phase6.sh` S0–S7; review bảo mật File Manager; runbook | 72758d4, f692a26 |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/internal/fsx/`, `agent/internal/ops/{fs,db,access,cron,pty,sandbox_data}.go`, `agent/internal/term/`, `agent/internal/gateway/`, `agent/cmd/itso-gateway/` |
| Panel | `apps/api/app/Domain/{Data,Terminal}/`, `app/Http/Controllers/Api/V1/Shared/{Database,Access,Cron,File,Terminal}Controller.php` |
| UI | `apps/web/src/shared/hosting/{upload,terminal}.ts`, `src/shared/hosting/pages/{DatabasesPage,FilesPage,Uploads,SftpPage,CronPage,Terminal,XtermView}.tsx` |
| Test VM | `tests/vm/phase6.sh`, `tests/vm/lib/term_client.py` |
| E2E stack thật | `apps/web/e2e-real/phase6.spec.ts` |
| Bảo mật · vận hành | `docs/security/file-manager-review.md`, `docs/runbooks/phase-6-hosting-data.md` |

## 3. Cách chạy thử

- Dev: `make dev` (agent sandbox + gateway), seed `DemoSeeder`, rồi `make test-e2e-real`.
- Demo không cần backend: `make dev-demo` (MSW).
- VM: sau `run-all.sh --no-uninstall`, chạy `bash tests/vm/phase6.sh`.

## 4. Kết quả test

`make check` (2026-11-21, PostgreSQL 16 + Redis cục bộ, trên commit f692a26): **19 PASS · 1 SKIP (staticcheck) · 3 FAIL** lần đầu (644 s): `test-fuzz` tìm ra lỗi thật (§4 mục 6), `docs-check` (khối code thiếu ngôn ngữ trong file review mới), `git-clean` (hệ quả: corpus fuzz lỗi + báo cáo chưa commit). Sau khi sửa, chạy lại đúng 3 mục đó: `make test-fuzz` PASS (8 target, ~3,5 triệu lần chạy), `make docs-check` PASS, cây git sạch sau commit. Chi tiết ở `TEST_REPORT.md` (Prompt 6.5, 6.6).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | 424/424 |
| Go (race, 15 package) + fuzz | PASS |
| Vitest | 501/501 |
| Playwright (demo MSW + Design System, gồm axe) | 263/263 |
| Playwright stack thật + agent sandbox + gateway (`make test-e2e-real`) | 12/12 |
| Installer 8/8 · unit systemd 14 | PASS |
| pint, phpstan, ESLint, Prettier, tsc, i18n (2626 khóa, vi = en), gofmt, go vet, no-exec, docs-check, contracts/codegen/tokens, db-verify | xanh |

E2E stack thật (itso-agent sandbox + itso-gateway), 12/12:

1. Admin: tạo database kèm user qua UI → mật khẩu hiện một lần; database thứ hai → export `.sql.gz` vào `backups/` → import lại từ file đó; FTPS phụ (mật khẩu sinh) → đổi mật khẩu; thêm khóa SSH ed25519; cron → chạy ngay → lịch sử "Thành công".
2. Admin File Manager: tạo thư mục; upload gửi nửa đầu, gửi lặp → 409 `errors.received=5`, gửi nửa sau → `completed`; upload qua UI → "Xong" → file có trong thư mục; sửa file (ETag) → nội dung khớp; nén zip → giải nén; tải về bằng link ký (chữ ký sai → 403).
3. Admin terminal: step-up TOTP → xterm → `whoami` ra `anphat` → `exit` → "Phiên đã kết thúc".
4. Portal: database + export/import, thư mục, `../../etc` → 422, cron chạy ngay, thấy thư mục trên UI.
5. Bốn luồng Phase 3, hai luồng Phase 4, hai luồng Phase 5 chạy lại: PASS.

**Lỗi tìm thấy nhờ e2e stack thật (đã sửa, có test hồi quy):**

1. `AuditLogger::redact` đổi `null` của khóa `password` thành chuỗi `[REDACTED]`, JobRunner gửi chuỗi đó cho agent: tạm khóa account có FTPS phụ luôn lỗi (`/params/password: minLength`). Lỗi có từ 6.3; e2e Phase 5 (tạm khóa) lỗi khi chạy sau Phase 6.
2. Laravel nhận khóa SSH base64 thiếu padding, agent từ chối → job lỗi. Nay Laravel kiểm như agent.
3. `itso-gateway` gửi hai khung close (coder/websocket 1.8.12 tự trả lời close + Close trùng) → Chrome báo 1006 "Close received after close", UI hiện "Không kết nối được" thay vì "Phiên đã kết thúc". Nâng lên 1.8.14 và chỉ Close một lần.
4. Uploader báo "Xong" trước khi job `fs.upload.commit` ghi file → danh sách chưa có file. Nay chờ `completed`, lỗi commit có thông báo riêng.
5. `make dev` để Laravel ghi staging upload ngoài gốc sandbox (agent không thấy). Thêm nhãn i18n cho job Phase 6 (`cron_job.*`, `sftp_account.*`, `file.upload`…).

6. **Fuzz (`make check`):** cron `0 27/1 * 1 0` (giờ bắt đầu 27 > 23 với bước) được chấp nhận và sinh `OnCalendar` hỏng ở agent; Laravel cũng nhận. Cả hai nay từ chối (UI đã đúng); thêm seed fuzz + Pest.

Thêm ở 6.5: dữ liệu demo có hai tài khoản SFTP trùng UUID (React báo trùng key ở `/admin/sftp`); `check_demo.py` nay chặn UUID trùng.

## 5. Tiêu chí nghiệm thu Phase 6 (11-ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Mọi test tấn công bị chặn | ✓ (code + sandbox) · **chờ VM** | Go `fsx`/`archive` test trên filesystem thật của container (`..`, symlink ngoài, symlink đổi giữa chừng, zip slip, link trong archive, zip bomb); evil-inputs 155 vector; Pest 422; e2e `../../etc` → 422; review §2 T1–T15. VM S1 (uid account, hardlink, home 0750 giữa 2 account), S2 (chroot), S7 (jail) |
| Upload 1 GB resumable | ✓ (giao thức) · **chờ VM** | Giao thức tus: Pest (sai offset 409, hủy, phiên người khác 404), Vitest (resync, tạm dừng/tiếp tục, chờ commit), e2e stack thật (gửi lặp → 409 → gửi tiếp → completed). VM S5: 1 GB ghi làm 2 lần → commit, sha256 khớp |
| DB import/export qua job | ✓ (sandbox) · **chờ VM** | e2e stack thật Admin + Portal: export `.sql.gz` → import qua job; Pest; VM S6: MariaDB thật dưới uid account, SQL của A không đụng DB của B |
| Cron chạy dưới uid account, bị giới hạn bởi slice | ✓ (unit) · **chờ VM** | Golden unit `itso-cron-<uuid>` (`User=`, `Slice=itso-acct-<uid>.slice`, `RuntimeMaxSec`, `NoNewPrivileges`); e2e chạy ngay → lịch sử. VM S4: `id -u` + `/proc/self/cgroup` của `run_once`, `systemctl show` của unit |

## 6. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 + 5 + 6 và dán kết quả vào mục 5.
- MariaDB `GRANT ALL ON prefix\_%`: owner account tạo được DB khớp prefix ngoài panel → vượt `db_limit` (không vượt quyền). Đề xuất Phase 7: reconcile phát hiện DB lạ.
- Chưa có lệnh dọn file staging của phiên upload bỏ dở (`/var/lib/itso/uploads`). Đề xuất Phase 7: `itso:uploads-prune`.
- Bản ghi phiên terminal gần đúng tới khi có op `pty.list` (Phase 7). Root terminal + ghi phiên: Phase 7 (D-75).
- Portal xóa database/website cần step-up nên khách phải bật MFA (giữ như Phase 5, chờ người dùng quyết).
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 7. Bước tiếp theo

Chờ duyệt Phase 6 và D-71 → D-75. **Không** bắt đầu Phase 7 khi chưa được duyệt.
