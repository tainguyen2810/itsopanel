# DECISIONS — ITSO Panel

> **Bảng trạng thái hiện hành theo phạm vi nội bộ chốt ngày 2026-11-20 ("FINAL PROJECT SCOPE UPDATE").** Lịch sử bên dưới được giữ nguyên, không xóa.
> Trạng thái: **APPROVED**/**Accepted** (đã duyệt) · **Proposed** (chờ duyệt) · **DEFERRED** (hoãn, có thể làm lại sau) · **OUT OF SCOPE** (không làm trong phạm vi hiện tại) · **Superseded**.

## Bảng trạng thái hiện hành

| ID | Quyết định (nội dung hiện hành) | Trạng thái |
|---|---|---|
| D-01 | Panel chạy runtime riêng FrankenPHP (Laravel Octane), không phụ thuộc PHP/Nginx của hosting | Proposed |
| D-02 | PostgreSQL panel dùng cluster riêng `itso` | Proposed |
| D-03 | Redis panel dùng instance riêng | Proposed |
| D-04 | Giữ stack React/TS/Vite/Tailwind/shadcn + Laravel + PostgreSQL + Redis + Go | **APPROVED** (2026-11-20, khi bắt đầu Phase 1) |
| D-05 | Thư viện frontend bổ sung (TanStack Router/Table, i18next, RHF+zod, xterm.js, CodeMirror, MSW) | **APPROVED** (2026-11-20, khi bắt đầu Phase 1) |
| D-06 | CLI `itso` viết bằng Go | Proposed |
| D-07 | `itso-gateway` (Go) cho realtime | Proposed |
| D-08 | Nginx từ repo nginx.org stable | Proposed |
| D-09 | MariaDB mặc định, MySQL tùy chọn, không cài song song | Proposed |
| D-10 | nftables trực tiếp, không UFW; có egress per UID | Proposed |
| D-11 | DNS qua provider API (Cloudflare) ở Phase 5; DNS server riêng (PowerDNS) DEFERRED | Proposed |
| D-12 | PHP-FPM master riêng cho mỗi account | Proposed |
| D-13 | Agent root + systemd hardening + policy cục bộ; đánh giá tách helper ở Phase 12 | Proposed |
| D-14 | Contracts-first (OpenAPI + JSON Schema, codegen) | **APPROVED** (2026-11-20, khi bắt đầu Phase 1) |
| D-15 | Mốc: v0.1.0-alpha sau Phase 8 (1 server, nội bộ) · v0.5.0-beta sau Phase 11 (multi-server) · v1.0.0 sau Phase 12 (Production Gate) | Proposed (đã sửa theo phạm vi nội bộ) |
| D-16 | SFTP mặc định; FTPS tùy chọn; tắt FTP thuần | Proposed |
| D-17 | Không làm email server; chặn port 25 với UID hosting; tắt `mail()` mặc định | Proposed |
| D-18 | Docker Manager chỉ cho SUPER_ADMIN/ADMIN; USER không có Docker. Docker Hosting cho USER: **DEFERRED** | Proposed |
| D-19 | Backup immutable (rest-server append-only / S3 Object Lock); panel không giữ quyền xóa | Proposed |
| D-20 | Phát hành tarball có chữ ký minisign; `.deb` sau | Proposed |
| D-21 | SSH/Terminal cho USER mặc định tắt; khi bật thì chạy trong jail, nằm trong slice của account | Proposed |
| D-22 | Dev trên Windows qua WSL2; Docker Compose chỉ dùng cho dev | **APPROVED** (2026-11-20, khi bắt đầu Phase 1) |
| D-23 | Mỗi hosting account có repo restic riêng | Proposed |
| D-24 | Admin tạo tay → Superseded bởi D-32 → nay **quay lại hiệu lực**: Super Admin cấp hosting thủ công qua Admin Panel | **APPROVED** (2026-11-20) |
| D-25 | Tách **Private Admin Panel** (IP allowlist/VPN, MFA bắt buộc) và **User Hosting Portal** (public, có auth/MFA/rate limit/CAPTCHA/WAF) | **APPROVED** (2026-11-20) |
| D-26 | Vai trò: SUPER_ADMIN, ADMIN, USER. SUPPORT, sub-user, BILLING_OPERATOR: DEFERRED | Proposed |
| D-27 | Thực thể Customer / Hosting Service / Subscription | **DEFERRED** |
| D-28 | Tách server công ty và server khách | **OUT OF SCOPE** (không có khách bên ngoài) |
| D-29 | Sandbox systemd cho mọi unit của account | Proposed |
| D-30 | Branding: một brand ITSO, logo/màu cấu hình trong Settings; white-label theo đại lý DEFERRED | Proposed |
| D-31 | Bảo vệ dữ liệu cá nhân (bản nội bộ): audit truy cập của nhân viên, impersonate có lý do, quy trình xóa có biên bản | Proposed |
| D-32 | Public Provisioning API | **DEFERRED** (giữ Hosting Provisioning Service nội bộ và đường dẫn `/api/provisioning/*` giữ chỗ) |
| D-33 | Billing Adapter | **OUT OF SCOPE** |
| D-34 | Adapter WooCommerce / WooCommerce Subscriptions | **OUT OF SCOPE** |
| D-35 | Billing giữ tiền và ngày đến hạn | **OUT OF SCOPE** |
| D-36 | Mốc quá hạn thanh toán (grace/suspend/terminate) | **OUT OF SCOPE** → thay bằng D-46 |
| D-37 | HMAC cho Provisioning API | **DEFERRED** |
| D-38 | Docker Hosting trên VM theo khách | **DEFERRED** |
| D-39 | Paid Customer Gate | **Superseded** bởi D-47 (Production Gate nội bộ) |
| D-40 | Tách danh tính admin/portal → sửa thành **một bảng `users` có `realm` bất biến** + hai guard | Proposed |
| D-41 | Topology: mặc định all-in-one; node join từ Phase 9; control plane máy riêng là **tùy chọn** | Proposed |
| D-42 | Placement Engine tự động → sửa thành **gợi ý server**, Super Admin quyết định | Proposed |
| D-43 | Package có version bất biến | Proposed |
| D-44 | Một hosting account nằm trên một server | Proposed |
| D-45 | Dải UID 20000–59999 trên mỗi server, không tái dùng UID trong 90 ngày | Proposed |
| D-46 | Vòng đời account: suspend/unsuspend thủ công có lý do; terminate → **giữ dữ liệu 30 ngày** → purge. **Trước purge bắt buộc:** cảnh báo (người dùng + admin, nhắc tại T-7, T-1), audit log mọi bước, **kiểm tra có backup cuối cùng hợp lệ** (`restic check` + restore thử vào sandbox) và vẫn khôi phục được cho tới lúc purge; purge 2 bước có biên bản; có legal hold | **APPROVED** (2026-11-20) |
| D-47 | Production Gate G1–G8 (isolation, quota, priv-esc, backup/restore, upgrade, DR, migration, uninstall) trước v1.0.0. **Mỗi bài có tiêu chí nghiệm thu đo được và bằng chứng kiểm thử** (lệnh, log, kết quả, screenshot) lưu trong `docs/gate/G<n>.md` | **APPROVED** (2026-11-20) |
| D-48 | Chuyển Hosting Account giữa các server (Phase 9): **website, database, SSL, cron, cấu hình (nginx/php/sftp), ownership/UID**, **kiểm tra dữ liệu** (checksum file, row count + checksum bảng, HTTP check) và **rollback** | **APPROVED** (2026-11-20) |
| D-49 | Hosting Provisioning Service dùng chung cho Admin Panel và CLI; **chưa mở API công khai** | **APPROVED** (2026-11-20) |
| D-50 | Pentest độc lập **không bắt buộc** cho Alpha nội bộ. **Bắt buộc** pentest độc lập và khắc phục mọi lỗ hổng nghiêm trọng (High/Critical) **trước khi mở bán hosting cho khách hàng bên ngoài** | **APPROVED** (2026-11-20) |
| D-51 | **Mới:** Không bắt buộc GitHub trước khi bắt đầu. Phase 1 khởi tạo **Git local**, sau đó kết nối GitHub. 2026-11-22: đã kết nối `github.com/tainguyen2810/itsopanel` (remote `github`) theo yêu cầu người dùng | **APPROVED** (2026-11-20) |
| D-52 | **Mới:** Phase 1 = Foundation + Architecture + Database (schema spec) + API Contracts + **Design System**; Phase 2 = demo UI hoàn chỉnh Admin Panel + User Hosting Portal | **APPROVED** (2026-11-20) |
| D-53 | Giữ installer giống aaPanel (một lệnh, native Ubuntu, Web Wizard, systemd, CLI `itso`, không bắt buộc Docker) và toàn bộ yêu cầu bảo mật, cách ly, backup immutable, quota thực, multi-server | **APPROVED** (2026-11-20) |
| D-54 | Design token lấy `design/tokens/tokens.json` làm nguồn; "preset" Tailwind v4 là khối `@theme inline` sinh ra (Tailwind 4 bỏ preset JS); Light mặc định ở `:root`, Dark bằng class `.dark`; mọi cặp màu khai báo phải đạt WCAG AA | **APPROVED** (2026-11-20, duyệt cùng Phase 1) |
| D-55 | Codegen từ contracts: TS bằng openapi-typescript + openapi-fetch (`apps/web/src/api/generated`), Go structs bằng generator Python trong `contracts/tools` (không thêm tool ngoài). File sinh được commit và kiểm bằng `make codegen-check` | **APPROVED** (2026-11-20, duyệt cùng Phase 1) |
| D-56 | **Mới (Phase 2.5):** Đặc tả sớm Git deploy (module 22) để có giao diện demo: bảng `git_repositories`, `git_deployments`; API `/git-repositories`, `/git-deployments/{id}:rollback`; op khai báo `git.deploy`, `git.rollback` (schema chi tiết ở Phase 10). Webhook công khai chưa có trong contract | **APPROVED** (2026-11-21, duyệt cùng Phase 2 khi người dùng yêu cầu tiếp Phase 4) |
| D-57 | **Mới (Phase 2.7):** Thêm `GET /hosting-accounts/{id}/features` (admin + portal, schema chung `AccountFeatures`): tập con an toàn của giới hạn gói hiện hành (phiên bản PHP, số PHP worker tối đa, SSH, khoảng cron tối thiểu, quota/retention backup) để Portal chọn PHP, biết gói có SSH mà không lộ `PackageLimits` đầy đủ (Admin-only) | **APPROVED** (2026-11-21, duyệt cùng Phase 2 khi người dùng yêu cầu tiếp Phase 4) |
| D-58 | **Mới (Phase 3):** Xác thực SPA bằng session cookie cùng origin (guard session của Laravel, bảng `sessions` theo DBML có `realm`, `mfa_verified_at`) + CSRF double-submit (`/auth/csrf`, header `X-XSRF-TOKEN`), không cài Sanctum; API token nội bộ (`api_tokens`, SHA-256, scopes, CIDR) qua guard riêng; MFA TOTP RFC 6238 tự viết (secret mã hóa bằng APP_KEY, mã khôi phục băm argon2id) | **APPROVED** (2026-11-21, duyệt cùng Phase 3 khi người dùng yêu cầu tiếp Phase 4) |
| D-59 | **Mới (Phase 3):** Pest chạy trên PostgreSQL 16 (bỏ SQLite) vì schema dùng trigger, `citext`, `inet`, `jsonb`, partial index, partition; `make test-api` cần PostgreSQL (`make services-up` hoặc cluster cục bộ) | **APPROVED** (2026-11-21, duyệt cùng Phase 3 khi người dùng yêu cầu tiếp Phase 4) |
| D-60 | **Mới (Phase 3):** Job runner = bảng `jobs`/`job_steps`/`job_logs` + `JobRunner` chạy từng bước gọi `AgentClient` qua queue Redis; test dùng queue sync + fake agent; tiến độ bằng polling `GET /jobs/{id}` và `/jobs/{id}/events?after=` (SSE để Phase 11) | **APPROVED** (2026-11-21, duyệt cùng Phase 3 khi người dùng yêu cầu tiếp Phase 4) |
| D-61 | **Mới (Phase 3):** Giả danh USER Portal bằng vé một lần: `POST /admin/users/{id}:impersonate` (chỉ SUPER_ADMIN, step-up, lý do) tạo `impersonation_sessions` (30 phút) + vé ngẫu nhiên lưu SHA-256 trong cache 60 giây; Portal đổi vé qua `POST /auth/impersonation:accept` lấy phiên portal của USER đích (cookie portal riêng, không dùng chung phiên admin), `POST /auth/impersonation:end` kết thúc. Phiên giả danh không đổi được mật khẩu/MFA/phiên; mọi audit ghi `impersonator_user_id` | **APPROVED** (2026-11-21, duyệt cùng Phase 3 khi người dùng yêu cầu tiếp Phase 4) |
| D-62 | **Mới (Phase 3):** Vòng đời account theo mô hình desired/observed: `lifecycle_state` (desired) đổi ngay khi nhận yêu cầu, kèm `spec_version++` và lifecycle event; `status` + `observed_version` (observed) đổi khi job agent xong (lỗi → `degraded` + `drift`). Riêng tạo mới: `provisioning` → `active` \| `failed` theo job. Khôi phục account đã chấm dứt trong thời gian giữ dùng `POST :unsuspend` (terminated → active, xóa `terminated_at`/`purge_after`); quá `purge_after` → 409. Một account chỉ có một job chưa xong (409 `resource_locked`). Purge (Phase 8) và chuyển server (Phase 9) trả `501` mã `purge_not_available` / `migration_not_available` (contract thêm response `NotImplemented`) | **APPROVED** (2026-11-21, duyệt cùng Phase 3 khi người dùng yêu cầu tiếp Phase 4) |
| D-63 | **Mới (Phase 4):** Lớp nền tảng agent: mọi lệnh hệ thống qua `platform.Runner` (argv cố định, binary tuyệt đối từ bảng cố định, env tối giản, cấm shell), mọi file hệ thống qua `platform.FS` (gốc cấu hình được, ghi atomic, `O_NOFOLLOW`); bản `ubuntu2404` cho máy thật, bản `fake` (ghi argv, gốc thư mục tạm) cho test và chế độ `--sandbox`. Không chọn: Agent gọi `exec.Command` rải rác; chỉ test trên VM | **APPROVED** (2026-11-21, cùng Phase 4) |
| D-64 | **Mới (Phase 4):** Giới hạn account: slice `itso-acct-<uid>.slice` (cha `itso-acct.slice` → `itso.slice`, suy ra từ tên; panel ở `itso-panel.slice`) bằng drop-in (CPUQuota, MemoryMax, MemoryHigh 90%, MemorySwapMax, TasksMax, IOWeight); phiên SSH: drop-in cho `user-<uid>.slice` 50% giới hạn (phương án (a)); disk: user quota kernel `setquota -u` (soft 95% hard), filesystem không có quota → chế độ `soft` (đo + cảnh báo), báo `quota_mode`. Không chọn: Gom SSH vào slice account bằng linger (b); chỉ đo `du` | **APPROVED** (2026-11-21, cùng Phase 4) |
| D-65 | **Mới (Phase 4):** Ký release bằng Ed25519: `manifest.json` (phiên bản, sha256 từng file) + `manifest.sig`; `install.sh` kiểm bằng `openssl pkeyutl -verify -rawin` với public key nhúng; khóa riêng không nằm trong repo (build cục bộ sinh khóa dev tạm). Không chọn: minisign (máy sạch chưa có), GPG | **APPROVED** (2026-11-21, cùng Phase 4) |
| D-66 | **Mới (Phase 4):** Xác thực caller agent: HMAC-SHA256 trên `v1\n{method}\n{path}\n{ts}\n{nonce}\n{sha256(body)}` (header `X-ITSO-Signature`/`-Timestamp`/`-Nonce`), khóa `/etc/itso/agent.key` 0640 root:itso-agent-clients; SO_PEERCRED uid ∈ allowlist (itso, itso-gw, root); lệch giờ ±60 s, nonce cache. Không chọn: Chỉ peercred; mTLS cục bộ | **APPROVED** (2026-11-21, cùng Phase 4) |
| D-67 | **Mới (Phase 5):** Vhost Nginx `/etc/nginx/sites-enabled/itso-<website_uuid>.conf` sinh từ template Go chỉ nhận giá trị đã validate (không có ô cấu hình tự do; `custom_snippet` DEFERRED); áp dụng = ghi bản mới → `nginx -t` → lỗi thì khôi phục bản cũ/xóa bản mới, không reload; `disable_symlinks if_not_owner`; suspend = cùng op với `suspended: true`. Không chọn: sửa nginx.conf chung; cho nhập snippet tự do | **APPROVED** (2026-11-21, cùng Phase 5) |
| D-68 | **Mới (Phase 5):** PHP-FPM master mỗi account mỗi phiên bản (`itso-php@<ver>-<user>.service`, chạy dưới uid account), pool theo website, socket `/run/itso/php/<user>-<hex8>.sock`, `php_admin_value` (open_basedir, tmp, session, disable_functions); Phase 5 chỉ PHP 8.3 từ kho Ubuntu, bản khác (PPA) để Phase 10. Không chọn: một master chung; thêm PPA ondrej ngay | **APPROVED** (2026-11-21, cùng Phase 5) |
| D-69 | **Mới (Phase 5):** ACME bằng `lego` (gói Ubuntu) do agent chạy, HTTP-01 webroot chung; khóa tài khoản ACME giữ trên máy (`/etc/itso/acme/`), `acme_accounts.key_location='agent'`; gia hạn hằng ngày khi < 30 ngày; chứng chỉ tải lên: khóa riêng mã hóa trong DB, job chỉ mang tham chiếu bí mật được JobRunner thay khi gọi agent. Không chọn: certbot; ACME viết trong Laravel; đưa khóa vào params job | **APPROVED** (2026-11-21, cùng Phase 5) |
| D-70 | **Mới (Phase 5):** DNS Cloudflare gọi từ Laravel (HTTP client, base URL cố định), token mã hóa, ghi Cloudflare trước rồi lưu DB, `itso:dns-sync`; chỉ Admin realm, ADMIN theo phạm vi account. Không chọn: PowerDNS tự host; qua agent | **APPROVED** (2026-11-21, cùng Phase 5) |
| D-71 | **Mới (Phase 6):** Database hosting: MariaDB 10.11 (D-09) + PostgreSQL 16 cluster `main` (panel dùng cluster riêng, D-02); agent gọi `mariadb`/`psql` qua Runner, SQL từ định danh đã validate gửi qua stdin, mật khẩu chỉ qua tham chiếu bí mật; tên bắt buộc tiền tố `<username>_`; mỗi account có danh tính chủ `unix_socket`/`peer`, dump/import chạy dưới uid account bằng danh tính đó; tạm khóa = `ACCOUNT LOCK`/`NOLOGIN`. Không chọn: import bằng root; MySQL 8 song song (DEFERRED) | **APPROVED** (2026-11-21, cùng Phase 6) |
| D-72 | **Mới (Phase 6):** File Manager: op `fs.*` chạy trong helper (`itso-agent fs-helper`) đã hạ về uid/gid account + `no_new_privs`, đường dẫn mở bằng `openat2(RESOLVE_BENEATH\|NO_MAGICLINKS\|NO_XDEV)`; nén/giải nén bằng Go (bỏ link/device/setuid, giới hạn mục/dung lượng/tỉ lệ); upload kiểu tus vào staging `/var/lib/itso/uploads`, `fs.upload.commit` chuyển fd cho helper; tải về theo `offset`. Không chọn: agent root thao tác file trong home; gọi `unzip`/`tar` hệ thống | **APPROVED** (2026-11-21, cùng Phase 6) |
| D-73 | **Mới (Phase 6):** SFTP = user Linux của account (internal-sftp, chroot home, group `itso-sftp`/`itso-ssh`); `sshd.match.apply` ghi `sshd_config.d/50-itso.conf` + `sshd -t` + hoàn tác; SSH key do panel quản lý ở `/etc/ssh/itso_authorized_keys/%u`; FTP phụ = virtual user Pure-FTPd TLS bắt buộc, ánh xạ uid account, chroot thư mục con (D-16). Không chọn: user Linux trùng uid; vsftpd; FTP thuần | **APPROVED** (2026-11-21, cùng Phase 6) |
| D-74 | **Mới (Phase 6):** Cron = systemd timer/service `itso-cron-<uuid>` (User account, Slice account, RuntimeMaxSec, NoNewPrivileges), lệnh trong file `/etc/itso-cron/<user>/<uuid>.sh`; agent đổi cron 5 trường → `OnCalendar` (DOM+DOW cùng giới hạn → từ chối); `cron.inspect` lấy lần chạy cuối. Không chọn: crontab user (ngoài slice); nhúng lệnh vào unit | **APPROVED** (2026-11-21, cùng Phase 6) |
| D-75 | **Mới (Phase 6):** Terminal USER: chỉ gói `ssh_allowed`, step-up MFA; ticket một lần 30 s từ `pty.open`; `itso-gateway` (Go, `itso-gw`) chuyển WebSocket ↔ socket stream agent, không tự quyết quyền; shell chạy bằng `systemd-run --pty` (uid + slice account, ProtectSystem=strict, ProtectHome=tmpfs + BindPaths home, PrivateTmp, NoNewPrivileges); ≤ 2 phiên/account, nhàn rỗi 15 phút. Root terminal + ghi phiên: Phase 7. Không chọn: WebSocket trong Laravel; scope không sandbox | **APPROVED** (2026-11-21, cùng Phase 6) |
| D-76 | **Mới (Phase 7):** Firewall: panel chỉ quản lý `table inet itso` (không flush bảng khác), ruleset từ `firewall_rules` qua template Go, input `policy drop` + loopback/established/ICMP giới hạn/cổng SSH/cổng panel; bất biến chống tự khóa kiểm ở Laravel và agent (không chặn SSH/panel với IP người áp dụng); safe-apply `nft -c` → lưu bản cũ → `nft -f` → transient timer `itso-fw-rollback` 60–300 s → `:confirm` bằng request mới, không xác nhận thì khôi phục. Không chọn: ufw; firewalld; flush toàn bộ ruleset | **APPROVED** (2026-11-21, cùng Phase 7) |
| D-77 | **Mới (Phase 7):** SSH hardening `sshd_config.d/10-itso-hardening.conf` từ tập khóa cố định, `sshd -t` → reload → xác nhận/hoàn tác như D-76; từ chối tắt mật khẩu khi chưa có khóa quản trị; đổi port mở firewall trước. Fail2ban `jail.d/itso.conf` (sshd, itso-panel đọc `/var/log/itso/auth.log`, pure-ftpd), `banaction = nftables`, allowlist panel vào `ignoreip`. Không chọn: sửa `sshd_config` chính; CrowdSec | **APPROVED** (2026-11-21, cùng Phase 7) |
| D-78 | **Mới (Phase 7):** WAF ModSecurity v3 + OWASP CRS (kho Ubuntu) theo website qua khối `modsecurity` trong template vhost (D-67) + `/etc/itso/waf/<uuid>.conf` (mode, paranoia 1–2, rule id loại trừ là số); mặc định DetectionOnly 7 ngày rồi nhắc chuyển On; sự kiện từ audit log JSON (`waf.events` theo con trỏ). Không chọn: Coraza ngay (DEFERRED, chỉ khi thiếu gói); ô rule tự do | **APPROVED** (2026-11-21, cùng Phase 7) |
| D-79 | **Mới (Phase 7):** Quét mã độc dưới uid account trong slice account (Nice 19, IO idle): `clamdscan --fdpass` + `yara` (rule webshell kèm panel); cách ly = helper uid account chuyển fd cho agent root chép vào `/var/lib/itso/quarantine` (0600) rồi xóa bản gốc; khôi phục ngược lại qua helper; chỉ Admin khôi phục. Không chọn: clamd đọc thẳng home; quét bằng root | **APPROVED** (2026-11-21, cùng Phase 7) |
| D-80 | **Mới (Phase 7):** FIM bằng Go trong agent, baseline giữ ở agent (`/var/lib/itso/fim/baseline.json`, root 0600) + bản sao `fim_baselines`; `security.audit` thu dữ kiện, Laravel tính điểm theo trọng số trong code; sự kiện cao → thông báo trong panel. Không chọn: AIDE/OSSEC; baseline chỉ ở panel | **APPROVED** (2026-11-21, cùng Phase 7) |
| D-81 | **Mới (Phase 7):** CAPTCHA tự host proof-of-work (HMAC, Web Worker, không dịch vụ ngoài) khi sai ≥ 3 lần hoặc luôn bật; tùy chọn bắt buộc MFA cho USER; allowlist Admin không lưu được nếu loại IP hiện tại + `itso allowlist reset`; Terminal root chỉ khi policy cục bộ `/etc/itso/agent-policy.yaml` `root_terminal: true` (bật bằng `itso policy set terminal.root on`, chỉ CLI máy chủ), SUPER_ADMIN + step-up ≤ 10 phút, ghi phiên asciicast v2 ở agent (50 MB, vượt thì đóng phiên), đọc bằng `pty.recording.read`. Không chọn: reCAPTCHA/hCaptcha (gọi ngoài); bật root từ panel | **APPROVED** (2026-11-21, cùng Phase 7) |
| D-82 | **Mới (Phase 8) — Repo và engine:** restic từ kho Ubuntu (recipe `restic`, kiểm phiên bản ≥ 0.16). Tách **đích** (`backup_destinations`: loại, cấu hình, credential ghi) và **repo** (`backup_repositories`: đích × account, hoặc đích × server cho cấu hình/panel; mật khẩu restic riêng mỗi repo, sinh ngẫu nhiên 32 byte, mã hóa trong DB). Đường dẫn repo cố định do agent dựng: `<đích>/itso/<server_uuid>/acct-<account_uuid>` / `.../server`. Tag: `itso`, `account:<uuid>`, `website:<uuid>`, `db:<name>`, `type:files\|db\|config\|panel`. Mỗi snapshot kèm `itso-meta.json` (phiên bản panel, account, website, DB, gói). **Bộ khôi phục** (recovery kit): đích + mật khẩu repo + khóa panel hiện **một lần** khi tạo đích/repo, SA phải xác nhận đã lưu offline; tải lại cần SUPER_ADMIN + step-up | **APPROVED** (2026-11-21, duyệt cùng Phase 8) |
| D-83 | **Mới (Phase 8) — Đích và immutable:** `local` (`/var/backups/itso/repos`, root 0700, không immutable), `sftp` (khóa SSH riêng do agent sinh, host key ghim khi kiểm tra kết nối), `s3` (endpoint + bucket + key; phát hiện Object Lock), `rest` (rest-server, user append-only). Panel/agent chỉ giữ **credential ghi**. `backup.forget`/prune tắt mặc định bằng policy agent (`backup.forget=false`); retention trong panel là "mong muốn": với đích không immutable và policy bật thì panel chạy forget theo retention, còn lại SA chạy `itso backup prune` trên máy chủ, nhập credential prune tại chỗ (không lưu) | **APPROVED** (2026-11-21, duyệt cùng Phase 8) |
| D-84 | **Mới (Phase 8) — Nội dung và nhất quán:** File: `restic backup` thư mục `sites/` + `backups/` + home (loại `tmp`, cache, session) do agent đọc bằng root, không theo symlink (`restic` lưu symlink như symlink), không qua thiết bị khác. DB: dump dưới uid account bằng danh tính chủ (D-71) — `mariadb-dump --single-transaction --routines --triggers --events` / `pg_dump -Fc` — pipe vào `restic backup --stdin --stdin-filename db/<name>.sql\|.dump`. Cấu hình máy chủ: `/etc/itso`, `/etc/nginx`, `/etc/php`, `/etc/ssh/sshd_config.d`, ruleset nft, unit `itso*`, danh sách gói. Panel: `pg_dump -Fc` DB `itso` + `/etc/itso` + khóa, **mã hóa thêm** bằng khóa công khai X25519 của panel (age); khóa riêng chỉ nằm trong bộ khôi phục của SA | **APPROVED** (2026-11-21, duyệt cùng Phase 8) |
| D-85 | **Mới (Phase 8) — Khôi phục:** Agent `restic restore` vào **staging root 0700** `/var/lib/itso/restore/<uuid>` (ngoài home), rồi helper uid account chép vào home qua `fsx` (như `fs.upload.commit`: bỏ setuid/thiết bị, không theo symlink, chủ = account). Website: vào `sites/<domain>.restore-<ts>` → kiểm → snapshot "pre-restore" bản hiện tại → đổi tên nguyên tử → reload. DB: mặc định DB mới `<name>_r<ts>`; ghi đè cần step-up + dump trước khi khôi phục. File lẻ: duyệt snapshot (`restic ls --json`) → khôi phục vào `backups/restore-<ts>/`. Khôi phục sang account khác cùng máy (nhân bản) được; sang máy khác: Phase 9 | **APPROVED** (2026-11-21, duyệt cùng Phase 8) |
| D-86 | **Mới (Phase 8) — Lịch, tài nguyên, quota:** Lịch trong panel: `itso:backup-due` mỗi 5 phút chọn policy đến hạn + jitter theo repo; mặc định file hằng ngày, DB 6 giờ, cấu hình hằng ngày. Agent chạy restic trong `itso-maint.slice` (CPUQuota 50%, IOWeight 10, Nice 10) bằng `systemd-run --wait`; một tác vụ một repo (khóa Redis + khóa restic). Quota backup theo gói (`backup_quota_mb`): dung lượng repo của account (từ `restic stats --mode raw-data`) vượt → cảnh báo, vượt 120 % → tạm dừng backup lịch (không xóa) | **APPROVED** (2026-11-21, duyệt cùng Phase 8) |
| D-87 | **Mới (Phase 8) — Kiểm chứng và DR:** Hằng tuần `restic check --read-data-subset=5%`; hằng tháng restore test tự động (khôi phục 1 website + 1 DB vào staging, so sha256 với manifest trong `itso-meta.json`, DB nạp vào DB tạm rồi xóa). Checklist 3-2-1-1-0 tính từ dữ kiện thật (số bản, loại phương tiện, off-site, immutable, lần kiểm gần nhất). Purge account (D-46) bắt buộc snapshot cuối đã kiểm chứng. DR: `install.sh --restore` → wizard nhập đích + đường dẫn/mật khẩu repo server + khóa riêng → khôi phục DB panel + `/etc/itso` (`itso panel-restore-apply`) → `itso:reconcile` áp lại desired state → `itso:dr-restore` khôi phục từng account (song song có giới hạn); runbook `docs/runbooks/disaster-recovery.md` | **APPROVED** (2026-11-21, duyệt cùng Phase 8) |
| D-88 | **Mới (Phase 9) — Vai trò cài đặt:** `install.sh --role all-in-one` (mặc định) · `--role control-plane` · `--role node --join <url> --token <token> --ca-sha256 <pin>` (node chỉ có agent + runtime hosting); `itso node status\|rejoin\|leave`; server all-in-one cũ là server local của control plane | **APPROVED** (2026-11-21, duyệt cùng kế hoạch Phase 9, `docs/planning/seed/PHASE_9_PROMPTS.md`) |
| D-89 | **Mới (Phase 9) — Kênh agent từ xa:** Dịch vụ `itso-relay` (Go, không root) trên control plane nghe `:28444` TLS 1.3 + mTLS; agent node kết nối ra (WebSocket, ping 20 giây, reconnect lũy thừa); Laravel gọi relay qua `/run/itso/relay.sock`; envelope vẫn ký HMAC (D-66) bằng khóa riêng mỗi server, relay không giả được op; node không mở cổng quản trị inbound | **APPROVED** (2026-11-21, duyệt cùng kế hoạch Phase 9, `docs/planning/seed/PHASE_9_PROMPTS.md`) |
| D-90 | **Mới (Phase 9) — CA nội bộ:** CA ECDSA P-256, khóa `/etc/itso/pki/ca.key` root 0600 chỉ agent local dùng (op `pki.sign_csr`, CN = `server_uuid`); chứng chỉ node 30 ngày, khóa sinh trên node, tự xoay ở 2/3 hạn; token enroll 32 byte, 1 giờ, một lần, lưu sha256; lệnh join ghim sha256 CA; xóa server → relay chặn fingerprint | **APPROVED** (2026-11-21, duyệt cùng kế hoạch Phase 9, `docs/planning/seed/PHASE_9_PROMPTS.md`) |
| D-91 | **Mới (Phase 9) — Job khi node mất kết nối:** Hàng đợi theo server; node offline → job `waiting_agent` tới deadline (30 phút, op đọc 2 phút) rồi `agent_unreachable`; op_id idempotent khi gửi lại; heartbeat 20 giây, 3 lần lỡ → `degraded`, 5 phút → `unreachable` + thông báo; không tự chuyển account khi node chết | **APPROVED** (2026-11-21, duyệt cùng kế hoạch Phase 9, `docs/planning/seed/PHASE_9_PROMPTS.md`) |
| D-92 | **Mới (Phase 9) — Năng lực và gợi ý server:** `server_capacity` từ facts agent + hạn mức đã cấp; lọc (role `web`, nhận account mới, đủ PHP/DB của gói, đĩa sau cấp ≥ 15 %) rồi xếp theo tỉ lệ cam kết thấp nhất; chỉ gợi ý kèm lý do, admin chọn | **APPROVED** (2026-11-21, duyệt cùng kế hoạch Phase 9, `docs/planning/seed/PHASE_9_PROMPTS.md`) |
| D-93 | **Mới (Phase 9) — Chuyển account:** Dữ liệu qua repo restic (tái dùng Phase 8): preflight → tạo account ở đích (giữ UID nếu trống) → sync lần đầu → kiểm tra (sha256, số dòng + checksum bảng, HTTP) → cutover (khóa nguồn, sync cuối, kiểm lại, bật đích, đổi DNS nếu zone do panel quản lý) → giữ nguồn 7 ngày → dọn dẹp `account.remove`; rollback ở mọi bước trước dọn dẹp; đo downtime | **APPROVED** (2026-11-21, duyệt cùng kế hoạch Phase 9, `docs/planning/seed/PHASE_9_PROMPTS.md`) |
| D-94 | **Mới (Phase 10) — Cài Docker:** Recipe `docker` = gói Ubuntu `docker.io` + `docker-compose-v2` (không kho ngoài); `docker.host.configure` ghi `/etc/docker/daemon.json` (ip 127.0.0.1, userland-proxy false, live-restore, log 10m×3); nhóm `docker` phải rỗng; agent dùng Engine API qua `/var/run/docker.sock` (API ≥ 1.43), `docker compose` chạy argv qua runner, project `/var/lib/itso/compose/<uuid>/` root 0700. ADR 0039 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 10 theo `docs/planning/seed/PHASE_10_PROMPTS.md`) |
| D-95 | **Mới (Phase 10) — Firewall Docker:** Agent đồng bộ chain `DOCKER-USER` (RETURN established/bridge nội bộ, ACCEPT cổng SA mở, DROP từ interface public), chạy lại sau mỗi lần Docker restart; không đụng bảng `inet itso` (D-77). ADR 0040 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 10 theo `docs/planning/seed/PHASE_10_PROMPTS.md`) |
| D-96 | **Mới (Phase 10) — Validator compose:** Validator Go trong agent là nguồn sự thật; chặn privileged, cap_add ngoài allowlist, host network/pid/ipc/userns, devices, tắt seccomp/apparmor, bind mount hệ thống/docker.sock, `build:`; viết lại ports thành 127.0.0.1:<cổng cấp>; thêm giới hạn mặc định; SA override từng rule có lý do + audit, ADMIN không; revision bất biến. ADR 0041 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 10 theo `docs/planning/seed/PHASE_10_PROMPTS.md`) |
| D-97 | **Mới (Phase 10) — Cổng và website Docker:** Dải 20000–29999 mỗi server, `port_allocations` unique, cấp trong transaction, agent kiểm cổng trống; website loại `docker` = vhost proxy `127.0.0.1:<port>` + ACME + websocket. ADR 0042 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 10 theo `docs/planning/seed/PHASE_10_PROMPTS.md`) |
| D-98 | **Mới (Phase 10) — Image và volume:** Cập nhật image giữ tag rollback `itso-rollback/<project>-<service>:<ts>`, kiểm health 60 giây, lỗi tự quay lại, giữ 2 bản; mật khẩu registry mã hóa ở DB, tới agent qua `secret_ref`; backup volume phạm vi compose project, mặc định pause container. ADR 0043 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 10 theo `docs/planning/seed/PHASE_10_PROMPTS.md`) |
| D-99 | **Mới (Phase 10) — WordPress Toolkit:** WP-CLI phar ghim sha512, chạy dưới UID account, op typed `wp.*` (không có wp.cli tự do); cập nhật = snapshot → bảo trì → update → verify-checksums + http.check → lỗi thì restore và `rolled_back`; staging subdomain + noindex + basic auth; hardening 6 mục. Đẩy staging → production và quét lỗ hổng: DEFERRED. ADR 0044 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 10 theo `docs/planning/seed/PHASE_10_PROMPTS.md`) |
| D-100 | **Mới (Phase 10) — Software Manager:** Catalog trong agent là nguồn sự thật (gói, kho, dịch vụ, xung đột, phụ thuộc); PHP 8.1/8.2/8.4 qua PPA ondrej/php với khóa ghim, chỉ bật khi cần; gỡ bị chặn khi đang dùng; unattended-upgrades bật/tắt, không tự reboot. ADR 0045 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 10 theo `docs/planning/seed/PHASE_10_PROMPTS.md`) |
| D-101 | **Mới (Phase 11) — Metrics:** Giữ PostgreSQL, không thêm TSDB; `metric_samples` partition ngày, 1 phút, giữ 7 ngày (drop partition); `metric_rollups` 1 giờ min/avg/max, giữ 90 ngày; server qua `metrics.snapshot` mỗi phút, account qua `metrics.cgroup` lô mỗi 5 phút; ≤ 24 giờ đọc samples, > 24 giờ đọc rollup, ≤ 500 điểm. ADR 0046 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 11 theo `docs/planning/seed/PHASE_11_PROMPTS.md`) |
| D-102 | **Mới (Phase 11) — Bộ máy cảnh báo:** `itso:alerts-evaluate` mỗi phút; rule metric/op/ngưỡng/thời gian/phạm vi/mức/kênh/nhắc lại; `pending → firing → resolved` theo fingerprint, resolve trễ 2 lượt; mất kết nối ≥ 90 giây firing ngay (≤ 2 phút); rule mặc định sửa được, không xóa được; ack, silence 5 phút–7 ngày; xem trước rule. ADR 0047 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 11 theo `docs/planning/seed/PHASE_11_PROMPTS.md`) |
| D-103 | **Mới (Phase 11) — Kênh thông báo:** email/Telegram/webhook chỉ SA; bí mật `Crypt` chỉ ghi; webhook https (http chỉ khi bật mạng riêng), ký HMAC-SHA256; SSRF guard (DNS trước, chặn loopback/link-local/metadata, dải riêng theo cờ, không redirect, 5 giây, 64 KB); queue + `notification_deliveries` + thử lại 1/5/15 phút + gửi lại; 30 tin/phút/kênh. ADR 0048 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 11 theo `docs/planning/seed/PHASE_11_PROMPTS.md`) |
| D-104 | **Mới (Phase 11) — Định tuyến thông báo:** danh mục sự kiện ở code, tùy chọn người × sự kiện × kênh, critical luôn in-app; USER chỉ in-app + email của mình; Telegram/webhook thuộc realm admin; nội dung không chứa bí mật. ADR 0049 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 11 theo `docs/planning/seed/PHASE_11_PROMPTS.md`) |
| D-105 | **Mới (Phase 11) — Uptime check:** gắn website, chỉ nhập đường dẫn trên domain của website (không URL tùy ý); op agent `uptime.probe` trên server chứa website (≤ 50 URL, ≤ 10 giây, không redirect ra host khác, hạn chứng chỉ, từ khóa); 60–3600 giây; down sau 3 lần lỗi; `uptime_results` 7 ngày. ADR 0050 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 11 theo `docs/planning/seed/PHASE_11_PROMPTS.md`) |
| D-106 | **Mới (Phase 11) — Realtime:** sự kiện job qua Redis pub/sub, SSE `GET /jobs/{id}/events` (5 phút, heartbeat 15 giây, `Last-Event-ID`), dashboard/chuông poll 30 giây, không WebSocket. ADR 0051 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 11 theo `docs/planning/seed/PHASE_11_PROMPTS.md`) |
| D-107 | **Mới (Phase 11) — Phát hành `v0.5.0-beta`:** `make release` ký Ed25519, release notes Phase 9–11, tag local trên `main` sau merge, không push. ADR 0052 | **APPROVED** (2026-11-22, người dùng chọn bắt đầu Phase 11 theo `docs/planning/seed/PHASE_11_PROMPTS.md`) |

---

## Lịch sử quyết định (giữ nguyên)

Trạng thái: **Proposed** (chờ duyệt) · **Accepted** · **Rejected** · **Superseded**.
Mỗi quyết định Accepted quan trọng sẽ có ADR trong `docs/adr/`.

| ID | Quyết định | Đề xuất | Lý do | Phương án khác | Trạng thái |
|---|---|---|---|---|---|
| D-01 | Runtime của panel | **FrankenPHP (Laravel Octane) riêng tại /opt/itso/runtime**, phục vụ panel trên port riêng | Panel không phụ thuộc PHP/Nginx của hosting; tự quản TLS | PHP-FPM version cố định + `itso-nginx` riêng | Proposed |
| D-02 | DB của panel | PostgreSQL 16 **cluster riêng `itso`**, chỉ unix socket | Tách khỏi PostgreSQL phục vụ USER | Dùng chung cluster `main` | Proposed |
| D-03 | Queue/Cache | Redis **instance riêng `itso-redis`** | Tách khỏi Redis của website | Laravel database queue (bớt một dịch vụ) | Proposed |
| D-04 | Giữ stack đề xuất | React/TS/Vite/Tailwind/shadcn + Laravel + PostgreSQL + Redis + Go | Không có lý do kỹ thuật buộc thay | — | Proposed |
| D-05 | Thư viện frontend bổ sung | TanStack Router, TanStack Table, i18next, react-hook-form + zod, xterm.js, CodeMirror 6, MSW | Lấp các khoảng trống của stack | React Router thay TanStack Router | Proposed |
| D-06 | CLI | `itso` viết bằng **Go** | Repair được khi Laravel hỏng; dùng chung code agent | CLI Artisan | Proposed |
| D-07 | Realtime | **`itso-gateway`** (Go, không đặc quyền) cho WebSocket/SSE | Laravel không hợp giữ kết nối dài | Laravel Reverb | Proposed |
| D-08 | Nguồn Nginx | Repo **nginx.org stable** | Bản mới, HTTP/3 | Nginx của Ubuntu (1.24) | Proposed |
| D-09 | MySQL hay MariaDB mặc định | **MariaDB 10.11 (Ubuntu)**; MySQL 8.x là lựa chọn trong wizard; không cài song song | Có sẵn trong repo, tương thích rộng | MySQL 8.4 LTS mặc định | Proposed |
| D-10 | Firewall | **nftables trực tiếp** (bảng `inet itso`), không dùng UFW | Tránh hai lớp quản lý; kiểm soát DOCKER-USER | UFW | Proposed |
| D-11 | DNS | Tích hợp **DNS provider API** (Cloudflare trước); không chạy DNS server ở v0.x | Nội bộ, ít vận hành | PowerDNS nội bộ | Proposed |
| D-12 | PHP-FPM | **Master riêng cho từng account** (systemd template, chạy dưới uid account, pm=ondemand) | Cần để áp cgroup per account | Pool chung một master (không giới hạn được per account) | Proposed |
| D-13 | Đặc quyền agent | Agent chạy **root + systemd hardening + policy cục bộ**; đánh giá tách helper ở Phase 12 | Cân bằng độ phức tạp/an toàn | Agent không đặc quyền + helper root nhỏ | Proposed |
| D-14 | Contracts-first | OpenAPI + JSON Schema là nguồn sự thật, codegen TS/Go | Tránh UI/agent trôi khỏi API | Viết tay | Proposed |
| D-15 | Mốc v0.1.0-alpha | **Cuối Phase 8** (có backup) | Hosting không backup chưa dùng thật được | Cuối Phase 6 | Proposed |
| D-16 | FTP | **SFTP mặc định**; FTPS (Pure-FTPd) tùy chọn; FTP thuần tắt | Bảo mật | vsftpd/FTP thuần | Proposed |
| D-17 | Email server | **Ngoài phạm vi v0.x** | Không có trong danh sách module; rủi ro vận hành cao | Thêm module Mail sau v1 | Proposed |
| D-18 | Docker cho USER | v0.2: chỉ SA/AD; USER dùng **managed compose qua validator** khi được duyệt | Socket = root | Rootless per user | Proposed |
| D-19 | Immutable backup | rest-server `--append-only` hoặc S3 Object Lock; credential prune **không lưu trong panel** | Đáp ứng yêu cầu "panel không xóa được backup immutable" | — | Proposed |
| D-20 | Phân phối | Tarball ký minisign + manifest; `.deb`/apt repo sau | Đơn giản cho v0.x | `.deb` ngay từ đầu | Proposed |
| D-21 | Session SSH vs slice | Phương án (a): drop-in giới hạn `user-<uid>.slice` riêng — xác nhận bằng spike Phase 4 | Đơn giản, ít phụ thuộc logind | (b) gom service vào user slice | Proposed |
| D-22 | Dev trên Windows | **WSL2 Ubuntu 24.04** khuyến nghị; Docker Compose chỉ cho dev | Gần production nhất | Windows thuần + mock agent | Proposed |

---

## Rà soát 2026-11-20: panel dùng cho công ty **và khách hàng**

Chi tiết: `docs/planning/14-CUSTOMER-MULTI-TENANT.md`.

### Quyết định thay đổi

| ID | Thay đổi | Lý do |
|---|---|---|
| D-11 | DNS: vẫn dùng provider API ở v0.x, nhưng **nâng lên P1** và mở phương án DNS hosted (PowerDNS, `ns1/ns2` của công ty) ở Phase 11 | Khách thường cần nameserver do nhà cung cấp quản lý |
| D-13 | Agent root giữ nguyên, nhưng **bắt buộc pentest độc lập trước khi nhận khách** (Phase 9 mới); đánh giá tách helper đặc quyền sớm hơn (Phase 9 thay vì 13) | Khách là tác nhân không tin cậy |
| D-15 | v0.1.0-alpha (cuối Phase 8) **chỉ dùng nội bộ**; nhận khách từ **v0.2.0-beta** sau Phase 9 Customer Readiness | Chưa đủ abuse/portal/pentest thì không nên mở cho khách |
| D-16 | FTPS (Pure-FTPd, TLS bắt buộc) nâng từ "tùy chọn" lên **P1** | Khách hay dùng FTP client; FTP thuần vẫn tắt |
| D-17 | Vẫn **không** làm mail server; thêm: chặn port 25 với uid hosting, tắt `mail()`, SMTP relay có giới hạn theo gói | Chống spam làm blacklist IP |
| D-18 | Thắt chặt: **khách không dùng Docker trên server shared**; chỉ trên server dedicated của chính khách đó | Rủi ro escape giữa tenant |
| D-21 | SSH shell cho khách mặc định **tắt**; khi bật thì shell chạy trong jail sandbox, nằm trong slice của account | Khách không tin cậy |
| D-04, D-12, D-10 | Giữ nguyên, **được củng cố**: PHP-FPM per account là bắt buộc; nftables cần thêm rule egress per uid | |

Các quyết định còn lại (D-01–D-03, D-05–D-09, D-14, D-19, D-20, D-22) không đổi.

### Quyết định mới

| ID | Quyết định | Đề xuất | Phương án khác | Trạng thái |
|---|---|---|---|---|
| D-23 | Tổ chức backup repo | **Một restic repo cho mỗi hosting account** trên server khách; repo chung cho server nội bộ | Một repo chung + tag (dedupe tốt, khó xóa sạch một khách) | Proposed |
| D-24 | Billing & cấp tài khoản | ~~Admin tạo tay hoàn toàn~~ → **Superseded bởi D-32/D-33** (định hướng Hosting Provider 2026-11-20) | | **Superseded** |
| D-25 | Truy cập panel | Tách **Admin area** (domain riêng, IP allowlist, MFA bắt buộc) và **Customer portal** (public, WAF, rate limit, CAPTCHA) | Một domain chung | Proposed |
| D-26 | Vai trò mới | Thêm **SUPPORT** (nhân viên hỗ trợ) và **sub-user** của khách | Chỉ 3 vai trò | Proposed |
| D-27 | Thực thể Customer | Thêm bảng `customers` đứng trên users/accounts | Gộp vào users | Proposed |
| D-28 | Tách hạ tầng | **Website công ty không chung server với khách**; nhóm server internal/customer. Trước khi có multi-server: mỗi server một panel | Chung server, chỉ dựa vào isolation | Proposed |
| D-29 | Sandbox per account | systemd sandboxing (ProtectSystem/ProtectHome/PrivateTmp/ProtectProc/…) cho mọi unit của account | CageFS-like tự viết, hoặc chỉ dựa vào uid | Proposed |
| D-30 | Branding | Một brand toàn hệ thống do SA cấu hình (logo, màu, domain, email template); brand theo đại lý để P2 | White-label đa brand ngay | Proposed |
| D-31 | Pháp lý dữ liệu | Áp dụng yêu cầu NĐ 13/2023: ToS có phiên bản, log truy cập của nhân viên, quy trình xóa khi chấm dứt | — | Proposed |

---

## Rà soát 2026-11-20 (lần 2): mô hình Hosting Provider

Chi tiết: `docs/planning/15-HOSTING-PROVIDER.md`.

### Đã chốt theo yêu cầu của bạn (Accepted)

| ID | Quyết định |
|---|---|
| D-32 | Có **Provisioning API** `/api/provisioning/v1` cho website bán hosting: tạo, kích hoạt, gia hạn, suspend, unsuspend, terminate (thay D-24) |
| D-33 | Billing **không nằm trong lõi**; tích hợp qua **Billing Adapter** (bắt đầu với WooCommerce) |
| D-25 | Tách Admin Panel và Customer Portal trên cùng control plane (chuyển từ Proposed sang Accepted) |
| D-27 | Thực thể Customer, cùng HostingService, Subscription, Service Lifecycle (mở rộng, Accepted) |
| D-15 | Thay bằng 3 giai đoạn: Internal Alpha (v0.1) → Hosting Provider Beta (v0.5, chưa thu phí) → Production (v1.0, mở bán) |
| D-39 | **Paid Customer Gate**: không nhận khách trả phí trước khi đạt PG1–PG8 (isolation, resource, priv-esc, backup/restore, upgrade, DR, lifecycle, vận hành) |

### Quyết định thay đổi

| ID | Thay đổi |
|---|---|
| D-18 | Docker Hosting cho khách là product line riêng trên **VM cô lập theo khách** (xem D-38); shared node không chạy Docker của khách |
| D-26 | Vai trò staff: SUPER_ADMIN, ADMIN, SUPPORT, **BILLING_OPERATOR**; vai trò khách: OWNER, MEMBER. Hai bảng danh tính tách biệt (D-40) |
| D-28 | Multi-server đưa lên **Phase 9** (đầu giai đoạn Beta); control plane chạy trên máy riêng (D-41) |

### Quyết định mới cần duyệt (Proposed)

| ID | Quyết định | Đề xuất | Phương án khác |
|---|---|---|---|
| D-34 | Adapter WooCommerce | Plugin WP dựa trên **WooCommerce Subscriptions** (extension trả phí) để quản lý gia hạn | Adapter tự quản chu kỳ gia hạn (không cần extension, phức tạp hơn) |
| D-35 | Nguồn sự thật | Billing quyết định tiền và ngày đến hạn; panel quyết định trạng thái kỹ thuật; panel không nhận số tiền | Panel tự quản ngày đến hạn |
| D-36 | Mốc quá hạn mặc định | Grace 3 ngày → suspend; D+30 terminate; giữ dữ liệu thêm 30 ngày → purge có biên bản; có legal hold | Mốc khác do ITSO quy định |
| D-37 | Xác thực Provisioning API | HMAC-SHA256 theo từng client + IP allowlist + idempotency; mTLS tùy chọn | OAuth2 client credentials |
| D-38 | Docker Hosting cho khách | Mỗi khách một VM (KVM/libvirt hoặc Proxmox), thiết kế sau v1.0 | Rootless Podman/gVisor trên node dùng chung |
| D-40 | Danh tính | Hai bảng và hai guard riêng: `staff_users` và `customer_users` | Một bảng users chung, phân bằng role |
| D-41 | Topology | Control plane trên máy riêng từ Beta; Alpha cho phép all-in-one; node thêm bằng `install.sh --role node --join <token>` | Control plane chạy chung trên một node hosting |
| D-42 | Placement Engine | Lọc theo yêu cầu, chấm điểm có trọng số, overcommit theo server group (CPU 4:1, RAM 1.5:1, disk 1:1), giữ chỗ trong transaction | Admin chọn node thủ công |
| D-43 | Package versioning | Version bất biến; dịch vụ gắn với version; đổi gói tạo version mới và migrate có kiểm soát | Sửa gói áp dụng ngay cho mọi dịch vụ |
| D-44 | 1 dịch vụ = 1 hosting account = 1 node | Đơn giản cho placement, backup, lifecycle | Một dịch vụ trải trên nhiều node |
| D-45 | Dải UID | 20000–59999 trên mỗi node, không tái dùng UID trong 90 ngày sau purge | Tái dùng ngay |
