# Review bảo mật Backup Center (Phase 8, Prompt 8.7)

- **Ngày:** 2026-11-21 · **Phạm vi:** đích + repo restic, policy và lịch, bộ khôi phục, duyệt/khôi phục, kiểm chứng, quota, purge kèm snapshot cuối, DR panel (Laravel `app/Domain/Backup/*`, controller `BackupAdminController`, `Shared/BackupController`, `Setup/*` phần restore, lệnh `itso:backup-*`, `itso:dr-restore`; agent `internal/backup`, `ops/backup*.go`, `ops/panel_restore.go`, `itso panel-restore-apply`, `itso backup panel-restore`).
- **Quyết định liên quan:** D-82 → D-87, ADR 0029–0033, threat model `docs/security/threat-model.md`.
- **Cách review:** đọc code theo từng đường vào và đối chiếu với test tự động: Pest `Phase8/*`, Go `backup/*_test`, `ops/backup*_test`, Vitest, Playwright demo và e2e stack thật `e2e-real/phase8.spec.ts` (restic thật trong sandbox agent). Phần cần kernel, systemd, MariaDB, rest-server thật hoặc 2 máy ghi **chờ VM** (`tests/vm/phase8.sh` B0–B6).

## 1. Ranh giới tin cậy

```text
Trình duyệt ──HTTPS──► Laravel (user itso, không chạy lệnh) ──HMAC/unix socket──► itso-agent (root)
   │ quyền backup.* + step-up          │ job params chỉ có {"$secret": …}        │ validate lại (JSON Schema + Go)
   │ kit hiện một lần                  │ bí mật giải ngay trước khi gọi agent   ├─ restic (systemd-run, itso-maint.slice)
   │                                   │                                         ├─ dump/import DB dưới uid account
   └─ Portal: chỉ snapshot của account, MFA + step-up                           └─ staging root 0700 → helper uid account
Đích (local / sftp / s3 / rest) ◄── chỉ credential GHI; prune/forget tắt mặc định (policy agent backup.forget=false)
```

1. **Laravel** chỉ dựng tham số kiểu hóa: đường dẫn repo do agent dựng từ UUID (`itso/<server>/acct-<account>|server`), tag trong danh sách cố định (`BackupTag`), mục khôi phục là `files:<RelPath>`, `website:<domain>`, `database:<DbName>`. Không có ô "lệnh restic tự do", không có `--option` do người dùng nhập.
2. **Agent** validate lại mọi tham số, ghi mật khẩu repo, URL rest có credential và credential S3 vào file 0600 (`--password-file`, `--repository-file`, `EnvironmentFile`), không bao giờ đưa vào argv.
3. **Dữ liệu account** đi qua uid account: dump/import DB bằng danh tính chủ (D-71), chép từ staging vào home bằng helper `fsx` (bỏ setuid/thiết bị, không theo symlink, chủ = account).

## 2. Các mối đe dọa và biện pháp

| # | Tấn công / rủi ro | Biện pháp | Kiểm bằng |
|---|---|---|---|
| B1 | Lộ mật khẩu repo / credential đích qua job, log, audit | Job params chỉ chứa tham chiếu `{"$secret":"kind:uuid"}`; giải ở `Secrets::resolve` ngay trước khi gửi agent; agent ghi file 0600 trong thư mục tạm root, xóa sau op; lỗi restic được làm sạch (URL rest bỏ user:pass) | Pest `BackupTest` (không có mật khẩu trong jobs/job_steps/job_logs/audit_logs), Go `backup_test` (sanitize stderr, argv không có bí mật) |
| B2 | Mất bộ khôi phục / lộ bộ khôi phục | Kit (đích, đường dẫn + mật khẩu repo server, khóa riêng age) hiện **một lần**; SA phải tick "đã lưu offline"; xem lại cần SUPER_ADMIN + step-up và ghi audit; đích báo "chưa xác nhận" khi kit cũ thiếu mục | Pest `BackupTest` (đích + bộ khôi phục); e2e stack thật (lần 2 → 403 hoặc `first_view=false`); Vitest dialog |
| B3 | Ransomware / panel bị chiếm xóa backup | Panel/agent chỉ giữ credential ghi; rest-server `--append-only`, S3 Object Lock (phát hiện khi kiểm tra), forget/prune tắt bằng policy agent; prune thật chạy `itso backup prune` trên máy chủ với credential nhập tại chỗ | Go `policy/policy_test` (backup.forget tắt mặc định); checklist 3-2-1-1-0; **VM B3** (forget bằng credential panel thất bại trên rest-server append-only) |
| B4 | Đọc file người khác / file hệ thống qua duyệt hoặc khôi phục | Duyệt chỉ trong snapshot của account (Portal lọc theo account, snapshot lạ → 404/422); đường dẫn là `RelPath` (chặn `..`, tuyệt đối, ký tự điều khiển); khôi phục vào staging root 0700 ngoài home rồi helper uid account chép vào, bỏ symlink/thiết bị/setuid (báo `skipped`) | Go `ops/backup_restore_test` (symlink tới `/etc/shadow`, setuid, thiết bị bị bỏ); Pest; e2e stack thật (Portal thấy đúng snapshot của mình, snapshot account khác bị từ chối) |
| B5 | Ghi đè dữ liệu đang chạy do nhầm lẫn | Mặc định khôi phục ra bản mới (`backups/restore-<ts>/`, DB `<tên>_r<ts>`); ghi đè chỉ một website hoặc một DB mỗi lần, cần gõ username + step-up; snapshot "pre-restore" của bản hiện tại trước khi đổi tên nguyên tử | Pest `BackupTest` (khôi phục); Vitest `RestoreWizard`; e2e stack thật (ghi đè website + DB, nội dung về bản gốc) |
| B6 | Portal tự khôi phục khi phiên bị chiếm | Portal phải bật MFA, step-up trong kỳ TOTP mới; chỉ khôi phục ra bản mới hoặc ghi đè trong account của mình; quota backup theo gói | Pest `BackupTest` (Portal khôi phục của mình); e2e stack thật (403 khi chưa MFA → bật TOTP → step-up → thành công) |
| B7 | Snapshot dở (mất mạng, hết đĩa) bị tính là điểm khôi phục | Panel chỉ ghi `backup_snapshots` khi restic trả `summary` với `snapshot_id`; lỗi giữa chừng → job `failed`, không có bản ghi; lần sau restic dùng lại dữ liệu đã tải lên | Pest; **VM B4** (chặn cổng rest-server giữa chừng) |
| B8 | Backup làm sập website (CPU/IO) | restic chạy `systemd-run --wait` trong `itso-maint.slice` (CPUQuota 50 %, IOWeight 10, Nice 10, PrivateTmp, NoNewPrivileges); một tác vụ một repo (khóa Redis + khóa restic); jitter lịch | Go argv golden; **VM B5** |
| B9 | Mã độc trong bản backup quay lại khi khôi phục | Khôi phục không giữ setuid, không theo symlink; khuyến nghị quét (Security Center) sau khôi phục; snapshot có `verified_at` và lịch restore test | Go `ops/backup_restore_test`; checklist "0 lỗi" |
| B10 | Backup hỏng không ai biết | `restic check --read-data-subset=5%` hằng tuần; restore test hằng tháng so sha256 với manifest trong `itso-meta.json`, DB nạp vào DB tạm rồi xóa; checklist 3-2-1-1-0 tính từ dữ kiện thật | Pest `BackupTest` (kiểm chứng); e2e stack thật (`itso:backup-verify`) |
| B11 | Purge account làm mất dữ liệu vĩnh viễn | Purge cần snapshot cuối (`final`) đã kiểm chứng, lịch purge + xác nhận lại (409 `precondition_failed` khi chưa đủ điều kiện); snapshot `final` không bị retention xóa | Pest `BackupTest` (purge D-46); Vitest |
| B12 | DR: lộ bí mật khi khôi phục panel | Wizard chỉ chạy ở `restore_mode` (máy mới, chưa thiết lập), mã thiết lập + giới hạn 10 lần thử / 10 phút / IP; bí mật job nằm trong Redis mã hóa bằng APP_KEY máy mới, hết hạn 2 giờ, xóa khi job xong; bản rõ ở staging root 0700 bị xóa sau khi áp | Pest `DisasterRecoveryTest`; Go `ops/panel_restore_test` (staging bị xóa); installer test `--restore` |
| B13 | DR: bản backup panel bị thay bằng bản độc | Dữ liệu panel mã hóa thêm bằng age (X25519); chỉ khóa riêng trong kit giải được; `pg_restore --single-transaction --exit-on-error`, lỗi thì DB không đổi; giữ `itso.env`, `agent.key`, `tls/` của máy mới | Go `ops/panel_restore_test`; **VM B6** |
| B14 | Đích SFTP giả mạo (MITM) | Khóa SSH riêng mỗi đích do agent sinh; host key ghim ở lần kiểm tra đầu, sau đó `StrictHostKeyChecking=yes` với known_hosts riêng; DR qua SFTP chỉ bằng CLI (cần khóa + ghim lại host key) | Go `backup/backup_test` (URL repo + sftp.command golden) |

## 3. Kết quả

- Không tìm thấy lỗ hổng mới trong mã Phase 8 khi review theo bảng trên.
- **Lỗi tìm thấy và sửa ở 8.6–8.7 khi chạy UI với API thật** (demo MSW lệch API):
  - Bộ khôi phục thiếu `destination_uuid`: DR không xác định được đích.
  - Đường dẫn dump DB trong snapshot là `db/<tên>.sql|.dump`, UI dựng sai từ cây file. Nay chọn DB theo danh sách `databases` của snapshot.
  - UI cho ghi đè nhiều mục, chọn máy chủ đích và mục "config" mà API từ chối. Nay ghi đè chỉ một website/DB, không có máy chủ đích (Phase 9).
  - Đích `local` cho nhập đường dẫn, API chỉ nhận `/var/backups/itso`. Nay cố định, UI chỉ hiển thị.
  - Khóa retention: contract/UI dùng `keep_*`, API dùng `last/daily/...`. Contract sửa trước (`last, hourly, daily, weekly, monthly`), rồi API + UI + DBML theo contract.
  - Ngữ nghĩa purge trong demo khác API (409/422 và job `hosting_account.purge`). Đã khớp lại.

## 4. Rủi ro còn lại / đề xuất

1. **Đích `local` cùng máy chủ** không bảo vệ khi mất máy: chỉ tính 1 bản sao, không off-site. Checklist 3-2-1-1-0 báo đỏ; runbook yêu cầu ít nhất một đích off-site + một đích bất biến.
2. **Credential ghi vẫn ghi đè được dữ liệu** trên đích không immutable (sftp, local, s3 không Object Lock): kẻ chiếm root máy chủ có thể xóa repo. Biện pháp là đích append-only/Object Lock.
3. **Danh sách bản backup panel** chưa hiện phiên bản panel và số account (nằm trong bản mã hóa age); SA chọn theo thời gian.
4. **Agent thật chưa có op `account.remove`** cho bước cuối của purge (Phase 6 mới có mock): purge thật trên VM cần op này trước khi bật.
5. **Bản ghi phiên terminal (Phase 7)** chưa đưa vào retention; vẫn đề xuất cho Phase sau.
6. **Chờ VM:** `tests/vm/phase8.sh` B0–B6 chưa chạy (container không có KVM/systemd/MariaDB thật; B6 cần 2 VM).
