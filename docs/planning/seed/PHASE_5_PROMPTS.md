# Phase 5 — Website / Nginx / PHP / SSL / DNS: prompt chi tiết

> Viết ngày 2026-11-21, sau khi người dùng duyệt Phase 4 ("ok, lên kế hoạch và làm Phase 5"). Nguồn: `ROADMAP.md` (Phase 5 + "DNS provider API (Cloudflare) đưa vào đây"), `docs/planning/11-ROADMAP.md` §Phase 5, `12-PHASE-PROMPTS.md` (5.1–5.4), `07-HOSTING-ISOLATION.md` §5–7, `06-AGENT-SECURITY.md`, `contracts/agent-ops/catalog.json`, `database/schema/itso.dbml`.
> Nhánh `phase-5`. Làm hàng loạt 5.1 → 5.6, tự merge local, DỪNG trước Phase 6. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.

## Mục tiêu Phase 5

Tạo và phục vụ website PHP/static/proxy có HTTPS cho account hosting: recipe Nginx/PHP + bước cài stack trong wizard; bố cục thư mục site theo 07 §5; vhost Nginx sinh từ template có kiểm `nginx -t` và tự hoàn tác; PHP-FPM master riêng cho từng account (D-12) với pool cho từng site; chứng chỉ ACME (lego, HTTP-01) + gia hạn tự động + tải chứng chỉ riêng; domain/alias/redirect; trang tạm khóa; xem log; DNS qua Cloudflare API. Nối các trang Website, PHP, Nginx, SSL, DNS đã có ở bản demo vào API thật.

## Ràng buộc môi trường

- Như Phase 4: container không có systemd/KVM. Mọi op mới đi qua lớp nền tảng (D-63), test bằng runner giả + gốc FS tạm (golden argv/file). Chế độ `--sandbox` mô phỏng `nginx -t`, `lego`, `php-fpm`.
- Không gọi Let's Encrypt/Cloudflare thật từ test: Laravel dùng `Http::fake`; ACME thật thử bằng Pebble trên VM/CI (job CI viết sẵn, chạy khi có remote). Tiêu chí cần máy thật ghi **chờ VM**.

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-67 | Vhost Nginx | File `/etc/nginx/sites-enabled/itso-<website_uuid>.conf` sinh từ template Go (`text/template`, chỉ nhận giá trị đã validate, không có ô cấu hình tự do; `custom_snippet` DEFERRED). Áp dụng: ghi bản mới cạnh bản cũ → `nginx -t` → lỗi thì khôi phục bản cũ (hoặc xóa nếu site mới) và trả `config_test_failed`, không reload → đúng thì `systemctl reload nginx`. Mọi vhost có `disable_symlinks if_not_owner`, log về `sites/<domain>/logs/`, location `/.well-known/acme-challenge/` trỏ webroot chung. Suspend = cùng op với `suspended: true` (trả trang tạm khóa), không có op riêng | Một vhost lỗi không làm hỏng site khác; không có đường chèn cấu hình |
| D-68 | PHP-FPM | Master riêng mỗi account mỗi phiên bản: unit template `itso-php@<ver>-<user>.service`, master chạy **dưới uid account** (07 §6), cấu hình `/etc/itso/php/<ver>/<user>/`; mỗi website một pool (`<user>-<8 hex đầu website_uuid>`), socket `/run/itso/php/<user>-<hex8>.sock` (ACL www-data), `pm=ondemand`, `php_admin_value` (open_basedir = thư mục site + tmp, upload_tmp_dir, session.save_path, disable_functions) — user không ghi đè được. Phase 5 chỉ hỗ trợ PHP **8.3 từ kho Ubuntu 24.04**; phiên bản khác cần PPA → trả `precondition_failed`, để Phase 10 (software mở rộng) | Áp cgroup theo account (D-12); không thêm nguồn apt bên thứ ba khi chưa duyệt |
| D-69 | Chứng chỉ | ACME bằng binary `lego` (gói Ubuntu) do agent chạy qua Runner, HTTP-01 webroot `/var/lib/itso/acme/webroot`; khóa tài khoản ACME do agent giữ trên máy (`/etc/itso/acme/`, root 0600) — bảng `acme_accounts` chỉ lưu email, directory, `key_location='agent'` (cột `key_encrypted` thành nullable); gia hạn `itso:certs-renew` hằng ngày khi còn < 30 ngày; tải chứng chỉ riêng: khóa riêng lưu mã hóa trong DB, job chỉ mang **tham chiếu bí mật** (`{"$secret": "cert_key:<uuid>"}`) được JobRunner thay giá trị ngay trước khi gọi agent, không ghi vào `job_steps` | Không đưa khóa riêng vào log/job; dùng công cụ ACME có sẵn trong kho Ubuntu |
| D-70 | DNS | Provider Cloudflare gọi từ Laravel bằng HTTP client (không qua agent, base URL cố định `https://api.cloudflare.com/client/v4`), API token mã hóa trong `dns_providers.credentials_encrypted`; thay đổi record ghi lên Cloudflare trước rồi mới lưu DB (ghi thất bại → không đổi DB); đồng bộ zone/record bằng lệnh `itso:dns-sync`. Chỉ Admin realm; ADMIN theo phạm vi account gắn với zone | Phase 5 theo ROADMAP gốc; không cần quyền root |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 5.1 | ADR vhost/PHP-FPM/ACME/DNS (D-67…D-70); contracts: op còn thiếu (`fs.site_layout.ensure`, `nginx.vhost.inspect`, `php.version.remove`, `php.ext.install`, `cert.inspect`, `log.tail`), sửa op đã đặc tả theo ADR, recipe `nginx`/`php8.3`/`lego`; OpenAPI bổ sung (DNS provider, redirect, nginx global, PHP Manager, wizard bước stack); DBML (`acme_accounts.key_location`) + migration Phase 5 | 0,5 ngày |
| 5.2 | Agent: template vhost + `nginx -t` + rollback, site layout, PHP pool/version/ext, cert issue/install/inspect/remove (lego), log.tail; golden test; sandbox mô phỏng; mock agent cập nhật | 1 ngày |
| 5.3 | Panel: websites (admin + portal), domains/alias/redirect, job tạo site (layout → pool → vhost), sửa nginx/php của site, xóa sạch cấu hình, suspend account → vhost trang tạm khóa, PHP Manager, Nginx global, log; quota website/domain theo gói; wizard bước stack | 1 ngày |
| 5.4 | SSL + DNS: ACME account, cấp/gia hạn/xóa chứng chỉ, tải chứng chỉ riêng (tham chiếu bí mật), `itso:certs-renew`; DNS provider Cloudflare, zones, records, `itso:dns-sync`; CI job Pebble | 1 ngày |
| 5.5 | UI: trang Website (list/detail tabs), PHP Manager, Nginx global, SSL, DNS, wizard bước stack dùng API thật; MSW cập nhật theo contract mới | 1 ngày |
| 5.6 | Tích hợp: e2e stack thật + agent sandbox (tạo site, domain, SSL, suspend, xóa), script VM Phase 5 (20 site, `nginx -t` lỗi → rollback, cách ly PHP 2 account, phpinfo đúng uid, Pebble), `make check`, báo cáo, runbook, merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p5)`, `test(p5)`, `docs(p5)`; đồng bộ bản sao lưu.

---

## Prompt 5.1 — ADR và contracts

```
[ITSO Panel] Prompt 5.1 — ADR website/PHP/ACME/DNS, contracts Phase 5, migration
Phạm vi: docs/adr/0014-vhost-nginx.md (D-67), 0015-php-fpm-per-account.md (D-68), 0016-acme-lego.md (D-69),
0017-dns-cloudflare.md (D-70). Contracts agent-ops: thêm fs.site_layout.ensure, nginx.vhost.inspect,
php.version.remove, php.ext.install (allowlist), cert.inspect, log.tail (access|error, ≤ 500 dòng); sửa
nginx.vhost.apply (type php|static|proxy, proxy_upstream 127.0.0.1:port, redirects, aliases), php.pool.apply
(open_basedir suy ra, không nhận đường dẫn), cert.issue (bỏ acme_account_uuid → email + directory_url
allowlist), cert.install (private_key_pem bí mật), recipe enum thêm nginx, php8.3, lego; catalog phase 5 →
specified; vector độc mới (server_name wildcard/IDN sai, document_root `..`, header CRLF, upstream ngoài
loopback). OpenAPI: /dns/providers CRUD, /dns/zones (+ :sync), /websites/{id}/redirects, /websites/{id}:suspend
không có (theo account), /servers/{id}/php-versions (+ :install/:remove, extensions), /servers/{id}/nginx,
/admin/setup/stack (bước 4 wizard). DBML: acme_accounts.key_location, key_encrypted nullable; make db-schema,
db-verify, make db-migrations PHASE=5. make contracts → make codegen → codegen-check.
Kiểm thử: contracts-check, examples hợp lệ/không hợp lệ cho op mới, db-verify, SchemaTest Phase 5.
```

## Prompt 5.2 — Agent ops website

```
[ITSO Panel] Prompt 5.2 — Agent: vhost, site layout, PHP-FPM, chứng chỉ, log
Phạm vi: internal/ops/web*.go: fs.site_layout.ensure (07 §5: sites/<domain>/{public,logs,tmp}, chủ/quyền/ACL,
idempotent), nginx.vhost.apply/remove/inspect (template D-67 cho php/static/proxy, redirect 301, alias,
suspended, tls + hsts; ghi atomic → nginx -t → rollback; reload), nginx.global.apply (conf.d/itso-global.conf),
php.version.install/remove (8.3 từ kho, khác → precondition_failed; remove từ chối khi còn pool),
php.ext.install (allowlist gói php8.3-*), php.pool.apply/remove (unit template itso-php@, pool theo site,
socket ACL www-data, php_admin_value), cert.issue (lego --http --http.webroot, argv cố định, email/directory
allowlist), cert.install (ghi fullchain + key 0600 root), cert.inspect (đọc not_after/issuer/SAN từ file),
cert.remove, log.tail (đọc ngược file log của site, không theo symlink). Sandbox: mô phỏng nginx -t (có thể
ép lỗi bằng tên miền đặc biệt cho test), lego (cấp cert tự ký), php-fpm. Mock agent: op mới (trạng thái trong
bộ nhớ). packaging: unit itso-php@.service.
Kiểm thử: golden argv + file cho từng op (3 loại vhost, suspended, tls), nginx -t lỗi → bản cũ được khôi phục,
site mới bị xóa, không reload; idempotent; vector độc bị từ chối trước khi chạy lệnh; fuzz template input;
contracttest chung mock + agent thật.
```

## Prompt 5.3 — Panel website

```
[ITSO Panel] Prompt 5.3 — Websites API, domain, PHP Manager, Nginx global, suspend, wizard stack
Phạm vi: model Website/Domain/WebsiteSetting/PhpVersion; WebsiteService: tạo (đếm quota max_websites/
max_domains theo gói, FOR UPDATE), job website.create (fs.site_layout.ensure → php.pool.apply nếu php →
nginx.vhost.apply), sửa nginx/php của site (spec_version tăng, job website.update), domain alias/redirect
(job áp lại vhost), xóa (job website.delete: vhost.remove → pool.remove; dữ liệu site giữ trong home), log
(job đọc qua log.tail, trả trực tiếp); account suspend/unsuspend → áp lại vhost mọi site (suspended);
reconcile thêm website; /servers/{id}/php-versions (+ :install/:remove/extensions), /servers/{id}/nginx
(GET/PATCH → nginx.global.apply); Portal: websites/domains/nginx/php/logs của account mình (404 ngoài);
wizard bước 4 (cài recipe nginx, php8.3, lego qua job). Ma trận quyền mở rộng.
Kiểm thử: Pest khớp OpenAPI mọi endpoint mới (admin + portal), quota website/domain 422, job tạo/sửa/xóa
đúng thứ tự op, lỗi nginx -t → website failed + thông báo, suspend áp vhost, ma trận quyền.
```

## Prompt 5.4 — SSL và DNS

```
[ITSO Panel] Prompt 5.4 — Chứng chỉ ACME/tải lên, gia hạn, DNS Cloudflare
Phạm vi: AcmeAccount (email theo cài đặt, directory allowlist: LE prod/staging, Pebble chỉ khi
ITSO_ACME_ALLOW_PEBBLE), CertificateService: cấp (job cert.issue → nginx.vhost.apply tls), gia hạn (renew
khi < 30 ngày; itso:certs-renew hằng ngày, thất bại → thông báo + audit), tải lên (kiểm PEM, khóa khớp cert,
SAN phủ domain, khóa lưu mã hóa; job dùng {"$secret": …} — JobRunner thay giá trị khi gọi, không lưu),
xóa (cert.remove → vhost không tls); /certificates (admin + portal). DNS: provider Cloudflare (kiểm token
khi tạo), zones (liệt kê từ Cloudflare, gắn account), records CRUD ghi Cloudflare trước, itso:dns-sync;
CI: job Pebble (tests/vm/pebble) chạy cert.issue thật với agent trên runner Ubuntu.
Kiểm thử: Pest + Http::fake cho Cloudflare (lỗi 4xx/5xx không đổi DB, token sai 422), tải cert sai khóa/hết
hạn/SAN thiếu → 422, bí mật không xuất hiện trong job_steps/audit/log, renew chọn đúng cert, ma trận quyền.
```

## Prompt 5.5 — UI

```
[ITSO Panel] Prompt 5.5 — Nối UI Website/PHP/Nginx/SSL/DNS vào API thật
Phạm vi: các trang demo Phase 2 (Website list/detail 8 tab, tạo website, PHP Manager, Nginx global, SSL, DNS)
gọi API thật qua lớp realm; trạng thái job (đang tạo, lỗi nginx -t hiện thông báo dễ hiểu), quota hết →
thông báo theo gói; wizard bước 4 (stack) gọi API; Portal dùng chung trang. MSW cập nhật theo contract mới
(bản demo vẫn chạy). Chuỗi VI/EN đủ.
Kiểm thử: Vitest cho form/logic mới, Playwright demo cập nhật, axe không lỗi mới, lint/i18n xanh.
```

## Prompt 5.6 — Tích hợp và báo cáo

```
[ITSO Panel] Prompt 5.6 — e2e stack thật, VM Phase 5, báo cáo, merge
Phạm vi: Playwright stack thật + agent sandbox: tạo website PHP cho account → job xong → thêm alias →
cấp SSL (sandbox tự ký) → tạm khóa account thấy trạng thái → xóa website; Portal tạo website của mình.
tests/vm/phase5.sh: 20 site, nginx -t lỗi → rollback và site khác vẫn 200, phpinfo chạy đúng uid account,
account A không đọc được file B qua PHP (open_basedir + quyền), Pebble cấp + gia hạn, xóa site không để lại
file cấu hình; make check xanh; docs/reports/phase-5.md (tiêu chí, phần "chờ VM"); runbook
docs/runbooks/phase-5-websites.md; merge phase-5 → main (local); DỪNG trước Phase 6.
Tiêu chí nghiệm thu Phase 5 (11-ROADMAP): site PHP hiển thị phpinfo đúng uid; HTTPS hợp lệ (Pebble/LE
staging); cert renew tự động; xóa site không để lại cấu hình rác; 1 vhost lỗi không làm hỏng các site khác.
```
