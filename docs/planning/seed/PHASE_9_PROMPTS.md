# Phase 9 — Multi-server & chuyển tài khoản: prompt chi tiết

> Viết ngày 2026-11-21, sau khi Phase 8 hoàn tất (`v0.1.0-alpha`, merge `7ec1afb`) và người dùng yêu cầu "sau khi xong parse 8 thì lên kế hoạch parse 9". Nguồn: `ROADMAP.md` §Phase 9, `ARCHITECTURE.md` §8 (topology), `docs/planning/02-ARCHITECTURE.md` §9–11 (agent remote mTLS, CA nội bộ), `DECISIONS.md` D-41, D-48, D-62, D-66, D-85, `contracts/agent-ops/catalog.json` (op `migrate.*` đã `specified` từ Phase 1), OpenAPI `/servers/enrollment-tokens`, `/servers/{id}/capacity`, `/placement/suggestions`, `/hosting-accounts/{id}:migrate`, `/account-migrations*` (đang trả 501), DBML `agents`, `agent_enrollment_tokens`, `server_capacity`, `account_migrations`, trang demo `ServerNewPage`, `AccountMigratePage` (Phase 2).
> Nhánh `phase-9`. Làm hàng loạt 9.0 → 9.8, tự merge local, DỪNG trước Phase 10. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED. Phase 9 không có mốc phát hành (mốc kế tiếp `v0.5.0-beta` sau Phase 11).
> Mockup trước khi code: Prompt 9.0 dựng màn hình và trạng thái mới trên bản demo (MSW), chụp ảnh vào `docs/screenshots/phase-9/`.
> **Điều kiện bắt đầu:** người dùng duyệt Phase 8 (D-82 → D-87) và kế hoạch này.

## Mục tiêu Phase 9

Một panel quản lý nhiều server: thêm node bằng lệnh join một lần, node **chỉ kết nối ra** control plane qua mTLS (không mở cổng quản trị inbound), CA nội bộ cấp và xoay vòng chứng chỉ, job chạy đúng server và xử lý đúng khi node mất kết nối, gợi ý server khi tạo account, **chuyển account giữa các server** có kiểm tra dữ liệu, cutover và rollback (D-48), và khôi phục backup sang server khác (phần hoãn từ D-85).

## Ràng buộc môi trường

- Như Phase 4–8: container không có systemd/KVM. Multi-server được test bằng **nhiều agent `--sandbox` trên cùng máy**, mỗi agent một gốc sandbox riêng: agent local qua unix socket như hiện nay, agent "node" kết nối ra relay qua mTLS trên loopback. Restic thật dùng cho dữ liệu chuyển account.
- Bộ test VM `tests/vm/phase9.sh` cần **3 VM** (control plane + 2 node): script sẵn sàng, kết quả **chờ VM**.
- Không chạy lệnh từ Laravel (cấm exec). Laravel không giữ khóa riêng CA: ký chứng chỉ qua op của agent local. Mọi thao tác máy chủ đi qua job + audit; params job không chứa bí mật.

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-88 | Vai trò cài đặt | `install.sh --role all-in-one` (mặc định, như hiện nay) · `--role control-plane` (panel không chạy hosting, không tạo account trên máy này) · `--role node --join <url> --token <token> --ca-sha256 <pin>` (chỉ agent + runtime hosting, không Laravel/PostgreSQL/Redis). `itso node status\|rejoin\|leave`. Server all-in-one cũ trở thành "server local" của control plane, không đổi gì | D-41; giữ đường nâng cấp từ v0.1.0-alpha |
| D-89 | Kênh agent từ xa | Dịch vụ mới **`itso-relay`** (Go, user `itso-relay`, không root) trên control plane: nghe `:28444` TLS 1.3 + **mTLS bắt buộc**; agent node mở kết nối ra (WebSocket trên HTTPS, ping 20 giây, reconnect lũy thừa tới 60 giây). Laravel gọi relay qua unix socket `/run/itso/relay.sock` với `server_uuid`; relay chuyển envelope nguyên vẹn. Envelope vẫn ký HMAC (D-66) bằng **khóa riêng mỗi server** (sinh lúc enroll), nên relay không giả được op. Agent node giữ nguyên validate + policy cục bộ. Stream (terminal/log) đi cùng kênh, multiplex theo ticket | Node không mở cổng quản trị inbound; relay bị chiếm vẫn không ra lệnh được |
| D-90 | CA nội bộ và chứng chỉ | CA ECDSA P-256 sinh lúc cài control plane, khóa riêng `/etc/itso/pki/ca.key` root 0600, chỉ agent local dùng (op `pki.sign_csr`, chỉ nhận CSR từ luồng enroll/rotate, CN = `server_uuid`). Chứng chỉ node 30 ngày, khóa riêng sinh và nằm trên node; tự xoay ở 2/3 hạn (`agent.cert.rotate` qua kênh hiện có); hết hạn → node offline, `itso node rejoin`. Token enroll 32 byte, hạn 1 giờ, dùng một lần, chỉ lưu sha256; lệnh join ghim sha256 CA. Thu hồi: xóa server → fingerprint vào danh sách chặn của relay ngay | Không phụ thuộc CA ngoài; lộ token chỉ dùng được một lần, trong 1 giờ |
| D-91 | Job khi node mất kết nối | Hàng đợi theo server; node offline → job ở `waiting_agent` tới `deadline` (mặc định 30 phút, op đọc 2 phút) rồi `failed` mã `agent_unreachable`; op_id idempotent nên gửi lại an toàn khi node quay lại giữa chừng (agent trả kết quả cache). Heartbeat 20 giây; 3 lần lỡ → server `degraded`, 5 phút → `unreachable` + thông báo. Panel không tự chuyển account khi node chết | Đúng tiêu chí "mất kết nối thì job chờ hoặc timeout đúng"; không làm hai lần một thao tác |
| D-92 | Năng lực và gợi ý server | `server_capacity` từ facts agent (CPU, RAM, đĩa, inode, số account, phiên bản PHP/DB) + tổng hạn mức đã cấp theo gói. Gợi ý = lọc (role tag `web`, `accepting_new_accounts`, đủ PHP/DB của gói, đĩa sau cấp ≥ 15 %) rồi xếp theo tỉ lệ cam kết thấp nhất; chỉ **gợi ý**, admin chọn. Không đặt chỗ tự động (DEFERRED) | Dễ hiểu, giải thích được lý do từng gợi ý |
| D-93 | Chuyển account | Dữ liệu đi **qua repo restic** (tái dùng Phase 8, không mở kênh node↔node): preflight (phiên bản PHP/DB, đĩa, username/UID ở đích, xung đột domain) → tạo account ở đích (cùng username; giữ UID nếu trống, không thì UID mới + chủ sở hữu theo account) → sync lần đầu (backup ở nguồn → restore ở đích, site đích chưa nhận traffic) → kiểm tra (sha256 manifest, số dòng + checksum bảng, HTTP check qua Host header ở đích) → **cutover**: tạm khóa account ở nguồn (trang bảo trì, dừng PHP-FPM/cron/SFTP), sync tăng dần lần cuối, kiểm tra lại, bật ở đích, đổi DNS nếu zone do panel quản lý (không thì hiện bản ghi cần đổi) → giữ nguồn 7 ngày (khóa) → dọn dẹp bằng `account.remove`. **Rollback** ở mọi bước trước dọn dẹp: mở khóa nguồn, trả DNS, gỡ account đích. Đo downtime từ lúc khóa nguồn tới lúc đích trả 200 | D-48; tái dùng đường backup/restore đã test với restic thật, nguồn không bị đụng tới khi chưa cutover |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code; mọi thay đổi máy chủ đi qua job + audit; params job không chứa bí mật; thao tác dữ liệu account chạy dưới uid account.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 9.0 | **Mockup:** thêm server (token + lệnh join), danh sách server nhiều node (kết nối, chứng chỉ, năng lực), gợi ý server khi tạo account, wizard chuyển account (preflight → sync → kiểm tra → cutover → giữ nguồn → dọn dẹp, rollback), khôi phục sang server khác, trạng thái node offline/job chờ; ảnh `docs/screenshots/phase-9/` | 0,5 ngày |
| 9.1 | ADR 0034–0038 (D-88…D-93); contracts agent-ops (`pki.sign_csr`, `agent.cert.rotate`, `migrate.*` viết lại, `http.check`, `account.remove`); OpenAPI rà lại; DBML + migration Phase 9 | 0,5 ngày |
| 9.2 | PKI + kênh: CA, `itso-relay` (mTLS, unix socket cho Laravel, chặn fingerprint), agent node kết nối ra (reconnect, ping, stream), khóa HMAC mỗi server, `AgentClient` chọn kênh theo server | 1,5 ngày |
| 9.3 | Installer + CLI: `--role control-plane\|node --join`, `itso node status\|rejoin\|leave`, timer xoay chứng chỉ, unit `itso-relay`, tường lửa node không mở cổng quản trị; test installer | 1 ngày |
| 9.4 | Panel API nhiều server: token enroll, enroll/heartbeat, danh sách + năng lực, job theo server (chờ/timeout D-91), gợi ý server, thu hồi/xóa server, thông báo node mất kết nối | 1 ngày |
| 9.5 | Agent: `migrate.preflight\|verify\|cutover\|rollback`, `http.check`, `account.remove` (thật, thay mock), khôi phục sang server khác (repo của server nguồn); test Go với restic thật trên 2 gốc sandbox | 1,5 ngày |
| 9.6 | Panel: điều phối chuyển account (máy trạng thái, cutover, rollback, giữ nguồn + dọn dẹp, DNS), khôi phục sang server khác, quyền + audit, Pest | 1,5 ngày |
| 9.7 | UI nối API thật theo mockup 9.0, MSW theo hành vi mới, i18n vi/en | 1 ngày |
| 9.8 | Tích hợp: e2e stack thật với 2 agent (một qua relay), `tests/vm/phase9.sh` (3 VM), review bảo mật, `make check`, báo cáo, merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p9)`, `test(p9)`, `docs(p9)`; đồng bộ bản sao lưu.

## Prompt 9.0 — Mockup

```
[ITSO Panel] Prompt 9.0 — Mockup Multi-server & chuyển tài khoản (trước khi code)
Phạm vi: chỉ bản demo (apps/web + src/demo + contracts/tools/demo.py), không đụng API/agent.
Màn hình và trạng thái:
- Máy chủ › Thêm server: tạo token (hạn 1 giờ, dùng một lần), lệnh join có ghim sha256 CA (sao chép), chờ node kết
  nối (đếm ngược), node đã vào → điền tên/role tag.
- Danh sách server: vai trò (control plane / all-in-one / node), kênh (local / mTLS), trạng thái kết nối (online,
  degraded, unreachable, lần thấy cuối), chứng chỉ (hạn, xoay vòng), phiên bản agent, năng lực (CPU/RAM/đĩa, số
  account, % cam kết), nhận account mới bật/tắt.
- Chi tiết server: tab Năng lực, tab Kết nối (fingerprint, lịch sử xoay chứng chỉ, thu hồi), job đang chờ node.
- Tạo account: gợi ý server kèm lý do (đủ PHP 8.3, đĩa còn 62 %, cam kết thấp nhất) + server bị loại và vì sao.
- Chuyển account: chọn server đích → kết quả preflight (đạt/cảnh báo/chặn) → tiến trình sync (dung lượng) → bảng
  kiểm tra (file sha256, số dòng + checksum từng bảng, HTTP) → xác nhận cutover (ước tính downtime, DNS tự đổi hay
  cần làm tay) → giữ nguồn (đếm ngược 7 ngày) → dọn dẹp; rollback ở mọi bước; danh sách lượt chuyển.
- Khôi phục từ backup: tùy chọn "sang server khác" (bỏ chặn của 8.6).
- Node mất kết nối: banner trên server, job "chờ node", job hết hạn "agent_unreachable".
Chụp: e2e/screenshots-phase9.spec.ts, make screenshots → docs/screenshots/phase-9.
Kiểm thử: Vitest/Playwright demo + axe xanh; i18n vi = en; check_demo.py.
```

## Prompt 9.1 — ADR và contracts

```
[ITSO Panel] Prompt 9.1 — ADR Multi-server, contracts Phase 9, migration
Phạm vi: docs/adr/0034-roles-topology.md (D-88), 0035-agent-relay-mtls.md (D-89), 0036-internal-ca.md (D-90),
0037-jobs-offline-placement.md (D-91, D-92), 0038-account-migration.md (D-93).
Contracts agent-ops: pki.sign_csr (chỉ agent local của control plane, CSR + server_uuid), agent.cert.rotate,
migrate.preflight / migrate.verify / migrate.cutover / migrate.rollback viết lại theo D-93 (dữ liệu qua BackupRepo,
không nhận đường dẫn/host tự do), http.check (Host header, đường dẫn tương đối, chỉ 127.0.0.1 của node),
account.remove (xóa home/pool/vhost/DB/user của account, cần cờ xác nhận + username khớp). Lỗi mới: agent_unreachable,
cert_expired, enrollment_invalid. Vector độc: CSR CN lạ, token, Host header, đường dẫn kiểm tra.
OpenAPI rà lại: enrollment-tokens, enroll (dùng token, trả cert + khóa HMAC một lần), servers (kết nối, chứng chỉ,
năng lực), placement/suggestions, :migrate, account-migrations (+ :cutover, :rollback, :cleanup), restore sang server
khác. DBML: agents (cert, hmac_key mã hóa, last_seen), agent_revocations, server_capacity, account_migrations (cột
theo máy trạng thái), jobs.waiting_agent; migration Phase 9; make db-verify.
make contracts, make codegen, codegen-check xanh.
```

## Prompt 9.2 — PKI và kênh agent từ xa

```
[ITSO Panel] Prompt 9.2 — CA nội bộ, itso-relay, agent kết nối ra
Phạm vi: agent/internal/pki (CA, ký CSR có kiểm CN/hạn/khóa, chứng chỉ 30 ngày), cmd/itso-relay (TLS 1.3 + mTLS,
danh sách chặn fingerprint, một kết nối mỗi server_uuid, unix socket /run/itso/relay.sock cho Laravel, giới hạn
kích thước/tốc độ, multiplex stream), agent: chế độ node (dial ra relay, ping, reconnect lũy thừa, nhận envelope
→ cùng dispatcher/validate/policy như socket local), khóa HMAC mỗi server. Laravel AgentClient chọn kênh theo
agents.transport (local | mtls).
Sandbox/dev: make dev chạy thêm itso-relay + một agent "node" (gốc sandbox riêng) qua mTLS loopback.
Test: Go (chứng chỉ sai CA/hết hạn/bị chặn bị từ chối, CN ≠ server_uuid bị từ chối, envelope ký sai khóa server bị
agent từ chối dù qua relay, reconnect giữ op_id idempotent), Pest (AgentClient theo transport).
```

## Prompt 9.3 — Installer và CLI

```
[ITSO Panel] Prompt 9.3 — install --role, itso node
Phạm vi: itso install --role all-in-one|control-plane|node; node: --join <url> --token --ca-sha256 (kiểm pin trước
khi gửi token, sinh khóa + CSR trên node, nhận cert + khóa HMAC, ghi /etc/itso/pki 0600), không cài Laravel/
PostgreSQL/Redis trên node; control-plane: unit itso-relay + mở 28444 trong tường lửa; node: không mở cổng quản trị
inbound. CLI: itso node status|rejoin|leave; timer itso-cert-rotate. units-check, test-installer (fake) cho từng vai trò.
```

## Prompt 9.4 — Panel API nhiều server

```
[ITSO Panel] Prompt 9.4 — enroll, server, job theo server, gợi ý
Phạm vi: POST /admin/servers/enrollment-tokens (SA + step-up, trả token + lệnh join một lần), endpoint enroll
(không cần phiên; token một lần + CSR → pki.sign_csr qua agent local), heartbeat/facts → server_capacity, danh sách
server (kết nối, chứng chỉ), xóa/thu hồi server (chặn khi còn account), job theo server + waiting_agent/deadline
(D-91), thông báo degraded/unreachable, GET /admin/placement/suggestions?package= (D-92), form tạo account dùng gợi ý.
Test Pest: token dùng lại/hết hạn bị từ chối, CN lạ bị từ chối, job chờ rồi timeout, op gửi lại sau reconnect
không chạy hai lần, ma trận quyền (ADMIN chỉ server được giao), gợi ý đúng thứ tự + lý do loại.
```

## Prompt 9.5 — Agent: chuyển account, account.remove

```
[ITSO Panel] Prompt 9.5 — migrate.*, http.check, account.remove
Phạm vi: migrate.preflight (phiên bản PHP/DB, đĩa, username/UID, domain), migrate.verify (manifest sha256, số dòng +
checksum bảng, http.check), migrate.cutover (khóa account nguồn: bảo trì + dừng pool/cron/SFTP; mở ở đích),
migrate.rollback; http.check; account.remove thật (thay mock, kiểm username + cờ, thứ tự: vhost → pool → cron →
SFTP → DB/user DB → home → user Linux); backup.restore nhận repo của server khác (khôi phục chéo server).
Test Go với restic thật trên 2 gốc sandbox: backup ở nguồn → restore ở đích → verify khớp; sửa file sau sync đầu →
sync cuối mang theo; rollback trả nguồn hoạt động; account.remove không đụng account khác, symlink không bị theo.
```

## Prompt 9.6 — Panel: điều phối chuyển account

```
[ITSO Panel] Prompt 9.6 — account migration orchestration
Phạm vi: POST /admin/hosting-accounts/{id}:migrate (SA/ADMIN có quyền cả 2 server + step-up), máy trạng thái
preflight → syncing → verifying → ready_for_cutover → cutover → holding → completed | rolled_back | failed, mỗi bước
một job (op_id idempotent); :cutover (step-up, đo downtime), :rollback, :cleanup (sau hạn giữ, hoặc sớm khi SA xác
nhận); DNS: zone do panel quản lý thì đổi bản ghi + giảm TTL trước cutover, không thì hiện bản ghi cần đổi; account
đổi server_id khi cutover xong; khôi phục backup sang server khác; audit + thông báo.
Test Pest: luồng đủ, preflight chặn (PHP thiếu, đĩa thiếu, domain trùng), node đích mất kết nối giữa sync → chờ/
timeout, rollback ở từng bước, không cutover khi verify lệch, Portal thấy trạng thái "đang chuyển" (không thao tác ghi).
```

## Prompt 9.7 — UI

```
[ITSO Panel] Prompt 9.7 — UI Multi-server nối API thật
Phạm vi: Thêm server (token + lệnh join, chờ node), danh sách/chi tiết server (kết nối, chứng chỉ, năng lực, thu
hồi), gợi ý server khi tạo account, wizard chuyển account + danh sách lượt chuyển, khôi phục sang server khác, banner
node mất kết nối, Portal trạng thái "đang chuyển"; MSW theo hành vi mới; i18n vi/en.
Test: Vitest + Playwright demo + axe.
```

## Prompt 9.8 — Tích hợp và báo cáo

```
[ITSO Panel] Prompt 9.8 — e2e, VM Phase 9, review bảo mật, merge, DỪNG
Phạm vi: apps/web/e2e-real/phase9.spec.ts (tạo token → agent node sandbox join qua relay → server online → tạo
account trên node theo gợi ý → website + DB → chuyển sang server local → kiểm tra → cutover → site trả nội dung từ
đích → rollback một lượt khác; dừng agent node → job chờ rồi agent_unreachable; thu hồi node → relay từ chối),
tests/vm/phase9.sh (3 VM: N0 join 2 node, N1 node không có cổng quản trị inbound (nmap/ss), N2 mất mạng node → job
chờ/timeout đúng, N3 xoay chứng chỉ, N4 chuyển 1 site WordPress + 1 DB, so checksum + HTTP 200, đo downtime với 2 GB,
N5 rollback sau cutover, N6 thu hồi node), docs/security/multi-server-review.md, make check, docs/reports/phase-9.md,
merge --no-ff main, DỪNG.
```

## Tiêu chí nghiệm thu (ROADMAP §Phase 9)

| Tiêu chí | Cách chứng minh |
|---|---|
| Quản lý 3 server | e2e 2 agent (container) · **VM N0** 3 máy |
| Node không mở cổng quản trị inbound | Unit/tường lửa node (test installer) · **VM N1** |
| Mất kết nối agent: job chờ hoặc timeout đúng | Pest + e2e (dừng agent node) · **VM N2** |
| Chuyển account xong site chạy ở server đích | Go với restic thật · e2e · **VM N4** |
| Downtime cutover ≤ 5 phút với 2 GB | **VM N4** (máy tham chiếu) |
| Rollback cutover | Pest + Go + e2e · **VM N5** |

## Rủi ro

- Khác phiên bản PHP/DB giữa các server → preflight chặn hoặc cảnh báo, không tự nâng/hạ phiên bản.
- DNS cache khi cutover → giảm TTL trước, giữ nguồn ở chế độ khóa 7 ngày, có rollback.
- Relay là điểm tập trung: bị chiếm vẫn không ra lệnh được (HMAC mỗi server) nhưng có thể chặn kết nối (mất quản lý, không mất dữ liệu); review bảo mật ở 9.8.
- Giữ tương thích all-in-one v0.1.0-alpha: server local không đổi kênh; migration DB Phase 9 chỉ thêm cột/bảng.
