# TEST_REPORT — ITSO Panel

> Cập nhật cuối mỗi prompt và cuối mỗi Phase. Ghi lệnh chạy thật và kết quả thật.

## 2026-11-22 — Phase 10 / Prompt 10.1 (ADR, contracts, DBML, migration) — nhánh `phase-10`

Phạm vi: ADR 0039–0045 (D-94…D-100, Accepted); agent-ops viết đủ schema 41 op Phase 10 (software.catalog/status/upgrade, os.auto_updates; docker.host.*, docker.container.list/inspect/control/logs/stats, docker.image.list/pull/prune/update/rollback, docker.registry.login, docker.volume.list/create/remove/backup/restore, docker.network.list/create/remove, docker.firewall.sync; compose.validate/apply/up/down/pull/remove; wp.detect/info/install/update/clone/harden/admin_password/maintenance), defs mới (ComposeProjectName, DockerImageRef, ContainerId, DockerVolumeName, ComposeRule/Override/Finding, WpSlug, WpSite…), Recipe thêm 10 recipe, 5 mã lỗi mới (compose_rejected, port_unavailable, in_use, docker_unavailable, wp_update_failed); 69 vector độc mới; OpenAPI thêm `GET /servers/{id}/docker/port-allocations`; DBML: docker_hosts, registries, compose_projects/revisions (số revision, override, sha256), containers, port_allocations (server×port×protocol, 20000–29999), image_rollbacks, wordpress_sites/components/updates; ALTER `/* phase:10 */` cho software_catalog, server_software (state, latest_version, upgrade_available), websites (compose_project_id/service), backup_policies (compose_project, docker_volumes, volume_consistency), backup_snapshots; migration `2026_11_20_000010_phase_10_schema.php` (sinh tự động). Laravel: trình bày thêm trường bắt buộc mới (Software, chính sách/snapshot backup) và nhóm catalog khớp enum.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` · `check_demo.py` | PASS: OpenAPI 410 operation (admin 290, portal 120); agent-ops 157 op có schema, 2 op khai báo (git.*); evil 318 vector (276 tầng schema, 42 tầng nghiệp vụ) · OK |
| Codegen | `make codegen` · `make codegen-check` | OK |
| Agent Go | `cd agent && go test -race ./...` | PASS (lần đầu `TestEvilVectors` đỏ vì vector recipe `docker`/`wp-cli` accept trước khi agent có recipe → chuyển vector sang 10.2 cùng allowlist Go) |
| DB | `make db-schema` · `make db-verify` | PASS: 93 bảng; **138 test SQL** (mới `90_docker_wordpress.sql` 40 test; lần đầu 1 lỗi: CHECK slug plugin để lọt NULL → thêm `slug IS NOT NULL`); migration Phase 3 → 10 khớp đặc tả, áp lần lượt = itso.sql + extras.sql. Lần đầu `db-schema` lỗi cột `status` trùng nhóm Desired/Observed → đổi thành `run_state`; đổi ghi chú `websites.type` làm lệch migration Phase 5 đã phát hành → hoàn tác |
| Pest | `make test-api` (PostgreSQL 16 cluster tạm + Redis cục bộ) | **483/483 PASS** (5599 assertion). Lần đầu 4 lỗi: SchemaTest thiếu 12 bảng Phase 10; response Software thiếu `source/service/core/conflicts/requires/in_use/remove_blocked` và nhóm `system`/`backup` ngoài enum; chính sách backup thiếu `volume_consistency`, snapshot thiếu `volumes` (schema đổi từ 10.0) → sửa presenter/seeder |
| Vitest | `pnpm -s vitest run` | 591/591 PASS (mới: cổng compose đã cấp) |
| Lint | `pnpm -s lint` · PHPStan · Pint · `make docs-check` | sạch (docs-check lần đầu lỗi bảng lồng trong ADR 0041 và `<port>` trong DECISIONS → sửa) |

**Test bị bỏ qua:** không.

## 2026-11-22 — Phase 10 / Prompt 10.0 (mockup Docker, WordPress, Software trên demo) — nhánh `phase-10`

Phạm vi: contracts (schema Docker/Compose/WordPress/Software/OS updates, endpoint mới, op khai báo), dataset demo, MSW `demo/handlers/docker.ts` (mới: Docker host, bật Docker, firewall, prune, volume, validator compose mô phỏng D-96, revision, image update/rollback, mẫu, registry test, OS updates) + `infra.ts` (compose tạo/sửa chạy validator, override chỉ SA, Software xung đột/phụ thuộc/gỡ bị chặn) + `sites.ts` (WordPress chi tiết/cài đặt/lịch sử/quét/cập nhật chọn lọc/hardening/bảo trì/mật khẩu/staging, website `docker`); UI: `ServerSoftwarePage`, `ServerDockerPage`, `ComposePage`, `ComposeDetailPage`, `docker/validation.tsx`, `RegistriesPage`, `WordPressPage` + `WordPressDetailPage` (mới, Admin + Portal), website loại docker, chính sách backup compose. Dữ liệu demo: thay plugin mẫu WooCommerce bằng WP Mail SMTP (ngoài phạm vi), thêm site WordPress cho An Phát (Portal).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` · `python3 contracts/tools/check_demo.py` · `make codegen` · `make codegen-check` | PASS (admin 289, portal 120 operation; 23 op khai báo) · PASS · OK · OK |
| Vitest | `pnpm -s vitest run` | **590/590 PASS** (mới: `demo/__tests__/phase10.test.ts` 10 test, `admin/__tests__/phase10-helpers.test.ts` 6 test; lần đầu 5 lỗi do form có trường mới (`volume_consistency`, `compose_project_uuid`/`service`) → cập nhật fixture + thêm case compose/docker; 4 lỗi GET WordPress chi tiết do test thiếu id → thêm `sites`) |
| Lint | `pnpm -s lint` (eslint, prettier, tsc, check-i18n) | sạch (i18n 3280 key, vi = en) |
| Playwright demo | `playwright test e2e/demo-*.spec.ts` | **199/199 PASS** sau sửa; lần đầu 198/199: `demo-infra` compose cũ triển khai thẳng → nay phải Kiểm tra trước (D-96) và chọn server đã bật Docker → cập nhật test |
| axe + 390px + EN (route mới) | `playwright test e2e/demo-smoke.spec.ts e2e/demo-audit.spec.ts -g "wordpress\|docker\|compose\|software\|registr\|websites\|backups"` | 32/32 PASS |
| Ảnh Phase 10 | `SCREENSHOT_DIR_P10=docs/screenshots/phase-10 playwright test e2e/screenshots-phase10.spec.ts` | **68/68** (17 màn × 1440/390 × sáng/tối); `make screenshots` đã nối `SCREENSHOT_DIR_P10` |

**Test bị bỏ qua:** không.

## 2026-11-22 — Phase 9 / Prompt 9.8 (tích hợp: e2e 2 agent qua relay, VM, review, make check) — nhánh `phase-9`

Phạm vi: `apps/web/e2e-real/phase9.spec.ts` (mới), sửa lỗi tìm ra nhờ e2e (`MigrationService` preflight repo chưa khởi tạo → cảnh báo; contract `migrate.preflight` thêm `enforce`, agent trả `precondition_failed`, chặng đích gửi `enforce=true`; `JobController` lọc `waiting_agent`), sandbox (`migrate.go` ownership/HTTP, `scripts/dev.sh` CA + URL relay, `Placement` cho chọn server bị loại ở wizard chuyển), `tests/vm/phase9.sh` + `tests/vm/lib/panel_api.php`, `docs/security/multi-server-review.md`, runbook §5, báo cáo `docs/reports/phase-9.md`. Commit 45ebccd.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| E2E stack thật Phase 9 | `pnpm -s exec playwright test -c playwright.real.config.ts --trace off e2e-real/phase9.spec.ts` (`make dev`: relay thật, agent local + node sandbox, restic thật) | **4/4 PASS** (5,0 phút). Các lần đầu lỗi: wizard bị drawer theo dõi job (modal) che khỏi cây a11y → test đóng drawer; toast "Đã xong" đè nút khi chuột đứng trên → dời chuột; trang Tác vụ `?state=waiting_agent` → 422 (**lỗi API**, sửa); lượt chuyển thứ hai lỗi `Unknown database` vì sandbox dùng chung MariaDB nên hoàn tác xóa luôn DB nguồn → lượt hoàn tác dùng account không DB. Trước đó (đầu 9.8): preflight chặn account chưa backup (**lỗi API**, sửa), ownership/HTTP trong sandbox, server local bị loại vì đĩa |
| Toàn bộ e2e stack thật | `ITSO_ACME_EMAIL=ops@itso.local make dev` + `migrate:fresh --seed` + `DemoSeeder` + `make test-e2e-real` | **23/23 PASS** (17,1 phút). Hai lần chạy trước: 21/23 (Phase 3 tạo account: server local bị loại vì đĩa container < 15 % sau cấp → dọn 17 GB clone cũ trong scratchpad; Phase 5 SSL phụ thuộc) và 22/23 (quên `ITSO_ACME_EMAIL` nên SSL sandbox không cấp) |
| Pest mới | `pest tests/Feature/Phase9/MigrationTest.php` · `NodeTest.php` | 7/7 (271 assertion; mới: repo chưa khởi tạo → cảnh báo, chặng đích `enforce` chặn → `failed`, không `account.ensure`) · 9/9 (thêm lọc `waiting_agent`) |
| Go | `go test -race ./internal/ops -run 'TestMigrate\|TestHTTPCheck\|TestBackupRestore'` · `go test ./...` | PASS (mới: `enforce` → `precondition_failed`) · PASS |
| `make check` | `make check` (1 143 s) | **19 PASS · 1 SKIP (staticcheck) · 3 FAIL** lần đầu: `test-e2e` 548/549 (`demo-admin2` còn giả định không có ô "Máy chủ đích" — Phase 9 thêm khôi phục sang server khác → sửa test, chạy lại 3/3), `test-fuzz` (`FuzzFirewallRule` tìm comment `";"` hợp lệ theo contract làm bất biến đếm `;` sai → đếm ngoài chuỗi trích dẫn, giữ input làm corpus; chạy lại `make test-fuzz` PASS), `git-clean` (do corpus fuzz mới, nay commit) |
| Còn lại trong `make check` | structure, docs-check, check-ci, db-verify (98), contracts-check, codegen-check, tokens-check, lint-web, test-web (562), build-web, build-demo, lint-api, test-api (483), no-exec, lint-agent, test-agent (19 gói), build-agent, units-check, test-installer | PASS |
| Ảnh Phase 9 | `SCREENSHOT_DIR_P9=… playwright test e2e/screenshots-phase9.spec.ts` | 52/52 (chụp lại wizard sau đổi `Placement`) |
| Script VM | `bash -n tests/vm/phase9.sh` · `lib/panel_api.php` thử với DB dev (GET servers 200, preflight 422 đúng) | OK (không có shellcheck). **Chờ VM:** N0 3 server online, N1 node không nghe TCP, N2 nftables → `waiting_agent`/`agent_unreachable`, N3 xoay chứng chỉ, N4 WordPress + 2 GB (checksum + HTTP 200, downtime ≤ 300 s), N5 rollback sau cutover, N6 thu hồi |

**Test bị bỏ qua:** không. **Chờ VM:** `tests/vm/phase4.sh`–`phase9.sh` (Phase 8 DR 2 VM, Phase 9 3 VM).

## 2026-11-21 — Phase 9 / Prompt 9.7 (UI multi-server khớp API thật) — nhánh `phase-9`

Phạm vi: trang mới **Lượt chuyển máy chủ** (`/admin/hosting-accounts/migrations`, lọc trạng thái, mở wizard); wizard chuyển account: ADMIN (có phạm vi cả hai server) vào được như API, kiểm chứng lệch → cảnh báo + khóa nút cutover, lượt chuyển lỗi → hiện lỗi + hoàn tác (account khóa sau cutover) hoặc chuyển lại, chặng chờ node mất kết nối (`waiting_agent`), dọn nguồn sớm chỉ SA, ghi chú HTTPS cấp lại ở đích; banner danh sách server khi node mất kết nối; Portal: banner "đang chuyển" + cảnh báo tổng quan `account_migrating` (API + MSW); nhãn job `migration.*`; `JobProgress` khóa theo vị trí bước (job thật có thể lặp op `backup.run`). MSW theo hành vi API: quyền ADMIN + phạm vi đích, chỉ account active, `connection`/`accepting` (warn), HTTP chỉ có sau cutover, cutover 409 khi lệch, hoàn tác 409 lúc đang đồng bộ, dọn sớm ADMIN 403, account `migrating` → ghi dữ liệu 409. API: link thông báo lượt chuyển trỏ về wizard của account. Commit b2ef24d.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Vitest | `pnpm -s vitest run` | **562/562 PASS** (lần đầu 2 lỗi ở `demo/__tests__/hosting.test.ts` do MSW đổi theo API: ADMIN chuyển sang đích ngoài phạm vi 403 → 422, khóa kiểm tra `agent` → `connection`; sửa test, thêm 1 test hành vi mới) |
| Playwright demo | `playwright test e2e/demo-hosting.spec.ts e2e/demo-infra.spec.ts e2e/demo-backup8.spec.ts e2e/demo-portal.spec.ts` | **20/20 PASS** (mới: danh sách lượt chuyển → wizard; banner node mất kết nối). Lần đầu 1 lỗi: cảnh báo React trùng key khi job có 2 bước `backup.run` → sửa `JobProgress` |
| axe + 390px + EN | `playwright test e2e/demo-audit.spec.ts` (mọi route, gồm route mới) | **77/77 PASS** |
| Ảnh Phase 9 | `SCREENSHOT_DIR_P9=docs/screenshots/phase-9 playwright test e2e/screenshots-phase9.spec.ts` | 52/52 (thêm `admin-migrations`, chụp lại wizard) |
| API | `vendor/bin/pest tests/Feature/Phase9` · `tests/Feature/Hosting` · `make lint-api` · `make no-exec` | 20/20 · 25/25 · sạch · OK |
| Lint web | `pnpm -s lint` · `tsc -b` | sạch (i18n 2999 key, vi = en) |

**Test bị bỏ qua:** không. **Giới hạn đã biết:** dữ liệu demo giữ `lehoa` ở `suspended` (mockup Phase 2) dù đang có lượt chuyển; API thật chỉ chuyển account active.

## 2026-11-21 — Phase 9 / Prompt 9.6 (điều phối chuyển account, khôi phục chéo server) — nhánh `phase-9`

Phạm vi: `app/Domain/Migration/{MigrationService,MigrationJobHandler}.php`, `Models/AccountMigration.php`, `Admin/AccountMigrationController.php` (preflight, migrate, danh sách/chi tiết, cutover, rollback, cleanup), `RestoreService` (khôi phục sang server khác), lệnh `itso:migrations-cleanup` (hàng giờ), route Phase 9 (`accounts.write` + step-up: SA/ADMIN có phạm vi cả 2 server), contracts (bỏ 501 của `:migrate`). Commit 8dfa8c2.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Chuyển account | `vendor/bin/pest tests/Feature/Phase9/MigrationTest.php` (PG 16 + Redis thật; nguồn = agent giả, đích = node mTLS qua relay giả, params/result kiểm theo `contracts/agent-ops`) | **6/6 PASS, 245 assertion**. Luồng trọn vẹn: preflight (ước lượng downtime, cùng server/ADMIN không phạm vi đích → 422, ngoài phạm vi → 404) → backup nguồn → đích account.ensure → DB → site → restore → cấu hình → verify → `verifying`; Portal thấy `migrating`, ghi → 409; lượt thứ hai → 409; dọn trước cutover → 409; cutover: nguồn khóa + backup `final` → đích restore lượt cuối, verify, mở, `http.check` → `holding`, account/site/DB đổi `server_id`, UID cấp ở đích, đo downtime, Portal ghi lại được (job chạy ở node mới); dọn sớm: sai username 422, ADMIN 403, SA → `account.remove reason=migrated` → `completed`, nhả UID nguồn; sau dọn không hoàn tác được. Preflight chặn: thiếu đích backup, PHP/đĩa/domain ở đích, node mất kết nối, account không active → 409 `precondition_failed`, không tạo lượt chuyển. Kiểm chứng lệch → cutover 409; hoàn tác ở verifying (đích khóa → nguồn mở) → `rolled_back`. DNS tự động (Cloudflare giả): TTL 3600 → 60 lúc đồng bộ, A đổi sang IP đích lúc cutover, hoàn tác sau cutover trả A + account/site về nguồn, nhả UID đích. Node đích rơi giữa chặng đồng bộ → `waiting_agent` có hạn, hoàn tác chen ngang → 409, quá hạn → job `agent_unreachable`, lượt chuyển `failed`, account active ở nguồn, có thông báo. Khôi phục chéo: job chạy ở node (account.ensure → backup.restore), account vẫn ở nguồn; ghi đè sang server khác 422, ADMIN không phạm vi 422, node offline 409 |
| Phase 9 API | `vendor/bin/pest tests/Feature/Phase9` | 20/20 PASS |
| Toàn bộ Pest | `scripts/pest-pg.sh --parallel` | 480/482 lần đầu: 2 test cũ còn giả định `:migrate`/`account-migrations` chưa có route; sửa test (gửi đủ Idempotency-Key; endpoint "chưa có ở bản này" đổi sang `compose-projects`) → chạy lại `tests/Feature/Platform` 20/20 PASS |
| Lint | `make lint-api` (pint + phpstan) · `make no-exec` · `make docs-check` · `pnpm -s lint` (web) | sạch · OK · OK · sạch (i18n 2964 key vi = en) |

**Test bị bỏ qua:** không. **Giới hạn đã biết:** chứng chỉ TLS không mang sang đích (khóa ACME ở agent nguồn) → vhost đích chỉ HTTP, cấp lại sau khi DNS trỏ về đích; chế độ DNS tay chỉ hiện bản ghi cần đổi. **Chờ VM:** chuyển account thật giữa 2 VM, đo downtime thật (`tests/vm/phase9.sh`, 9.8).

## 2026-11-21 — Phase 9 / Prompt 9.5 (agent: migrate.*, http.check, account.remove) — nhánh `phase-9`

Phạm vi: `agent/internal/ops/{migrate.go,account_remove.go}` (+ `migrate_test.go`), `ops/sandbox*.go` (Sim `userdel`, `groupdel`, `pure-pw list`, đếm bảng), `platform/runner.go` (thêm `groupdel` vào bảng lệnh cho phép), `ops.Deps.HTTPAddrs` (test).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Op mới | `go test ./internal/ops/ -run 'TestHTTPCheck\|TestAccountRemove\|TestMigrate\|TestBackupRestoreCrossServer'` | **PASS** (restic 0.16.4 thật, 2 gốc sandbox). `http.check`: Host header đúng, không theo redirect, 6 path độc + host có cổng bị chặn, không kết nối được → status 0. `account.remove`: sai confirm/uid/user hệ thống bị chặn; xóa đủ 11 loại đối tượng đúng thứ tự vhost → pool → cron → SFTP → DB → user; symlink trong home trỏ sang account khác không bị theo; vhost/pool/DB/user của account khác còn nguyên; chạy lại trả rỗng. Chuyển account: preflight ok và 5 mục `block` (username/uid, đĩa, PHP, domain, mật khẩu repo); backup ở nguồn → restore ở đích → verify khớp (file mẫu, chủ, DB 2/2 bảng, HTTP); sửa file sau lượt đầu → verify báo lệch → lượt cuối mang theo → khớp; cutover nguồn dừng pool/timer, gỡ SFTP, bật bảo trì, chạy lại không lặp; cutover đích bật pool; rollback đích khóa, nguồn mở lại đúng, rollback lần 2 trả false. Khôi phục sang server khác ra bản mới đúng nội dung |
| Go toàn bộ | `go test -race ./...` · `make lint-agent` · `make no-exec` | PASS · sạch · OK |

**Test bị bỏ qua:** không. **Giới hạn đã biết:** verify DB so số bảng với dump (MariaDB); PostgreSQL (-Fc) chỉ báo số bảng ở đích; chưa so số dòng/checksum từng bảng (để `tests/vm/phase9.sh` với MariaDB thật). **Chờ VM:** nginx/systemd/userdel thật, đo downtime.

## 2026-11-21 — Phase 9 / Prompt 9.4 (enroll, thu hồi, job chờ node, xoay chứng chỉ) — nhánh `phase-9`

Phạm vi: `apps/api/app/Domain/Servers/{NodeEnrollment,RelaySync,CertRotation}.php`, `Infrastructure/Agent/RelayClient.php`, `Http/Controllers/Api/V1/Internal/NodeEnrollController.php`, `ServerController` (token, thu hồi), `JobRunner` (`waiting_agent`), lệnh `itso:relay-sync`, `itso:certs-rotate`, model `AgentEnrollmentToken`, `AgentCertificate`; mọi service gọi agent qua `forServer`; contracts (ErrorCode `agent_unreachable`, `enrollment_invalid`; CSR CN `itso-enroll`); `agent/internal/install/node.go` đọc phản hồi enroll dạng `{data}`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Pest Phase 9 | `vendor/bin/pest tests/Feature/Phase9` (PostgreSQL + Redis thật) | **14/14**. Mới (`NodeTest.php`): token một lần (DB chỉ sha256, ADMIN bị chặn, thiếu CA → 409); enroll tạo server/agent/chứng chỉ/khóa mã hóa, token dùng lại/hết hạn bị từ chối; thiếu/sai chữ ký relay → 401, CSR CN lạ → 422 không tạo server, sai > 10 lần → 429; thu hồi (còn account 409, sai tên 422, máy panel 409, đúng → revoked + đẩy relay); job chờ node → relay-sync chạy tiếp cùng op_id, quá hạn → `failed agent_unreachable`; relay-sync thông báo mất/kết nối lại; xoay chứng chỉ 2/3 hạn; gợi ý server có lý do loại; ma trận quyền ADMIN |
| Pest toàn bộ | `bash scripts/pest-pg.sh --parallel` | **476/476** |
| Installer Go | `go test -race ./internal/install/` | PASS |
| Lint · no-exec · contracts | `make lint-api` · `make no-exec` · `make codegen-check` | PASS · OK · OK |
| Web | `pnpm lint` · `pnpm vitest run` | sạch (i18n 2964 key, vi = en) · **561/561** |
| Docs | `make docs-check` | 0 lỗi |

**Test bị bỏ qua:** không. **Chờ VM:** enroll node thật qua relay, mất mạng thật giữa node và control plane (9.8 `tests/vm/phase9.sh`).

## 2026-11-21 — Phase 9 / Prompt 9.3 (installer theo vai trò, `itso node`) — nhánh `phase-9`

Phạm vi: `agent/internal/install/{node.go,steps.go,manage.go,release.go,env.go,preflight.go}` (+ `node_test.go`), `agent/internal/pki` (CSR join CN `itso-enroll`), `agent/cmd/itso` (`--role/--join/--token/--ca-sha256`, `pki`, `node`), `packaging/systemd/{itso-relay,itso-agent-node,itso-cert-rotate}.*`, `itso.target`, `packaging/Caddyfile`, `packaging/install.sh.in`, `scripts/release.sh` (build `itso-relay`), `tests/installer/install_sh_test.sh`, `docs/runbooks/multi-server.md`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Installer Go (gốc giả + runner giả) | `go test ./internal/install/` | **PASS**. Mới: control plane tạo CA/relay/enroll đúng quyền + chủ, unit relay + timer xoay, chạy lại không ghi gì và không sinh lại CA, đổi vai trò tại chỗ bị từ chối; node join với control plane giả (TLS do CA nội bộ cấp): không cài postgresql/redis/artisan/itso.target, file 0600/0644/0700, khóa HMAC riêng, output không lộ token/khóa, token không xuống đĩa; pin sai → dừng và **không gửi token**; token sai → `enrollment_invalid`; chứng chỉ trả về cho khóa khác → từ chối; tham số sai bị chặn trước mọi kết nối; `node status`/`leave --yes` (thiếu `--yes` lỗi)/`rejoin` (khóa mới, restart agent node); `update`/`rollback` trên node chỉ đổi release + restart `itso-agent-node`; `doctor` trên node kiểm chứng chỉ node, không kiểm dịch vụ panel |
| PKI | `go test ./internal/pki/` | PASS (CSR join `itso-enroll` → chứng chỉ CN = server_uuid) |
| Go toàn bộ | `go test -race ./...` · `make lint-agent` · `make no-exec` | PASS · sạch · OK |
| Unit systemd | `make units-check` | `verify-units: OK (18 unit)` (mới: `itso-relay.service`, `itso-agent-node.service`, `itso-cert-rotate.service/.timer`) |
| install.sh | `make test-installer` | **11/11** (mới: `--role node --join --token --ca-sha256` và `--role control-plane` chuyển nguyên cho `itso install`) |
| Lint API · Docs | `make lint-api` · `make docs-check` | PASS · 0 lỗi |

**Test bị bỏ qua:** không. **Chờ VM:** cài control plane + join node thật, tường lửa, `systemctl` thật (9.8 `tests/vm/phase9.sh`). Lệnh `itso:certs-rotate` mà timer gọi được hiện thực ở 9.4.

## 2026-11-21 — Phase 9 / Prompt 9.2 (CA nội bộ, itso-relay, agent node) — nhánh `phase-9`

Phạm vi: `agent/internal/pki`, `agent/internal/ops/pki.go` (+ `pki_test.go`), `agent/internal/relay/{frame,hub,node,server}.go` (+ `relay_test.go`), `agent/cmd/itso-relay`, `agent/cmd/itso-agent` (`--mode node`); Laravel `AgentClient::forServer`, `AgentUnreachable`, `JobRunner`, `config/itso.php` (`relay.socket`, `relay.enroll_key_file`); `scripts/dev.sh` (relay + node sandbox).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go relay + PKI | `go test -race -count=5 ./internal/relay/` · `go test -race ./internal/pki/` | **PASS** (5 lần liền, không flaky). Kiểm: khứ hồi qua relay + `/v1/status`; envelope ký sai khóa server bị agent trả `unauthorized_caller` dù qua relay (handler không chạy); node chưa kết nối → 503; chứng chỉ CA khác / hết hạn / CN không phải uuid bị từ chối, thiếu chứng chỉ client → 401, `/v1/ca` trả đúng CA; thu hồi cắt kết nối ngay, chặn quay lại, lưu xuống đĩa; mất kết nối → node tự nối lại, gửi lại cùng op_id → kết quả cache, handler chạy đúng 1 lần; enroll chuyển tiếp có chữ ký relay đúng + IP client, lần 11 trong 10 phút → 429 |
| Go op PKI | `go test ./internal/ops/ -run 'Pki\|CertRotate'` | PASS: chưa có CA → `precondition_failed`; ký đúng (CN, hạn ≤ 30 ngày, fingerprint khớp); CSR server khác → `enrollment_invalid`; chế độ node → `op_disabled`; xoay hai pha: chứng chỉ không khớp khóa chờ / CA khác → từ chối, đúng → thay `node.pem` + `node.key` nguyên tử |
| Go toàn bộ | `go test -race ./...` · `make lint-agent` · `make no-exec` | PASS · gofmt + vet sạch · OK |
| Smoke dev | `itso-relay dev-init/dev-issue` → relay `127.0.0.1:28455` + `itso-agent --sandbox --mode node` → `curl --unix-socket relay.sock /v1/status` + `system.ping` ký HMAC qua `/v1/nodes/{uuid}/ops` | node `connected:true`, ping `ok:true` |
| Pest | `bash scripts/pest-pg.sh tests/Feature/Phase9 tests/Unit/AgentClientTest.php` rồi `--parallel` toàn bộ (467/467 PASS) | Lần đầu 1 lỗi (test tự tạo `job_steps` thiếu `op_id`) → dùng `JobDispatcher` → **10/10 PASS**. Mới: local/không agent → socket cục bộ; mtls → `http://relay/v1/nodes/{uuid}/ops`, chữ ký bằng khóa riêng node trên `/v1/ops`, khóa lưu mã hóa; 503 → `AgentUnreachable`; node bị thu hồi / chưa có khóa → `AgentUnavailable`; `JobRunner` gửi tới relay theo `server_id`, lỗi `agent_unreachable` |
| Lint API | `make lint-api` | Lần đầu Pint báo import thừa → sửa → Pint PASS · PHPStan 0 lỗi |

**Test bị bỏ qua:** không. **Chờ VM:** relay + node trên 2 máy thật (9.8, `tests/vm/phase9.sh`).

## 2026-11-21 — Phase 9 / Prompt 9.1 (ADR, contracts, migration) — nhánh `phase-9`

Phạm vi: `docs/adr/0034–0038`; `contracts/tools/{gen_agent_ops,gen_vectors,schemas,gen_openapi,demo,check_contracts}.py`; `database/tools/{gen_dbml,gen_migrations}.py` (hỗ trợ đánh dấu `/* phase:N */` cho ALTER bảng Phase trước), `database/schema/extras.sql`, migration `2026_11_20_000009_phase_9_schema.php` (sinh), `database/tests/80_multiserver.sql`; Laravel: `PurgeService`/`BackupJobHandler` theo tham số `account.remove` mới, `ServerPresenter` (`node_role`, `transport`, `connection`, `last_seen_at`, `cert`), gợi ý server (`eligible`, `excluded_reasons`, `commit_pct`), `config/itso.php` (`relay.*`); mock agent theo `account.remove` mới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` · `make codegen` · `make codegen-check` | Lần đầu 1 lỗi (`/api/v1/internal/nodes:enroll` ngoài prefix admin cho phép) → thêm prefix `internal` vào kiểm tra → **PASS** (admin 270 operation, 117 op agent có schema, 251 vector độc, RE2 90 pattern) · OK |
| Schema | `make db-schema` · `gen_migrations.py 3…8 --check` · `make db-verify` | Lần đầu lỗi trùng `agents_transport_chk` (đã có từ Phase 3) → bỏ câu trùng → migration Phase 3–8 khớp đặc tả (không sửa), Phase 3 → 11 áp lần lượt = itso.sql + extras.sql; **98 test SQL PASS** (mới 20: vai trò node, kết nối, chứng chỉ trùng/sai định dạng, token lưu rõ bị chặn, job `waiting_agent`, một lần chuyển mở mỗi account, `holding`, giữ nguồn ≤ 30 ngày) |
| Pest | `bash scripts/pest-pg.sh --parallel` | Lần đầu 4 lỗi (bảng Phase 9 mới; Server/gợi ý thiếu trường contract mới) → cập nhật `SchemaTest` + presenter + gợi ý → **462/462 PASS** |
| Lint API | `make lint-api` | Pint PASS · PHPStan 0 lỗi |
| Go | `go vet ./...` · `go test ./...` | PASS (mock: `account.remove` thiếu `confirm` → `invalid_params`, sai username → `precondition_failed`) |
| Docs | `make docs-check` | 0 lỗi markdownlint, link, mermaid |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 9 / Prompt 9.0 (mockup multi-server & chuyển tài khoản) — nhánh `phase-9`

Phạm vi: chỉ bản demo. Contracts (`schemas.py`, `gen_openapi.py`, `demo.py`): `JobState` thêm `waiting_agent`; `Server` thêm `node_role`, `transport`, `connection` (`online/degraded/unreachable/pending/revoked`), `last_seen_at`, `cert`; `EnrollmentToken.ca_sha256`; `PlacementSuggestion` thêm `eligible`, `excluded_reasons`, `commit_pct`; `MigrateRequest` bỏ `strategy`/`dry_run`; mới `MigrationPreflight`, `POST /hosting-accounts/{id}:migrate-preflight`, `POST /account-migrations/{id}:cleanup`, `POST /servers/{id}:revoke`; `AccountMigration` thêm `holding`, `verification` dạng danh sách, `dns`, `downtime_estimate_sec`, `cutover_at`, `error`; demo có 2 job trên node mất kết nối. UI: `servers/*` (vai trò/kênh/kết nối/chứng chỉ, banner offline, thẻ Kênh, thu hồi), `hosting/Placement` (dùng ở tạo account và chuyển account), `AccountMigratePage` (6 bước, giữ nguồn + dọn nguồn), `backups/RestoreNewPage` (chọn server đích), `pages/JobsPage` (lọc `waiting_agent`); MSW `admin.ts` (gợi ý D-92), `hosting.ts` (preflight/migrate/cutover → holding/rollback/cleanup), `infra.ts` (node join mTLS, revoke), `governance.ts` (khôi phục sang server khác: chỉ ra bản mới, đích phải online, `account.ensure` + `backup.restore`).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS (admin 269 operation, portal 114) · OK |
| Dữ liệu demo | `python3 contracts/tools/check_demo.py` | OK — 13 account, 21 website, 10 database, 12 job |
| Type + lint + i18n | `pnpm tsc -b --noEmit` · `pnpm lint` | PASS · PASS; `check-i18n: OK — 6 namespace, 2962 key, 0 thiếu (vi = en)` |
| Vitest | `pnpm exec vitest run` | Lần đầu 3 lỗi (schema gợi ý server thiếu trường mới; preflight trả body thiếu `data`; test khôi phục còn chờ 422 khi sang server khác). Sửa MSW + test → **561/561 PASS** (37 file). Mới: preflight đích mất kết nối → chặn + migrate 409; migrate → verifying → cutover → holding → cleanup (sai username 422) → completed; rollback khi đang giữ nguồn đưa account về máy cũ; khôi phục sang server khác (ghi đè 422, node mất kết nối 409, đúng → `account.ensure`, `backup.restore`) |
| Playwright demo | `pnpm exec playwright test --trace off e2e/demo-audit.spec.ts e2e/demo-backup8.spec.ts e2e/demo-hosting.spec.ts e2e/demo-infra.spec.ts` | Lần đầu 2 lỗi (lệnh join đổi sang `--token … --ca-sha256`; luồng chuyển có thêm bước giữ nguồn), sửa test → **92/92 PASS** (gồm axe) |
| Ảnh mockup | `SCREENSHOT_DIR_P9=docs/screenshots/phase-9 pnpm exec playwright test --trace off e2e/screenshots-phase9.spec.ts` | 48/48 → 48 ảnh (12 màn × 1440/390 × light/dark); `make screenshots` có `SCREENSHOT_DIR_P9` |

**Test bị bỏ qua:** không. **Chờ VM:** không áp dụng (chỉ demo).

## 2026-11-21 — Phase 8 / Prompt 8.7 (e2e, VM, review, release v0.1.0-alpha) — nhánh `phase-8`

Môi trường: PostgreSQL 16 + Redis cục bộ; `make dev` (Laravel + queue + Vite + itso-agent `--sandbox` dùng **restic 0.16.4 thật** + itso-gateway, `ITSO_ACME_EMAIL=ops@itso.local`), DB `migrate:fresh --seed` + `DemoSeeder`, gốc sandbox `.dev/agent-sandbox/root` xóa cùng lúc.

Sửa theo API thật trong 8.7: đích `local` chỉ nhận `/var/backups/itso` (form bỏ ô đường dẫn, hiện gợi ý; MSW 422 nếu khác); khóa retention lệch (contract/UI `keep_*`, API `last/daily/…`) → sửa contract trước (`schemas.py` `RETENTION`: `last, hourly, daily, weekly, monthly`), `make contracts` + `make codegen`, rồi `PolicyService`/`BackupService::expired`, DBML + migration Phase 8; phiên bản mặc định agent/CLI/`make release` `0.4.0-dev` → `0.1.0-alpha`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| E2E stack thật Phase 8 | `pnpm exec playwright test -c playwright.real.config.ts --trace off e2e-real/phase8.spec.ts` | Lần đầu 1 lỗi test (wizard mở ở bước 1 với snapshot chọn sẵn, test chưa bấm "Tiếp"), sửa test → **2/2 PASS** (1,2 phút). Admin: website tĩnh + DB mẫu → đích local qua UI (bộ khôi phục phải xác nhận, lần 2 không hiện lại) → policy `retention {last: 5}` → `:run` → snapshot files + DB, repo trên đĩa → duyệt `sites` → phá dữ liệu → khôi phục file ra bản mới → ghi đè website qua wizard (index.html về bản gốc) → ghi đè DB (export có MARK-A, không có MARK-B) → `itso:backup-verify`. Portal: chỉ snapshot của mình, quota, 403 khi chưa MFA → bật TOTP → step-up → khôi phục thành công, snapshot account khác bị từ chối |
| E2E stack thật toàn bộ | `make test-e2e-real` (stack reset) | **19/19 PASS** (12,6 phút) |
| API | `bash scripts/pest-pg.sh tests/Feature/Phase8` | 11/11 PASS |
| Toàn bộ | `make check` | **20 PASS · 1 SKIP (staticcheck) · 2 FAIL** lần đầu (1 533 s): `lint-web` (Prettier `e2e-real/phase8.spec.ts`), `test-e2e` 14/493 (`demo-admin2.spec.ts` 2 test còn chọn "Cấu hình account" + máy chủ khác đã bỏ ở 8.6; ảnh `recovery-kit` còn nhập đường dẫn local; ảnh `snapshot-detail`/`browse-file` tìm snapshot `4f2a9c1e` đã sang trang 2 → tìm bằng ô Tìm kiếm). Chạy lại đúng các mục: `make lint-web` PASS (i18n 2900 key, vi = en), `playwright test e2e/demo-admin2.spec.ts` 3/3, `SCREENSHOT_DIR_P8=… playwright test e2e/screenshots-phase8.spec.ts -g "recovery-kit\|snapshot-detail\|browse-file"` 12/12 (12 ảnh chụp lại). Còn lại xanh: Pest 462, Vitest 559, Playwright demo 479, Go 17 gói, fuzz 76 539 lần, db-verify 78, contracts/codegen/tokens, docs-check, installer, units, git-clean |
| Go sau đổi phiên bản | `go test ./internal/ops/ ./cmd/... ./internal/install/` | PASS |
| Script VM | `bash -n tests/vm/phase8.sh` | Cú pháp OK (không có shellcheck trên container). **Chờ VM:** B0 gói, B1 backup → xóa site → restore (sha256 + 200), B2 MariaDB số dòng + CHECKSUM TABLE, B3 rest-server `--append-only` forget thất bại, B4 chặn mạng giữa chừng → không snapshot, lần sau xong, B5 `itso-maint.slice` + site 200 khi backup, B6 DR 2 VM |

**Test bị bỏ qua:** không. **Chờ VM:** `tests/vm/phase4.sh`–`phase8.sh` (gồm DR 2 VM).

## 2026-11-21 — Phase 8 / Prompt 8.6 (UI Backup & Restore nối API thật) — nhánh `phase-8`

Phạm vi: `apps/web/src` — `shared/hosting/pages/RestoreWizard` (DB theo `snapshot.databases`, ghi đè đúng 1 website/DB, bỏ mục cấu hình), `shared/hosting/backup.ts`, `entries/admin/backups/{RestoreNewPage,RecoveryKitDialog}` (không chọn server khác; dòng `destination_uuid`), `entries/admin/hosting/TerminatedPage` (xác nhận purge chỉ sau hạn giữ), `entries/admin/install/{DrRestore,InstallPage}` (đường dẫn repo server, `restore_mode`, SFTP → CLI); MSW `demo/handlers/{governance,hosting,setup}.ts` theo hành vi API thật; i18n VI/EN; dữ liệu demo (`contracts/tools/demo.py`: oldshop hết hạn giữ, bộ khôi phục mẫu đúng định dạng thật). Contracts: chỉ ví dụ/mô tả.

Đối chiếu UI ↔ API thật tìm ra (mockup 8.0 giả định khác API): DB trong snapshot không nằm ở `databases/<tên>.sql.zst` (agent: `db/<tên>.sql|.dump`) → chọn theo danh sách `databases` của snapshot; ghi đè nhiều mục / sang server khác / mục cấu hình bị API từ chối → chặn ngay ở wizard; bộ khôi phục thiếu `destination_uuid` nên CLI `itso backup panel-restore` không đọc được; purge thật xóa ngay khi xác nhận và chỉ sau hạn giữ (mockup: xác nhận bất kỳ lúc nào, xóa khi tới hạn).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Vitest (toàn bộ) | `pnpm exec vitest run` (apps/web) | PASS 559/559 (37 file). Sửa/mới: `demo/__tests__/backup8.test.ts` (kit có `destination_uuid`; DR: SFTP 422 kèm hướng dẫn CLI, sai đường dẫn repo 422), `governance.test.ts` (ghi đè sai username → 422 trường `confirm`; ghi đè 2 mục 422; server khác 422), `hosting.test.ts` (mới chấm dứt → xác nhận 409 "Chưa tới hạn"; lên lịch lại thay biên bản cũ; tự xác nhận 409; SA khác → job `hosting_account.purge`, account `purged`; xác nhận lại 422), `backups.test.ts` (`restoreItem('database:…')`) |
| Lint + Prettier + i18n | `pnpm lint` · `pnpm tsc --noEmit` | PASS; `check-i18n: OK — 6 namespace, 2899 key, 0 thiếu (vi = en)` · OK |
| Playwright demo | `pnpm exec playwright test --trace off e2e/demo-backup8.spec.ts e2e/demo-hosting.spec.ts` | 12/12 PASS (Backup Center 5 tab + Portal + wizard DR: axe 0 lỗi critical/serious; purge 2 bước: SA khác xác nhận → "Xóa vĩnh viễn tài khoản", account rời danh sách) |
| Playwright hồi quy | `pnpm exec playwright test --trace off e2e/demo-smoke.spec.ts e2e/demo-portal.spec.ts` | 80/80 PASS |
| Ảnh | `SCREENSHOT_DIR_P8=docs/screenshots/phase-8 playwright test e2e/screenshots-phase8.spec.ts -g "install-dr\|terminated"` | 16/16, chụp lại 12 ảnh (wizard DR có đường dẫn repo server, trang purge) |
| API (không đổi hành vi) | `bash scripts/pest-pg.sh tests/Feature/Phase8` · `make lint-api` · `make contracts-check` · `make codegen-check` | PASS 11/11 · PASS · PASS · OK |

**Chờ VM:** không (luồng thật kiểm ở 8.7). **Test bị bỏ qua:** không.

## 2026-11-21 — Phase 8 / Prompt 8.5 (khôi phục thảm họa) — nhánh `phase-8`

Môi trường: PostgreSQL 16 + Redis trong container; agent giả kiểm params/result theo `contracts/agent-ops`; agent thật chạy với restic thật trong test Go. Diễn tập DR trên 2 VM: **chờ VM** (`tests/vm/phase8.sh`, Prompt 8.7).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Phase 8 API | `bash scripts/pest-pg.sh tests/Feature/Phase8` | PASS 11/11. Mới `DisasterRecoveryTest` 4 test (89 assertion): `restore_mode` theo mã thiết lập (mã thường → false); inspect chưa xác minh mã 403, sai trường 422, đích SFTP 422 kèm hướng dẫn CLI, liệt kê bản panel mới nhất trước (`accounts` null), agent báo sai mật khẩu → 422 trên `repository_password`, không tạo job, không lưu bí mật; start → job `setup.restore`/`panel.restore`, agent nhận giá trị thật, `job_steps` chỉ có tham chiếu `$secret`, khóa Cache bị xóa khi job xong, bí mật không có trong job/log/audit/bảng backup; đã tạo SA → 409, đã cài → 410; `itso:dr-restore` chưa bật không làm gì, `--dry-run` không bật, `--start --parallel=1` → một job 2 bước ghi đè (website + DB), restore job gộp kết quả + snapshot pre-restore, lượt sau báo xong (`dr.finished`), lượt nữa không xếp thêm; một bước lỗi → restore job `failed`, giữ kết quả bước đã xong, báo "1 account lỗi" |
| Pest toàn bộ | `make test-api` | PASS 462/462 (5161 assertion) |
| Agent | `go test ./internal/install/ ./internal/platform/ ./internal/ops/ ./cmd/...` | PASS. `TestPanelRestoreStagesAndSchedulesApply` (restic thật: backup panel mã hóa age → giải vào staging 0700, hẹn `systemd-run … itso panel-restore-apply`, thiếu `itso.dump` → `precondition_failed` và dọn staging, repo không phải `/server` → từ chối); `TestPanelRestoreApply` (đường dẫn ngoài staging/`..` bị từ chối; `pg_restore` lỗi → dịch vụ bật lại, DB không đổi, kết quả ghi `ok:false`; đúng thứ tự pre-restore → down → stop → pg_restore → migrate → start → reconcile → dr-restore → up; `itso.env` chỉ thay APP_KEY; `agent.key`/TLS giữ bản máy mới; bản rõ trong staging bị xóa); `TestInstallRestoreMode` (mã thiết lập `mode: restore`, gợi ý DR) |
| Trình cài đặt | `make test-installer` | PASS 9/9 (mới: `--restore` được chuyển nguyên cho `itso install`) |
| Tĩnh | `vendor/bin/phpstan analyse` · `make lint-api` · `make no-exec` · `make lint-agent` | 0 lỗi · PASS · OK · OK |
| Contracts/DB | `make contracts && make codegen && make contracts-check && make codegen-check && make db-verify` | PASS (op mới `panel.restore`; `SetupRestoreSource.repository_path`; `SetupStatus.restore_mode`; inspect khai báo 409) |
| Web | `pnpm lint` · `pnpm tsc --noEmit` · `pnpm vitest run` | OK · OK · PASS 559/559 (37 file). Lần đầu 2 test `portal.test.ts` fail (đã fail từ trước, không do 8.5: account `hoidong` thêm ở mockup 8.0 cùng chủ anphat) → cập nhật danh sách account kỳ vọng |

Lỗi tìm ra nhờ test và đã sửa: test agent gọi `panel.restore` hai lần cùng giây đụng thư mục staging (đổi đồng hồ test); test wizard demo timeout khi demo bật `restore_mode` (demo giữ false, cài mới là luồng mặc định); kết quả gộp nhiều bước trùng đường dẫn (khử trùng).

Giới hạn còn lại: danh sách bản backup panel chưa hiện phiên bản panel/số account (nằm trong bản mã hóa age); đích SFTP không khôi phục qua wizard (cần khóa SSH + host key theo `destination_uuid`), đi đường CLI `itso backup panel-restore` → `itso panel-restore-apply` (runbook).

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 8 / Prompt 8.4 (Panel API Backup & Restore) — nhánh `phase-8`

Môi trường: PostgreSQL 16 + Redis trong container; agent giả (`FakeAgent`) kiểm mọi params/result op backup theo `contracts/agent-ops` (helper `p8schema`, Opis JSON Schema), nên tham số panel gửi đi khớp schema agent thật.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Phase 8 API | `make test-api` (lọc `tests/Feature/Phase8`) | PASS 7/7, 423 assertion: đích (tạo/sửa/kiểm tra, trùng vị trí 409, local sai đường dẫn 422, credential chỉ tới agent qua tham chiếu bí mật, Object Lock phát hiện → prune `cli`), bộ khôi phục (lần đầu 200, sau xác nhận + hết step-up 403); backup ngay (init → files → DB → stats, lần sau không init, snapshot ghi nhận theo loại); Portal chỉ thấy snapshot/khôi phục account mình, USER khác 404/422; duyệt + link tải ký HMAC (chữ ký sai 403, quá 5 phút 403, nội dung stream theo khúc đúng); policy + `itso:backup-due` (chưa đến hạn không chạy, đến hạn chạy, lần kế lệch jitter, `last_status`), retention keep_last 1 → forget, đích append-only → không forget; quota 1 MB đang dùng 5 MB → 409 `quota_exceeded`, policy bỏ qua, tổng quan báo `paused`; verify (check + restore test, lỗi lệch sha256 → failed + lỗi trong 3-2-1-1-0); xóa snapshot (ADMIN 403, đích bất biến 409, SA → forget); khôi phục new (website/file, DB mới `<tên>_r<ts>` sẵn sàng), overwrite (sai username 422, hết step-up 403 `mfa_step_up_required`, đúng → snapshot pre-restore), Portal khôi phục cần MFA/step-up; purge (account chưa chấm dứt 409, ADMIN 403, restore test hỏng → xác nhận 409 D-46, chưa tới hạn 409, người lên lịch tự xác nhận 409, SUPER_ADMIN thứ hai → `account.remove` + biên bản, account `purged`); ma trận quyền; bí mật (mật khẩu repo, credential đích, khóa age riêng) không có trong job_steps/job_logs/audit_logs/jobs/các bảng backup |
| Pest toàn bộ | `make test-api` | PASS 458/458 (5074 assertion). Lần đầu 3 test cũ fail vì còn kỳ vọng purge trả 501 và `backup-snapshots` chưa có route: đã cập nhật theo hành vi mới (purge chặn account chưa chấm dứt / thiếu biên bản; đường dẫn "chưa có" dùng `/account-migrations` của Phase 9) |
| Tĩnh | `vendor/bin/phpstan analyse` · `make lint-api` · `make no-exec` | 0 lỗi · PASS · OK (lần đầu `no-exec` bắt dấu backtick trong chuỗi thông báo; đổi sang ngoặc kép) |
| Contracts/DB | `make contracts && make codegen && make contracts-check && make codegen-check && make db-verify` | PASS (op mới `backup.file.read`; `Restore.snapshot_uuid` nullable + `restore_jobs.snapshot_id` nullable để giữ lịch sử khi snapshot bị forget) |
| Agent | `go test ./internal/ops/ ./internal/contracts/...` · `make lint-agent` | PASS (`TestBackupFileRead`: đọc khúc giữa file, offset ≥ size → eof, thư mục/symlink bị từ chối) · OK |

Lỗi tìm ra nhờ test và đã sửa: hạn link tải dùng `time()` (không theo đồng hồ test) → `Carbon::now()`; forget snapshot vướng khóa ngoại (`backup_jobs`, `restore_jobs`…) → giữ lịch sử với tham chiếu null; trigger DB `itso_hosting_purge_guard` đòi người xác nhận khác người lên lịch → panel kiểm trước và báo 409 rõ ràng; policy ghi `running` sau khi job đồng bộ đã xong → ghi trước khi dispatch.

Giới hạn còn lại (ghi vào báo cáo Phase 8): agent thật chưa hiện thực `account.remove` (chỉ agent mock) nên bước xóa của purge trên máy thật sẽ báo lỗi op, không giả thành công.

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 8 / Prompt 8.3 (agent: khôi phục, kiểm chứng, forget, backup panel, CLI) — nhánh `phase-8`

Môi trường: restic 0.16.4 (gói Ubuntu) trong container, chạy bằng root; helper File Manager chạy trong tiến trình ở sandbox (uid account kiểm qua argv ghi lại).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| fsx khôi phục | `go test ./internal/fsx/ -run 'TestRestoreTar\|TestExchange'` | PASS 2/2: giải đúng nội dung, symlink/FIFO bị bỏ và báo lý do, setuid gỡ (0755), đích có sẵn → `already_exists`, tên `..` bị từ chối không để rác, vượt kích thước lỗi, đích là symlink ra ngoài không bị ghi xuyên; hoán đổi nguyên tử, từ chối hoán đổi với symlink |
| Backup panel + bộ khôi phục | `go test ./internal/backup/` | PASS: tar + age round-trip (bản mã không chứa chuỗi bí mật, khóa sai/recipient sai lỗi, vượt giới hạn lỗi, tar độc `..`/symlink bị từ chối, file giải ra không cho group/other đọc); `ParseKit` (CRLF, 2 repo, đường dẫn repo lạ bị từ chối) |
| restic thật: khôi phục | `go test ./internal/ops/ -run 'TestBackupRestore\|TestBackupCheck\|TestBackupForget\|TestBackupPanel\|TestKitCreds'` | PASS 8/8: file vào `backups/restore-<ts>` khớp nội dung, symlink → `/etc/shadow` không tạo lại, setuid gỡ, giải qua helper `[uid=20001]`, staging được dọn, chạy lại → `already_exists`; symlink đặt sẵn tại đích và thư mục cha symlink → từ chối, thư mục ngoài home trống; website ghi đè trả về bản snapshot, file lạ (`shell.php`) rời bản đang chạy, bản cũ giữ ở `.restore-<ts>`, snapshot pre-restore có hostname = server; DB bản mới/đã tồn tại/sai tên/account khác, ghi đè có pre-restore, nhập dưới uid 20001; `restore_test` DB nạp DB tạm OK; `check` 100% OK, làm hỏng pack → `check` báo lỗi và `restore_test` không ra ok; `backup.forget` bị `op_disabled` theo policy mặc định; backup panel: `pg_dump --cluster 16/itso -Fc itso` dưới uid postgres, staging dọn, `restore_test` kiểm sha256 file `.age`, `KitPanelRestore` giải ra đúng 3 file, khóa riêng sai bị từ chối; prune bằng bộ khôi phục keep-last 1: dry-run 2 mục (snapshot + meta), chạy thật còn đúng snapshot mới nhất |
| CLI | `go test ./cmd/itso/` | PASS: cú pháp sai → mã 2 + usage; thiếu `--keep-*`, keep âm, snapshot `latest`, bộ khôi phục thiếu khóa riêng → mã 1 với thông báo rõ |
| Agent toàn bộ | `go vet ./... && go test ./...` · `make lint-agent` · `make no-exec` | PASS · OK · OK (lần đầu `no-exec` bắt chuỗi shebang trong dữ liệu test; đổi nội dung file test) |

Lỗi gặp khi viết test và đã sửa: `os.Chmod(…, 0o4755)` của Go không đặt setuid (phải dùng `os.ModeSetuid`); tag `pre_restore_tags` thử ngoài mẫu schema bị từ chối đúng (đổi dữ liệu test); hai lần khôi phục cùng giây trùng tên `.restore-<ts>` → `already_exists` đúng thiết kế (test đổi giờ).

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 8 / Prompt 8.2 (agent: runner restic, đích, backup) — nhánh `phase-8`

Môi trường: restic 0.16.4 (gói Ubuntu) trong container.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Logic backup | `go test ./internal/backup/` | PASS: URL 4 loại đích, 15 đích/repo độc bị từ chối, argv không chứa mật khẩu repo/credential S3/rest, `sftp.command` cố định, loại trừ neo dưới home, tag/snapshot id độc, đọc `ls --json` chỉ mục con trực tiếp, phân loại lỗi + che credential, manifest bỏ symlink và file đổi; SSH server thật trong tiến trình (ghim host key, lệch → `host_key_mismatch`, khóa chưa thêm → `repo_auth_failed`); S3 SigV4 + Object Lock 30 ngày, rest-server append-only 403/404 |
| restic thật | `go test ./internal/ops/ -run TestBackup` | PASS 4/4: init idempotent, repo local 0700, backup files (symlink → `/etc/shadow` lưu như symlink, `tmp/` `.cache/` `*.log` bị loại), dump DB dưới uid 20001 qua `--stdin`, snapshots (snapshot meta bị ẩn, hostname = server), browse + truncated, stats, sai mật khẩu → `repo_auth_failed`, repo chưa init → `repo_not_initialized`, thư mục bí mật bị xóa sau op; golden argv máy thật `backup.s3.argv` (EnvironmentFile 0600); 10 tham số độc bị từ chối trước khi chạy restic. Lần đầu golden thiếu bước `init` do hook test so chuỗi sai (" cat config"); sửa hook, ghi lại golden |
| Fuzz | `go test -run='^$' -fuzz=FuzzParseDest -fuzztime=15s ./internal/backup` | PASS 87 482 lần (lần đầu đếm sai số thành phần `sftp.command` trong chính test: 23, không phải 22); thêm vào `make test-fuzz` |
| Agent toàn bộ | `go vet ./... && go test ./...` · `make no-exec` | PASS · OK |

**Test bị bỏ qua:** không (test restic thật tự bỏ qua khi máy không có `/usr/bin/restic`; ở đây có).

## 2026-11-21 — Phase 8 / Prompt 8.1 (ADR, contracts, migration) — nhánh `phase-8`

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` | PASS: 113 op có schema, 466 example, 233 vector độc (207 tầng schema đã kiểm, 26 tầng nghiệp vụ) |
| Codegen | `make codegen` · `make codegen-check` | OK (`types_gen.go`, schema TS, dữ liệu agent đồng bộ) |
| DB | `make db-schema` · `python3 database/tools/gen_migrations.py 8` · `make db-verify` | Lần đầu lỗi: `50_purge.sql` còn chèn `restic_password_encrypted` (cột đã bỏ). Sửa seed sang `backup_repositories`; thêm `70_backup.sql` (17 kiểm tra). Chạy lại: 78 test PASS, Phase 3 → 11 áp lần lượt = đặc tả |
| Agent | `cd agent && go build ./... && go test ./...` | PASS |
| Pest | `make test-api` | 450/451 lần đầu: `SchemaTest` liệt kê bảng theo Phase chưa có Phase 8. Thêm `PHASE8_TABLES`; `pest tests/Feature/Schema/SchemaTest.php` 12/12 PASS |
| Docs | `make docs-check` · `make structure` | PASS |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 8 / Prompt 8.0 (mockup Backup & Restore trên bản demo) — nhánh `phase-8`

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Ảnh mockup | `SCREENSHOT_DIR_P8=docs/screenshots/phase-8 npx playwright test e2e/screenshots-phase8.spec.ts --trace off --workers=4` | PASS 84/84 (21 màn × 1440/390 × sáng/tối); `make screenshots` thêm `SCREENSHOT_DIR_P8` |
| E2E demo Phase 8 | `npx playwright test e2e/demo-backup8.spec.ts --trace off` | Lần đầu 6/8: axe `label-content-name-mismatch` ở nút kiểm chứng (nhãn không chứa chữ hiển thị) và hộp thoại bộ khôi phục đóng được bằng Esc lúc đang tải. Sửa nhãn `bk.verifyFor` + chặn Esc/bấm ngoài khi chưa xác nhận. Chạy lại 8/8 PASS |
| Unit/demo | `pnpm vitest run` | 37 file, 559 test PASS (mới `backup8.test.ts` 14) |
| Lint + i18n | `pnpm lint` | PASS; i18n 2895 key, vi = en |
| Contracts | `make contracts-check` · `make codegen` → `make codegen-check` · `python3 contracts/tools/check_demo.py` | PASS · OK · OK (466 example, độ phủ 100%) |
| Agent contracts | `cd agent && go test ./internal/contracts/...` | PASS |

**Test bị bỏ qua:** không. Ảnh Phase 2–7 có thể đổi ở lần `make screenshots` sau vì dữ liệu demo thêm account đã chấm dứt, quota và đích SFTP.

## 2026-11-21 — Phase 7 / Prompt 7.7 (e2e, VM, review, báo cáo) — nhánh `phase-7`

Môi trường: PostgreSQL 16 + Redis cục bộ; `make dev` (Laravel + queue + Vite + itso-agent `--sandbox` + itso-gateway, `ITSO_ACME_EMAIL=ops@itso.local`), DB `migrate:fresh --seed` + `DemoSeeder`, gốc sandbox `.dev/agent-sandbox/root` xóa cùng lúc.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| E2E stack thật | `make test-e2e-real` | PASS 17/17 (9,9 phút). Mới `phase7.spec.ts` 5: tường lửa (xem trước có cổng mới → áp dụng → "Giữ cấu hình mới" → confirmed; áp dụng không xác nhận 30 giây → `rolled_back`, confirm muộn 409, sự kiện high), SSH hardening (thiếu server 422, MaxAuthTries → xác nhận → API + UI), WAF (mặc định detect → block, sự kiện `942100 blocked` qua `itso:waf-events-sync`) + EICAR (quét → finding clamav → cách ly → khôi phục), FIM (added + modified qua `itso:fim-check`), CAPTCHA Portal (422 `captcha_required`, lời giải giả bị từ chối, UI tự giải rồi vào được) + root terminal policy tắt → 409. Lần chạy đầu 16/17: `phase3` tạo account lỗi `already_exists` (gid 20004) vì DB reset mà gốc sandbox còn account cũ; xóa gốc sandbox, chạy lại xanh |
| Lỗi thật tìm thấy | — | Gốc sandbox không có user `root` → `sshd.config.apply` luôn `not_found` ở dev/e2e. Sửa `Sim.SeedBase()`; `go test ./internal/ops -run TestSimSeedBase` PASS; `go test ./...` PASS |
| Toàn bộ | `make check` | 19 PASS · 1 SKIP (staticcheck) · 3 FAIL lần đầu (923 s): docs-check (dấu gạch đứng trong bảng của file review), test-e2e (4 ảnh mockup `admin-login-captcha`: realm Admin không còn CAPTCHA từ 7.6 → xóa mockup), test-agent (6 test installer kiểm preflight đĩa thật: còn 9 GB < 10 GB; `composer clear-cache` giải phóng 19 GB). Chạy lại: `make docs-check` PASS, `make test-agent` PASS, `playwright test e2e/screenshots-phase7.spec.ts` 64/64 PASS. Còn lại xanh: Pest 451, Vitest 541, Playwright demo 401, fuzz 600 866 lần, db-verify 60, contracts/codegen/tokens, installer, units, git-clean |
| Script VM | `bash -n tests/vm/phase7.sh` | Cú pháp OK. **Chờ VM:** S0–S7 (gói, safe-apply khi dừng agent, fail2ban thật, WAF OWASP, EICAR + tải, FIM, điểm ≥ 80, root theo policy) |

**Test bị bỏ qua:** không. **Chờ VM:** `tests/vm/phase4.sh`–`phase7.sh`.

## 2026-11-21 — Phase 7 / Prompt 7.6 (UI nối API thật) — nhánh `phase-7`

Phạm vi: `apps/web/src` — `shared/api/core.ts` (`SendOpts` có `query`, `getWith` thử lại sau step-up), `entries/admin/security/{useServer,SshPage,Fail2banPage,FimPage,TerminalSessionsPage}`, `servers/{ServerFirewallPage,firewall.ts,ServerTerminalPage}`, `sites/WebsiteDetailPage` (WAF events), `install/InstallPage`, `system/SettingsPage`; i18n VI/EN; MSW `demo/handlers/{security,governance,infra,admin}.ts`. Contracts không đổi.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Vitest (toàn bộ) | `pnpm exec vitest run` (apps/web) | 541/541 PASS (36 file). Mới/sửa: `demo/__tests__/security.test.ts` (CAPTCHA chỉ Portal + Admin không đòi; SSH/fail2ban thiếu/sai server → 422/404; root policy tắt 409, ADMIN 403, SA 201; bản ghi phân trang qua `loadRecording`; bans + unban; firewall status/preview; FIM changes; WAF events), `servers/__tests__/firewall.test.ts` (sự kiện `resume`), `shared/auth/__tests__/captcha.test.ts`; `governance`/`handlers`/`infra` test cập nhật theo `?server=` và 409 root |
| Lint + Prettier + i18n | `pnpm lint` | PASS; `check-i18n: OK — 6 namespace, 2748 key, 0 thiếu (vi = en)` |
| Playwright demo mới | `pnpm exec playwright test --trace off e2e/demo-security7.spec.ts` | 2/2 PASS (gỡ chặn IP fail2ban + axe 0 lỗi critical/serious; hộp áp dụng tường lửa hiện ruleset xem trước). Lần đầu đỏ do test: thiếu trường Nguồn, và drawer theo dõi job che bảng (đã đóng drawer trong test) |
| Playwright demo hồi quy | `pnpm exec playwright test --trace off e2e/demo-smoke.spec.ts e2e/demo-infra.spec.ts` | 82/82 PASS. Trước đó smoke đỏ 1 do MSW thiếu `fim/changes` → thêm list spec, chạy lại xanh |

**Chờ VM:** không (thay đổi chỉ ở web/MSW; luồng thật kiểm ở 7.7). **Test bị bỏ qua:** không.

## 2026-11-21 — Phase 7 / Prompt 7.5 (Terminal root + ghi phiên) — nhánh `phase-7`

Phạm vi: agent `internal/policy` (record_user, bí danh khóa, `RootTerminal()`), `internal/term/record.go` (Recorder asciicast v2, ReadPage), `term.Manager` (phiên sống, ghi phiên, `ErrDuplicate`), `ops/pty.go` (`pty.open.root`, `pty.policy`, `pty.list`, `pty.recording.read`, argv root), CLI `itso allowlist reset`, `itso policy set … on|off`; Panel `TerminalService` (openRoot, policy, recording, reap theo pty.list), `TerminalController` mode=root, `Security/TerminalSessionController`, model `TerminalRecording`, lệnh `itso:allowlist-reset`. Contracts không đổi (đã đặc tả ở 7.1).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go (toàn bộ, race) | `cd agent && go test -race ./...` | PASS. Mới: `term/record_test.go` 4 (ghi + đọc theo trang 1 KB ghép bằng bản đọc một lần, offset giữa dòng/vượt kích thước bị từ chối, file 0600; vượt giới hạn → marker truncated + đóng phiên `limit`; không ghi được / thiếu RecDir → `record_failed`, uuid trùng → ErrDuplicate; rune UTF-8 cắt đôi), `ops/pty_test.go` +3 (pty.open.root khi policy tắt → `op_disabled` ở handler và ở registry dùng policy thật dù Deps cấu hình sai, `ops.pty.open.root=false` thắng cờ; pty.list/pty.recording.read qua harness hợp đồng, đọc theo trang ≥ 3 trang ghép lại khớp; golden argv root), `install_test` (bí danh terminal.root/record_user, on/off, `allowlist reset` → artisan). Test cũ sửa: `term_test`, `pty_test`, `gateway_test` cấp session_uuid mới mỗi lần (uuid trùng phiên sống nay bị từ chối) |
| Go vet + gofmt | `make lint-agent` | PASS |
| Pest (toàn bộ, PostgreSQL 16 + Redis) | `scripts/pest-pg.sh --parallel` tương đương `make test-api-pg` | 451/451 PASS (32 s). Mới `Phase7/TerminalRootTest` 7: SUPER_ADMIN mở root khớp hợp đồng, ticket không vào DB/audit; policy tắt → 409 kèm hướng dẫn CLI, audit failure; ADMIN trong phạm vi / USER Portal → 403 không gọi agent; thiếu/sai server 422; step_up_seconds = 3600 nhưng root đòi ≤ 10 phút; mỗi lần mở một session_uuid mới, agent hết chỗ → 409; policy + danh sách phiên theo phạm vi (ADMIN không thấy root, ngoài phạm vi 404); bản ghi theo offset, next_offset null khi hết, metadata bytes/truncated cập nhật, offset sai 422, ADMIN 403, step-up quá hạn, phiên không ghi 404; reap theo pty.list + dự phòng 12 giờ; `itso:allowlist-reset`. Test cũ sửa: `Phase6/TerminalTest` mode=root không còn 409 (nay 422 thiếu server_uuid) |
| PHPStan level 8 + Pint | `make lint-api` | PASS (0 lỗi) |
| Không lệnh hệ thống | `make no-exec` | OK (lần đầu bắt được backtick trong chuỗi thông báo → đổi sang ngoặc kép) |
| Codegen | `make codegen-check` | OK |

**Chờ VM:** root terminal thật qua systemd-run + itso-gateway, bật bằng `itso policy set terminal.root on` rồi có bản ghi, policy tắt → bị từ chối (`tests/vm/phase7.sh` ở 7.7). **Test bị bỏ qua:** không.

## 2026-11-21 — Phase 7 / Prompt 7.4 (Panel API Security Center) — nhánh `phase-7`

Phạm vi: `apps/api/app/Domain/Security/*` (Net, FirewallRuleset, SafeApply + 4 panel step, FirewallService, SshService, Fail2banService, WafService, MalwareService, SecurityAudit, SecurityScore, SecurityEvents, SecurityBaseline, SecurityJobHandler), controller `Security/{Firewall,Security,Protection}Controller`, `Auth/{Captcha,AuthFailureLog}`, 10 model, 3 lệnh lịch; contracts: `FirewallRule.ports` cho phép null (icmp), `password:forgot` nhận `captcha`; DB: thêm cột uuid/direction/enabled/sha256… cho bảng Phase 7 (migration Phase 7 chưa phát hành → sinh lại).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Pest (toàn bộ, PostgreSQL 16 + Redis) | `scripts/pest-pg` tương đương `make test-api-pg` | 444/444 PASS (56 s). Mới `tests/Feature/Phase7/`: FirewallTest 6 (ruleset PHP == golden `firewall.nft` của agent; vector evil-inputs `firewall_rule`/`cidr` dùng chung với agent; rule nháp → xem trước → apply step-up → pending → confirm; token không có trong job_steps/job_logs/audit_logs/jobs/firewall_applies; một lần chờ → 409; confirm quá hạn → job failed `precondition_failed`, rolled_back + sự kiện high + thông báo; `itso:security-audit --expire-only`; apply tự khóa → 422 would_lock_out, agent would_lock_out → failed; ma trận quyền + step-up), SecurityCenterTest 6 (điểm mặc định 80/100 hạng B với dữ kiện sau cài, tổng trọng số 100, thiếu dữ kiện không 500; SSH safe-apply, admin_keys = 0 chặn tắt mật khẩu, đổi port = job firewall.apply + sshd.config.apply, một confirm cho cả hai; fail2ban ignoreip = allowlist, jail lạ/bantime sai → 422, bans + unban, ADMIN chỉ xem/gỡ cấm; FIM không trùng lặp + baseline step-up; sự kiện lọc/ack, ADMIN ngoài phạm vi 404; allowlist không chứa IP hiện tại → would_lock_out, chuẩn hóa CIDR, chặn IP ngoài danh sách), ProtectionTest 3 (quét website → finding + sự kiện; cách ly/khôi phục; quét dở → 409; Portal: tổng quan, quét, cách ly, xóa cần step-up, USER khác 404; WAF DetectionOnly mặc định, If-Match 412, chặn → mode On, đồng bộ 55 sự kiện theo con trỏ + `waf.burst`), AuthProtectionTest 4 (CAPTCHA sai/sửa/realm khác/dùng lại/hết hạn → 422 captcha_required, ngưỡng 0, quên mật khẩu; auth.log đúng failregex, không chứa email/mật khẩu; portal_mfa_required) |
| Test cũ phải sửa theo hành vi mới | — | `Auth/LoginTest` khóa lũy tiến: đặt ngưỡng CAPTCHA = 10 trong test (CAPTCHA Portal mặc định bật sau 3 lần sai, kiểm riêng ở Phase7); `Platform/PlatformApiTest` "chưa có route": đổi sang `/admin/backup-snapshots` (Phase 8) vì `/admin/security/overview` nay đã có |
| PHPStan level 8 + Pint | `make lint-api` | PASS (0 lỗi) |
| Không lệnh hệ thống | `make no-exec` | OK |
| Contracts / codegen | `make contracts-check` · `make codegen-check` | PASS · OK |
| DB | `make db-verify` | 60 SQL test PASS (thêm 7: direction/protocol/priority, sha256/engine của finding); Phase 3 → 11 áp lần lượt == `itso.sql` + `extras.sql` |
| Web | `pnpm exec tsc --noEmit` · `pnpm vitest run` | PASS · 525/525 (sau khi sinh lại kiểu từ contracts) |

**Chờ VM:** safe-apply thật qua agent (mất kết nối → tự hoàn tác), fail2ban đọc `/var/log/itso/auth.log`, ModSecurity/ClamAV thật. **Test bị bỏ qua:** không.

## 2026-11-21 — Phase 7 / Prompt 7.3 (agent WAF, malware, FIM, audit) — nhánh `phase-7`

Phạm vi: `agent/internal/ops/{waf,malware,fim}.go`, helper `fsx` (op `hash`, `raw`, `delete_if`), `platform.FS.Lstat/ReadChunk`, vhost template thêm `include /etc/itso/waf/<uuid>.nginx*;`, sandbox mô phỏng clamdscan/yara (EICAR, `eval(base64_decode(`), `packaging/share/yara/itso-webshell.yar` (đóng gói trong `scripts/release.sh`).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go (toàn bộ) | `go test -count=1 ./...` (agent) | PASS (15 package có test). Mới `ops/security2_test.go`: WAF (thiếu gói → available=false; golden rule/include/argv; đổi rule vẫn nginx -t + reload; nginx -t lỗi → khôi phục; Off gỡ; rule id trùng/chuỗi, paranoia 5 bị từ chối), sự kiện WAF (Host ↔ server_name, chọn rule cụ thể thay vì 949110, dòng hỏng/dòng chưa ghi xong, limit, xoay vòng log), quét (EICAR + webshell, symlink tới file hệ thống không bị theo, argv systemd-run có slice/Nice/IO idle, traversal bị từ chối), cách ly (sha256 lệch, symlink → path_outside_home, 0600, idempotent), khôi phục (không ghi đè, account khác bị từ chối, overwrite), xóa theo sha256, FIM (thêm/sửa/xóa/chmod setuid, bỏ qua thư mục chứng chỉ, chỉ itso* trong systemd), security.audit (sshd -T, unattended, reboot-required, gói -security, firewall policy drop, baseline) |
| Golden vhost | `go test ./internal/ops -run Vhost -update` | 5 file golden vhost chỉ thêm đúng 1 dòng include WAF (đã xem diff) |
| Lỗi thật phát hiện khi test | — | helper op `raw` (mới) ghi JSON lỗi vào stdout như op thường → agent coi là nội dung file; sửa: `fsx.StreamsStdout` dùng chung cho cat/raw (lỗi qua stderr, mã 3) |
| Lint agent | `make lint-agent` | PASS |

**Chờ VM:** ModSecurity/CRS thật (payload SQLi/XSS bị chặn ở On, chỉ ghi nhận ở DetectionOnly), clamd thật với EICAR, yara 4.5 (`-N`, `-z`). **Test bị bỏ qua:** không.

## 2026-11-21 — Phase 7 / Prompt 7.2 (agent firewall, SSH, Fail2ban) — nhánh `phase-7`

Phạm vi: `agent/internal/ops/{safe,firewall,sshd_hardening,fail2ban,sandbox_security}.go`, lệnh `itso-agent safe-rollback <kind> <apply_id>` (timer systemd gọi) + hoàn tác lần chờ quá hạn lúc khởi động, Bins `nft`, `fail2ban-client`, recipe Phase 7 trong `validate.Recipes`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go (toàn bộ) | `go test ./...` (agent) | PASS (15 package có test). Mới `ops/security_test.go`: safe-apply + xác nhận (token sai/đúng, lặp lại idempotent, busy khi còn chờ, token không lưu thô), hết hạn → hoàn tác (đồng hồ giả), lần đầu bị hoàn tác → xóa bảng, timer chạy muộn không làm gì, agent khởi động lại sau hạn → hoàn tác, không hẹn được timer → hoàn tác ngay, `nft -c` lỗi → không áp dụng, 13 biến thể tự khóa/độc, vector `firewall_rule` + `cidr` từ contracts, SSH hardening (0 khóa → would_lock_out, thứ tự sshd -t → reload → timer, hết hạn → xóa file, `sshd -t` lỗi → khôi phục không reload), fail2ban (golden jail/filter, status/ban list, unban, IP/jail lạ, `-t` lỗi); golden mới `firewall.nft`, `10-itso-hardening.conf`, `fail2ban-itso*.conf`, `fail2ban.apply.argv` |
| Lần chạy đầu | `go test ./...` | 2 lỗi thật đã sửa: test vector cũ đọc `input` kiểu chuỗi (vector mới là số/đối tượng) → đọc RawMessage; `validate.Recipes` thiếu fail2ban/modsecurity |
| Fuzz | `go test -run='^$' -fuzz=FuzzFirewallRule -fuzztime=10s ./internal/ops` (thêm vào `make test-fuzz`) | PASS (~100k exec, không lỗi) |
| Lint agent | `make lint-agent` (gofmt, go vet, không os/exec ngoài platform) | PASS |

**Chờ VM:** nft/sshd/fail2ban thật, mất kết nối → tự hoàn tác (tests/vm/phase7.sh ở 7.7). **Test bị bỏ qua:** không.

## 2026-11-21 — Phase 7 / Prompt 7.1 (ADR + contracts + migration) — nhánh `phase-7`

Phạm vi: ADR 0023–0028; agent-ops Phase 7 (22 op có schema, `would_lock_out`, recipe, ví dụ envelope `firewall.apply` hợp lệ + 1 không hợp lệ); OpenAPI +7 operation; DBML +6 bảng, extras (CHECK, unique một phần "một safe-apply chờ", partition `waf_events`), migration Phase 7. Chưa đổi hành vi Laravel/agent/UI (handler demo cho 7 endpoint mới làm ở 7.6).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` → `make codegen` → `make codegen-check`; `make contracts-check` | PASS (admin 258, portal 113 operation; agent-ops 108 op có schema, 12 khai báo; evil-inputs 190 vector, tầng schema đúng kỳ vọng; 7 envelope hợp lệ, 11 không hợp lệ bị từ chối) |
| Schema DB | `make db-schema`, `make db-verify` | PASS: 53 test SQL (mới `database/tests/60_security.sql` 12 test); migration Phase 3–7 khớp đặc tả, áp lần lượt = itso.sql + extras.sql |
| Pest SchemaTest (PG16) | `php vendor/bin/pest --filter=SchemaTest` | 12/12 (thêm kiểm 12 bảng Phase 7 + ràng buộc safe-apply/WAF/FIM) |
| Go | `go build ./...`, `go test ./internal/contracts/... ./internal/registry/... ./internal/mock/...` | PASS (struct sinh cho 22 op mới) |
| Vitest | `pnpm exec vitest run` | 525/525 (không đổi) |
| Cấu trúc / docs | `make structure`, `make docs-check` | PASS |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 7 / Prompt 7.0 (mockup trước khi code) — nhánh `phase-7`

Phạm vi: chỉ bản demo + contract cho màn mới (không đụng Laravel/agent). Contract thêm trước: `GET /auth/captcha` + `LoginRequest.captcha`, `ErrorCode` `captcha_required`/`would_lock_out`, `SshSettingsPatch.rollback_after_sec` + `POST /security/ssh:confirm`, `GET /servers/{id}/terminal/policy`, `GET /terminal/sessions` + `/{id}/recording`, `GET /security/malware/findings` + `:quarantine`, `POST /servers/{id}/fim:baseline`, Portal `/protection`, `/protection/findings` (+ `:quarantine`, `DELETE`), `POST /hosting-accounts/{id}/scans`; op khai báo `sshd.config.confirm`, `malware.quarantine`, `malware.delete`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` → `make codegen` → `make codegen-check`, `make contracts-check` | PASS (admin 251, portal 113 operation; lần đầu contracts-check báo Portal dùng tài nguyên/tag admin-only `security` → đổi sang `/protection`, tag `Protection`; op job chưa có trong catalog → khai báo) |
| Dữ liệu demo | `python3 contracts/tools/check_demo.py` | PASS |
| Vitest | `pnpm exec vitest run` | 525/525 (mới: `demo/__tests__/security.test.ts` 16 test: PoW, CAPTCHA ngưỡng + dùng một lần, SSH safe-apply xác nhận/tự hoàn tác/would_lock_out, chống tự khóa tường lửa, policy root, phiên + bản ghi, mã độc Admin/Portal). Lần đầu 4 test cũ lỗi do đổi hành vi có chủ đích (PATCH SSH cần `rollback_after_sec`, root mặc định bị policy chặn, route `/recording` cần id phiên có ghi) → cập nhật test |
| Playwright demo (gồm axe) | `pnpm exec playwright test --grep-invert "screenshots…"` | 211/211 |
| Mockup | `SCREENSHOT_DIR_P7=docs/screenshots/phase-7 playwright test e2e/screenshots-phase7.spec.ts` | 68/68 ảnh (17 màn × 1440/390 × sáng/tối) |
| Lint web | `make lint-web` (ESLint, Prettier, tsc, i18n 2716 khóa vi = en, tokens) | PASS |
| Go | `go build ./...`, `go test ./internal/contracts/...` | PASS |
| Pest (PG16 + Redis) | `php vendor/bin/pest` | 424/424 (không đổi hành vi Laravel) |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 6 / Prompt 6.6 — nhánh `phase-6`

Môi trường: PostgreSQL 16 + Redis cục bộ; `make dev` (Laravel + queue + Vite + itso-agent `--sandbox` + itso-gateway), DB `migrate:fresh --seed` + `DemoSeeder`. Container không có KVM/systemd: `tests/vm/phase6.sh` **chờ VM**.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| E2E stack thật | `make test-e2e-real` | PASS 12/12 (4.9 phút). Mới `phase6.spec.ts`: DB + user (mật khẩu một lần) → export → import; FTPS phụ + đổi mật khẩu; khóa SSH ed25519 thật; cron chạy ngay → lịch sử; File Manager (thư mục, upload gửi lặp → 409 `received=5` → gửi tiếp → completed, upload UI, sửa ETag, nén/giải nén, link ký + chữ ký sai 403); terminal (step-up → xterm → `whoami` → `exit` → "Phiên đã kết thúc"); Portal tương tự. Chạy lại `phase5.spec.ts` sau Phase 6: PASS 2/2 |
| Lỗi e2e tìm thấy | — | (1) `redact` đổi `null` thành `[REDACTED]` gửi agent làm mật khẩu (tạm khóa account có FTPS lỗi); (2) khóa SSH thiếu padding qua Laravel, agent từ chối; (3) gateway gửi 2 khung close → Chrome 1006 (coder/websocket 1.8.12 → 1.8.14 + Close một lần); (4) Uploader báo xong trước commit; (5) `make dev` staging ngoài gốc sandbox. Mỗi lỗi có test hồi quy (Pest kiểm thất bại trước khi sửa với (1), (2)) |
| Pest liên quan | `pest tests/Feature/Phase6/DataTest.php` | PASS 7/7 (435 assertion) |
| Vitest | `pnpm test` | PASS 501/501 (thêm: chờ `committing` → `completed`/`failed`) |
| Go gateway | `go test -race ./internal/gateway` | PASS |
| Toàn bộ | `make check` | Lần đầu **19 PASS · 1 SKIP (staticcheck) · 3 FAIL** (644 s): Pest 424, Vitest 501, Playwright demo 263, test-agent 15 gói. FAIL: `test-fuzz` — `FuzzCronToOnCalendar`: `"0 27/1 * 1 00"` → OnCalendar hỏng (lỗi thật từ 6.2: `a/n` với a > max cho tập rỗng; Laravel `CronSchedule` cùng lỗi); `docs-check` MD040 ở `file-manager-review.md`; `git-clean` do corpus fuzz + báo cáo chưa commit |
| Chạy lại mục lỗi | `make test-fuzz` · `make docs-check` · `pest DataTest` · `go test ./internal/ops` | PASS · PASS · PASS (thêm `0 27/1 * * *` → 422) · PASS (seed fuzz mới) |
| Script VM | `bash -n tests/vm/phase6.sh` · `python3 -m py_compile tests/vm/lib/term_client.py`; params thử với agent sandbox | Cú pháp OK; params khớp schema (fs.read/fs.chmod/cron.run_once). **Chờ VM:** S0–S7 |

**Test bị bỏ qua:** không. **Chờ VM:** `tests/vm/phase6.sh` (cùng phase4/phase5).

## 2026-11-21 — Phase 6 / Prompt 6.5 — nhánh `phase-6`

Môi trường: Node 22 + pnpm, Chromium Playwright có sẵn; demo MSW (không cần Laravel). Terminal thật (xterm ↔ gateway) chỉ chạy khi không ở demo: kiểm ở 6.6 trên stack thật.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts · demo data | `make contracts` · `make codegen` · `make codegen-check` · `python3 contracts/tools/check_demo.py` | PASS. Sửa lỗi 6.1: hai tài khoản SFTP demo trùng UUID (`anphat_deploy`/`binhminh`) làm React báo trùng key ở `/admin/sftp`; `check_demo.py` nay chặn UUID trùng trong mọi bảng |
| Lint web | `make lint-web` (tokens, contrast, eslint, prettier, tsc, i18n) | PASS; i18n 2613 key, vi = en |
| Vitest | `pnpm test` | PASS 500/500 (34 file). Mới: `upload.test.ts` 7 (chunk 8 MiB, Content-Range, 409 → gửi tiếp từ `errors.received`, tạm dừng/tiếp tục đồng bộ trạng thái, hủy → DELETE), `terminal.test.ts` (URL ws từ ticket, khung resize, mã đóng 4403/4410/4408/1000/1011); MSW: PATCH chunk lệch offset → 409 + `errors.received`, GET/DELETE phiên tải lên, `JobAccepted.secret` khi tạo SFTP không nhập mật khẩu và khi đổi mật khẩu; mọi GET handler hợp lệ theo schema |
| Playwright demo | `pnpm e2e` | 260/261 lần đầu: `/admin/sftp` lỗi console trùng key (dữ liệu demo, đã sửa) → chạy lại `-g sftp` 4/4 PASS. Thêm 2 test (`-g "chunk\|một lần"` PASS 2/2): tải file lên theo chunk → "Xong" → file có trong thư mục; tạo SFTP không mật khẩu → hộp "Mật khẩu mới" hiện một lần. axe-core (demo-audit) PASS cho trang SFTP |
| Build | `make build` · `make build-demo` | PASS; build thường không chứa MSW |
| Pest (seeder demo dùng dataset) | `pest tests/Feature/Demo` | PASS 1/1 |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 6 / Prompt 6.4 — nhánh `phase-6`

Môi trường: như 6.3. Agent: shell giả (sandbox) và socket unix thật trong thư mục tạm; không có systemd nên `systemd-run --pty` thật là **chờ VM**.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` · `make codegen` · `make codegen-check` | PASS (`createTerminalSession` thêm 503 agent không kết nối) |
| Lint agent · no-exec | `make lint-agent` · `make no-exec` | PASS · PASS (cấp pty + `exec` chỉ trong `internal/platform`, bin `systemd-run` trong bảng) |
| Ticket + phiên | `go test -race ./internal/term` | PASS: ticket 32 byte base64url, dùng lại → từ chối, quá 30 giây → `ticket_expired`, tối đa 2 phiên mỗi account (tính theo account), ticket sai định dạng; shell giả hai chiều (echo ký tự, `whoami`, resize, `exit` → khung exit), nhàn rỗi → `idle`, gõ liên tục vẫn đóng khi quá thời gian sống → `expired`, phiên đóng giải phóng chỗ; khung quá 64 KiB / loại lạ bị từ chối |
| pty.open | `go test ./internal/ops -run 'TestPtyOpen\|TestTermArgv'` | PASS: chưa bật socket → `dependency_unavailable`; shell nologin (gói không SSH) → `precondition_failed`; user không có → `not_found`; sai uid → `precondition_failed`; uid 0 và 1000 bị chặn trước khi tra passwd; phiên thứ 3 → `quota_exceeded`; golden argv `systemd-run --pty` (uid/gid/slice account, ProtectSystem=strict, ProtectHome=tmpfs + BindPaths home, PrivateTmp/Devices, NoNewPrivileges, ProtectProc=invisible); TermArgv từ chối root/uid hệ thống/uuid hoặc username độc |
| Gateway | `go test -race ./internal/gateway` | PASS: nối hai chiều qua socket unix thật (resize JSON, dữ liệu nhị phân, exit → đóng 1000 "exited"); ticket dùng lại → 4403, hết hạn → 4410, ticket sai định dạng → HTTP 400, Origin lạ → HTTP 403; caller ngoài allowlist peercred bị agent đóng kết nối → 1011 |
| Go toàn bộ | `go test -count=1 ./...` | PASS |
| Laravel | `pint` · `phpstan` · `pest tests/Feature/Phase6/TerminalTest.php` | PASS · 0 lỗi · PASS 3/3: admin + chủ account nhận ticket (201 khớp hợp đồng, `no-store`), ticket không có trong `audit_logs/terminal_sessions/job_*`; chưa bật MFA → 403, quá hạn step-up → 403 `mfa_step_up_required`; gói không SSH → 409 `package_limit_reached` (không gọi agent); account khóa → 409; `mode=root` → 409; account ngoài phạm vi → 422; agent hết chỗ → 409 `resource_locked` + phiên đóng `error`; agent chưa bật terminal → 503; `itso:terminal-reap` đóng phiên quá 12 giờ |
| Ma trận quyền | `pest tests/Feature/Rbac` | PASS (+1 dòng `POST /admin/terminal/sessions`) |
| Pest toàn bộ | `scripts/pest-pg.sh` | PASS 424/424 |
| Unit systemd · installer | `make units-check` · `make test-installer` | PASS 14 unit (thêm `itso-gateway.service`: user `itso-gw`, chỉ loopback, không capability, `IPAddressDeny=any`) · PASS 8/8 |
| Web | `eslint vite.config.ts` · `tsc -b --noEmit` | PASS (Vite proxy `/gateway` có `ws: true`) |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 6 / Prompt 6.3 — nhánh `phase-6`

Môi trường: PostgreSQL 16 + Redis cục bộ, queue sync; agent giả qua `Tests\Support\FakeAgent` (Http::fake), staging upload `ITSO_UPLOAD_DIR=/tmp/itso-test-uploads` (phpunit.xml).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` · `make codegen` · `make codegen-check` | PASS (File Manager thêm 503 agent không phản hồi, 422 file > 2 MiB, 412 `if_etag` lệch) |
| Phân tích tĩnh | `vendor/bin/pint` · `vendor/bin/phpstan analyse` · `make no-exec` | PASS · PASS 0 lỗi · PASS |
| Phase 6 API | `pest tests/Feature/Phase6` | PASS 7/7: database tạo kèm user (mật khẩu trả một lần, `Cache-Control: no-store`, agent nhận mật khẩu thật, `job_steps/job_logs/audit_logs/jobs` không chứa mật khẩu, chỉ có tham chiếu `$secret`), quyền (diff, quyền ngoài danh sách → 422), đổi mật khẩu, export/import (`../` → 422), xóa cần step-up (portal chưa step-up → 403), ngoài phạm vi → 404; tên không tiền tố/chèn SQL/tên hệ thống/hoa/quá dài → 422, trùng → 409, vượt `database_limit` → 422 `quota_exceeded`, PG host `%` → 422; SFTP (user chính, root `.`, một tài khoản) + FTPS (tiền tố, `root_path` thoát home → 422, `read_only` → 422), đổi mật khẩu 202 + secret; khóa SSH (fingerprint `SHA256:`, trùng → 409, loại lạ/base64 hỏng/nhiều dòng → 422); cron (lịch dày hơn `cron_min_interval_min` → 422, biểu thức sai, lệnh nhiều dòng → 422, If-Match lệch → 412, không thay đổi → 409, chạy ngay ghi `cron_runs` manual, `itso:cron-sync` ghi lần chạy theo lịch không trùng, vượt `cron_limit` → 422); File Manager (liệt kê sắp xếp + phân trang cursor, `../`//etc → 422, đọc có ETag sha256, > 2 MiB → 422, ghi kèm `if_sha256`, agent `precondition_failed` → 412, thao tác nén qua job `file.operate`, op lạ/xóa home/chmod setuid → 422, link tải HMAC 5 phút: tải đúng nội dung, chữ ký sai hoặc người khác dùng link → 403); upload tus (staging 0600, sai offset → 409 kèm `received`, độ dài lệch → 422, đủ byte → job `file.upload` với `fs.upload.commit`, phiên người khác → 404, hủy → 204 xóa staging); tạm khóa account → `db.mysql.lock`, cron tắt, FTPS tắt, mọi tài nguyên `suspended`, không tạo/ghi mới (409); mở khóa → `ready` |
| Ma trận quyền | `pest tests/Feature/Rbac` | PASS 257/257 (+8 dòng admin, +4 dòng portal cho dữ liệu hosting) |
| Pest toàn bộ | `scripts/pest-pg.sh` | PASS 417/417 |
| Web | `npx vitest run` · `tsc -b --noEmit` | PASS 486/486 · tsc sạch |

Ghi chú: `PlatformApiTest` đổi đường dẫn ví dụ "chưa có ở bản này" từ `/admin/databases` (nay đã có) sang `/admin/security/overview` (Phase 7).

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 6 / Prompt 6.2 — nhánh `phase-6`

Môi trường: như 6.1 (container không có systemd, MariaDB, PostgreSQL client thật cho agent, sshd, Pure-FTPd). Agent chạy với runner giả (Sim) trên gốc thư mục tạm; riêng `internal/fsx` chạy trên kernel thật (openat2).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Lint agent | `make lint-agent` (gofmt + `go vet ./...`) · `make no-exec` | PASS · PASS (helper File Manager là chính binary agent qua bảng `Bins`, không có shell) |
| Go toàn bộ | `go test -count=1 ./...` · `go test -race ./internal/ops ./internal/fsx ./internal/mock` | PASS · PASS |
| File Manager tấn công (FS thật) | `go test ./internal/fsx` | PASS: `../`, đường dẫn tuyệt đối, symlink ra ngoài home, symlink đổi giữa chừng (34k lần đọc, không thoát), zip slip, zip bomb (tỉ lệ, số entry, tổng dung lượng), symlink/setuid trong zip, tar.gz có hardlink/symlink/device/`../`, helper từ chối chạy bằng root, upload commit theo fd |
| Op dữ liệu (Sim) | `go test ./internal/ops -run 'TestDB\|TestSshd\|TestSFTP\|TestSSH\|TestFTP\|TestCron\|TestFS'` | PASS: vòng đời DB MariaDB + PostgreSQL (owner, create idempotent, user, grant, inspect, import → dump qua helper dưới uid account, dump lỗi không để lại file, lock, drop); tên DB độc/sai tiền tố/tên hệ thống và mật khẩu có nháy/gạch chéo ngược/khoảng trắng bị từ chối **trước khi chạy lệnh**; mật khẩu không bao giờ nằm trong argv; `sshd -t` lỗi → khôi phục, không reload; SFTP đổi group sftp ↔ ssh, idempotent; SSH key: chặn option `command=`, loại lạ, base64 hỏng, blob khác loại, comment có ký tự điều khiển, trùng → `already_exists`; FTP: tiền tố, root_path không có/thoát home/symlink → từ chối, tắt = mật khẩu ngẫu nhiên, xóa sai account → từ chối; cron: bảng chuyển đổi 13 biểu thức + 13 biểu thức bị từ chối (DOM+DOW, 30/2, ngoài miền, bước 0…), unit/script golden, lệnh nằm nguyên văn trong script `root:<group> 0640`, tắt job → xóa unit, `cron.inspect`, `cron.run_once` trong slice; File Manager qua helper: write/read/sha, staging symlink bị chặn |
| Golden | `testdata/golden/{db.sql,50-itso.conf,itso-cron.service,itso-cron.timer,cron.apply.argv,sshd.match.apply.argv}` | PASS |
| Ví dụ contracts | `TestContractExamples` | PASS (thêm `fs.list`, `cron.apply`, `db.mysql.create` chạy qua agent thật) |
| Fuzz | `go test -fuzz=FuzzCronToOnCalendar -fuzztime=10s` · `-fuzz=FuzzParseSSHKey` · `FuzzCheckPath` | PASS (105k / 279k lần chạy, không lỗi); thêm vào `make test-fuzz` |
| Installer · unit | `make test-installer` · `make units-check` | PASS 8/8 · PASS 13 unit (thư mục mới `/var/lib/itso/uploads` itso 0700, `/etc/itso-cron`, `/etc/ssh/itso_authorized_keys`) |

Ghi chú: chạy thật MariaDB/PostgreSQL/sshd/Pure-FTPd/systemd-run (chroot SFTP, TLS bắt buộc, slice) là **chờ VM** (`tests/vm/phase6.sh` ở 6.6).

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 6 / Prompt 6.1 — nhánh `phase-6`

Môi trường: như Phase 5 (PostgreSQL 16 + Redis local, container không có systemd).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` · `make codegen` · `make codegen-check` | PASS: admin 243 operation (+4: `GetUpload`, `CancelUpload`, `DownloadFile` stream ký số, `rotateSftpPassword`), portal 107; agent-ops 87 op có schema (+14: `fs.stat`, `fs.rename`, `fs.upload.commit`, `db.{mysql,pg}.{owner_ensure,lock,inspect}`, `sshd.match.apply`, `ftp.user.ensure/remove`, `cron.inspect`, `pty.open` từ khai báo → đặc tả; sửa `fs.list/read/extract`, `db.*.user_ensure` (mật khẩu `SecretPassword` thay `password_ref`), `db.*.dump/import` chạy dưới uid account, `sftp.user.*` chỉ user chính, `cron.apply/run_once` có `timeout_sec`); recipe `mariadb`, `postgresql`, `pure-ftpd`; 434 example hợp lệ, độ phủ 100%; `JobAccepted.secret` (trả mật khẩu một lần), `UploadSession.status/job_uuid`, `FileOperation` thêm `rename`, `CronJob.timeout_sec`, `TerminalTicket.session_uuid` |
| Vector độc | `gen_vectors.py` + check_contracts | PASS: 155 vector (+17: `SecretPassword` nháy/gạch chéo ngược/khoảng trắng/xuống dòng/`$()`, `FtpUsername` chèn trường passwd, cron DOM+DOW, bước 0, ngày 31/2) |
| DB | `make db-schema` · `make db-migrations PHASE=6` · `make db-verify` | PASS: 81 bảng (+`file_operations`); migration Phase 6: 10 bảng, 84 câu lệnh; Phase 3 → 11 áp lần lượt = itso.sql + extras.sql. Thay đổi: `databases.charset`, `database_users` có uuid + desired/observed, `sftp_accounts.password_encrypted/read_only/last_login_at`, `ssh_keys` uuid/type/unique theo account, `cron_jobs.website_id/working_dir/php_version`, `cron_runs` uuid/status/trigger, `upload_sessions` uuid/status/overwrite/job_id, `terminal_sessions` uuid/mode/ended_reason; CHECK tên DB/user, host, trạng thái, op; unique DB user khi chưa xóa |
| Schema Laravel · Pest toàn bộ | `scripts/pest-pg.sh` | PASS 370/370 (thêm: đủ 10 bảng Phase 6; DB trùng tên/tên độc/upload vượt kích thước/op lạ/trạng thái cron bị CHECK chặn) |
| Go | `go vet ./...` · `go test -count=1 ./...` | PASS |
| Web | `npx vitest run` · `tsc --noEmit` | PASS 486/486 · tsc sạch (MSW cập nhật theo schema mới: DB user có desired/observed, upload chunk 8 MiB + status, cron `timeout_sec`) |
| Tài liệu | `make docs-check` | PASS (ADR 0018–0022) |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 5 / Prompt 5.6 — nhánh `phase-5`

Môi trường: PostgreSQL 16 + Redis cục bộ; `make dev` (Laravel + queue + Vite + itso-agent `--sandbox`, `ITSO_ACME_EMAIL=ops@itso.local`), DB `migrate:fresh --seed` + `DemoSeeder`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Toàn bộ | `make check` | **22 PASS · 1 SKIP (staticcheck chưa cài) · 0 FAIL**, git-clean PASS, 632 s: Pest 369, Vitest 486, Playwright demo 261, fuzz 308 974 lần, docs-check, contracts/codegen/tokens, units, installer |
| E2E stack thật | `make test-e2e-real` | PASS 8/8. Mới `phase5.spec.ts`: cài PHP 8.3 qua PHP Manager → tạo website PHP (job layout → pool → vhost) → alias → chứng chỉ (lego sandbox tự ký) → tạm khóa account (website `suspended`) → mở khóa → xóa (gõ domain + step-up TOTP); Portal tự tạo website. 4 luồng Phase 3 + 2 luồng Phase 4 vẫn PASS |
| Step-up | `vitest src/shared/auth` | PASS 3: 403 `mfa_step_up_required` → hỏi mã → gửi lại một lần với Idempotency-Key mới; hủy / không có hộp thoại → lỗi gốc; request step-up lỗi không hỏi lại |
| Xóa website gỡ chứng chỉ | `pest tests/Feature/Phase5` | PASS 21 (715 assertion). Mới: xóa website có chứng chỉ → `nginx.vhost.remove` → `php.pool.remove` → `cert.remove`, không còn bản ghi chứng chỉ |
| Script VM | `bash -n tests/vm/phase5.sh tests/vm/pebble/start.sh` | Cú pháp OK. **Chờ VM:** W0–W5 (stack, 20 site + uid, cô lập A/B, `nginx -t` hoàn tác, Pebble HTTP-01 thật + gia hạn, xóa sạch) |

**Lỗi tìm thấy và sửa:** (1) xóa website / provider DNS cần step-up nhưng UI không có hộp thoại → luôn 403; thêm `StepUpHost` dùng chung. (2) nhãn i18n thiếu cho job Phase 5 (`website.domain.add`, `setup.stack`, `php.version.*`, `certificate.renew`, `nginx.global.update`…). (3) xóa website không gỡ chứng chỉ (`/etc/itso/certs/<uuid>` còn lại).

**Test bị bỏ qua:** không. **Chờ VM/CI:** `tests/vm/phase5.sh`, job CI `pebble`.

## 2026-11-21 — Phase 5 / Prompt 5.5 — nhánh `phase-5`

Môi trường: Node 22, Chromium Playwright có sẵn, MSW (bản demo) theo OpenAPI.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Vitest | `pnpm -C apps/web test` | PASS 483 test (31 file). Mới: `jobErrors.test.ts` (mọi mã lỗi có giải thích VI+EN; `quota_exceeded` diễn giải theo tài nguyên gói), `JobView.test.tsx` (`nginx -t` lỗi hiện "đã hoàn tác" + dòng lỗi gốc; mã lạ → tiêu đề chung), schema tải chứng chỉ (PEM, wildcard, khóa có mật khẩu bị chặn), schema provider/zone DNS, MSW: provider chỉ SUPER_ADMIN, token không trả về, gắn/đồng bộ/đổi account/gỡ zone, provider còn zone 409, quota website → `quota_exceeded` + `errors.websites`; wizard đi hết 10 bước có bước stack gọi `GET /admin/setup/stack` + `POST :install` |
| Sửa test cũ theo tính năng mới | `wizard.test.ts`, `InstallPage.test.tsx`, `demo/__tests__/sites.test.ts` | Bước `stack` không còn "chưa có ở bản này"; vượt số website trả `quota_exceeded` như API thật (trước là `package_limit_reached`) |
| Lint · i18n · tsc | `pnpm -C apps/web lint` | PASS (eslint, prettier, tsc, check-i18n: 2575 khóa, vi = en) |
| Playwright demo (gồm axe) | `pnpm -C apps/web e2e` | PASS 261 test (6,3 phút). Mới: DNS gắn zone Cloudflare → đồng bộ → gỡ; SSL tải chứng chỉ riêng kiểm PEM |
| Build | `make build-demo` | PASS: build thường không chứa MSW, build demo có worker |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 5 / Prompt 5.4 — nhánh `phase-5`

Môi trường: như 5.3. Cloudflare giả bằng `Http::fake` (bộ nhớ record, ép mã lỗi); agent giả bằng FakeAgent.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Chứng chỉ | `pest tests/Feature/Phase5/CertificateTest.php` | PASS 7 test: ACME → `cert.issue` (email/directory theo cấu hình) → `nginx.vhost.apply` có tls; danh sách admin + portal khớp OpenAPI; domain chưa gắn 422, thiếu `ITSO_ACME_EMAIL` / Pebble chưa cho phép 409; tải lên khóa lệch, SAN thiếu (wildcard không phủ gốc), không phải PEM, khóa mã hóa → 422; hết hạn → 422; hợp lệ → `cert.install` → vhost → gỡ bản ACME cũ; **bí mật**: `job_steps` chỉ có `{"$secret": "certificate_key:<uuid>"}`, khóa không có trong `job_steps`/`job_logs`/`audit_logs`/`certificates` (đã mã hóa)/phản hồi, agent nhận khóa thật; `itso:certs-renew` chỉ chọn chứng chỉ ACME < 30 ngày có auto_renew (bỏ qua bản 60 ngày, tắt auto_renew, tải lên); renew lỗi → `last_error`, audit `failure`, thông báo `certificate.renew_failed` cho SUPER_ADMIN; xóa chứng chỉ đang dùng → vhost bỏ tls rồi `cert.remove`; website tạo với `ssl_mode=acme` (cấp lỗi → `degraded`, chứng chỉ `failed`); PATCH none → acme cấp chứng chỉ; ma trận quyền 404 ngoài phạm vi |
| DNS | `pest tests/Feature/Phase5/DnsTest.php` | PASS 4 test: token sai → 422, Cloudflare 503 → 409, DB không đổi; token mã hóa, không có trong phản hồi/`dns_providers`/audit/job; mọi request tới base URL cố định; zone không có trên Cloudflare 422, tạo zone đồng bộ record (bỏ loại HTTPS); ADMIN chỉ zone của account trong phạm vi, ADMIN ngoài phạm vi 404, portal không có route DNS; If-Match sai 412; record tạo/sửa/xóa ghi Cloudflare trước rồi DB; Cloudflare 400 → job failed `invalid_params`, DB giữ nguyên; 502 → thử lại 3 lần rồi failed `dependency_unavailable`; nội dung sai theo loại (IP, MX thiếu priority, proxied cho TXT, CAA, ký tự điều khiển) 422; `:sync` và `itso:dns-sync`; gỡ zone không gọi Cloudflare |
| Laravel toàn bộ | `make test-api` | PASS 368 test, 3299 assertion |
| Agent | `make lint-agent test-agent` | PASS. Thêm `TestCertReplaceInUseReloadsNginx`: thay chứng chỉ vhost đang dùng → `nginx -t` + reload; chưa ai dùng hoặc nội dung không đổi → không reload |
| Lint · tĩnh · docs | `pint` · `phpstan` · `make no-exec` · `make docs-check` | PASS |

**Lỗi tìm thấy nhờ test:** cast `Bytea` đọc stream PDO một lần, lần truy cập thứ hai trả chuỗi rỗng → `JobRunner` không giải được khóa chứng chỉ tải lên. Sửa: đọc stream từ offset 0 mỗi lần.

**Test bị bỏ qua:** không. **Chờ CI/VM:** job `pebble` (`tests/vm/pebble/run.sh`: lego thật ↔ Pebble) chưa chạy được: repo chưa có remote, và lệnh chạy Pebble + test dưới root trong container dev bị từ chối (không thử lại). Test đã biên dịch (`go vet -tags pebble`).

## 2026-11-21 — Phase 5 / Prompt 5.3 — nhánh `phase-5`

Môi trường: như 5.1 (PostgreSQL 16 + Redis local). Agent giả qua `Http::fake` (FakeAgent), job chạy đồng bộ.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Website Phase 5 | `pest tests/Feature/Phase5` | PASS 9 test, 352 assertion: tạo site PHP → op `fs.site_layout.ensure` → `php.pool.apply` → `nginx.vhost.apply` (static bỏ pool); sửa `document_root` chỉ áp vhost; nginx/php áp đúng op; If-Match lệch 412; header chèn `;`/CRLF, redirect `javascript:`, hàm PHP lạ → 422; quota website/alias/PHP worker → 422 `quota_exceeded`; domain trùng (khác hoa thường) 409; `nginx -t` lỗi khi tạo → website `failed` + thông báo `job.failed`; lỗi khi thêm domain → domain bị gỡ, site vẫn `ready`; suspend/unsuspend áp lại vhost mọi site; xóa: `nginx.vhost.remove` → `php.pool.remove`, job còn đọc được; ma trận quyền (ADMIN ngoài phạm vi, USER khác → 404; ADMIN không có `software.write`/`servers.write` → 403); PHP Manager (8.2 → 409, gỡ khi còn site → 409 `resource_locked`, extension ngoài allowlist 422); Nginx toàn server (không đổi 409, ngoài khoảng 422); log agent lỗi → 503; wizard bước 4 cài phần thiếu qua `setup.stack`, đủ → `steps_done` có `stack`. Mọi phản hồi khớp OpenAPI admin + portal |
| Laravel toàn bộ | `make test-api` | PASS 357 test, 2947 assertion. Sửa 2 test cũ theo tính năng mới: catalog recipe 7 mục (thêm nginx, lego); endpoint mẫu "chưa có ở bản này" đổi từ websites sang databases (Phase 6) |
| Helper hợp đồng | `tests/Pest.php` | Sửa `assertMatchesContract` giải mã JSON dạng object: trước đây `{}` thành `[]` nên map rỗng (`extra_headers`) bị báo sai kiểu |
| Lint · tĩnh | `pint --test` · `phpstan` · `make no-exec` | PASS (0 lỗi phpstan) |
| Contracts · Web | `make contracts-check` · `make codegen-check` · `tsc` · `vitest run` | PASS · PASS · sạch · 465 test |

**Test bị bỏ qua:** không. **Chờ VM:** áp vhost/pool thật qua agent sandbox → VM ở 5.6.

## 2026-11-21 — Phase 5 / Prompt 5.2 — nhánh `phase-5`

Môi trường: như 5.1. Đã cài `nginx` 1.24.0 và `php8.3-fpm` 8.3.6 (kho Ubuntu 24.04) **trong container dev** chỉ để kiểm cú pháp file sinh ra; không khởi động dịch vụ nào (policy-rc.d chặn).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go toàn bộ | `cd agent && go vet ./... && go test -count=1 ./...` | PASS 12 package |
| Golden op website | `go test ./internal/ops -run 'Site\|PHP\|Vhost\|Nginx\|LogTail\|Cert'` | PASS: argv + file cho site layout (quyền/chủ/ACL, log ngoài home), pool + master + drop-in, vhost php/static/proxy/suspended/tls, nginx.conf, lego run/renew, Pebble cần policy + CA (env `LEGO_CA_CERTIFICATES`); chạy lại lần 2 không có lệnh ghi |
| Hoàn tác | `TestVhostRollback`, `TestPHPPoolGolden` | PASS: `nginx -t` lỗi → site mới bị xóa, site sửa về bản cũ, không reload, site khác vẫn áp được; `php-fpm -t` (uid account) lỗi → pool cũ khôi phục, không reload |
| Cú pháp thật | `go test ./internal/ops -run TestRenderedConfigsWithRealBinaries -v` | PASS: `nginx -t` thật trên 5 vhost golden + `nginx.conf`; `php-fpm8.3 -t` thật trên pool + master. Lần đầu lỗi `include fastcgi_params` (đường dẫn tương đối) và `listen [::]` trên máy không IPv6 → sửa template (đường dẫn tuyệt đối, IPv6 theo `/proc/net/if_inet6`) |
| Vector độc | `TestEvilInputsRejectedBeforeAnyCommand` · `validate.TestEvilVectors` | PASS: thêm nhóm domain, path, header_value, url_path, redirect_target, nginx_size, php_version, php_extension, email gọi thẳng handler → bị từ chối, 0 lệnh chạy. Lần đầu: `php.version.remove 7.4` chạy `dpkg-query` trước khi từ chối → sửa: chỉ nhận 8.3 |
| Contract chung mock + agent | `TestWebsiteLifecycleSharedWithMock` · `TestWebsiteLifecycleSharedWithAgent` | PASS: cùng luồng PHP → layout → pool → vhost (idempotent, `config_test_failed` giữ bản cũ) → chứng chỉ → TLS → xóa |
| Fuzz template | `go test -fuzz FuzzRenderVhost -fuzztime 20s` · `FuzzRenderPool 10s` | PASS: 244 456 + 158 516 lần chạy; mọi cấu hình render được đều đúng dạng (mỗi dòng một directive, ngoặc cân bằng, không chèn thêm `open_basedir`) |
| Unit systemd | `make units-check` | PASS 13 unit (thêm `itso-php@8.3-lehoa.service`) |
| Contracts · lint | `make contracts-check` · `make codegen-check` · `make lint-agent` · `make no-exec` | PASS (ví dụ envelope sửa `php_socket` theo quy tắc agent suy ra) |

**Test bị bỏ qua:** không. Ghi chú: một đề xuất bỏ qua vector `path` tầng semantic (symlink) trong test validator bị từ chối; thay bằng test riêng `TestRelPath` cho lớp cú pháp, phần symlink kiểm ở `TestSiteLayoutGolden` (FS thật). **Chờ VM:** master PHP chạy thật dưới uid account (phpinfo), socket ACL, `systemctl` thật, lego với Pebble.

## 2026-11-21 — Phase 5 / Prompt 5.1 — nhánh `phase-5`

Môi trường: như Phase 4 (PostgreSQL 16 + Redis local, container không có systemd).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make contracts-check` · `make codegen-check` | PASS: admin 239 operation (+11: DNS provider/zone 6, PHP install/extension 2, wizard bước stack 2, cộng `syncDnsZone`), portal 103; agent-ops 73 op có schema (+6: `fs.site_layout.ensure`, `nginx.vhost.inspect`, `php.version.remove`, `php.ext.install`, `cert.inspect`, `log.tail`; sửa `nginx.vhost.apply`, `php.pool.apply`, `cert.issue`, `cert.install`, `nginx.global.apply`, `php.version.install`); envelope mẫu cập nhật; Redocly 0 lỗi; 416+ example hợp lệ |
| Vector độc | `python3 contracts/tools/gen_vectors.py` + check_contracts | PASS: 138 vector (+26: HeaderValue CRLF/`;`/`$`/`{}`, UrlPath, RedirectTarget `javascript:`/không scheme, NginxSize, PhpExtension ngoài allowlist, email chèn cờ lego, recipe php8.1 cần PPA) |
| DB | `make db-schema` · `make db-verify` · `make db-migrations PHASE=5` | PASS 41 test SQL; Phase 3 → 11 áp lần lượt = itso.sql + extras.sql; migration Phase 5: 9 bảng, 62 câu lệnh. Thay đổi đặc tả: `domains.uuid`, `dns_records.uuid` + `priority`, `dns_providers.account_label`, `acme_accounts.server_id` + `key_location` (CHECK khóa chỉ ở agent hoặc db), `certificates.private_key_encrypted` + `acme_account_id` + `auto_renew` + `last_renew_attempt_at` + `last_error` |
| Schema Laravel | `pest tests/Feature/Schema/SchemaTest.php` | PASS 10 test (thêm: đủ 9 bảng Phase 5; domain duy nhất khi còn hoạt động, chữ thường; CHECK `acme_accounts_key_chk`) |
| Go | `go vet ./...` · `go test -count=1 ./...` | PASS (validator recipe thêm nginx, php8.3, lego; vector chung PHP/Go) |
| Laravel toàn bộ · Web | `pest --parallel` · `npx vitest run` · `tsc` | PASS 348 · 465 · tsc sạch |

**Test bị bỏ qua:** không. Ghi chú môi trường: `make db-verify` dừng cụm PostgreSQL dev trên cổng 5432; khởi động lại bằng `pg_ctl` trước khi chạy Pest.

## 2026-11-21 — Phase 4 / Prompt 4.6 — nhánh `phase-4`

Môi trường: PostgreSQL 16 + Redis local; agent thật `itso-agent --sandbox` (runner giả, gốc riêng `.dev/agent-sandbox/root`, ký HMAC D-66). Container không có KVM/systemd/cgroup v2 nên **bộ test VM chưa chạy (chờ VM)**.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Toàn bộ pipeline | `make check` | **22 PASS · 1 SKIP (staticcheck) · 0 FAIL**, git-clean PASS, 576 s. Lần đầu: 3 FAIL (e2e demo wizard 1/259 vì test còn dùng mã bất kỳ, nay API demo chỉ nhận `DEMO-2026-ITSO`; docs-check + git-clean do runbook đang viết dở lúc chạy) → sửa test, chạy lại file lỗi (6/6) rồi chạy lại toàn bộ trên cây sạch |
| Playwright stack thật + agent sandbox | `make dev` · `DemoSeeder` · `make test-e2e-real` | PASS 6/6: 4 luồng Phase 3 qua agent sandbox; Server detail (thẻ Nền tảng "Sandbox", amd64; restart nginx → job `service.restart` → op `service.control` thành công; dung lượng đã cấp); account có mức sử dụng từ snapshot + API usage 200 |
| Agent sandbox kiểm tay | `tests/vm/lib/agent_call.py --socket … --key-file …` | `system.ping` ok; `system.exec` → `unknown_op`; username `../root` → `invalid_params`; không ký / ký sai → `unauthorized_caller`; `account.ensure` ok; audit JSONL có `op_id`, `params_hash` |
| `make dev` | chạy nền + `itso:server-local`, `itso:reconcile`, `itso:metrics-collect`, `itso:usage-refresh` | 8 job reconcile thành công qua agent sandbox; platform `agent_mode=sandbox`; 12 dịch vụ; 3 snapshot usage |
| Script VM | `bash -n tests/vm/*.sh tests/vm/lib/common.sh` · `ruby -c tests/vm/Vagrantfile` · `python3 -m py_compile tests/vm/lib/agent_call.py` | PASS cú pháp. **Chạy thật: chờ VM** (`make release && make test-vm`) |
| Laravel | `make test-api` | PASS 347 (ServerOpsTest cập nhật: job `service.restart`) |

**Test bị bỏ qua:** không. **Chờ VM:** cài sạch ≤ 10 phút, enforcement E1–E8 (CPU, OOM, TasksMax, EDQUOT, cách ly /home, ps, `sudo -l -U itso`), agent từ chối trên máy thật, update → rollback, uninstall. `staticcheck`, `shellcheck` không có trên container.

## 2026-11-21 — Phase 4 / Prompt 4.5 — nhánh `phase-4`

Môi trường: như 4.1 (PostgreSQL 16 + Redis local). Agent trong Pest là `FakeAgent` (HTTP giả theo envelope thật); UI chạy trên API giả lập MSW.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts-check` · `make codegen-check` | PASS: admin 228 operation (+7 wizard, +1 `/system/updates`), Redocly 0 lỗi, ajv, codegen khớp |
| Server/metrics/dịch vụ/phần mềm | `php artisan test tests/Feature/Phase4/ServerOpsTest.php` | PASS 9 test: `itso:metrics-collect` ghi platform (quota soft, cgroup v2, systemd, amd64, sandbox), disk, 4 metric, 12 dịch vụ, capacity; agent tắt → lệnh FAIL, server `degraded`, platform giữ nguyên; `service.control` qua job (params đúng), ngoài allowlist/hành động lạ 422, trùng job 409; software: catalog 5 recipe, cài qua job ghi bản thật, gỡ → available, gỡ acl/quota/nftables 409, upgrade 409, key lạ 404, lỗi → failed, đang cài 409; reboot qua job `system.reboot` 60 giây; usage-refresh ghi snapshot + metric account, usage/metrics account khớp OpenAPI, metric sai 422; prune xóa partition > 7 ngày; `/system/updates` liệt kê release có `.complete`, đánh dấu bản active |
| Wizard | `php artisan test tests/Feature/Phase4/SetupWizardTest.php` | PASS 6 test: đi hết 6 bước có API (mọi phản hồi khớp OpenAPI, audit `setup.*`); TOTP bắt buộc trước bước 3 (403); complete khi chưa lưu bước 3 → 409; sau khóa: verify/admin/access/quota/complete → **410** `setup_completed`; dùng lại mã ở phiên khác → **409** `setup_code_used`; mã sai 422; hết hạn/không có file → 409 `setup_code_expired`; mã mới vô hiệu phiên cũ (403 `setup_not_verified`); 10 lần sai → 429; đã có SA ngoài wizard → 410 |
| Ma trận quyền | `php artisan test tests/Feature/Rbac/MatrixTest.php` | PASS: 46 endpoint admin × 4 nhân vật (thêm 9 endpoint 4.5: ADMIN đọc trong phạm vi, ghi dịch vụ/reboot/phần mềm và `/system/updates` → 403, ngoài phạm vi 404) |
| Laravel toàn bộ | `php artisan test --parallel` · `make lint-api` | PASS: 347 test (thêm 51); pint, phpstan 0 lỗi; `make no-exec` OK |
| Web | `pnpm lint` · `npx vitest run` | PASS: eslint, prettier, tsc, i18n 2486 key (vi = en); Vitest 465 test (thêm: wizard 10 bước trên MSW gọi đủ 8 API, panel đã cài hiện thẻ khóa; logic wizard 9 test; thẻ Nền tảng 3 test) |

**Test bị bỏ qua:** không. Chưa chạy với agent thật trên VM: số liệu cgroup/quota kernel thật → 4.6 (chờ VM).

## 2026-11-21 — Phase 4 / Prompt 4.4 — nhánh `phase-4`

Môi trường: như 4.1. Cài đặt chỉ chạy trên gốc giả (thư mục tạm) với runner giả `ops.Sim`; trên container chỉ chạy preflight/dry-run (chỉ đọc).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go toàn bộ (race) | `cd agent && go test -race -count=1 ./...` | PASS: 12 package (thêm `internal/install`) |
| Installer | `go test ./internal/install -v` | PASS 8 test: preflight trên máy không systemd/cgroup v2 → FAIL đúng, không ghi gì; `--dry-run` không ghi; cài hỏng ở bước database → chạy lại tiếp từ database, không làm lại users/packages; lần chạy thứ 3 không có lệnh ghi, khóa agent giữ nguyên; quyền 0640 root:itso cho agent.key/itso.env/panel.key/setup-code; update → rollback → update, health lỗi → tự rollback, giữ 3 bản; chữ ký sai, sha sai, tar có `..`/symlink ra ngoài/thiết bị → từ chối; uninstall giữ /home, đổi tên /etc/itso, purge cần xác nhận hostname; repair phát hiện unit/file bị sửa và `--fix`; policy set/get; admin reset từ chối email lạ; setup code chỉ lưu băm |
| install.sh | `make test-installer` | PASS 8/8: đúng → chạy `itso install` với tham số; manifest sửa, ký khóa khác, binary/tarball bị thay, phiên bản lạ, OS Debian, user không phải root → dừng |
| Unit systemd | `make units-check` | PASS 12 unit (target, 7 service/timer, 3 slice + 2 drop-in mẫu); kiểm đối chứng: thêm khóa lạ → FAIL |
| Release | `make release` | PASS: `itso-0.4.0-dev-linux-amd64.tar.gz` 25,6 MB (api `--no-dev --prefer-dist`, không .git), `itso`, `install.sh` nhúng khóa công khai, `sbom.json`, `manifest.json` + `manifest.sig` (openssl verify OK). Khóa dev tạm ở `build/` (không commit). **Thiếu frankenphp** (cần tải upstream) → manifest ghi `missing_components` |
| Chuỗi thật trên container | `ITSO_RELEASE_DIR=build/release/0.4.0-dev bash install.sh --dry-run` | install.sh kiểm chữ ký + sha → `itso install --dry-run`: release PASS (chữ ký đúng), os PASS, **cgroup_v2 FAIL, systemd FAIL** (container) → dừng đúng, không thay đổi gì |
| Laravel | `make test-api` · `make lint-api` | PASS: 296 test (thêm 2: `itso:admin-reset-password`, `itso:admin-reset-mfa`); pint, phpstan |
| Khác | `make no-exec` · `make lint-agent` · `make docs-check` · `python3 scripts/check-ci.py` | PASS (CI thêm bước `make units-check test-installer`) |

**Test bị bỏ qua:** không. Chưa chạy trên máy thật: cài đặt đầy đủ (apt, pg_createcluster, systemd) → chờ VM (4.6). `shellcheck` không có trên container.

## 2026-11-21 — Phase 4 / Prompt 4.3 — nhánh `phase-4`

Môi trường: như 4.1. Op thật chạy với runner giả `ops.Sim` trên gốc FS tạm (`/etc/passwd|group|shadow`, `/home`) và `/proc`, `/sys` giả; không lệnh nào chạy trên máy.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go toàn bộ (race) | `cd agent && go test -race -count=1 ./...` | PASS: 11 package |
| Op thật | `go test ./internal/ops -v` | PASS 10 test: golden argv cho 15 op (`testdata/golden/*.argv`) + 3 drop-in slice; lần 2 cùng tham số không có lệnh ghi (account.ensure, limits.apply, suspend, unsuspend, quota.apply, hostname.set, service.control, software.install/remove); quyền/chủ home đúng 07 §5; soft quota đo được file 3 MB; system.info/metrics đọc đúng /proc, cgroup (throttled, memory.max, oom_kill, pids); lệnh lỗi → `internal` / `dependency_unavailable` (retryable) / `precondition_failed`; op.cancel hủy op đang chạy → `cancelled` |
| Vector độc | `TestEvilInputsRejectedBeforeAnyCommand` | PASS: gọi thẳng handler (bỏ qua schema) với mọi vector reject của username/hostname/service_name/recipe + uid 0, home `..`, shell lạ → từ chối, **0 lệnh** được chạy |
| Contract dùng chung | `internal/contracttest` từ `internal/mock` và `internal/ops` | PASS cả hai: vòng đời account, idempotent, mã lỗi already_exists/not_found/precondition_failed/path_outside_home; ví dụ `valid-06-account.ensure.json` chạy qua agent thật |
| Drop-in slice | `systemd-analyze verify itso-acct-20001.slice user-20001.slice` (nội dung golden) | PASS, không cảnh báo. Kiểm đối chứng: `Slice=` trong unit `.slice` bị báo "Failed to assign slice" → sửa ADR 0011/D-64/07 §3 (cha suy ra từ tên). Ghi chú: báo cáo 4.1 ghi PASS cho mẫu cũ vì `verify` trả mã 0 cả khi có cảnh báo; từ nay đọc cả output |
| Contracts | `make contracts-check` · `make codegen-check` | PASS (sửa `ts` trong ví dụ envelope cho khớp `deadline`: 2026-11-20 01:15Z thay vì 11-26) |
| Laravel | `make test-api` | PASS: 294 test (không đổi) |
| Lint / no-exec / docs | `make lint-agent` · `make no-exec` · `make docs-check` · `make structure` | PASS |
| Smoke binary | `itso-agent --sandbox` không có `--root` | Từ chối đúng ("sandbox cần --root là thư mục riêng") |

**Test bị bỏ qua:** không. Chưa kiểm trên hệ thống thật: useradd/setquota/setfacl/systemctl thật (chờ VM, `tests/vm/` ở 4.6).

## 2026-11-21 — Phase 4 / Prompt 4.2 — nhánh `phase-4`

Môi trường: như 4.1 (PostgreSQL 16 + Redis cục bộ cho Pest).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Go toàn bộ (race) | `cd agent && go test -race ./...` | PASS: 10 package |
| Xác thực | `go test ./internal/auth` | PASS: chữ ký đúng; sai body/khóa/path, lệch giờ 120 s, thiếu chữ ký, nonce ngắn → từ chối; nonce lặp → từ chối; khóa others đọc được/ngắn/symlink → từ chối; SO_PEERCRED trả đúng uid/pid; allowlist; vector chữ ký chung với PHP |
| Handler có xác thực | `go test ./internal/server` | PASS: qua socket Unix thật — ký đúng → ok; không ký → `unauthorized_caller`; op bị policy tắt → `op_disabled`; op lạ → lỗi; uid ngoài allowlist → `unauthorized_caller`; audit ghi 4 bản ghi đúng kết quả + uid caller, chuỗi hợp lệ |
| Policy | `go test ./internal/policy` | PASS: mặc định theo catalog (docker/backup.forget tắt), ghi đè op, cờ docker thắng ops, op/khóa lạ, sai version → từ chối; strict: quyền 0644 hoặc chủ không phải root → từ chối; lưu 0600 |
| Audit cục bộ | `go test ./internal/audit` | PASS: chuỗi nối tiếp qua lần mở lại; sửa một dòng hoặc xóa dòng giữa → phát hiện, không ghi tiếp |
| Lớp nền tảng | `go test ./internal/platform` | PASS: bảng lệnh không có sh/bash/env/sudo…, đường dẫn tuyệt đối; argv có NUL/xuống dòng → từ chối; FakeRunner; ExecRunner chỉ chạy lệnh chỉ-đọc `findmnt`; FS: đường dẫn tương đối/chưa chuẩn hóa → từ chối, ghi atomic idempotent, symlink → từ chối ghi/đọc/EnsureDir |
| Validator + vector evil | `go test ./internal/validate` | PASS: mọi vector username/hostname/service/recipe đúng expect (kể cả layer semantic) |
| Fuzz | `go test -fuzz=FuzzUsername/FuzzHostname -fuzztime=10s` | PASS (thêm vào `make test-fuzz`) |
| Laravel | `make test-api` · `make lint-api` | PASS: 294 test (thêm 2: vector chữ ký, header khớp body đã gửi + khóa ngắn → AgentUnavailable); pint, phpstan |
| No-exec | `make no-exec` | PASS (os/exec chỉ trong `agent/internal/platform`) |

**Test bị bỏ qua:** không.

## 2026-11-21 — Phase 4 / Prompt 4.1 — nhánh `phase-4`

Môi trường: container cloud Ubuntu 24.04, kernel 6.18, **không có** cgroup v2 (`/sys/fs/cgroup` là tmpfs), systemd không phải PID 1, không có `setquota`/`repquota`/`setfacl`; có `systemd-analyze` (verify offline).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: agent-ops 67 op có schema (thêm 6), 21 op khai báo; evil-inputs 112 vector (thêm 19); ajv examples hợp lệ/không hợp lệ |
| Go | `cd agent && go vet ./... && go test ./...` | PASS (mock `system.info` trả đủ trường mới, khớp schema) |
| Kiểm cú pháp slice mẫu | `systemd-analyze verify itso-acct-20001.slice` | PASS (không cảnh báo) |
| Docs | `make docs-check` | PASS |

**Test bị bỏ qua:** không. Test cần VM (slice, quota thật) ghi trong ADR 0011/0012 và chạy ở 4.6 bằng `tests/vm/`.

Ghi chú: `account.remove` giữ ở Phase 8 (cần backup cuối hợp lệ theo D-46), không đưa vào Phase 4.

## 2026-11-20 — Phase 3 / Prompt 3.6 — nhánh `phase-3`

Môi trường: như 3.4; stack thật chạy bằng `make dev` (Vite 5173, Laravel 8000, mock agent, queue worker), DB `itso` đã `migrate:fresh --seed` + `DemoSeeder`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| E2E stack thật | `make test-e2e-real` | PASS: 4/4 — Admin đăng nhập MFA (mã sai bị từ chối, chưa xác minh bị đưa về MFA); tạo user portal → gói → account qua wizard → job mock agent → Hoạt động → tạm khóa → mở khóa; Portal chỉ thấy `anphat`, `oldshop`, account người khác 404 (API + URL); sai realm 401 và user portal không vào được Admin |
| Endpoint còn thiếu test | `php artisan test tests/Feature/Platform` | PASS: 20 test (mới: 501 purge/migrate, gợi ý đặt account, đánh dấu đọc thông báo Admin, sự kiện + chạy lại job Portal) |
| DemoSeeder | `php artisan test tests/Feature/Demo/DemoSeederTest.php` | PASS |
| Toàn bộ | `make check` | 20 PASS · 1 SKIP (staticcheck) · 0 FAIL; Pest 292 (2095 assertion), Vitest 457, Playwright 259, db-verify 41, fuzz 240.425 lần, git-clean PASS |

Lần chạy `make check` đầu: FAIL ở docs-check (URL/email trần trong runbook), test-e2e (21 test shell bị đưa về đăng nhập vì build thường dùng phiên thật), test-api (1 test còn kỳ vọng `type` `not_found` cho route không tồn tại), git-clean (sửa file trong lúc chạy). Đã sửa runbook, thêm giả lập `/auth/me` vào fixture e2e, cập nhật kỳ vọng test theo hành vi mới; lần 2 xanh hết.

Coverage: không có pcov/xdebug, build pcov trong container bị chặn → thay bằng đối chiếu route (87/87 route có test gọi tới), chi tiết ở `docs/reports/phase-3.md` §6.

**Test bị bỏ qua:** không.

### Acceptance Prompt 3.6

- ✓ Client gửi CSRF, xử lý 401/419; phiên thật thay persona ở build thường
- ✓ DemoSeeder (mật khẩu dev, SA dùng secret TOTP dev), `make dev` chạy web + api + queue + mock agent
- ✓ Module Phase sau hiện "Chưa có ở bản này"
- ✓ Playwright trên stack thật; `make check` xanh; báo cáo `docs/reports/phase-3.md`; runbook `docs/runbooks/phase-3-demo.md`

## 2026-11-20 — Phase 3 / Prompt 3.5 — nhánh `phase-3`

Môi trường: như 3.4.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS (thêm response `NotImplemented` 501 và 2 mã lỗi; admin 220 / portal 103 operation) |
| Gói + account + Portal | `php artisan test tests/Feature/Hosting/HostingTest.php` | PASS: 25 test — gói tạo/409/422/412, sửa limits → phiên bản 2, phiên bản bị DB chặn sửa, xóa còn account → 409; tạo account qua job với agent giả → `active` (op `account.ensure` + `quota.apply`, home `/home/<user>`, shell theo `ssh_allowed`, override áp vào limits), username trùng 409, sai/tên hệ thống 422, server ngoài phạm vi / không nhận account 422; agent lỗi → `failed` → retry → `active`; suspend/unsuspend/terminate/khôi phục, quá hạn giữ 409, chuyển sai 409, 501 cho purge/migrate, account bận 409 `resource_locked`, terminate thiếu quyền 403; bảng chuyển trạng thái (15 ca); đổi gói / giảm override dưới mức dùng → 422 `quota_exceeded`, migrate-accounts qua job; `ensureCanAdd`; UID không tái dùng trong 90 ngày; Portal chỉ account của mình (404 với account người khác), overview, profile (ETag), USER gọi Admin API → 401; `itso:usage-refresh` |
| Ma trận quyền | `php artisan test tests/Feature/Rbac/MatrixTest.php` | PASS: 169 test — admin 37 endpoint × 4 nhân vật; Portal 10 endpoint × chủ / USER khác (USER khác → 404 với account, job của người khác) |
| Pest toàn bộ | `make test-api` | PASS: 287 test, 1991 assertion |
| Lint | `make lint-api` · `make no-exec` | PASS |

**Test bị bỏ qua:** không.

Ghi chú:

- `account_usage_snapshots` thuộc Phase 4 nên mức dùng Phase 3 lưu ở `hosting_accounts.observed_facts.usage` (lệnh `itso:usage-refresh`); `QuotaService` tự dùng bảng snapshot khi có.
- Bảng website/database/FTP/cron có từ Phase 5–6: số đếm hiện bằng 0, `QuotaService` tự đếm khi bảng xuất hiện.
- Step `php.pool.apply` trong ví dụ contract của job tạo account chưa có trong mock (Phase 5 PHP-FPM), job Phase 3 gồm `account.ensure` + `quota.apply`.

### Acceptance Prompt 3.5

- ✓ /hosting-packages CRUD, phiên bản bất biến, /versions, migrate-accounts qua job
- ✓ Provisioning: tạo (username, server, UID 90 ngày, job), suspend có lý do, unsuspend, terminate (≥30 ngày, legal hold), khôi phục trong thời gian giữ, đổi gói; lifecycle events
- ✓ /features, /usage, /lifecycle-events; QuotaService 422 `quota_exceeded`
- ✓ API Portal: hosting-accounts, overview, profile, jobs, notifications
- ✓ Purge/migrate trả 501 có mã rõ ràng

## 2026-11-20 — Phase 3 / Prompt 3.4 — nhánh `phase-3`

Môi trường: như 3.1 (PostgreSQL 16 local, Redis; queue `sync` trong Pest, agent giả bằng `Http::fake` — `tests/Support/FakeAgent.php`).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Agent mock | `cd agent && go test ./...` · `make lint-agent` · `make no-exec` | PASS — `accounts_test.go`: vòng đời ensure → quota.apply → suspend → unsuspend → remove, quota.report; params sai schema / home ngoài `/home/<user>` / shell ngoài enum → `invalid_params` / `path_outside_home` |
| Job | `php artisan test tests/Feature/Platform/JobsTest.php` | PASS: 8 test — thành công (op_id `uuid:seq:1`, requested_by, tiến độ 100, audit `job.create`); lỗi tạm thời tự thử lại với op_id mới; hết lượt → failed; agent không kết nối = lỗi tạm thời; lỗi không thử lại → failed + thông báo; retry qua API cần Idempotency-Key, không chạy lại bước đã xong, replay trả response cũ + `Idempotent-Replayed`, cùng key khác request → 409; cancel queued / running (dừng trước bước kế), cancel lần hai 409; timeout → `timed_out`; phạm vi (ADMIN ngoài phạm vi, USER khác → 404); mọi endpoint admin/portal khớp OpenAPI |
| Audit, thông báo, cài đặt, server, dashboard | `php artisan test tests/Feature/Platform/PlatformApiTest.php` | PASS: 8 test — UPDATE/DELETE audit bị DB chặn, chuỗi hash hợp lệ, sửa trực tiếp (bỏ trigger) bị `itso:audit-verify` phát hiện; lọc `prefix.*`, phạm vi ADMIN, CSV thêm `'` trước `= + - @`; 403 khi ghi → audit `denied`; thông báo chỉ của chính user, đọc một/đọc hết; cài đặt không trả secret (lưu mã hóa, không vào audit), 412, 422, 403 cho ADMIN, step-up hết hạn → 403; server local + `itso:server-local` (agent giả), phạm vi ADMIN, ETag/412, 409 trùng tên, agent mất liên lạc → `agent_connected=false` / `degraded`; dashboard theo phạm vi |
| Ma trận quyền | `php artisan test tests/Feature/Rbac/MatrixTest.php` | PASS: 113 test — thêm 11 endpoint 3.4 × 4 nhân vật |
| Contracts | `make contracts-check` · `make codegen-check` | PASS (không đổi contract) |
| Pest toàn bộ | `make test-api` | PASS: 206 test, 1496 assertion |
| Lint | `make lint-api` (pint + Larastan) · `make lint-agent` · `make no-exec` | PASS |

**Test bị bỏ qua:** không.

Ghi chú:

- Helper `tests/Support/OpenApi.php`: YAML `{}` (schema rỗng) được parse thành mảng PHP rỗng; nay đổi thành `true` để validate được `SettingsGroup`/`DashboardSummary.counts`.
- `make no-exec` báo nhầm chuỗi `"/bin/sh"` trong test Go (giá trị shell sai để kiểm validate); đổi sang `/usr/bin/zsh`, không nới luật kiểm.
- Idempotency-Key dùng lại với request khác trả 409 `idempotency_key_reused` theo contract (prompt ghi 422). `/jobs/{id}/events` trả một bản chụp SSE (contract không có tham số `after`); luồng liên tục qua gateway ở Phase 11.

### Acceptance Prompt 3.4

- ✓ JobRunner nhiều bước, retry/cancel/timeout, job_logs; mock agent op account/quota theo schema
- ✓ /jobs admin + portal (portal chỉ job của account mình); Idempotency-Key
- ✓ Audit append-only + hash chain + CSV chống chèn công thức; audit `denied`
- ✓ Thông báo in-app; /settings/{group} chỉ SA, không trả secret
- ✓ /servers (server local seed từ cấu hình), /dashboard/summary

## 2026-11-20 — Phase 3 / Prompt 3.3 — nhánh `phase-3`

Môi trường: như 3.1.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS (portal thêm `POST /auth/impersonation:accept`, `POST /auth/impersonation:end`; admin 220 / portal 103 operation) |
| Ma trận quyền | `php artisan test tests/Feature/Rbac/MatrixTest.php` | PASS: 69 test — 17 endpoint × 4 nhân vật (SA, ADMIN trong phạm vi, ADMIN ngoài phạm vi, USER) + danh sách theo phạm vi. Ngoài phạm vi → 404, thiếu quyền → 403, USER gọi Admin API → 401 (GET) / 419 (ghi, không có phiên admin nên chặn ở CSRF) |
| Users API | `php artisan test tests/Feature/Rbac/UsersApiTest.php` | PASS: 12 test — mọi endpoint users/roles/api-tokens khớp OpenAPI (200/201/204/404/409/412/422); token tạo qua API dùng được đúng scope; mời user 72 giờ; ≥1 SUPER_ADMIN; ETag/If-Match; khóa thu hồi phiên, mở khóa xóa bộ đếm, reset MFA; step-up hết hạn; gán phạm vi; giả danh (vé một lần, hết hạn 60 giây / 30 phút, chặn đổi mật khẩu/MFA, audit kèm người giả danh); audit che secret + hash chain; cursor + sort sai 422 |
| Pest toàn bộ | `make test-api` | PASS: 146 test, 983 assertion |
| Lint | `make lint-api` · `make docs-check` · web `tsc -b` | PASS (Larastan 0 lỗi) |

**Test bị bỏ qua:** không.

Ghi chú: Policies hiện thực bằng `App\Auth\Access` (truy vấn có phạm vi dùng chung cho list và chi tiết) + middleware `itso.perm`; model của 3.4/3.5 (job, audit, account, gói) dùng cùng lớp này khi có endpoint.

### Acceptance Prompt 3.3

- ✓ Seed vai trò/quyền, phạm vi ADMIN, USER chỉ thấy của mình (`Access::accounts`)
- ✓ /users (lọc, tạo, sửa, khóa/mở, reset MFA, scopes), /roles, API token
- ✓ Giả danh chỉ SA, có lý do, chỉ USER Portal đang hoạt động, impersonation_sessions, audit
- ✓ Luôn còn ít nhất một SUPER_ADMIN; ADMIN chỉ quản lý USER Portal trong phạm vi
- ✓ Ma trận quyền tự động

## 2026-11-20 — Phase 3 / Prompt 3.2 — nhánh `phase-3`

Môi trường: như 3.1 (PostgreSQL 16 + Redis 7 cục bộ).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contracts | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS (thêm header `X-ITSO-Realm`, scheme `adminSession`/`portalSession`) |
| TOTP | `php artisan test tests/Unit/Auth` | PASS: 10 test — 6 vector RFC 6238 (SHA-1, 8 số), 10 vector HOTP RFC 4226, base32, cửa sổ ±1 bước, otpauth URI |
| Auth (Feature) | `php artisan test tests/Feature/Auth` | PASS: 32 test. Mọi endpoint `/auth/*` kiểm response theo schema OpenAPI (200/204/401/409/422/429). Khóa sau 5 lần sai (429 + Retry-After, khóa tăng 1 → 2 phút, đúng mật khẩu xóa bộ đếm), khóa theo IP; sai realm = sai mật khẩu; CSRF thiếu/sai → 419 `csrf_mismatch` (cả khi đã đăng nhập); phiên admin không gọi được API portal và ngược lại (kể cả đổi tên cookie, đổi header realm); realm theo host; MFA enroll/confirm/verify, chặn dùng lại mã, mã khôi phục một lần, 429 sau 5 lần sai; SA chưa bật MFA bị chặn; step-up hết hạn sau 10 phút; danh sách/thu hồi phiên; đổi/quên/đặt lại mật khẩu (token một lần, hết hạn 60 phút); IP allowlist; API token (sai, hết hạn, CIDR, scope, user portal/khóa) |
| Pest toàn bộ | `make test-api` | PASS: 65 test, 431 assertion |
| Thử thật qua HTTP | `php artisan serve` + `curl` (csrf → login SA → me → admin/system/version) | PASS: cookie `XSRF-TOKEN-ADMIN`, `itso_admin_session` mã hóa; SA chưa bật MFA nhận `403 mfa_required` |
| Lint | `make lint-api` · `make docs-check` · `make structure` | PASS (Pint, Larastan 0 lỗi) |

**Test bị bỏ qua:** không.

Phát hiện và sửa trong lúc test:

- `ResolveRealm` (đặt tên cookie phiên theo realm) bị Laravel xếp sau `StartSession` theo middleware priority → request admin ngay sau một request portal đọc nhầm cookie portal. Thêm `ResolveRealm` vào priority trước `EncryptCookies`; test "phiên admin và portal xen kẽ" bắt được lỗi này.
- Test giả lập trình duyệt (`tests/Support/Spa.php`) dựng lại session store và guard mỗi request để không dùng trạng thái session trong bộ nhớ của test.

### Acceptance Prompt 3.2

- ✓ Đăng nhập theo realm, khóa lũy tiến, argon2id, logout, me
- ✓ MFA TOTP + mã khôi phục, SUPER_ADMIN bắt buộc MFA, step-up
- ✓ Phiên (liệt kê, thu hồi), đổi/quên/đặt lại mật khẩu
- ✓ IP allowlist realm admin, guard API token
- ✓ Pest khớp OpenAPI; vector RFC 6238; khóa sau N lần sai; tách realm; CSRF 419

## 2026-11-20 — Phase 3 / Prompt 3.1 — nhánh `phase-3`

Môi trường: PHP 8.3.6, Laravel 13, Pest 4; PostgreSQL 16 (cluster tạm `initdb`, database `itso` và `itso_test`) + Redis 7 chạy cục bộ.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Đặc tả DB + migration | `make db-verify` | PASS: 41 test SQL; `2026_11_20_000003_phase_3_schema.php` khớp đặc tả; áp lần lượt SQL Phase 3 → 11 vào DB rỗng cho `pg_dump --schema-only` giống hệt itso.sql + extras.sql. Đã thử cả chế độ `DB_VERIFY_URL` (như CI) |
| Pest | `make test-api` | PASS: 23 test (9 test schema mới + 14 cũ) — đủ 26 bảng Phase 3, partition mặc định audit; 3 vai trò đúng realm, CHECK chặn vai trò lạ; uuid do DB sinh có ngay sau create; realm bất biến; vai trò khác realm bị chặn; email citext duy nhất; chủ account phải là USER portal, username/UID sai bị chặn, terminated thiếu purge_after bị chặn; phiên bản gói bất biến, retention < 30 ngày bị chặn, cột `text[]` đọc/ghi đúng; audit append-only và chuỗi hash nối tiếp; lịch sử vòng đời append-only; job sai trạng thái/tiến độ bị chặn |
| Migrate thật | `php artisan migrate:fresh --seed`, `migrate:rollback`, `migrate` (DB `itso`) | PASS |
| Lint | `make lint-api` · `make docs-check` · `make structure` · `python3 scripts/check-ci.py` | PASS (Larastan 0 lỗi) |

**Test bị bỏ qua:** không.

### Acceptance Prompt 3.1

- ✓ Migrations 26 bảng Phase 3 + phần extras.sql tương ứng (purge guard để Phase 8 vì cần `purge_records`)
- ✓ Model, cast, factory; Pest chạy trên PostgreSQL 16 (D-59)
- ✓ So khớp schema migrate với đặc tả; test trigger/CHECK

## 2026-11-20 — Phase 2 / Prompt 2.8 — nhánh `phase-2` (kiểm tra tổng)

Môi trường: như 2.1; PostgreSQL 16 (cluster tạm `initdb`) và Redis 7 chạy cục bộ cho `test-api-pg`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Số liệu nhất quán | `npx vitest run src/demo/__tests__/consistency.test.ts` | PASS: 5 test — dashboard = tổng danh sách (server, account đang sống, website, database, user, gói, phân bổ gói); số account theo server; usage website/DB/SFTP/cron = danh sách; Portal và Admin cùng usage, số thông báo chưa đọc khớp; tạo website ở Portal → usage, dashboard, danh sách cùng tăng |
| Kiểm tra mọi route | `npx playwright test e2e/demo-audit.spec.ts` | PASS: 74 route (56 Admin + 18 Portal, bỏ 2 route chuyển hướng) — axe light + dark 0 critical/serious, không tràn ngang 390px, giao diện EN không lẫn tiếng Việt (trừ dataset, nội dung API trả về, tên "Tiếng Việt"). Lần đầu 59/74: sửa 5 lỗi a11y (xem dưới) và bộ lọc dữ liệu API trong test |
| Ảnh trang chính | `make screenshots` | PASS: 56 ảnh `docs/screenshots/phase-2/` (14 trang × 1440/390 × light/dark) + Design System; cả bộ Playwright 259 test |
| Toàn bộ | `make check` | Lần đầu 19 PASS · 1 SKIP · 2 FAIL: `docs-check` (dấu gạch đứng trong code span ở bảng TEST_REPORT) và `test-api-pg` (cluster tạm chưa có database `itso_test`). Sửa và chạy lại riêng hai bước: `make docs-check` PASS, `make test-api-pg` PASS 14/14. Còn lại: Vitest 457, Playwright 259, db-verify 41, fuzz 212.940 lần, git-clean PASS |
| Bản demo tĩnh | `python3 -m http.server` trên `apps/web/dist-demo` + script Playwright | PASS: `/admin/` và `/portal/` hiện H1, điều hướng sidebar tới Website thấy dữ liệu giả lập, không lỗi trang |

Phát hiện và sửa:

- Bộ lọc Thông báo dùng tab không có panel (`aria-controls` trỏ tới phần tử không tồn tại) → nhóm nút bật/tắt `aria-pressed`.
- Nút "Đã đọc" và link trạng thái ở danh sách Khôi phục có `aria-label` không chứa chữ hiển thị → chữ bổ sung `sr-only`.
- Link "Quên mật khẩu" (đăng nhập Portal) thiếu tương phản ở dark, link "Quay lại đăng nhập" vùng bấm < 24px → `text-primary-text`, `min-h-6`.

**Test bị bỏ qua:** không. `staticcheck` SKIP vì chưa cài được (như Phase 1).

### Acceptance Prompt 2.8 / Phase 2

- ✓ Mọi mục sidebar mở trang có nội dung thật
- ✓ VI/EN không chuỗi cứng; dark/light đúng; không tràn ngang 390px
- ✓ Số liệu nhất quán giữa các trang
- ✓ Screenshot trong repo; bản demo tĩnh build được; báo cáo `docs/reports/phase-2.md`

## 2026-11-20 — Phase 2 / Prompt 2.7 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: thêm `AccountFeatures` + `GET /hosting-accounts/{id}/features` cho admin (220 op) và portal (101 op) |
| API giả lập Portal | `npx vitest run src/demo/__tests__/portal.test.ts` | PASS: 12 test — An Phát chỉ thấy anphat/oldshop, Marketing chỉ thấy mktitso/pending01; website, database, SFTP, cron, snapshot, khôi phục chỉ thuộc account của mình; account/usage/tính năng/website/job của người khác → 404 và không lộ tên; job và thông báo tách theo user; không tạo website trên account người khác; không có endpoint admin trong realm portal |
| Portal không gọi /admin/ | `npx vitest run src/entries/portal` | PASS: 22 test — render từng route trong 18 route Portal trên API giả lập, ghi lại mọi request: không request nào chứa `/admin/`, chỉ `/api/v1/portal`, `/api/v1/system`, `/api/v1/auth`, trang dữ liệu đều có gọi API; đăng nhập portal gọi `/auth/login` rồi vào Portal; menu chỉ chức năng USER; chuông đếm thông báo chưa đọc thật |
| Vitest toàn bộ | `npx vitest run` | PASS: 452 test (26 file) |
| Đổi user demo (Portal) | `npx playwright test e2e/demo-portal.spec.ts` | PASS: 2 test — An Phát thấy anphat.vn/shop.anphat.vn, không có cột WAF; đổi sang Phòng Marketing thì website, database, Tổng quan chỉ còn dữ liệu mktitso, menu không có link admin; đổi lại thấy dữ liệu An Phát; mở thẳng URL account/website của An Phát khi là Marketing → "Không tìm thấy" |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 129 test (smoke 18 route Portal, axe shell Portal 4 tổ hợp theme/ngôn ngữ) |
| Lint | `make lint` | PASS: ESLint (gồm ranh giới realm), Prettier, tsc, i18n (6 namespace, 2476 key, vi = en), pint, phpstan, check-no-exec |
| API | `make test-api` | PASS: 14 test Pest |
| Build | `make build-demo` | PASS: build thường không chứa MSW |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 18 route Portal | Không lỗi console, không tràn ngang ở 390px |

Phát hiện và sửa:

- Đổi user demo chỉ xóa cache (`clear()`), trang đang mở vẫn giữ dữ liệu của người trước tới khi chuyển trang → dùng `resetQueries()` để tải lại ngay (lỗi có từ 2.1, test Playwright mới bắt được).
- Chuông thông báo trên topbar là số cố định (3/1) từ 2.1 → đếm từ `/notifications` của người đang đăng nhập, cùng key với trang Thông báo nên đánh dấu đã đọc cập nhật ngay.
- Select đổi từ uncontrolled sang controlled (cảnh báo React) ở 4 trang → luôn truyền `value` (rỗng = placeholder).
- axe: nút "Chi tiết" có `aria-label` không chứa chữ hiển thị (label-content-name-mismatch) → nhãn "Chi tiết {{name}}".
- Test 1.5/1.6 của shell Portal chờ dòng health của trang tạm cũ → kiểm Tổng quan thật (fixture thêm `/portal/overview`).

**Chưa kiểm:** `make check` đầy đủ (2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.7

- ✓ Mọi route mục B sitemap: đăng nhập/MFA/quên mật khẩu, Tổng quan usage/quota, account, websites (+new, :id), databases, files, sftp, cron, backups, wordpress, terminal (chỉ gói có SSH), jobs/:id, notifications, profile
- ✓ Chỉ dữ liệu của USER đang đăng nhập; không có route/menu admin, không mua hàng (nâng gói: liên hệ quản trị)
- ✓ Vitest Portal không gọi /admin/; Playwright đổi user demo → chỉ thấy dữ liệu của mình

## 2026-11-20 — Phase 2 / Prompt 2.6 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make codegen-check` | PASS: dataset thêm 4 quy tắc cảnh báo, 2 cảnh báo (đã xử lý / đã xác nhận), 5 kiểm tra uptime, 3 lần quét mã độc, chính sách "Cấu hình panel hằng tuần", 1 lần khôi phục lỗi |
| API giả lập quản trị | `npx vitest run src/demo/__tests__/governance.test.ts` | PASS: 21 test — xác nhận sự kiện một lần, ADMIN không thấy sự kiện ngoài phạm vi; SSH chỉ SA, chặn cấu hình tự khóa, áp dụng qua job; fail2ban; allowlist kiểm CIDR, không rỗng, chống ghi đè khi dữ liệu đã đổi; khôi phục file cách ly; đích sao lưu kiểm cấu hình theo loại, không trả credentials, không giảm Object Lock; chính sách tạo/sửa/chạy/xóa, chặn cron sai; snapshot thủ công, snapshot trên đích bất biến không xóa được; duyệt cây, link tải có hạn, kiểm chứng; khôi phục ghi đè phải gõ đúng username; người dùng (vai trò khớp realm, email duy nhất, ADMIN chỉ tạo user portal, không tự hạ quyền, luôn còn 1 SA, khóa/mở khóa/MFA, phạm vi ADMIN); đăng nhập thay cần lý do và ghi audit; quy tắc cảnh báo; xuất CSV audit theo bộ lọc và phạm vi; đánh dấu đã đọc; cài đặt chỉ SA, không tắt MFA quản trị, không lộ mật khẩu SMTP; API token hiện secret một lần |
| Ma trận quyền + nhật ký | `npx vitest run src/entries/admin/system` | PASS: 10 test — `allows` (`*`, `x.*`, không suy diễn write ⇒ read), ma trận với 3 vai trò mẫu, render `RoleMatrix` (cột theo vai trò, ô Có/Không cho trình đọc màn hình, đếm ô được phép, không có ô nhập/nút), bảng thay đổi audit |
| CSV | `npx vitest run src/shared/lib` | PASS: 4 test — RFC 4180 (dấu phẩy, nháy kép, xuống dòng), chặn chèn công thức `= + - @` nhưng giữ số âm, khứ hồi `toCsv` → `parseCsv` có tiếng Việt, CRLF |
| Sao lưu + bảo mật | `npx vitest run src/entries/admin/backups src/entries/admin/security` | PASS: 19 test — quy tắc 3-2-1-1-0 (đủ, thiếu, đích lỗi và lỗi kiểm chứng/chính sách), snapshot mới nhất theo account bỏ bản `final`, hạn kiểm chứng 7 ngày; mục khôi phục (bỏ mục con khi đã chọn cha, gộp config); form đích S3/local, chính sách; CIDR/IP, allowlist trùng, SSH không để trống nhóm |
| Vitest toàn bộ | `npx vitest run` | PASS: 383 test (24 file) |
| Luồng quản trị (demo) | `npx playwright test e2e/demo-admin2.spec.ts` | PASS: 3 test — wizard khôi phục (chưa chọn snapshot, chưa chọn mục, gõ sai username đều bị chặn → ghi đè `database:anphat_shop` + config → job "Đã xong" → dòng "Thành công" trong /restores); khôi phục từ menu snapshot ra bản mới sang srv-hn-02; nhật ký lọc "Thất bại", xem chi tiết, tải CSV đúng tên file và tiêu đề cột |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 127 test (smoke 76 route gồm 18 route mới) |
| Lint | `make lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 2417 key, vi = en), pint, phpstan, check-no-exec |
| Build | `make build-demo` | PASS |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 24 màn/tab mới | Không lỗi console; sau khi sửa không tràn ngang ở 390px |

Phát hiện và sửa:

- Bảng Vai trò tràn ngang 136px ở 390px dù đã bọc `overflow-x-auto`: chữ `sr-only` (định vị tuyệt đối) thoát khỏi vùng cuộn → thêm `relative` cho vùng cuộn (cả bảng Thông báo và chi tiết Nhật ký).
- Thông báo dùng `setState` trong `useEffect` (ESLint) → tách form, khởi tạo từ dữ liệu, `key` theo `updated_at`.
- Test 1.5 mong tiêu đề tạm "Cài đặt hệ thống"; trang thật tên "Cài đặt" → cập nhật kỳ vọng (vẫn kiểm SA vào được).
- Ký tự BOM viết trực tiếp trong mã → đổi thành `\uFEFF`.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.6

- ✓ /security + WAF, mã độc (quét, cách ly, khôi phục), SSH, fail2ban, FIM, IP được phép (cảnh báo khi IP phiên hiện tại không nằm trong danh sách)
- ✓ /backups: Đích, Chính sách, Lịch sử, Kiểm chứng, checklist 3-2-1-1-0
- ✓ /restores + wizard khôi phục mới
- ✓ /users (+ :id, phạm vi ADMIN, impersonate có lý do), /roles (ma trận chỉ xem)
- ✓ /monitoring (+ cảnh báo), /audit-logs (lọc, chi tiết, xuất CSV), /notifications, /settings (tab)
- ✓ Vitest ma trận quyền hiển thị, xuất CSV; Playwright wizard khôi phục

## 2026-11-20 — Phase 2 / Prompt 2.5 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| DB + Contract | `make db-schema` · `make db-verify` · `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: 80 bảng (thêm `git_repositories`, `git_deployments`), db-verify 41 test; OpenAPI thêm Git deploy (admin + portal), op `git.deploy`/`git.rollback` khai báo; dataset 3 zone DNS, 2 repository, 4 lần deploy |
| Thư viện Hosting II | `npx vitest run src/shared/hosting` | PASS: 43 test — đường dẫn File Manager (chuẩn hóa `~`, tuyệt đối trong home, chặn `..` thoát home, `/etc/passwd`, home người khác, ký tự điều khiển; breadcrumb; chuyển thư mục vào chính nó; quyền 0755 → rwxr-xr-x), cron (5 trường, khoảng/bước/danh sách, ngoài miền, 5 lần chạy tới, khoảng cách ngắn nhất, mô tả bằng lời), record DNS (IPv4/IPv6 kể cả `:::`, CNAME ở gốc, proxy chỉ A/AAAA/CNAME, MX/SRV cần độ ưu tiên, TTL 60–86400 theo contract, SRV/CAA) |
| Form Hosting II | `npx vitest run src/entries/admin/sites` | PASS: 13 test — website (domain chữ thường, thư mục gốc `..`/tuyệt đối, proxy chỉ 127.0.0.1, PHP bắt buộc), tiền tố username cho database/SFTP, cron sai/lệnh nhiều dòng, chỉ nhận khóa SSH công khai, URL repo/branch/đường dẫn dùng chung/số release, ngày còn lại của chứng chỉ |
| API giả lập Hosting II | `npx vitest run src/demo/__tests__/sites.test.ts` | PASS: 27 test — tạo website → job (4 bước) → `ready` + domain xác minh + chứng chỉ; chặn vượt số website, PHP ngoài gói, domain trùng, proxy ra ngoài, document root thoát site, account tạm ngưng, ADMIN ngoài phạm vi; PHP/log đúng contract; File Manager chặn `../`, `/etc/passwd`, `/home/mktitso`, lưu với etag cũ → 412, mkdir/move vào chính nó/xóa; DNS 1 ca thêm + 5 ca chặn; cron sai và dày hơn gói; chạy cron thêm lịch sử; tiền tố tên DB, SFTP ngoài home, SSH khi gói không cho; WordPress cần site PHP, cập nhật; Git deploy chồng → 409 `resource_locked`, rollback đánh dấu release sau `rolled_back`, xoay webhook secret |
| API giả lập theo OpenAPI | `npx vitest run src/demo/__tests__/handlers.test.ts` | PASS: mọi handler đăng ký có trong OpenAPI, mọi GET trả body hợp lệ schema (thêm Git, file, log) |
| Vitest toàn bộ | `npx vitest run` | PASS: 326 test (19 file) |
| Luồng Hosting II (demo) | `npx playwright test e2e/demo-sites.spec.ts` | PASS: 4 test — tạo website (báo lỗi khi thiếu dữ liệu, chặn `../../etc`) → job "Đã xong: Tạo website" → dòng "Sẵn sàng" PHP 8.2 → tab SSL có chứng chỉ; File Manager chặn `/etc/passwd`, sửa `index.php`, tạo thư mục qua job; DNS báo IPv4 sai → thêm record A → có trong zone; cron xem trước "Hằng ngày lúc 02:00", báo biểu thức sai, chạy ngay → lịch sử; Git deploy → quay về release cũ → "Đang chạy" |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 124 test (smoke 76 route + luồng lõi, hạ tầng, hosting I/II + Design System + axe) |
| Lint | `pnpm lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 1750 key, vi = en) |
| Build | `make build-demo` | PASS |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 11 màn Hosting II | Không tràn ngang ở 390px, không lỗi console |

Phát hiện và sửa:

- `ListPage` ở chế độ nhúng (trong tab) bỏ luôn mô tả và nút thao tác → nút "Thêm record", "Thêm domain"… không hiện; nay hiện mô tả và nút phía trên bảng (không ảnh hưởng trang cũ vì chưa trang nào truyền hai thuộc tính này khi nhúng).
- Chứng chỉ SSL không lọc theo phạm vi ADMIN (chỉ gắn website) → suy ra account qua website.
- TTL "tự động" (1) của Cloudflare không có trong contract (`ttl` 60–86400) → bỏ khỏi form, schema và API giả lập.
- Tên op sai so với contract agent (`db.*.user_remove`, `db.pg.restore`, `cron.run`) → `user_drop`, `import`, `cron.run_once`.
- Lỗi form có tham số chuỗi (tiền tố tên) → `translateError` truyền thêm `{{value}}`.
- Khóa deploy/URL webhook dài chạy dưới nút sao chép → `CodeBlock` có chế độ xuống dòng và nền cho nút.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.5

- ✓ /websites (+ thêm website → job) và /websites/:id 8 tab: Tổng quan, Domain, PHP, SSL, Nginx, WAF, Log, Sao lưu
- ✓ /databases (database + user, quyền, đổi mật khẩu hiện một lần, xuất)
- ✓ /files: chọn account trước, 2 khung (cây thư mục + danh sách), chặn đường dẫn ngoài home, sửa file có etag, tải lên, thao tác hàng loạt qua job
- ✓ /sftp (+ SSH key), /ssl, /dns (zone + record), /cron (+ lịch sử chạy, xem trước lịch), /wordpress, /git-deployments
- ✓ Vitest đường dẫn File Manager, form record DNS, cron expr; Playwright tạo website → job

## 2026-11-20 — Phase 2 / Prompt 2.4 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: dataset thêm Super Admin thứ hai (14 user); bản nhúng trong agent đồng bộ lại |
| API giả lập hosting | `npx vitest run src/demo/__tests__/hosting.test.ts` | PASS: 35 test — 28 ca ghi/đọc (201/202/403/409/422) hợp lệ schema, gồm ADMIN ngoài phạm vi server, username trùng/hệ thống, server không nhận account, legal hold chỉ SA; tạo account → `provisioning` → job xong → `active`, có website và vòng đời; D-43 đổi giới hạn → v2, account giữ v1 tới khi chuyển, đổi tên không tạo phiên bản; D-46 chấm dứt (giữ ≥ 30 ngày) → ADMIN không lên lịch purge → SA A lên lịch → SA A tự xác nhận bị 403 → SA B xác nhận → lần 2 bị 409; legal hold chặn purge; chuyển server → `verifying` → không mở lần thứ hai → cutover → account ở máy đích |
| Logic form/wizard | `npx vitest run src/entries/admin/hosting` | PASS: 10 test — form gói (giới hạn mẫu hợp lệ; mã gói, số âm/thập phân/rỗng, PHP rỗng, giữ dữ liệu < 30 ngày → khóa lỗi i18n); so sánh phiên bản; username 3–16 ký tự + tên hệ thống; bước wizard bắt buộc chọn, domain tùy chọn + chuyển chữ thường; gợi ý username từ tên tiếng Việt; đếm ngày còn lại; bước wizard chuyển server; giai đoạn purge |
| Vitest toàn bộ | `npx vitest run` | PASS: 233 test (16 file) |
| Luồng hosting (demo) | `npx playwright test e2e/demo-hosting.spec.ts` | PASS: 4 test — wizard tạo account (chặn khi chưa chọn chủ sở hữu, gợi ý username, chặn `root`) → job "Đã xong" → trang account Hoạt động → có trong danh sách; purge 2 bước: người lên lịch bị chặn tự xác nhận, đổi vai trò sang Nguyễn Hải → gõ username → "Đã xác nhận, chờ tới hạn"; sửa RAM gói Basic → v3 → tab So sánh hiện 1 GB → 2 GB; chuyển server lehoa: cutover → "Đã chuyển sang srv-hn-02" |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 120 test (smoke 76 route + luồng lõi, hạ tầng, hosting + Design System + axe) |
| Lint | `pnpm lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 1190 key, vi = en) |
| Build | `make build-demo` | PASS |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 cho 10 màn gói/tài khoản | Không tràn ngang ở 390px, không lỗi console |

Phát hiện và sửa:

- Bấm "Tiếp" ở bước cuối wizard gửi luôn form: React tái dùng cùng nút và đổi `type` thành `submit` trước khi trình duyệt xử lý click → đặt `key` riêng cho nút Tiếp và nút Tạo.
- Lần chuyển server mẫu giữ `job_uuid` của job cũ không có trong dữ liệu → trang tiến trình gọi job 404; cutover/hoàn tác nay gán job mới.
- Gợi ý đặt account là danh sách tĩnh, ADMIN thấy cả server ngoài phạm vi → tính điểm theo RAM/disk/số account của server trong phạm vi.
- Lỗi form chỉ truyền `{{min}}` → thêm `{{max}}` cho thông báo "Tối đa".
- Danh sách tài khoản loại account đã chấm dứt/xóa (có trang riêng) để khớp số trên dashboard.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.4

- ✓ /hosting-packages (+new, :id với lịch sử phiên bản, so sánh giới hạn)
- ✓ /hosting-accounts (danh sách, mức dùng, vòng đời), /new wizard (người dùng, gói, server có gợi ý, username)
- ✓ /hosting-accounts/:id: Tổng quan + mức dùng, Website, Database, SFTP, Cron, Backup, Vòng đời; khóa/mở khóa, đổi gói, chuyển server, chấm dứt gõ username, legal hold
- ✓ /:id/migrate wizard (kiểm tra trước, đồng bộ, kiểm tra dữ liệu, cutover, hoàn tác)
- ✓ /hosting-accounts/terminated: đếm ngược 30 ngày, backup đã kiểm chứng, purge 2 bước (D-46)
- ✓ Vitest validate form gói/wizard; Playwright tạo account → job → xuất hiện trong danh sách

## 2026-11-20 — Phase 2 / Prompt 2.3 — nhánh `phase-2`

Môi trường: như 2.1. Không chạy `make check` đầy đủ ở prompt này (chạy ở 2.8); đã chạy các bước liên quan bên dưới.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: thêm `compose_yaml` vào `ComposeProject` (lấy từ revision hiện tại, bảng `compose_revisions`); dataset có YAML mẫu |
| API giả lập hạ tầng | `npx vitest run src/demo/__tests__/infra.test.ts` | PASS: 35 test — 30 ca ghi (201/202/204/403/404/409/422) hợp lệ schema; dữ liệu con tách theo server (dừng nginx ở srv-hn-01 không đổi srv-hn-02); safe-apply: xác nhận trong hạn giữ rule, quá hạn tự hoàn tác về bộ rule cũ + audit `firewall.rollback`, xác nhận sau khi hoàn tác → 409; token thêm server → sau 6 giây server mới xuất hiện trong danh sách (hợp lệ schema); compose tạo → job xong → `running` |
| Logic trang server | `npx vitest run src/entries/admin/servers` | PASS: 11 test — reducer đếm ngược safe-apply (bắt đầu khi job xong, hết hạn → hoàn tác, xác nhận → giữ, job lỗi → idle); form rule (cổng 1–65535 và khoảng hợp lệ, ICMP không cần cổng, IPv4/IPv6 CIDR, ưu tiên 1–9999); form token server, Nginx; hành động phần mềm theo trạng thái; terminal mô phỏng không chạy lệnh |
| Vitest toàn bộ | `npx vitest run` | PASS: 188 test (14 file) |
| Luồng hạ tầng (demo) | `npx playwright test e2e/demo-infra.spec.ts` | PASS: 4 test — restart nginx → drawer job chạy tới "Đã xong" → job đứng đầu trang Tác vụ, trạng thái Thành công; tường lửa: cổng 99999 bị chặn, thêm rule → "1 thay đổi chưa áp dụng" → áp dụng 60 giây → đếm ngược giảm → "Giữ cấu hình mới" → đã xác nhận; thêm server srv-hcm-02 → lệnh join → agent kết nối → mở trang server → có trong danh sách; tạo compose project → trang chi tiết → Đang chạy |
| Playwright toàn bộ | `npx playwright test --trace off` | PASS: 116 test (smoke 76 route + luồng lõi + hạ tầng + Design System + axe) |
| Lint | `pnpm lint` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 877 key, vi = en) |
| Build | `make build-demo` | PASS: build thường không chứa MSW; `dist-demo` có worker |
| Ảnh rà soát | script Playwright (scratchpad) 1440/390 các trang server, tường lửa, terminal, Docker, Nginx, Compose, Registry | Không tràn ngang ở 390px |

Phát hiện và sửa:

- Thanh mục của server đặt trên breadcrumb → thêm slot `nav` cho PageHeader/DetailPage, đặt dưới tiêu đề.
- Badge "drift" hiện nguyên văn tiếng Anh → thêm `drift`, `inSync` vào bảng trạng thái của StatusBadge.
- Toast job hiện mã loại job (`service.restart`) → dùng nhãn i18n ("Đã xong: Khởi động lại dịch vụ").
- Drawer job (modal) che nút xác nhận tường lửa trong lúc đếm ngược → tự đóng drawer khi bắt đầu đếm ngược.
- Danh sách server không có tham số lọc trạng thái trong contract → bỏ bộ lọc (không gửi tham số ngoài contract).
- Dữ liệu demo nằm trong bộ nhớ trình duyệt: tải lại trang thì làm mới. Test luồng điều hướng trong SPA; ghi chú trong runbook demo.

**Chưa kiểm:** `make check` đầy đủ (để cuối Phase, 2.8), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.3

- ✓ /servers, /servers/new (lệnh join + chờ agent giả lập), /servers/:id (Tổng quan, Dịch vụ, Tài nguyên, Agent, Accounts), nginx, php, software, firewall, docker, terminal; /compose-projects (+:id); /docker/registries
- ✓ Firewall safe-apply có đếm ngược và tự hoàn tác; terminal mô phỏng, ghi rõ chính sách
- ✓ Thao tác dịch vụ chạy JobProgress; Playwright restart dịch vụ → job xong

## 2026-11-20 — Phase 2 / Prompt 2.2 — nhánh `phase-2`

Môi trường: như 2.1. PostgreSQL không bật ở lần `make check` này.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Contract | `make contracts` · `make codegen` · `make contracts-check` · `make codegen-check` | PASS: thêm `POST /api/v1/{admin,portal}/jobs/{id}:retry` (admin 210, portal 91 operation); file sinh khớp |
| API giả lập (đọc + ghi) | `npx vitest run src/demo` | PASS: 98 test — bảng ca ghi (login thiếu dữ liệu → 422, MFA `000000` → 422 `validation_failed`, mật khẩu < 12 ký tự → 422, thu hồi phiên hiện tại → 409, hủy/thử lại job → 202 `JobAccepted`) đều hợp lệ schema; job thử lại chạy tới `succeeded` và sinh audit; số trên dashboard bằng độ dài các danh sách với SUPER_ADMIN và ADMIN (Trần Minh) |
| Logic wizard cài đặt | `npx vitest run src/entries/admin/install` | PASS: 9 test (validate từng bước, chặn bước, cảnh báo allowlist rỗng/SSH mật khẩu, tách allowlist) |
| Tìm kiếm Ctrl+K | `src/entries/admin/__tests__/search.test.ts` | PASS: tìm theo username/domain, không phân biệt dấu (`quan tri` → "Quản trị hệ thống"), ≤ 5 kết quả/nhóm, ADMIN không có nhóm người dùng |
| Vitest toàn bộ | `make test-web` | PASS: 141 test (12 file) |
| Luồng lõi (demo) | `npx playwright test e2e/demo-core.spec.ts` | PASS: 6 test — số trên thẻ thống kê = số bản ghi API danh sách (SA và ADMIN); bấm server ở dashboard → trang chi tiết server; Ctrl+K "anphat" → mở chi tiết; đăng nhập → MFA (mã sai báo lỗi, mã đúng vào dashboard); wizard chặn bước khi thiếu mã, sang bước khi hợp lệ, quay lại được |
| Playwright toàn bộ | `make test-e2e` | PASS: 112 test (smoke 76 route + luồng lõi + Design System + axe) |
| Lint | `make lint-web` | PASS: ESLint, Prettier, tsc, i18n (6 namespace, 575 key, vi = en) |
| `make check` | `scripts/check-all.sh` | PASS: 20 PASS · 2 SKIP (test-api-pg: PostgreSQL không chạy; staticcheck chưa cài) · 0 FAIL, 197 giây |

Phát hiện và sửa:

- `test.use({ baseURL })` đặt trong module chung `e2e/demo.ts` chỉ áp cho file spec nạp đầu tiên mỗi worker (module được cache) → khi thêm spec thứ hai, vài smoke test chạy nhầm cổng 5173 và gặp 502. Chuyển sang fixture `baseURL` trong `test.extend`.
- Test ảnh drawer 390px chờ mọi animation của trang; dashboard mới có skeleton chạy vô hạn khi API không được giả lập → chỉ chờ animation trong drawer.
- Dashboard trả sớm trạng thái lỗi làm mất thẻ trạng thái hệ thống → hiện lỗi tại chỗ, phần còn lại vẫn hiển thị.
- 202 của contract là `JobAccepted` ở cấp gốc (không bọc `data`) → sửa mock.
- Tiêu đề dashboard đổi thành lời chào theo mockup → cập nhật App.test và test đổi ngôn ngữ.

**Chưa kiểm:** `test-api-pg` (không có thay đổi API Laravel), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.2

- ✓ Dashboard theo mockup; số liệu tính từ cùng dữ liệu với các danh sách (Vitest + Playwright)
- ✓ Luồng dashboard → server (Playwright)
- ✓ Jobs, chi tiết job (hủy/thử lại), Hồ sơ, Ctrl+K, Đăng nhập/MFA, wizard 10 bước; logic wizard và tìm kiếm có Vitest
- ✓ Chuỗi giao diện VI/EN đầy đủ

## 2026-11-20 — Phase 2 / Prompt 2.1 — nhánh `phase-2`

Môi trường: như 1.7 (Node 22, pnpm, Chromium Playwright có sẵn). PostgreSQL không bật ở lần `make check` này.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Dataset nhất quán | `python3 contracts/tools/check_demo.py` (bước 3 của `make contracts-check`) | PASS: khóa ngoại, số đếm tổng hợp (dashboard, usage, account_count, domains_count, portal_overview), uuid duy nhất; thử âm tính sửa `account_count` → lỗi |
| MSW theo OpenAPI | `npx vitest run src/demo` | PASS: 77 test — mọi handler (> 60) có operation trong OpenAPI; mọi GET trả < 300 và hợp lệ theo schema (ajv 2020, theo `$ref` vào `paths/…/responses` và `components/responses` của common.yaml); phân trang cursor, `q`, `limit=999` → 422 hợp lệ schema; ADMIN chỉ thấy phạm vi (lehoa thấy, account srv-hn-02 → 404) |
| Router, guard, breadcrumb | `npx vitest run src/entries src/shared` | PASS: `/` → `/dashboard`; route chưa làm hiện trang tạm có breadcrumb (crumb cha là link, crumb uuid rút gọn); sidebar active theo route; ADMIN vào `/settings` → 403; SA vào được; đường dẫn lạ → 404; portal không có link admin |
| ListPage URL state | `src/shared/page/__tests__/ListPage.test.tsx` | PASS: đọc `?q=&status=` từ URL và gửi theo tham số contract; gõ tìm kiếm cập nhật URL (giữ bộ lọc khác); "Xóa bộ lọc" làm sạch URL |
| Vitest toàn bộ | `make test-web` | PASS: 110 test (9 file) |
| Smoke mọi route (demo) | `npx playwright test e2e/demo-smoke.spec.ts` | PASS: 76 test — 58 route admin + 18 route portal (`pnpm dev:demo`, MSW bật), mỗi route có h1, không 404/403, không lỗi console, không request `/api` ≥ 400; ADMIN → `/settings` 403; điều hướng sidebar không tải lại trang; chuyển vai trò trên topbar áp guard ngay |
| Playwright toàn bộ | `make test-e2e` | PASS: 106 test; ảnh Design System 390px drawer lặp 2 lần ổn định |
| Build thường không có MSW | `make build-demo` (`scripts/check-demo-build.sh`) | PASS: `dist` không chứa `mockServiceWorker`, `X-Demo-User`, `setupWorker`, uuid kind 0xfe; `dist-demo` có worker và API giả lập |
| Lint | `make lint-web` | PASS: ESLint, Prettier, tsc, i18n (5 namespace, 278 key, vi = en) |
| `make check` | `scripts/check-all.sh` | PASS: 20 PASS · 2 SKIP (test-api-pg: PostgreSQL không chạy; staticcheck chưa cài) · 0 FAIL, 198 giây; repo sạch sau khi chạy |

Phát hiện và sửa:

- Contract: thao tác danh sách nhận `limit/sort/filter` nhưng chưa khai báo lỗi 422 → thêm 422 `ValidationFailed` cho mọi list (oas.py), mock trả 422 khi sort sai (trước là 400 không có trong contract).
- Handler MSW `*/api/*` bắt nhầm module Vite `/src/api/*.ts` → chỉ xử lý `/api/v1/`.
- Hai dev server (thường 5173, demo 5174) dùng chung cache deps của Vite → React bị nạp hai bản ("Invalid hook call") → demo dùng `cacheDir` riêng.
- Ứng dụng nhiều entry cần history fallback: `/admin/*` → `admin/index.html`, `/portal/*` → `portal/index.html` (plugin dev/preview; production là `try_files` của Nginx).
- Test ảnh drawer 390px mở menu khi router còn đang chuyển `/admin/` → `/admin/dashboard` (animation bị hủy) → chờ trang tải xong.
- `src/test/setup.ts` giả định jsdom → bỏ qua phần DOM khi test chạy môi trường node.

**Chưa kiểm:** `test-api-pg` (không bật PostgreSQL lần này; không có thay đổi API Laravel), CI trên GitHub.
**Test bị bỏ qua:** không.

### Acceptance Prompt 2.1

- ✓ Mọi route trong sitemap tồn tại (58 admin, 18 portal); smoke test xanh
- ✓ Response MSW 100% hợp lệ theo OpenAPI (mọi GET đã mock); dataset nhất quán (check_demo.py)
- ✓ Build thường không chứa MSW (kiểm bằng grep `dist`, chạy trong `make check` và CI)

## 2026-11-20 — Phase 1 / Prompt 1.7 — nhánh `phase-1`

Môi trường: như 1.6; PostgreSQL 16 (cluster tạm `initdb`) và Redis 7 (`redis-server`) chạy cục bộ cho bước `test-api-pg`.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Codegen TS | `make codegen` → `apps/web/src/api/generated/{admin,portal}/schema.ts` | PASS: `tsc` xanh, client openapi-fetch thay type viết tay; 26 test web vẫn xanh |
| Codegen Go | `contracts/tools/gen_go_types.py` → `agent/internal/contracts/types_gen.go` | PASS: `go vet`, `go test -race`; 3 test mới (mọi op đặc tả có Params/Result; 6 envelope mẫu decode chặt và mã hóa lại hợp lệ theo schema; kết quả `system.ping` có type hợp lệ) |
| Codegen check | `make codegen-check` | PASS; thử âm tính: sửa `admin/schema.ts`, `types_gen.go`, một schema nhúng → cả 3 lần exit ≠ 0 |
| Chặn Admin API ở portal | ESLint `no-restricted-imports` | PASS; thử âm tính: import `@/api/admin` trong `src/shared` → lỗi |
| Pest với PostgreSQL + Redis | `make test-api-pg` | PASS: 14 test; thử âm tính sai cổng PG → test trạng thái DB đỏ (xác nhận chạy trên PG thật) |
| Workflow CI | `python3 scripts/check-ci.py` | PASS: 7 job, 16 lệnh make có trong Makefile; thử âm tính target sai → lỗi. **actionlint chưa chạy** (máy cloud không cho tải) |
| `make check` | `scripts/check-all.sh` | PASS: 20 PASS · 1 SKIP (staticcheck chưa cài được) · 0 FAIL, 123 giây; thử âm tính codegen lệch → exit 2 |
| Clean clone | `git clone -b phase-1` → `make setup && make check` | PASS: 20 PASS · 1 SKIP · 0 FAIL; tổng 10 phút 54 giây (setup khoảng 8,5 phút vì Composer phải clone git; `make check` 134 giây); repo sạch sau khi chạy |

Phát hiện và sửa: ảnh Playwright thay đổi mỗi lần chạy làm bẩn repo → e2e ghi vào `test-results`, chỉ `make screenshots` cập nhật `docs/screenshots` (tắt animation, ảnh ổn định giữa các lần chạy); openapi-fetch giữ tham chiếu `fetch` lúc tạo client → truyền hàm gọi `globalThis.fetch` lúc request; test portal "không gọi `/admin/`" trước đó so chuỗi `[object Request]` (luôn đúng) → đọc `Request.url`.

**Chưa kiểm:** CI trên GitHub (chưa có remote), staticcheck và actionlint (không tải được ở máy cloud), `make services-up` (không có Docker).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.7 và Phase 1

- ✓ Tất cả acceptance 1.1–1.6 đạt
- ✓ `make check` xanh (0 FAIL) trên `phase-1` và clean clone; codegen không diff
- ✓ Không code nghiệp vụ, không thao tác hệ thống, không deploy, không push
- ✓ Báo cáo `docs/reports/phase-1.md`; PHASE_STATUS: Phase 1 ✓ chờ duyệt

## 2026-11-20 — Phase 1 / Prompt 1.6 — nhánh `phase-1`

Môi trường: như 1.5; thêm `@playwright/test` 1.63.0 (dùng Chromium có sẵn, không tải trình duyệt), `@axe-core/playwright` 4.14.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Token sinh tự động | `make tokens-check` (`gen-tokens.mjs --check`, nằm trong `make lint`) | PASS: `tokens.css` khớp `tokens.json` (45 màu × 2 theme) |
| Tương phản WCAG AA | `node design/tools/check-contrast.mjs` (trong `make tokens-check`) | PASS: 84/84 cặp (chữ ≥ 4.5:1, UI ≥ 3:1, light + dark). Lần đầu 4 cặp trượt → chỉnh màu `info`/`input` light, `danger`/`input` dark |
| Lint cấm màu hard-code | `make lint-web` (ESLint `no-restricted-syntax`) | PASS; thử âm tính: thêm `#ff0000`, `rgb()`, `bg-red-500`, `bg-[#123456]`… vào component → 6 lỗi |
| i18n | `pnpm i18n:check` (trong `make lint-web`) | PASS: 4 namespace, 187 key, 0 thiếu, VI = EN, biến `{{…}}` khớp |
| Vitest | `make test-web` | PASS: 26 test / 7 file: DataTable 5 (sắp xếp, lọc, chọn dòng, phân trang, card mobile), ConfirmDialog 4 (gõ đúng tên mới bật nút), FormField 3 (lỗi zod qua i18n), ThemeProvider 5 (đổi theme, `system` theo `prefers-color-scheme`, storage lỗi vẫn chạy), formatter VI/EN, 2 entry |
| Playwright | `make test-e2e` (`playwright test --trace off`, deviceScaleFactor 2) | PASS: 30 test: 12 ảnh (`/design`, AdminShell, PortalShell × 1440/390 × light/dark) + 2 ảnh drawer mở, không cuộn ngang ở mọi ảnh; không nháy theme (`.dark` có trước DOMContentLoaded); Ctrl+K; đổi theme/ngôn ngữ giữ sau khi tải lại; thu gọn sidebar; drawer nằm trên lớp phủ |
| axe-core | trong `make test-e2e` (WCAG 2.0/2.1/2.2 A, AA) | PASS: 0 lỗi critical/serious trên `/design`, AdminShell, PortalShell × light/dark × VI/EN (12 lần quét) |
| Build | `make build` | PASS: `dist/admin`, `dist/portal`, `theme-init.js`; không có `/design` trong `dist`. Cảnh báo: chunk chung 521 kB (gzip 164 kB) → tách theo route ở Phase 2 |
| Hồi quy 1.5 | `make test` + `make lint` | PASS: web 26, Pest 14 (63 assertion), Go `-race`, chặn exec, Pint, PHPStan 0 lỗi, gofmt/vet |
| Docs | `make docs-check` | PASS |

Phát hiện và sửa nhờ Playwright: drawer mobile bị lớp phủ che (token z-index `drawer` 50 < `overlay` 60 → đổi thành `overlay` 50 < `drawer` 60, thêm kiểm `elementFromPoint`); `/design` tràn ngang 104 px ở 390 px (Card thiếu `min-w-0` trong grid, tên op dài không xuống dòng); axe báo `label-content-name-mismatch` ở nút ngôn ngữ và user menu (`aria-label` khác chữ hiển thị → dùng `sr-only`). Prettier định dạng lại file sinh `tokens.css` làm `--check` lệch → loại file sinh khỏi Prettier.

**Chưa kiểm:** trình duyệt khác Chromium (Firefox, Safari).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.6

- ✓ Token light/dark sinh tự động, không màu hard-code trong component (lint rule, thử âm tính)
- ✓ 25 component nền (`src/ui`) + AdminShell, PortalShell, đúng ở 390 px và 1440 px
- ✓ 14 ảnh thật trong `docs/screenshots/design-system/`
- ✓ a11y (axe 0 critical/serious), tương phản 84/84, i18n 0 key thiếu

## 2026-11-20 — Phase 1 / Prompt 1.5 — nhánh `phase-1`

Môi trường: Node 22.23 + pnpm 10.28 (corepack), PHP 8.3.6, Composer 2.8.12, Laravel 13.43.0, Pest 4.7.8, PHPStan 2.3.7 + Larastan 3, Go 1.24.7; PostgreSQL 16 (cluster tạm `initdb`) và Redis 7 (`redis-server` cục bộ) chỉ để chạy thử trang trạng thái.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Web: Vitest render mỗi entry | `make test-web` | PASS: 3 test (admin: trạng thái OK + báo lỗi problem+json; portal: chỉ health, không gọi `/admin/`) |
| Web: lint | `make lint-web` (ESLint strict + `react/no-danger`, Prettier, `tsc`) | PASS; thử âm tính `dangerouslySetInnerHTML` → ESLint báo lỗi |
| Web: build | `make build` | PASS: `dist/admin`, `dist/portal` |
| API: Pest | `make test-api` | PASS: 14 test, 63 assertion: health/version/status khớp schema OpenAPI (validate bằng opis/json-schema từ `contracts/openapi`), 404/405/500 trả `application/problem+json` đúng schema Problem, 500 không lộ chi tiết, CORS tắt mặc định, AgentClient |
| API: rule cấm lệnh hệ thống | `tests/PHPStan/NoSystemCommandRuleTest` (trong Pest) | PASS: bắt đủ 12 vi phạm trong fixture (7 hàm kể cả `\EXEC`, backtick, 2 import, 2 lớp Process) |
| API: lint | `make lint-api` (Pint, PHPStan level 8 + Larastan + rule riêng) | PASS: 0 lỗi |
| Chặn exec (grep) | `make no-exec` (`scripts/check-no-exec.sh`) | PASS trên repo; âm tính: fixture PHP + Go có `os/exec`, `sh -c` → bắt 12 dòng, exit 1 |
| Agent: unit + race | `make test-agent` (`go test -race ./...`) | PASS: envelope 16 ca (op lạ → `unknown_op`, params thừa → `invalid_params`, ts lệch → `replay_rejected`, deadline…), registry (op ngoài catalog, op chưa hỗ trợ → `op_disabled`, cache theo `op_id`, nonce replay), result khớp `result.schema.json` + schema kết quả từng op, socket unix, TCP chỉ loopback, bản nhúng trùng `contracts/` |
| Agent: fuzz | `make test-fuzz` (30 giây) | PASS: 720 nghìn lượt (clean clone), 1,19 triệu lượt (lần đầu), không panic |
| Agent: lint | `make lint-agent` (gofmt, go vet) | PASS |
| Docs | `make structure` + `make docs-check` | PASS: 0 lỗi lint, 93 link, 8 khối Mermaid |
| Chạy thật | `make dev` + `curl` + Playwright | PASS: `/admin/` hiện API ok, Agent `ping mock 0.1.0-mock`, PostgreSQL OK, Redis OK; `/portal/` hiện API ok; `/admin` chuyển hướng `/admin/`; Ctrl+C/TERM dừng cả 3 tiến trình và xóa socket. Ảnh: `docs/screenshots/phase-1/1.5-*.png` |
| Clean clone | `git clone` → `make setup` → `make dev` → `make test` → `make lint` | PASS: setup 143 giây, dev sẵn sàng sau 1 giây, test và lint xanh, `git status` sạch sau khi chạy |

Phát hiện và sửa: `$!` của pipeline trỏ vào bộ lọc log nên Ctrl+C để sót tiến trình → đổi sang process substitution và dừng cả tiến trình con của `artisan serve`; context deadline của registry dùng đồng hồ thật thay vì đồng hồ của request → dùng thời lượng tương đối; lỗi tạm thời (`deadline_exceeded`) không còn bị cache theo `op_id`; Laravel mặc định trả `Access-Control-Allow-Origin: *` → tắt CORS, chỉ bật qua `ITSO_CORS_ORIGINS`.

**Ghi chú môi trường:** máy cloud chặn tải zip từ `codeload.github.com` nên Composer phải clone git (chậm) và gói `phpstan/phpstan` (chỉ có dist) được nạp sẵn vào cache Composer từ tag 2.3.7; `composer.lock` giữ nguyên nguồn chuẩn của Packagist. Thời gian 143 giây đo với cache Composer/pnpm/Go đã có; máy dev bình thường (tải zip trực tiếp) ước 3–6 phút, trong giới hạn 15 phút. Docker không chạy được trong máy cloud nên `make services-up` chưa chạy thử (`docker compose -f docker-compose.dev.yml config -q` PASS; PostgreSQL/Redis kiểm bằng bản cài trực tiếp).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.5

- ✓ Clean clone → `make setup && make dev` → `/admin` và `/portal` hiển thị health của API; ping mock agent hiển thị ở `/admin` (≤ 15 phút: đo 143 giây + 1 giây)
- ✓ `make test` và `make lint` xanh
- Lệch có chủ đích: ping agent chỉ hiện ở `/admin`, không ở `/portal` (thông tin agent là Admin-only, theo ranh giới realm của contracts). Endpoint version theo contract là `/api/v1/admin/system/version` (prompt ghi `/api/v1/system/version`), bật ở local/testing tới khi có auth.

## 2026-11-20 — Phase 1 / Prompt 1.4 — nhánh `phase-1`

Công cụ: `@redocly/cli` 2.71.0, `ajv-cli` 5.0.0 + `ajv-formats` 3.0.1 (draft 2020-12, strict), Python `jsonschema` 4.26 (Draft 2020-12 + FormatChecker).

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Sinh lại không diff | `make contracts-check` bước 1 (so sha256 trước/sau khi sinh) | PASS |
| Redocly lint | `redocly lint --config contracts/redocly.yaml` (recommended-strict + rule riêng) | PASS: 0 lỗi, 0 cảnh báo (admin, portal, common) |
| Ngữ nghĩa | `python3 contracts/tools/check_contracts.py` | PASS: 298 operation (admin 208, portal 90), 101 operation trả 202 Job đều có Idempotency-Key + JobAccepted, mọi 4xx/5xx dùng Problem |
| Example khớp schema | trong `check_contracts.py` | PASS: 373 example; độ phủ **282/282 = 100%** operation có body (16 operation 204 không có body) |
| Portal ⊄ admin-only | trong `check_contracts.py` | PASS: không path/tag/schema admin-only, không `/api/provisioning` |
| Op trong Job ↔ catalog agent | trong `check_contracts.py` | PASS: 57 op đều có trong `catalog.json` |
| Mẫu ràng buộc OpenAPI = agent; RE2 | trong `check_contracts.py` | PASS: 10 mẫu trùng khớp; 48 pattern không lookahead/backreference |
| Agent schema | ajv compile strict + `check_schema` | PASS: 64 schema; 6 envelope mẫu hợp lệ, 10 envelope không hợp lệ bị từ chối (cả ajv và Python) |
| Evil inputs | trong `check_contracts.py` | PASS: **93 vector** (82 tầng schema cho kết quả đúng, 11 tầng nghiệp vụ để dành cho test Phase 3–6) |
| HTML docs | `make contracts-docs` | PASS: admin 657 KiB, portal 442 KiB (không commit) |
| Docs repo | `make structure` + `make docs-check` | PASS: lint 0 lỗi, 92 link, 8 khối Mermaid |
| Âm tính (7 ca, bản sao trong scratchpad) | sửa contract rồi chạy `check_contracts.py` | PASS: bắt đúng cả 7: example sai (username chữ hoa), path `/portal/servers`, bỏ Idempotency-Key, 404 không dùng Problem, đảo kỳ vọng vector, thêm `/api/provisioning`, pattern có lookahead |

Phát hiện và sửa trong quá trình làm: Redocly bắt 21 example PATCH thiếu trường bắt buộc → thêm schema `*Patch` (cập nhật một phần); pattern job type không cho chữ số (`fail2ban.update`) → sửa pattern; portal có DNS trái với sitemap → bỏ khỏi portal; thiếu `password:forgot/reset` cho trang quên mật khẩu → bổ sung.

**Chưa kiểm:** codegen TypeScript/PHP từ OpenAPI (Prompt 1.7); thực thi vector tầng nghiệp vụ (Phase 3–6).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.4

- ✓ 2 file OpenAPI + common lint 0 lỗi; 100% operation có body có example (yêu cầu ≥ 95%)
- ✓ Agent schemas validate (ajv strict); evil-inputs 93 vector (yêu cầu ≥ 60)
- ✓ `API.md` có mục 0 link tới contracts

## 2026-11-20 — Phase 1 / Prompt 1.3 — nhánh `phase-1`

Môi trường: PostgreSQL 16.15 (Ubuntu 24.04 package) chạy cluster tạm bằng `initdb`/`pg_ctl`; `@dbml/cli` 3.9.0; `@softwaretechnik/dbml-renderer` 1.0.31.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| DBML → SQL | `make db-schema` (gen_dbml.py → dbml2sql → postprocess) | PASS: 78 bảng, không lỗi |
| Sinh xác định | chạy `make db-schema` lần 2, `diff` với lần 1 (DBML và SQL) | PASS: không khác biệt |
| ERD | `make db-erd` | PASS: 9 SVG (`erd-full` + 8 nhóm) |
| Áp schema PG16 | `make db-verify` (itso.sql + extras.sql) | PASS: 78 bảng + 2 partition mặc định |
| Test SQL | `make db-verify` | **PASS: 41/41** (realm 10, hosting 11, domain 6, audit 7, purge 7) |
| Độ phủ migration plan | script so danh sách bảng trong `migration-plan.md` với `itso.sql` | PASS: 78/78, không thiếu, không thừa |
| Docs | `make structure` + `make docs-check` | PASS: lint 0 lỗi, 83 link, 8 khối Mermaid |
| Âm tính: bỏ trigger realm | bản sao repo, xóa `CREATE TRIGGER users_realm_immutable` → `db-verify.sh` | PASS: exit 1, báo đúng test "Đổi realm của user bị từ chối" |

Test SQL bắt buộc theo prompt, đều có trong 41 test: domain trùng bị từ chối và cho phép lại sau soft-delete; UPDATE/DELETE `audit_logs` bị từ chối; đổi realm bị từ chối; gán USER cho user realm admin bị từ chối; xóa hosting account còn website bị từ chối; UID trùng trên cùng server bị từ chối. Bổ sung: purge guard D-46 (đủ 6 điều kiện chặn + 1 trường hợp hợp lệ), chuỗi hash audit, partition theo tháng, package version bất biến, migration cùng server bị từ chối.

**Chưa kiểm:** chạy `db-verify` qua `DB_VERIFY_URL` với PostgreSQL trong docker compose (sẽ có ở Prompt 1.5).
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.3

- ✓ DBML convert không lỗi; ERD SVG có trong repo (`database/docs/erd/`)
- ✓ `db-verify.sh` exit 0, 41/41 test SQL pass
- ✓ `DATABASE.md` có mục 0 link tới DBML, SQL, extras, ERD, tài liệu

## 2026-11-20 — Phase 1 / Prompt 1.2 — nhánh `phase-1`

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Markdown lint | `npx markdownlint-cli2@0.17.2` (41 file, trừ `docs/planning/` là bản lịch sử) | PASS: 0 lỗi |
| Link nội bộ | `node scripts/check-links.mjs .` | PASS: 58/58 link hợp lệ |
| Mermaid | `bash scripts/check-mermaid.sh` (mermaid-cli 11.4.2 + Chromium) | PASS: 6/6 khối render được |
| Tổng hợp | `make check` | PASS (structure + docs-check) |
| Âm tính: link hỏng | bản sao repo, thêm link tới file không tồn tại | PASS: exit 1, báo đúng file |
| Âm tính: Mermaid sai | bản sao repo, thêm khối `a -->\|( b` | PASS: exit 1 |
| Âm tính: lint | bản sao repo, thêm `#Sai heading` | PASS: báo 2 lỗi |
| Độ phủ sitemap | script đếm cột Module trong phần Admin | PASS: đủ 30/30 module |

Ghi chú: checker Mermaid đã bắt được 1 lỗi thật trong ARCHITECTURE.md (nhãn cạnh có `--` chưa đặt trong ngoặc kép) và đã sửa.

### Acceptance Prompt 1.2

- ✓ ≥ 10 ADR (10), mỗi ADR có Bối cảnh / Quyết định / Hệ quả / Trạng thái và mã D-xx
- ✓ Sitemap đủ 30 module (Admin) và portal USER
- ✓ Lint + link check + Mermaid check pass

## 2026-11-20 — Phase 1 / Prompt 1.1 — nhánh `phase-1`

Môi trường: Linux (container cloud), GNU Make 4.x, bash, git.

| Bộ test | Lệnh | Kết quả |
|---|---|---|
| Danh sách lệnh | `make help` | PASS: in 10 target |
| Cấu trúc repo (dương tính) | `make structure` | PASS: exit 0, đủ 22 thư mục + 18 file bắt buộc |
| Cấu trúc repo (âm tính) | bản sao repo, xóa `LICENSE` + track `apps/web/.env` → `bash scripts/check-structure.sh` | PASS: exit 1, báo đúng 2 lỗi (thiếu LICENSE, .env bị track) |
| Git | `git log --oneline` / `git status` | PASS: 2 commit trên `main`, nhánh `phase-1` tạo từ đó; working tree sạch |
| Target chưa hiện thực | `make setup` … | In "chưa hiện thực — Prompt 1.x" (đúng thiết kế) |

**Chưa kiểm:** `scripts/dev.ps1` trên Windows thật (môi trường hiện tại là Linux) — cần chạy thử trên máy Windows có WSL2.
**Test bị bỏ qua:** không.

### Acceptance Prompt 1.1

- ✓ Repo Git local, nhánh `phase-1`, working tree sạch
- ✓ 8 file kế hoạch ở gốc + `CLAUDE.md` + `README.md`
- ✓ `scripts/check-structure.sh` exit 0 (và exit 1 khi thiếu)
- ✓ `PHASE_STATUS.md` cập nhật
