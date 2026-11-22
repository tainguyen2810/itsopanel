# Phase 10 — Docker Manager, WordPress Toolkit, Software Manager: prompt chi tiết

> Viết ngày 2026-11-22, sau khi Phase 9 hoàn tất (merge `8d2a613`) và người dùng chọn "Bắt đầu Phase 10". Nguồn: `ROADMAP.md` §Phase 10, `docs/planning/09-DOCKER.md`, `docs/planning/03-MODULES.md` §17–21, `docs/planning/08-BACKUP.md` §3 (volume), `DECISIONS.md` D-18, D-38, D-68 (PHP bản khác để Phase 10), D-77…D-81 (tường lửa), D-82…D-87 (backup), `contracts/agent-ops/catalog.json` (op `docker.*`, `compose.*`, `wp.*` đang `declared`), OpenAPI `/compose-projects*`, `/registries*`, `/servers/{id}/docker/*`, `/servers/{id}/software*`, `/wordpress/sites*` (admin + portal), DBML `docker_hosts`, `registries`, `compose_projects`, `compose_revisions`, `containers`, `port_allocations`, `wordpress_sites`, `software_catalog`, `server_software`, trang demo Phase 2 (`ServerDockerPage`, `ComposePage`, `ComposeDetailPage`, `RegistriesPage`, `ServerSoftwarePage`, `WordPressPage`).
> Nhánh `phase-10`. Làm hàng loạt 10.0 → 10.8, tự merge local, DỪNG trước Phase 11. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Docker cho USER: DEFERRED (D-18/D-38). Phase 10 không có mốc phát hành (mốc kế tiếp `v0.5.0-beta` sau Phase 11).
> Mockup trước khi code: Prompt 10.0 dựng màn hình và trạng thái mới trên bản demo (MSW), chụp ảnh vào `docs/screenshots/phase-10/`.
> **Điều kiện bắt đầu:** người dùng duyệt Phase 9 và chọn bắt đầu Phase 10 (2026-11-22).

## Mục tiêu Phase 10

1. **Software Manager** đầy đủ: catalog có kiểm soát (thêm Docker, PHP 8.1/8.2/8.4, Redis/Valkey, Memcached, Node.js LTS, Composer, WP-CLI), xung đột, đang được dùng thì không gỡ, cập nhật, trạng thái dịch vụ.
2. **Docker Manager** cho SUPER_ADMIN/ADMIN: bật Docker trên server, container/image/volume/network, compose project có revision + validator, cấp cổng từ dải panel, `127.0.0.1` bind, chain `DOCKER-USER`, registry mã hóa, website loại `docker` (reverse proxy + SSL), cập nhật image có rollback, backup/restore volume.
3. **WordPress Toolkit**: WP-CLI chạy dưới UID account, phát hiện site WP, cài 1-click, cập nhật core/plugin/theme có **backup trước + tự rollback khi lỗi**, clone staging, hardening, đổi mật khẩu admin, bảo trì; Admin + Portal.

## Ràng buộc môi trường

- Như Phase 4–9: container không có systemd/KVM/**Docker**. Docker được test bằng **Docker Engine API giả** (server HTTP trên unix socket trong gốc sandbox, mô phỏng container/image/volume/network) và runner giả cho `docker compose`; validator compose test bằng YAML thật. Hành vi Docker thật + firewall: `tests/vm/phase10.sh`, kết quả **chờ VM**.
- WordPress: test Go với WP-CLI giả qua runner; e2e stack thật dùng runner sandbox. Cài WP thật + MariaDB + cập nhật lỗi → rollback: VM.
- Không chạy lệnh từ Laravel (cấm exec). Mọi thao tác máy chủ đi qua job + audit; params job không chứa bí mật (mật khẩu registry/WP admin đi qua vault của agent hoặc trường mã hóa, không vào params).

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-94 | Cài Docker | Recipe `docker` = gói Ubuntu 24.04 `docker.io` + `docker-compose-v2` (không thêm kho ngoài). Op `docker.host.configure` ghi `/etc/docker/daemon.json` (`"ip":"127.0.0.1"`, `"userland-proxy":false`, `"live-restore":true`, `log-opts` 10m×3, `"iptables":true`) rồi restart; kiểm **không user nào trong group `docker`** (có thì báo `drift`, op gỡ khỏi group). Agent nói chuyện với Docker qua **Engine API trên `/var/run/docker.sock`** (client Go tự viết, ghim API ≥ 1.43); `docker compose` chạy argv qua runner, `-p itso_<uuid>`, thư mục project `/var/lib/itso/compose/<uuid>/` root 0700 | Không phụ thuộc kho Docker Inc; socket chỉ agent chạm |
| D-95 | Docker không phá tường lửa | Agent đồng bộ chain **`DOCKER-USER`** (iptables-nft) từ `firewall_rules` có `scope=docker`: `RETURN` cho ESTABLISHED/RELATED và traffic nội bộ bridge, `ACCEPT` cổng SA mở rõ ràng, `DROP` mọi traffic từ interface public tới container. Chạy lại sau mỗi lần Docker restart (unit `itso-docker-user.service` After=docker). Bảng `inet itso` không đụng bảng Docker (giữ D-77). Test bắt buộc: publish `0.0.0.0:8080` → từ ngoài không vào được | Docker chèn NAT trước UFW/nft của panel (09 §5) |
| D-96 | Compose và validator | Validator Go trong agent là nguồn sự thật (`compose.validate`): chặn `privileged`, `cap_add` ngoài allowlist, `network_mode/pid/ipc/userns_mode: host`, `devices`, `security_opt` tắt apparmor/seccomp, bind mount tới `/`, `/etc`, `/proc`, `/sys`, `/var/run/docker.sock`, `/root`, `/home` (ADMIN), `build:` (chỉ image); viết lại `ports` thành `127.0.0.1:<cổng cấp>:<cổng container>`; thêm `cpus`/`mem_limit`/`pids_limit` mặc định nếu thiếu; nhãn `io.itso.project`. SA override từng rule (danh sách mã rule) có cảnh báo + audit; ADMIN không override. Revision bất biến, áp dụng = ghi YAML đã validate + `compose up -d --remove-orphans`; diff giữa revision ở panel | 09 §3; không có đường chạy YAML chưa qua validator |
| D-97 | Cổng và website Docker | Dải `20000–29999` mỗi server, `port_allocations` unique, panel cấp trong transaction, agent kiểm cổng trống (`/proc/net/tcp*`) trước khi apply. Cổng 80/443/22/panel không bao giờ publish. Website loại `docker`: vhost Nginx `proxy_pass http://127.0.0.1:<port>` + ACME như site thường (tái dùng Phase 5), có websocket upgrade | Không trùng cổng Nginx; ra ngoài chỉ qua Nginx + SSL |
| D-98 | Image và volume | Cập nhật image: pull theo tag → so digest → nếu mới: tag image cũ `itso-rollback/<project>-<service>:<ts>` → recreate → health (container `running` + healthcheck nếu có, 60 giây) → lỗi thì tự quay về image cũ; giữ 2 bản rollback. Registry: mật khẩu mã hóa ở DB (Laravel `Crypt`), gửi agent qua trường `secret_ref` của vault agent một lần khi lưu/đổi, không vào params job. Volume backup: phạm vi mới `docker_volume` trong policy Phase 8; mặc định **dừng tạm (pause) container dùng volume** trong lúc snapshot (tùy chọn `consistency: pause\|none`), restic backup `/var/lib/docker/volumes/<name>/_data`; restore vào volume mới hoặc ghi đè khi container đã dừng | Rollback được; backup nhất quán (08 §3) |
| D-99 | WordPress Toolkit | WP-CLI phar ghim phiên bản + sha512 (`/usr/local/lib/itso/wp-cli-<ver>.phar`, recipe `wp-cli`), chạy `php<ver-của-site> wp-cli.phar --path=<docroot> --skip-plugins --skip-themes` (trừ lệnh cần) dưới **UID account trong slice account**, op typed `wp.*` (không có `wp.cli` tự do; subcommand allowlist trong agent). Cập nhật: snapshot restic (file site + DB, tái dùng `backup.run` Phase 8, tag `pre-wp-update`) → bật maintenance → update → `wp core verify-checksums` + `http.check` (200, không có chuỗi lỗi PHP fatal) → lỗi thì **restore snapshot** (file + DB) và báo `rolled_back`. Clone staging: website mới `staging.<domain>` (hoặc tên chọn), copy file + DB mới, `search-replace` URL, `noindex`, có basic auth tùy chọn; đẩy staging → production: DEFERRED. Hardening: tắt file edit (`DISALLOW_FILE_EDIT`), chặn `xmlrpc.php` và PHP trong `uploads/` ở vhost Nginx, `wp-config.php` 0400, khóa salt mới, ẩn version. Lỗ hổng plugin: DEFERRED (cần chọn nguồn dữ liệu) | Cập nhật lỗi không làm sập site; USER không có shell WP-CLI tự do |
| D-100 | Software Manager | Catalog ở agent (recipe → gói, kho, dịch vụ, xung đột, phụ thuộc) là nguồn sự thật; panel seed `software_catalog` từ `software.catalog`. PHP 8.1/8.2/8.4: kho **PPA ondrej/php** với khóa ký ghim fingerprint trong agent, chỉ bật khi SA cài bản PHP đó (kho apt `signed-by` riêng, không đụng nguồn khác). Thêm: `redis` (Ubuntu), `valkey` (xung đột `redis`), `memcached`, `nodejs` (Ubuntu 24.04, cho app Docker/Git build), `composer`, `wp-cli`, `docker`. Gỡ bị chặn khi đang dùng (PHP có site/pool, Docker có project, Redis có site dùng); `software.upgrade` = `apt-get install --only-upgrade` theo recipe. Cập nhật bảo mật OS (unattended-upgrades) bật/tắt, không tự reboot | 03 §17, D-68 |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code; mọi thay đổi máy chủ đi qua job + audit; params job không chứa bí mật; thao tác dữ liệu account chạy dưới uid account; USER không có đường nào tới Docker.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 10.0 | **Mockup:** Software (catalog dạng app store, xung đột, đang dùng, cập nhật, PHP nhiều bản), Docker server (bật Docker, kiểm tra daemon, container/image/volume/network, log, stats), compose (tạo từ YAML/template, kết quả validator, override SA, revision + diff, cổng cấp), registry, website loại Docker, cập nhật image + rollback, backup volume; WordPress (danh sách, cài, cập nhật có backup trước, rollback, staging, hardening, đổi mật khẩu admin) Admin + Portal; ảnh `docs/screenshots/phase-10/` | 0,5 ngày |
| 10.1 | ADR 0039–0045 (D-94…D-100); contracts agent-ops (`software.catalog\|upgrade\|status`, `docker.host.*`, `docker.container.*`, `docker.image.*`, `docker.volume.*`, `docker.network.*`, `docker.firewall.sync`, `compose.*`, `wp.*`); OpenAPI rà lại; DBML + migration Phase 10 | 0,5 ngày |
| 10.2 | Software Manager: agent (catalog, kho PPA ghim khóa, PHP nhiều bản + pool theo bản, upgrade, status, unattended-upgrades), panel (seed catalog, cài/gỡ/cập nhật, chặn khi đang dùng, chọn PHP version cho site), Pest + Go | 1 ngày |
| 10.3 | Agent Docker: client Engine API + fake Engine, `docker.host.configure\|status`, container/image/volume/network, log stream qua gateway, stats, `DOCKER-USER`, validator compose + `compose.*`, cập nhật image có rollback, backup/restore volume; Go test + fuzz validator | 1,5 ngày |
| 10.4 | Panel Docker: bật Docker trên server, compose project + revision + diff, cấp cổng, registry mã hóa, cache container, website loại `docker`, cập nhật image, phạm vi backup `docker_volume`, quyền (SA/AD, USER bị chặn) + audit; Pest | 1,5 ngày |
| 10.5 | Agent WordPress: WP-CLI ghim, `wp.detect\|info\|install\|update\|clone\|harden\|admin_password\|maintenance`, rollback bằng snapshot, chạy dưới UID account; Go test | 1 ngày |
| 10.6 | Panel WordPress: Admin + Portal, `wordpress_sites` + `wordpress_components`, quét phát hiện, chính sách tự cập nhật (lịch), lịch sử cập nhật, quyền + audit; Pest | 1 ngày |
| 10.7 | UI nối API thật theo mockup 10.0, MSW theo hành vi mới, i18n vi/en | 1 ngày |
| 10.8 | Tích hợp: e2e stack thật, `tests/vm/phase10.sh`, review bảo mật Docker/WordPress, `make check`, báo cáo, merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p10)`, `test(p10)`, `docs(p10)`; đồng bộ bản sao lưu.

## Prompt 10.0 — Mockup

```
[ITSO Panel] Prompt 10.0 — Mockup Docker, WordPress, Software (trước khi code)
Phạm vi: chỉ bản demo (apps/web + src/demo + contracts/tools/demo.py), không đụng API/agent.
Màn hình và trạng thái:
- Server › Phần mềm: catalog theo nhóm (Web, PHP, Database, Cache, Runtime, Bảo mật, Docker), trạng thái (đã cài,
  phiên bản, có bản cập nhật, dịch vụ chạy/dừng), xung đột (Redis ↔ Valkey), gỡ bị chặn kèm lý do (đang có 4 site dùng
  PHP 8.2), cài PHP 8.4 (kho PPA ghim khóa), cập nhật bảo mật OS bật/tắt.
- Server › Docker: chưa bật (nút cài + cấu hình daemon) → đã bật (phiên bản, daemon.json an toàn, cảnh báo user trong
  group docker, DOCKER-USER đồng bộ lúc …); tab Container (trạng thái, cổng 127.0.0.1, CPU/RAM, log, start/stop/restart),
  Image (dung lượng, có bản mới, prune), Volume (dung lượng, đang dùng bởi), Network.
- Compose: danh sách project; tạo từ YAML/template (Uptime Kuma, n8n, MinIO, WordPress); kết quả validator (lỗi chặn,
  cảnh báo, dòng đã viết lại ports/limits); SA override rule kèm lý do; revision + diff; cổng được cấp; cập nhật image
  (digest cũ → mới, rollback tự động khi health lỗi); gắn website loại Docker (domain → 127.0.0.1:20031 + SSL).
- Registry: thêm (mật khẩu chỉ ghi), kiểm tra đăng nhập.
- Backup: phạm vi "Docker volume" trong policy, khôi phục volume.
- WordPress (Admin + Portal): danh sách site (phiên bản core, plugin/theme cần cập nhật, hardening, tự cập nhật),
  cài mới trên website, cập nhật (tiến trình: snapshot → bảo trì → cập nhật → kiểm tra → xong | đã rollback),
  staging clone, hardening từng mục, đổi mật khẩu admin, lịch sử cập nhật.
Chụp: e2e/screenshots-phase10.spec.ts, make screenshots → docs/screenshots/phase-10.
Kiểm thử: Vitest/Playwright demo + axe xanh; i18n vi = en; check_demo.py.
```

## Prompt 10.1 — ADR và contracts

```
[ITSO Panel] Prompt 10.1 — ADR Docker/WordPress/Software, contracts Phase 10, migration
Phạm vi: docs/adr/0039-docker-engine.md (D-94), 0040-docker-firewall.md (D-95), 0041-compose-validator.md (D-96),
0042-docker-ports-sites.md (D-97), 0043-docker-images-volumes.md (D-98), 0044-wordpress-toolkit.md (D-99),
0045-software-manager.md (D-100).
Contracts agent-ops: software.catalog / software.upgrade / software.status / os.auto_updates; docker.host.configure /
docker.host.status; docker.container.list|inspect|control|logs|stats; docker.image.list|pull|prune|update|rollback;
docker.volume.list|create|remove|backup|restore; docker.network.list|create|remove; docker.firewall.sync;
compose.validate|apply|up|down|pull|remove (viết lại theo D-96); wp.detect|info|install|update|clone|harden|
admin_password|maintenance. Lỗi mới: compose_rejected, port_unavailable, in_use, docker_unavailable,
wp_update_failed. Vector độc: YAML privileged/host network/bind /, tên project/volume/image lạ, đường dẫn WP ngoài home.
OpenAPI rà lại: docker hosts (:enable), containers/images/volumes/networks, compose-projects (+ revisions, diff,
:apply/:update-images/:rollback), registries (:test), port-allocations, websites type docker, software (+ :upgrade,
auto-updates), wordpress sites (admin + portal: install, update, clone-staging, harden, admin-password, maintenance,
updates history). DBML: docker_hosts, compose_projects/revisions (override, report), containers, port_allocations,
image_rollbacks, wordpress_sites/components/updates, server_software (upgrade_available), backup scope docker_volume;
migration Phase 10; make db-verify. make contracts, make codegen, codegen-check xanh.
```

## Prompt 10.2 — Software Manager

```
[ITSO Panel] Prompt 10.2 — Software catalog, PHP nhiều bản, upgrade
Phạm vi: agent: catalog (recipe → gói, kho, dịch vụ, xung đột, phụ thuộc, core), kho PPA ondrej/php (khóa ghim
fingerprint, signed-by riêng), php8.1/8.2/8.4 + itso-php@<ver>-<user> theo bản, redis/valkey/memcached/nodejs/
composer/wp-cli/docker, software.upgrade/status, os.auto_updates. Panel: seed catalog từ agent, cài/gỡ/cập nhật
(job + audit), chặn gỡ khi đang dùng (PHP có site, Docker có project, cache có site), chọn PHP version cho website
(gói cho phép), trạng thái dịch vụ.
Test: Go (xung đột bị chặn, kho chỉ thêm khi cài PHP bản PPA, khóa sai fingerprint bị từ chối, idempotent), Pest
(gỡ khi đang dùng bị chặn, ma trận quyền), vector độc recipe.
```

## Prompt 10.3 — Agent Docker

```
[ITSO Panel] Prompt 10.3 — Docker Engine client, validator compose, DOCKER-USER, image/volume
Phạm vi: agent/internal/docker (client Engine API qua unix socket, timeout, giới hạn kích thước; fake Engine cho
sandbox/test), docker.host.configure|status (daemon.json, group docker), container/image/volume/network ops, log
stream qua gateway (ticket, như terminal), stats, docker.firewall.sync (DOCKER-USER), agent/internal/compose
(validator + viết lại ports/limits, override theo mã rule), compose.apply|up|down|pull|remove (argv, -p itso_<uuid>),
docker.image.update (digest, tag rollback, health, tự quay về), docker.volume.backup|restore (pause, restic).
Test Go: validator (bảng vector chặn/viết lại, fuzz YAML), cổng trùng → port_unavailable, image update lỗi health →
rollback, volume đang dùng không xóa được, DOCKER-USER đúng thứ tự rule, policy tắt docker.* thì op bị từ chối.
```

## Prompt 10.4 — Panel Docker

```
[ITSO Panel] Prompt 10.4 — Docker hosts, compose, cổng, registry, website Docker
Phạm vi: POST /admin/servers/{id}/docker:enable (cài recipe docker + configure, step-up), danh sách container/image/
volume/network (cache containers, làm mới theo job đọc), compose-projects CRUD + revision + diff + :apply (validate
trước, lưu report, override chỉ SA + lý do), cấp cổng (port_allocations, transaction), :update-images / :rollback,
registries (mật khẩu Crypt, :test), website loại docker (vhost proxy + SSL), firewall rule scope=docker → docker.
firewall.sync, policy backup phạm vi docker_volume + khôi phục volume. Quyền: SA toàn bộ; ADMIN trên server được giao,
không override; USER/Portal không có route nào. Audit mọi thao tác.
Test Pest: validator chặn → không apply, override bởi ADMIN bị từ chối, cổng không trùng khi 2 project tạo song song,
xóa project trả cổng, registry không lộ mật khẩu ở API/job params, USER bị 403/404 mọi route docker.
```

## Prompt 10.5 — Agent WordPress

```
[ITSO Panel] Prompt 10.5 — wp.* dưới UID account
Phạm vi: recipe wp-cli (phar ghim sha512), wp.detect (quét docroot các site của account), wp.info (core, plugin,
theme, bản cập nhật), wp.install (DB tạo trước bởi db.*, mật khẩu admin qua stdin), wp.update (snapshot restic
pre-wp-update → maintenance → update → verify-checksums + http.check → rollback khi lỗi), wp.clone (site staging, copy
file + DB, search-replace, noindex), wp.harden (DISALLOW_FILE_EDIT, salt mới, quyền file, cờ vhost chặn xmlrpc +
PHP trong uploads), wp.admin_password, wp.maintenance. Mọi lệnh chạy php<ver> wp-cli.phar dưới uid account trong
slice; không subcommand tự do; đường dẫn chỉ trong home account (chặn symlink).
Test Go: update lỗi → restore snapshot (file + DB), đường dẫn ngoài home/symlink bị chặn, mật khẩu không xuất hiện
trong argv/log, clone không ghi đè site có sẵn.
```

## Prompt 10.6 — Panel WordPress

```
[ITSO Panel] Prompt 10.6 — WordPress Toolkit Admin + Portal
Phạm vi: GET/POST admin + portal wordpress/sites (quét, cài trên website, cập nhật chọn thành phần, clone staging,
harden, admin-password (step-up), maintenance), wordpress_sites + wordpress_components + wordpress_updates (lịch sử,
snapshot id, kết quả), chính sách tự cập nhật (none|minor|all, cửa sổ giờ, lịch qua scheduler), thông báo khi
rollback, quota backup tính snapshot pre-update. Quyền: USER chỉ site của account mình; ADMIN theo phạm vi.
Test Pest: USER không thấy/không thao tác site account khác, cập nhật lỗi → trạng thái rolled_back + thông báo,
clone vượt giới hạn website của gói bị chặn, lịch tự cập nhật đúng cửa sổ.
```

## Prompt 10.7 — UI

```
[ITSO Panel] Prompt 10.7 — UI Docker/WordPress/Software nối API thật
Phạm vi: theo mockup 10.0: Software, Docker server, compose (validator, revision/diff, cổng, update/rollback),
registry, website Docker, backup volume, WordPress Admin + Portal; MSW theo hành vi mới; i18n vi/en.
Test: Vitest + Playwright demo + axe.
```

## Prompt 10.8 — Tích hợp và báo cáo

```
[ITSO Panel] Prompt 10.8 — e2e, VM Phase 10, review bảo mật, merge, DỪNG
Phạm vi: apps/web/e2e-real/phase10.spec.ts (cài PHP 8.2 → đổi PHP site; gỡ PHP đang dùng bị chặn; bật Docker trên
server sandbox → tạo compose từ template → validator chặn privileged → sửa → apply → cổng cấp → website Docker + SSL →
cập nhật image lỗi → rollback; registry; backup volume; WordPress: cài trên site → cập nhật lỗi → rolled_back →
clone staging → harden; USER không thấy Docker), tests/vm/phase10.sh (V0 cài Docker, daemon.json, không ai trong
group docker; V1 publish 0.0.0.0:8080 → từ máy ngoài bị chặn, mở trong panel → vào được; V2 compose thật + website
Docker + SSL; V3 image update lỗi → rollback; V4 volume backup/restore nhất quán; V5 WordPress thật: cài, cập nhật
lỗi giả lập → rollback, staging, harden; V6 PHP 8.1/8.2/8.4 song song), docs/security/docker-wordpress-review.md,
make check, docs/reports/phase-10.md, merge --no-ff main, DỪNG.
```

## Tiêu chí nghiệm thu (ROADMAP §Phase 10)

| Tiêu chí | Cách chứng minh |
|---|---|
| Container publish `0.0.0.0` không lộ ra ngoài nếu chưa mở trong panel | Go (DOCKER-USER, daemon.json) · **VM V1** |
| USER không có đường nào tới Docker | Pest (mọi route) · review quyền socket/group · e2e |
| WordPress cập nhật lỗi thì rollback được | Go + Pest + e2e · **VM V5** |
| Compose không qua validator thì không chạy | Go (vector + fuzz) · Pest · e2e |
| Cập nhật image lỗi thì quay về image cũ | Go · e2e · **VM V3** |
| PHP nhiều bản song song | Go · e2e · **VM V6** |

## Rủi ro

- Docker Engine bản Ubuntu chậm hơn bản Docker Inc → chấp nhận cho nội bộ; ghi chú trong ADR, đánh giá lại ở Phase 12.
- `DOCKER-USER` dùng iptables-nft, tồn tại song song bảng `inet itso` → test thứ tự rule trên VM, không flush bảng của Docker.
- PPA ondrej là kho bên thứ ba → ghim khóa, chỉ bật khi cần, có thể gỡ kho khi không còn PHP bản PPA.
- WP-CLI chạy plugin của khách khi update → dùng `--skip-plugins` ở lệnh đọc, chạy dưới uid account trong slice có giới hạn; snapshot trước update.
- Fake Engine API khác Docker thật → hợp đồng client ghim theo tài liệu API 1.43, xác minh trên VM V0–V4.
