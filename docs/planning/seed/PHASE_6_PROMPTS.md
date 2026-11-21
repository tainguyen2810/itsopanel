# Phase 6 — Database / File Manager / FTP-SFTP / Cron / Terminal USER: prompt chi tiết

> Viết ngày 2026-11-21, sau khi người dùng duyệt Phase 5 ("tiếp nhé, lên kế hoạch làm Phase 6"). Nguồn: `ROADMAP.md` (Phase 6 + "Terminal cho USER (jail) đưa vào đây"), `docs/planning/11-ROADMAP.md` §Phase 6, `12-PHASE-PROMPTS.md` (6.1–6.4), `03-MODULES.md` (Database, File, FTP/SFTP), `06-AGENT-SECURITY.md` §2, §5, `07-HOSTING-ISOLATION.md` §2, §5, §7, `contracts/agent-ops/catalog.json`, `database/schema/itso.dbml`, OpenAPI đã đặc tả từ Phase 1.
> Nhánh `phase-6`. Làm hàng loạt 6.1 → 6.6, tự merge local, DỪNG trước Phase 7. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.

## Mục tiêu Phase 6

Cho account hosting dùng được: database MariaDB/PostgreSQL (tạo, user, quyền, đổi mật khẩu, import/export qua job); File Manager (duyệt, sửa, upload resumable tới 1 GB, tải về, nén/giải nén) chạy dưới uid account; SFTP (OpenSSH chroot) và tài khoản FTPS phụ (Pure-FTPd, TLS bắt buộc) giới hạn thư mục con; SSH key; cron chạy dưới uid account trong slice của account; Terminal cho USER (jail) qua gateway WebSocket. Nối các trang Databases, Files, SFTP, Cron, Terminal đã có ở bản demo vào API thật, cho cả Admin và Portal.

## Ràng buộc môi trường

- Như Phase 4–5: container không có systemd/KVM. Mọi op mới đi qua lớp nền tảng (D-63), test bằng runner giả + gốc FS tạm (golden argv/file). Chế độ `--sandbox` mô phỏng `mariadb`, `psql`, `pure-pw`, `sshd -t`, `systemd-run`, shell của terminal.
- Kernel container hỗ trợ `openat2`, nên test tấn công File Manager (traversal, symlink, zip slip, zip bomb) chạy thật trên thư mục tạm. Phần cần uid khác, quota kernel, slice, sshd/chroot thật: **chờ VM** (`tests/vm/phase6.sh`).
- Không cài MariaDB/PostgreSQL hosting/Pure-FTPd vào container. SQL sinh ra được kiểm bằng golden test; trên VM chạy với server thật.

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-71 | Database | MariaDB 10.11 (kho Ubuntu, recipe `mariadb`, D-09) và PostgreSQL 16 cluster `main` cho hosting (recipe `postgresql`, khác cluster của panel theo D-02). Agent gọi `mariadb`/`psql` qua Runner: argv cố định, câu SQL sinh từ định danh đã validate (regex + quote), gửi qua stdin; mật khẩu chỉ đến agent bằng tham chiếu bí mật (D-69), không nằm trong argv/log. Tên DB/user bắt buộc tiền tố `<username>_`. Mỗi account có **danh tính chủ** xác thực bằng `unix_socket` (MariaDB) / `peer` (PostgreSQL) trùng user Linux, có quyền trên DB của chính account; **dump/import chạy dưới uid account** bằng danh tính đó, đọc/ghi file trong home qua helper File Manager, nên câu SQL trong file import không đụng được DB của account khác. Tạm khóa: `ACCOUNT LOCK` / `NOLOGIN`. MySQL 8: DEFERRED (cùng op, khác recipe) | Import bằng root là đường leo thang; không đưa mật khẩu ra argv |
| D-72 | File Manager | Op `fs.*` chạy trong **tiến trình helper** (agent tự exec lại `itso-agent fs-helper`) đã hạ về uid/gid account (không group phụ, `no_new_privs`); mọi đường dẫn mở bằng `openat2(home_fd, RESOLVE_BENEATH\|RESOLVE_NO_MAGICLINKS\|RESOLVE_NO_XDEV)`, từ chối đường dẫn tuyệt đối/NUL. Tiến trình root của agent không bao giờ đọc/ghi file trong home. Nén/giải nén viết bằng Go (zip, tar.gz): bỏ symlink/hardlink/device, xóa bit setuid/setgid, giới hạn số mục, tổng dung lượng, tỉ lệ nén 100:1; giải nén vào thư mục tạm rồi đổi tên. Upload resumable (kiểu tus): Laravel nhận chunk ≤ 8 MiB vào thư mục staging `/var/lib/itso/uploads` (user `itso`), phiên 24 giờ; hoàn tất → op mới `fs.upload.commit`: agent mở file staging (O_NOFOLLOW), chuyển fd cho helper ghi vào home. Tải về: `fs.read` có `offset`, Laravel stream từng khúc 1 MiB. Sửa file ≤ 2 MiB với `if_sha256` (khác → 409) | 06 §5: không thao tác file của account bằng root; giới hạn kernel (quota) áp đúng uid |
| D-73 | SFTP, FTPS, SSH key | SFTP = user Linux của account (OpenSSH `internal-sftp`, chroot home, group `itso-sftp`; gói có SSH → `itso-ssh`). Op mới `sshd.match.apply` ghi `/etc/ssh/sshd_config.d/50-itso.conf` (Match Group, `DenyGroups itso-suspended`, `AuthorizedKeysFile /etc/ssh/itso_authorized_keys/%u`, tắt forwarding), kiểm `sshd -t`, lỗi thì hoàn tác, đúng thì reload. SSH key do panel quản lý trong file root sở hữu (user không sửa được). Tài khoản FTP phụ = virtual user Pure-FTPd (recipe `pure-ftpd`, TLS bắt buộc, FTP thuần tắt, D-16) ánh xạ về uid/gid account, chroot vào thư mục con, tính vào `ftp_limit`; mật khẩu qua stdin. Mật khẩu SFTP của account đặt bằng `chpasswd` qua stdin | Chroot đúng yêu cầu home root sở hữu (07 §5); file tài khoản phụ vẫn thuộc uid account (quota, PHP) |
| D-74 | Cron | Mỗi job một cặp unit `itso-cron-<uuid>.timer/.service`: `User=<account>`, `Slice=itso-acct-<uid>.slice`, `WorkingDirectory` trong home, `RuntimeMaxSec=<timeout>`, `NoNewPrivileges=yes`, `Nice=10`; lệnh nằm trong file `/etc/itso-cron/<user>/<uuid>.sh` (root 0644) và `ExecStart=/bin/bash <file>`, không nhúng lệnh vào unit. Agent đổi biểu thức cron 5 trường sang `OnCalendar` (DOM và DOW cùng bị giới hạn → từ chối, vì systemd không có nghĩa OR). `cron.apply` là desired state theo account (gỡ unit thừa). Op mới `cron.inspect` đọc lần chạy cuối từ systemd để ghi `cron_runs`. Chạy ngay = `cron.run_once` (dưới uid trong slice, trả 8 KiB output cuối). Khoảng tối thiểu theo gói kiểm ở panel | Cron nằm trong slice account (giới hạn CPU/RAM); không phải escape lệnh trong unit |
| D-75 | Terminal USER | Chỉ account có gói `ssh_allowed`, không bị khóa, người mở đã step-up MFA. `POST /terminal/sessions` → agent `pty.open{account}` trả ticket dùng một lần 30 s → trình duyệt mở WebSocket `/gateway/terminal?ticket=…` tới **itso-gateway** (Go, user `itso-gw`, không tự quyết quyền) → gateway nối socket stream `/run/itso/agent-stream.sock` bằng ticket → agent chạy shell của account bằng `systemd-run --pty` (transient service: uid account, slice account, `ProtectSystem=strict`, `ProtectHome=tmpfs` + `BindPaths=<home>`, `PrivateTmp`, `NoNewPrivileges`, `RestrictSUIDSGID`). Tối đa 2 phiên/account, nhàn rỗi 15 phút thì đóng; ghi `terminal_sessions` (mở/đóng). Root terminal và ghi lại nội dung phiên: Phase 7 | "Jail" có thật (namespace của systemd), quyền vẫn do panel + policy agent quyết |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý (cron/terminal chạy lệnh của chính account dưới uid account, trong slice); contract trước code.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 6.1 | ADR 0018–0022 (D-71…D-75); contracts agent-ops: `fs.upload.commit`, `fs.stat`, `fs.read.offset`, `db.*.owner_ensure` + `db.*.lock`, `sshd.match.apply`, `ftp.user.ensure/remove` (tách khỏi `sftp.user.*`), `ssh.keys.apply` theo D-73, `cron.inspect`, `pty.open` (phase 6, specified), recipe `mariadb`/`postgresql`/`pure-ftpd`; vector độc mới; OpenAPI rà lại (FTP account, terminal Portal, upload kiểu tus, cron runs); DBML + migration Phase 6 | 0,5 ngày |
| 6.2 | Agent: helper File Manager (hạ quyền + openat2), nén/giải nén an toàn, upload commit; db MariaDB/PostgreSQL; SFTP/FTPS/SSH key/sshd.match; cron (OnCalendar, units, inspect, run_once); sandbox; test tấn công | 1,5 ngày |
| 6.3 | Panel: databases/database-users/grants/import/export, files (list/read/write/operate/upload/download, file_operations), sftp/ftp accounts, ssh-keys, cron-jobs/runs (+ đồng bộ `itso:cron-sync`), quota theo gói, tạm khóa account (khóa DB, tắt cron/FTP), reconcile, ma trận quyền | 1,5 ngày |
| 6.4 | Terminal: agent `pty.open` + socket stream, `cmd/itso-gateway` (WebSocket), unit `itso-gateway.service`, Laravel `/terminal/sessions` (admin + portal), dev proxy | 1 ngày |
| 6.5 | UI: Databases, File Manager (2 pane, editor, upload resumable, nén/giải nén), SFTP/FTP + SSH key, Cron (lịch sử chạy), Terminal (xterm.js), Admin + Portal; MSW theo contract | 1,5 ngày |
| 6.6 | Tích hợp: e2e stack thật + agent sandbox, `tests/vm/phase6.sh` (test tấn công trên kernel thật, chroot escape, cron trong slice, upload 1 GB, import/export DB, terminal jail), review bảo mật File Manager, `make check`, báo cáo, runbook, merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p6)`, `test(p6)`, `docs(p6)`; đồng bộ bản sao lưu.

---

## Prompt 6.1 — ADR và contracts

```
[ITSO Panel] Prompt 6.1 — ADR database/file/SFTP/cron/terminal, contracts Phase 6, migration
Phạm vi: docs/adr/0018-database-hosting.md (D-71), 0019-file-manager-ha-quyen.md (D-72), 0020-sftp-ftps-ssh-key.md
(D-73), 0021-cron-systemd-timer.md (D-74), 0022-terminal-user-jail.md (D-75). Contracts agent-ops: thêm fs.stat,
fs.upload.commit, db.mysql.owner_ensure, db.pg.owner_ensure, db.mysql.lock, db.pg.lock, sshd.match.apply,
ftp.user.ensure, ftp.user.remove, cron.inspect; sửa fs.read (offset), db.*.dump/import (chạy as account),
db.*.user_ensure (password_ref = tham chiếu bí mật), ssh.keys.apply (file root), cron.apply (timeout_sec),
pty.open (phase 6, specified, uid ≥ 1000), sftp.user.* (chỉ user chính); recipe enum thêm mariadb, postgresql,
pure-ftpd; vector độc mới (định danh SQL, cron DOM+DOW, subpath FTP `..`, khóa SSH có option). OpenAPI: FTP account
(protocol ftps), upload (Upload-Offset), Portal terminal, cron runs, database import/export trả job.
DBML: databases unique(server_id, engine, name), file_operations, upload_sessions (uuid, staging), ftp trên
sftp_accounts (password_encrypted), terminal_sessions (uuid, ended_reason); make db-schema, db-verify,
make db-migrations PHASE=6. make contracts → make codegen → codegen-check.
Kiểm thử: contracts-check, examples hợp lệ/không hợp lệ cho op mới, db-verify, SchemaTest Phase 6.
```

## Prompt 6.2 — Agent ops

```
[ITSO Panel] Prompt 6.2 — Agent: File Manager hạ quyền, database, SFTP/FTPS, cron
Phạm vi: internal/fsx (openat2 RESOLVE_BENEATH|NO_MAGICLINKS|NO_XDEV, helper `itso-agent fs-helper` chạy với
Credential uid/gid account + no_new_privs, giao tiếp JSON qua stdin/stdout, chuyển fd staging cho upload);
fs.list/stat/read/write/mkdir/move/copy/delete/chmod/archive/extract/upload.commit; nén zip/tar.gz an toàn.
db.mysql.* / db.pg.*: create/drop/user_ensure/user_drop/grant/owner_ensure/lock/dump/import (SQL qua stdin,
dump/import chạy dưới uid account bằng danh tính unix_socket/peer). sshd.match.apply (sshd -t + hoàn tác),
sftp.user.ensure/remove (group, chpasswd stdin), ftp.user.ensure/remove (pure-pw, puredb), ssh.keys.apply.
cron.apply (OnCalendar + unit + script), cron.inspect, cron.run_once (systemd-run trong slice).
Sandbox: mô phỏng các công cụ; mock agent: op mới. packaging: thư mục /etc/itso-cron, /etc/ssh/itso_authorized_keys, /var/lib/itso/uploads.
Kiểm thử: golden argv/SQL/file; test tấn công trên FS thật: ../, đường dẫn tuyệt đối, symlink ra ngoài home,
symlink đổi giữa chừng (race), zip slip, zip bomb, tar có hardlink/device/setuid; SQL identifier injection
bị từ chối trước khi chạy lệnh; cron DOM+DOW bị từ chối; sshd -t lỗi → khôi phục; fuzz đường dẫn và cron.
```

## Prompt 6.3 — Panel API

```
[ITSO Panel] Prompt 6.3 — Database, File, SFTP/FTP, SSH key, Cron API
Phạm vi: model Database/DatabaseUser/SftpAccount/SshKey/CronJob/CronRun/UploadSession/FileOperation; DatabaseService
(quota database_limit/db_user_limit theo gói, FOR UPDATE, tiền tố `<username>_`, mật khẩu sinh/đổi lưu mã hóa, job chỉ
mang tham chiếu bí mật, import/export qua job), FileService (gọi agent đồng bộ cho list/read/write, job cho
archive/extract/move lớn, upload kiểu tus: chunk vào staging, kiểm offset/sha256, commit qua job; download stream;
ghi file_operations + audit), SFTP/FTP (ftp_limit, subpath trong home), SSH key (fingerprint, trùng → 409),
CronService (cron_limit, cron_min_interval_min, job cron.apply theo account, chạy ngay ghi cron_runs,
`itso:cron-sync` gọi cron.inspect); tạm khóa/mở khóa account: khóa DB, tắt cron, khóa FTP; reconcile;
Portal: mọi tài nguyên của account mình (404 ngoài). Ma trận quyền mở rộng.
Kiểm thử: Pest khớp OpenAPI mọi endpoint (admin + portal), quota 422, tên sai/injection 422, bí mật không có trong
job_steps/audit, upload resume sai offset 409, file > 2 MiB không mở editor, cron dưới khoảng tối thiểu 422,
suspend khóa đủ tài nguyên, ma trận quyền.
```

## Prompt 6.4 — Terminal USER

```
[ITSO Panel] Prompt 6.4 — Terminal cho USER: pty.open, itso-gateway, phiên terminal
Phạm vi: agent pty.open (kiểm uid ≥ 1000, account có SSH, ≤ 2 phiên), ticket một lần 30 s, socket stream
/run/itso/agent-stream.sock (peercred itso-gw), systemd-run --pty với thuộc tính jail (D-75), resize, đóng khi
nhàn rỗi 15 phút; sandbox: shell giả. cmd/itso-gateway: WebSocket /gateway/terminal?ticket=…, chuyển khung
dữ liệu và resize, không tự quyết quyền; packaging itso-gateway.service (user itso-gw, hardening); Laravel
/terminal/sessions (admin + portal; step-up; ghi terminal_sessions, audit), lệnh dọn phiên quá hạn; make dev chạy
gateway, Vite proxy /gateway.
Kiểm thử: Go: ticket dùng lại/hết hạn bị từ chối, uid 0 bị từ chối, golden argv systemd-run, gateway nối hai
chiều (test với agent giả); Pest: gói không có SSH 409, account khóa 409, chưa step-up 403, ma trận quyền.
```

## Prompt 6.5 — UI

```
[ITSO Panel] Prompt 6.5 — Nối UI Databases/File Manager/SFTP/Cron/Terminal vào API thật
Phạm vi: trang demo Phase 2 gọi API thật qua lớp realm: Databases (tạo DB/user, quyền, đổi mật khẩu hiện một lần,
import/export qua job), File Manager (2 pane, editor có xung đột 409, upload resumable có tạm dừng/tiếp tục, tải về,
nén/giải nén, chmod), SFTP (user chính, FTP phụ, SSH key), Cron (tạo/sửa, chạy ngay, lịch sử), Terminal (xterm.js
qua gateway) cho Admin và Portal; lỗi job dễ hiểu; quota theo gói. MSW cập nhật theo contract mới. Chuỗi VI/EN đủ.
Kiểm thử: Vitest cho logic mới (upload chunk/resume, cron, path), Playwright demo cập nhật, axe không lỗi mới,
lint/i18n xanh.
```

## Prompt 6.6 — Tích hợp và báo cáo

```
[ITSO Panel] Prompt 6.6 — e2e stack thật, VM Phase 6, review bảo mật, báo cáo, merge
Phạm vi: Playwright stack thật + agent sandbox: tạo DB + user → export → import; File Manager tạo thư mục, upload
(resume), sửa file, nén/giải nén, tải về; tạo FTP phụ + SSH key; cron tạo → chạy ngay → lịch sử; terminal mở và
nhận output; Portal làm tương tự trên account mình. tests/vm/phase6.sh: test tấn công File Manager trên kernel thật
dưới uid account, chroot SFTP không thoát được, FTPS bắt buộc TLS, cron chạy đúng uid và nằm trong slice, upload
1 GB resumable, import/export DB, import không đụng DB account khác, terminal trong jail; review bảo mật File Manager
(docs/security/file-manager-review.md); make check xanh; docs/reports/phase-6.md (tiêu chí, phần "chờ VM");
runbook docs/runbooks/phase-6-hosting-data.md; merge phase-6 → main (local); DỪNG trước Phase 7.
Tiêu chí nghiệm thu Phase 6 (11-ROADMAP): mọi test tấn công bị chặn; upload 1 GB resumable; DB import/export qua
job; cron chạy dưới uid account, bị giới hạn bởi slice.
```
