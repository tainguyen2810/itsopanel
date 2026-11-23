# Phase 12 — Production Hardening & Production Gate: prompt chi tiết

> Viết ngày 2026-11-23, sau khi Phase 11 được duyệt (merge `359ae17`, tag local `v0.5.0-beta`) và người dùng yêu cầu "merge và làm tiếp parse 12". Nguồn: `ROADMAP.md` §Phase 12 + Production Gate G1–G8, `DECISIONS.md` D-13 (đánh giá tách helper đặc quyền ở Phase 12), D-15 (`v1.0.0` sau Phase 12), D-47 (Gate G1–G8 có bằng chứng ở `docs/gate/G<n>.md`), D-50 (pentest độc lập bắt buộc trước khi mở bán cho khách ngoài), `docs/planning/11-ROADMAP.md` §Phase 12 (ASVS L2, CIS, RLS, 200 account/server, import, offline installer, chaos test, update/rollback 20 lần), `docs/planning/10-INSTALLER.md` (`--offline <bundle.tar>`, update/rollback, uninstall), `docs/planning/06-AGENT-SECURITY.md` §helper đặc quyền, mã đã có (`install/release.go` update + rollback tự động, `ITSO_RELEASE_DIR`, `tests/vm/*.sh`, review bảo mật Phase 6–11).
> Nhánh `phase-12`. Làm hàng loạt 12.0 → 12.8, tự merge, DỪNG cuối Phase 12. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.
> Mockup trước khi code: Prompt 12.0 dựng màn hình mới trên bản demo (MSW), chụp ảnh vào `docs/screenshots/phase-12/`.
> **Điều kiện bắt đầu:** người dùng yêu cầu bắt đầu Phase 12 (2026-11-23).

## Mục tiêu Phase 12

1. **Import từ panel khác:** aaPanel, HestiaCP và Nginx thuần (vhost + thư mục web + DB) → hosting account ITSO, chạy thử (dry-run) trước, không sửa máy nguồn.
2. **Hardening:** review nội bộ theo OWASP ASVS L2 (danh sách kiểm có bằng chứng), kiểm CIS Ubuntu 24.04 (L1, phần liên quan máy chủ hosting) chỉ đọc + hiển thị, quyết định RLS PostgreSQL và tách helper đặc quyền (ADR có số liệu).
3. **Hiệu năng:** đo và tối ưu ở 200 account/server (API, bộ đánh giá cảnh báo, metrics, trang danh sách).
4. **Vận hành:** offline installer (bundle), update/rollback lặp 20 lần + chaos (mất điện giữa update), chính sách cập nhật bảo mật, SBOM + ký release hoàn chỉnh, sổ tay vận hành.
5. **Production Gate G1–G8:** mỗi bài có tiêu chí đo được, phần tự động chạy được trong container, phần cần máy thật có script VM; bằng chứng ở `docs/gate/G<n>.md`.

**Tiêu chí nghiệm thu (ROADMAP):** không còn lỗ hổng High/Critical mở; update/rollback thành công 20 lần liên tiếp; tài liệu đầy đủ; Gate G1–G8 đạt **trên VM** trước `v1.0.0`.

## Ràng buộc môi trường

- Như Phase 4–11: container không có systemd/KVM/cgroup v2 đầy đủ/nftables thật. Bài Gate cần kernel, nhiều server, mất điện thật → script VM (`tests/vm/gate.sh`), đánh dấu **chờ VM**; phần kiểm được bằng agent sandbox, Pest, Go, Playwright stack thật thì làm ngay.
- **Không gắn `v1.0.0` khi Gate chưa đạt trên VM** (D-47). Cuối 12.8 phát hành `v1.0.0-rc.1` (tag local), `v1.0.0` chỉ sau khi có bằng chứng VM G1–G8 (xem D-115).
- Import chỉ **đọc** máy nguồn (agent op chỉ đọc cấu hình/thư mục được phép); dữ liệu đi vào account ITSO qua các op hiện có (tạo account, website, DB import, ghi file dưới UID account).
- Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code.

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-108 | Import từ panel khác | Op agent chỉ đọc `import.scan` (nguồn `aapanel` \| `hestia` \| `nginx`, trên **cùng máy** đang cài ITSO): phát hiện site, domain/alias, docroot, PHP, SSL, DB (tên, kích thước), cron, user hệ thống; trả **kế hoạch** (không đổi gì). Panel: wizard chọn mục → map sang gói/USER → job `import.run` theo account: tạo account ITSO → copy file (op `import.copy`: rsync-like trong agent, đọc nguồn, ghi dưới UID account, giữ quyền hợp lệ, bỏ symlink ra ngoài) → dump DB nguồn (MariaDB qua socket) → `db.import` vào DB mới → vhost/SSL (dùng lại chứng chỉ nếu hợp lệ, không thì ACME) → báo cáo khác biệt. Máy nguồn **không bị sửa**; site cũ vẫn chạy tới khi người dùng chuyển nginx (bước cutover riêng, có rollback). Import từ **máy khác**: DEFERRED (dùng chuyển account Phase 9 sau khi import tại chỗ) | Đường an toàn, test được bằng cây file giả; tái dùng op có sẵn |
| D-109 | CIS Ubuntu 24.04 | Op chỉ đọc `cis.audit` (≈ 40 mục L1 liên quan: mount option `/tmp`, sysctl mạng, SSH, auditd, cron quyền, tài khoản rỗng mật khẩu, unattended-upgrades, AppArmor, dịch vụ không cần…); trả pass/fail/n.a. + bằng chứng; panel hiển thị ở Security Center, gộp vào điểm bảo mật; **không tự sửa** (mục sửa được trỏ tới recipe hiện có: SSH hardening, firewall) | Chỉ đọc nên không phá máy hosting; tự sửa CIS dễ gãy dịch vụ |
| D-110 | RLS PostgreSQL | Đánh giá bằng thử nghiệm: bật RLS trên bảng phạm vi account (`hosting_accounts`, `websites`, `databases`, `backup_snapshots`, …) với `SET LOCAL itso.user_id` mỗi request; đo chi phí + độ phức tạp (job runner, scheduler, migration chạy với vai trò khác). **Đề xuất: chưa bật RLS ở v1.0**; giữ phạm vi ở tầng ứng dụng (`Access::*`) + test ma trận quyền tự động sinh từ route list (mọi route có tham số id phải có test ngoài phạm vi → 404); ghi lại kết quả đo trong ADR | Một DB user cho cả panel, worker, scheduler: RLS thêm rủi ro sai cấu hình nhiều hơn lợi ích ở quy mô nội bộ |
| D-111 | Tách helper đặc quyền (D-13) | Đánh giá: liệt kê op cần root thật, đo bề mặt; **đề xuất ở v1.0: giữ một agent root** + siết thêm (systemd sandboxing `ProtectSystem=strict` với `ReadWritePaths` theo nhu cầu, `CapabilityBoundingSet` tối thiểu, `SystemCallFilter=@system-service`, policy op cục bộ đã có, kiểm unit bằng `systemd-analyze security` ≤ 4.0 trên VM); tách helper: lộ trình v1.x (ADR ghi điểm tách) | Tách helper là thay đổi kiến trúc lớn; siết sandboxing cho lợi ích đo được ngay |
| D-112 | Hiệu năng 200 account/server | Bộ seed tổng hợp (200 account × 3 website × 2 DB, 7 ngày metrics, 10 nghìn job, 100 nghìn audit) trên PostgreSQL thật; mục tiêu: API danh sách p95 ≤ 300 ms, trang chi tiết p95 ≤ 200 ms, `alerts-evaluate` ≤ 10 giây/lượt, `metrics-collect` + `usage-refresh` ≤ 30 giây/server, `metric_samples` insert ≤ 5 giây/phút; công cụ `itso:bench` (artisan, chỉ đọc + DB test) ghi kết quả vào `docs/perf/`; sửa điểm nóng (index, N+1, phân trang cursor) | Rủi ro đã ghi từ Phase 11; con số đo được thay cho ước lượng |
| D-113 | Offline installer | `make release-offline` → `itso-<ver>-offline.tar` gồm gói release ký + toàn bộ `.deb` phụ thuộc cho Ubuntu 24.04 amd64 (danh sách khóa phiên bản, tải khi đóng gói, kiểm sha256) + FrankenPHP; `install.sh --offline <bundle.tar>` dựng repo apt cục bộ tạm (`file:` + `[trusted=yes]` chỉ trong lúc cài, xóa sau), không cần Internet; ACME tắt mặc định ở chế độ offline | 10-INSTALLER P2; máy chủ nội bộ không ra Internet |
| D-114 | Update/rollback 20 lần + chaos | `tests/vm/upgrade-loop.sh`: 20 vòng `update → kiểm site + panel → rollback → update`; chaos: `kill -9` agent/CLI và `echo b > /proc/sysrq-trigger` (mất điện) ở từng bước của `Update` (sau giải nén, sau migrate, sau đổi symlink) → khởi động lại → `itso doctor` phát hiện + `itso repair` hoàn tất hoặc quay lại; Update ghi **journal** (`/var/lib/itso/update.journal`) để tiếp tục/hoàn tác đúng bước; migration Laravel chỉ thêm (expand/contract), có kiểm `breaking_db` trong manifest. Go test mô phỏng crash ở từng bước bằng Runner giả | Update đang có rollback khi lỗi, chưa có journal cho mất điện |
| D-115 | Phát hành cuối Phase 12 | `v1.0.0-rc.1`: `make release` + `make release-offline`, release notes `docs/releases/v1.0.0-rc.1.md`, tag local. **`v1.0.0` chỉ gắn khi `docs/gate/G1–G8.md` có bằng chứng VM đạt** và không còn High/Critical mở (prompt riêng sau khi chạy VM). Pentest độc lập: vẫn bắt buộc trước khi mở bán cho khách ngoài (D-50), không chặn `v1.0.0` nội bộ | D-47: Gate có bằng chứng trước v1.0.0 |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code; mọi thay đổi máy chủ đi qua job + audit; params job không chứa bí mật; USER chỉ thấy dữ liệu của mình.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 12.0 | **Mockup:** wizard Import (chọn nguồn → quét → kế hoạch → map gói/USER → chạy → báo cáo khác biệt → cutover), CIS trong Security Center, trang Cập nhật (lịch sử update/rollback, journal dở dang, kênh), trang trạng thái Gate (SA, chỉ đọc từ `docs/gate`? → không: trang "Sẵn sàng production" tổng hợp kiểm tự động); ảnh `docs/screenshots/phase-12/` | 0,5 ngày |
| 12.1 | ADR 0053–0060 (D-108…D-115); contracts agent-ops (`import.scan`, `import.copy`, `cis.audit`, journal update), OpenAPI (`/imports*`, `/security/cis`, `/system/updates` mở rộng, `/system/readiness`), DBML + migration Phase 12 (`imports`, `import_items`, `cis_results`) | 0,5 ngày |
| 12.2 | Agent: `import.scan` (aaPanel/Hestia/nginx, cây file giả trong sandbox), `import.copy` (dưới UID, chặn symlink/hardlink ra ngoài, giới hạn kích thước), `cis.audit`; update journal + `itso repair` tiếp tục/hoàn tác; Go test (crash từng bước) | 1 ngày |
| 12.3 | Panel import: API, job `import.run` theo account (tạo account → file → DB → vhost/SSL → báo cáo), cutover + rollback, quyền SA; Pest | 1 ngày |
| 12.4 | Hardening: ASVS L2 checklist có bằng chứng (`docs/security/asvs-l2.md`), sửa mục thiếu; test ma trận quyền sinh từ route list; CIS API + điểm bảo mật; ADR RLS + helper có số liệu; siết unit systemd agent | 1 ngày |
| 12.5 | Hiệu năng: seed 200 account, `itso:bench`, đo + sửa điểm nóng, kết quả `docs/perf/phase-12.md` | 1 ngày |
| 12.6 | Offline installer (`make release-offline`, `install.sh --offline`), `tests/vm/upgrade-loop.sh` (20 vòng + chaos), chính sách cập nhật bảo mật, SBOM + ký hoàn chỉnh; test installer | 1 ngày |
| 12.7 | UI nối API thật (Import, CIS, Cập nhật, Sẵn sàng production), MSW theo hành vi mới, i18n vi/en; sổ tay vận hành `docs/runbooks/operations-handbook.md` | 1 ngày |
| 12.8 | Production Gate: `docs/gate/G1–G8.md` (tiêu chí, phần tự động + bằng chứng container, script `tests/vm/gate.sh`), e2e stack thật Phase 12, `make check`, báo cáo, release `v1.0.0-rc.1`, merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p12)`, `test(p12)`, `docs(p12)`; đẩy nhánh `phase-12` lên `github`; đồng bộ bản sao lưu.

## Prompt 12.0 — Mockup

```
[ITSO Panel] Prompt 12.0 — Mockup Import, CIS, Cập nhật, Sẵn sàng production (trước khi code)
Phạm vi: chỉ bản demo (apps/web + src/demo + contracts/tools/demo.py), không đụng API/agent.
Màn hình và trạng thái:
- Import (SA): chọn nguồn (aaPanel, HestiaCP, Nginx thuần) + server → quét (đang quét, không tìm thấy, lỗi quyền)
  → kế hoạch (site, domain, docroot, PHP, SSL, DB, cron; cảnh báo: PHP không có, domain trùng, DB quá lớn) → chọn mục
  + map sang gói và USER (tạo mới hoặc có sẵn) → chạy (tiến độ theo account) → báo cáo khác biệt → cutover/rollback.
- Security Center › CIS: điểm, nhóm mục pass/fail/n.a., bằng chứng, mục sửa được trỏ tới recipe.
- Cập nhật hệ thống: phiên bản, kênh, lịch sử update/rollback, cảnh báo journal dở dang (sau mất điện) + "Sửa (repair)".
- Sẵn sàng production (SA): danh sách kiểm tự động (backup immutable, MFA, allowlist, CIS, cập nhật, chứng chỉ, Gate
  G1–G8 trạng thái đọc từ dữ liệu panel) với link tới chỗ sửa.
Chụp: e2e/screenshots-phase12.spec.ts, make screenshots → docs/screenshots/phase-12.
Kiểm thử: Vitest/Playwright demo + axe xanh; i18n vi = en; check_demo.py.
```

## Prompt 12.1 — ADR và contracts

```
[ITSO Panel] Prompt 12.1 — ADR Phase 12, contracts, migration
Phạm vi: docs/adr/0053-import-other-panels.md (D-108), 0054-cis-audit.md (D-109), 0055-rls-evaluation.md (D-110),
0056-privileged-helper.md (D-111), 0057-performance-200-accounts.md (D-112), 0058-offline-installer.md (D-113),
0059-update-journal-chaos.md (D-114), 0060-release-v1.0.0.md (D-115). DECISIONS.md: D-108…D-115 Accepted.
Contracts agent-ops: import.scan (nguồn, gốc mặc định theo nguồn, giới hạn số mục), import.copy (src trong danh sách
nguồn cho phép, dst trong home account, uid, max_bytes), cis.audit (danh sách mục, kết quả + bằng chứng rút gọn);
vector độc (src ngoài gốc nguồn, dst ngoài home, symlink, uid ngoài dải). OpenAPI: /imports (scan, plan, run, items,
cutover, rollback), /security/cis, /system/updates (lịch sử, journal), /system/readiness. DBML + migration Phase 12.
make contracts, make codegen, make codegen-check, make db-verify xanh.
```

## Prompt 12.2 — Agent

```
[ITSO Panel] Prompt 12.2 — Agent import, CIS, update journal
Phạm vi: agent/internal/ops/import_*.go: aaPanel (/www/server/panel/vhost/nginx/*.conf, /www/wwwroot, panel DB
sqlite chỉ đọc nếu có), HestiaCP (/usr/local/hestia/data/users/*/web.conf, /home/<u>/web/<d>/public_html), Nginx
thuần (/etc/nginx/sites-enabled, root/server_name, fastcgi_pass → phiên bản PHP); parser nginx tối thiểu an toàn
(không include ngoài /etc/nginx, giới hạn kích thước, fuzz). import.copy: đọc nguồn bằng O_NOFOLLOW, bỏ symlink/
device/socket, ghi dưới UID account, giới hạn max_bytes, báo số file/bytes/bỏ qua. cis.audit chỉ đọc. Sandbox: cây
aaPanel/Hestia/nginx giả dưới gốc sandbox. install: journal update theo bước, repair tiếp tục/hoàn tác; test crash ở
từng bước bằng Runner giả. Go test + fuzz parser.
```

## Prompt 12.3 — Panel import

```
[ITSO Panel] Prompt 12.3 — Import API và job
Phạm vi: ImportController (SA, step-up khi chạy), Domain/Import: scan (job, lưu kế hoạch), plan (chọn mục, map gói/
USER, kiểm trùng domain/username/quota gói), run (job theo account: account → website → file → DB dump + import →
SSL dùng lại hoặc ACME → cron), báo cáo khác biệt (số file/bytes/bảng), cutover (nginx: tắt vhost nguồn — op có sẵn
nginx.vhost.* cho file của ITSO; vhost của panel nguồn chỉ đổi tên .conf → .itso-disabled, có rollback), audit.
Mật khẩu DB mới sinh ở panel, không vào params. Pest: kế hoạch, map, trùng, quota, job đủ bước với agent giả, cutover
+ rollback, quyền (ADMIN/USER 403/404).
```

## Prompt 12.4 — Hardening

```
[ITSO Panel] Prompt 12.4 — ASVS L2, ma trận quyền tự động, CIS, RLS/helper, systemd
Phạm vi: docs/security/asvs-l2.md (V1–V14 mục áp dụng: trạng thái, bằng chứng = test/file), sửa mục thiếu (header bảo
mật, giới hạn kích thước request, khóa phiên khi đổi mật khẩu…, tùy kết quả rà). Test ma trận quyền sinh từ
`route:list`: mọi route admin/portal có {id} được gọi bằng actor ngoài phạm vi → 404/403, route ghi thiếu
itso.perm → lỗi test. CIS: API + gộp điểm bảo mật. ADR 0055/0056 kèm số liệu đo. Unit itso-agent siết sandboxing
(units-check + `systemd-analyze security` trên VM: chờ VM).
```

## Prompt 12.5 — Hiệu năng

```
[ITSO Panel] Prompt 12.5 — 200 account/server
Phạm vi: database/seeders/PerfSeeder (chỉ môi trường test/dev), `itso:bench` (đo API qua kernel HTTP nội bộ, lệnh
lịch, insert metrics; in p50/p95/max), docs/perf/phase-12.md (trước/sau). Sửa điểm nóng: index, N+1 (Pest
`assertQueryCount` cho trang danh sách chính), phân trang. Mục tiêu theo D-112; không đạt thì ghi rõ + phương án.
```

## Prompt 12.6 — Offline installer, upgrade loop, chính sách cập nhật

```
[ITSO Panel] Prompt 12.6 — Offline installer, update/rollback 20 lần + chaos, chính sách cập nhật
Phạm vi: scripts/release-offline.sh + make release-offline (danh sách .deb khóa phiên bản, sha256), install.sh
--offline (apt repo cục bộ tạm, xóa sau cài, ACME tắt), test-installer với bundle giả; tests/vm/upgrade-loop.sh
(20 vòng, chaos theo bước, đo thời gian gián đoạn site = 0 lỗi HTTP); docs/security/update-policy.md (kênh, thời hạn vá
High/Critical, ký release, xoay khóa ký, SBOM, quy trình báo lỗi bảo mật nội bộ).
```

## Prompt 12.7 — UI và sổ tay vận hành

```
[ITSO Panel] Prompt 12.7 — UI nối API thật, sổ tay vận hành
Phạm vi: Import wizard, CIS, Cập nhật, Sẵn sàng production nối API thật theo mockup 12.0; MSW theo hành vi API; i18n
vi/en; docs/runbooks/operations-handbook.md (cài, nâng cấp, sao lưu/DR, sự cố thường gặp, xoay khóa, thêm/bớt server,
import, gỡ cài đặt, liên hệ/trách nhiệm) — gom và trỏ tới runbook Phase 4–11.
```

## Prompt 12.8 — Production Gate và phát hành

```
[ITSO Panel] Prompt 12.8 — Gate G1–G8, e2e, make check, v1.0.0-rc.1
Phạm vi: docs/gate/G1.md … G8.md (tiêu chí đo được, lệnh, phần đã chạy trong container + bằng chứng, phần VM),
tests/vm/gate.sh (G1 isolation trên 2 server, G2 quota, G3 priv-esc từ webshell/portal/giả định Laravel RCE, G4
restore ngẫu nhiên 10 account + 1 sang server khác + immutable, G5 nâng 3 phiên bản + rollback giữa chừng, G6 DR control
plane + cả server, G7 chuyển 5 account, G8 uninstall giữ site/home/DB); e2e stack thật apps/web/e2e-real/phase12.spec.ts
(import từ cây aaPanel/Hestia/nginx giả, CIS, readiness); make check; docs/reports/phase-12.md; release notes
docs/releases/v1.0.0-rc.1.md; make release + make release-offline; merge --no-ff vào main; tag local v1.0.0-rc.1;
DỪNG. v1.0.0 sau khi chạy gate.sh trên VM và cập nhật docs/gate.
```

## Tiêu chí nghiệm thu (ROADMAP §Phase 12)

| Tiêu chí | Cách chứng minh |
|---|---|
| Không còn High/Critical mở | ASVS L2 checklist + review Phase 6–12 + ma trận quyền tự động · pentest độc lập trước khi mở bán (D-50) |
| Update/rollback 20 lần liên tiếp, chịu mất điện | Go test (crash từng bước) · **VM upgrade-loop.sh** |
| 200 account/server đạt mục tiêu | `itso:bench` + `docs/perf/phase-12.md` · VM tham chiếu |
| Import aaPanel/HestiaCP/Nginx | Go (cây giả) · Pest · e2e · **VM** với panel thật |
| Gate G1–G8 | `docs/gate/G<n>.md` · **VM gate.sh** (bắt buộc trước `v1.0.0`) |

## Rủi ro

- Import gặp cấu hình lạ của panel nguồn → chỉ hỗ trợ cấu trúc mặc định, mục không hiểu được đưa vào báo cáo "cần làm tay", không đoán.
- Gate cần nhiều máy và thời gian thật → `v1.0.0` có thể chậm sau `v1.0.0-rc.1`; ghi rõ mục còn chờ.
- Hiệu năng trên container khác VM thật → số đo trong container là tương đối, xác nhận lại trên VM tham chiếu.
- Offline bundle lớn (≈ vài trăm MB) và gắn với bản vá Ubuntu tại thời điểm đóng gói → khuyến nghị đóng gói lại mỗi bản phát hành.
