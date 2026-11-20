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
| D-51 | **Mới:** Không bắt buộc GitHub trước khi bắt đầu. Phase 1 khởi tạo **Git local**, sau đó kết nối GitHub | **APPROVED** (2026-11-20) |
| D-52 | **Mới:** Phase 1 = Foundation + Architecture + Database (schema spec) + API Contracts + **Design System**; Phase 2 = demo UI hoàn chỉnh Admin Panel + User Hosting Portal | **APPROVED** (2026-11-20) |
| D-53 | Giữ installer giống aaPanel (một lệnh, native Ubuntu, Web Wizard, systemd, CLI `itso`, không bắt buộc Docker) và toàn bộ yêu cầu bảo mật, cách ly, backup immutable, quota thực, multi-server | **APPROVED** (2026-11-20) |
| D-54 | Design token lấy `design/tokens/tokens.json` làm nguồn; "preset" Tailwind v4 là khối `@theme inline` sinh ra (Tailwind 4 bỏ preset JS); Light mặc định ở `:root`, Dark bằng class `.dark`; mọi cặp màu khai báo phải đạt WCAG AA | **APPROVED** (2026-11-20, duyệt cùng Phase 1) |
| D-55 | Codegen từ contracts: TS bằng openapi-typescript + openapi-fetch (`apps/web/src/api/generated`), Go structs bằng generator Python trong `contracts/tools` (không thêm tool ngoài). File sinh được commit và kiểm bằng `make codegen-check` | **APPROVED** (2026-11-20, duyệt cùng Phase 1) |
| D-56 | **Mới (Phase 2.5):** Đặc tả sớm Git deploy (module 22) để có giao diện demo: bảng `git_repositories`, `git_deployments`; API `/git-repositories`, `/git-deployments/{id}:rollback`; op khai báo `git.deploy`, `git.rollback` (schema chi tiết ở Phase 10). Webhook công khai chưa có trong contract | **ĐỀ XUẤT** (chờ duyệt cùng Phase 2) |
| D-57 | **Mới (Phase 2.7):** Thêm `GET /hosting-accounts/{id}/features` (admin + portal, schema chung `AccountFeatures`): tập con an toàn của giới hạn gói hiện hành (phiên bản PHP, số PHP worker tối đa, SSH, khoảng cron tối thiểu, quota/retention backup) để Portal chọn PHP, biết gói có SSH mà không lộ `PackageLimits` đầy đủ (Admin-only) | **ĐỀ XUẤT** (chờ duyệt cùng Phase 2) |
| D-58 | **Mới (Phase 3):** Xác thực SPA bằng session cookie cùng origin (guard session của Laravel, bảng `sessions` theo DBML có `realm`, `mfa_verified_at`) + CSRF double-submit (`/auth/csrf`, header `X-XSRF-TOKEN`), không cài Sanctum; API token nội bộ (`api_tokens`, SHA-256, scopes, CIDR) qua guard riêng; MFA TOTP RFC 6238 tự viết (secret mã hóa bằng APP_KEY, mã khôi phục băm argon2id) | **ĐỀ XUẤT** (chờ duyệt cùng Phase 3) |
| D-59 | **Mới (Phase 3):** Pest chạy trên PostgreSQL 16 (bỏ SQLite) vì schema dùng trigger, `citext`, `inet`, `jsonb`, partial index, partition; `make test-api` cần PostgreSQL (`make services-up` hoặc cluster cục bộ) | **ĐỀ XUẤT** (chờ duyệt cùng Phase 3) |
| D-60 | **Mới (Phase 3):** Job runner = bảng `jobs`/`job_steps`/`job_logs` + `JobRunner` chạy từng bước gọi `AgentClient` qua queue Redis; test dùng queue sync + fake agent; tiến độ bằng polling `GET /jobs/{id}` và `/jobs/{id}/events?after=` (SSE để Phase 11) | **ĐỀ XUẤT** (chờ duyệt cùng Phase 3) |

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
