# 15 — ITSO Panel theo mô hình Hosting Provider

> **⚠ DEFERRED / OUT OF SCOPE (2026-11-20):** phạm vi đã chốt là NỘI BỘ. Billing, WooCommerce, Subscription, storefront: OUT OF SCOPE. Public Provisioning API, Customer/Service, Placement tự động, Docker Hosting: DEFERRED. Chỉ giữ file này làm tài liệu tham khảo cho tương lai. Bản hiện hành: `seed/*.md`.

> Cập nhật 2026-11-20 theo "HOSTING PROVIDER DIRECTION UPDATE". Tài liệu này **ghi đè** 01–14 khi có khác biệt. Đặc biệt, nó **thay thế D-24** (trước đây là "admin tạo tay"): nay có Provisioning API và Billing Adapter.

ITSO Panel là **nền tảng hạ tầng self-hosted do ITSO sở hữu và vận hành** để kinh doanh Web Hosting. Đây không phải SaaS bán license. Phần mềm không có license server, và cũng không có cổng thanh toán nằm trong lõi.

## 1. Kiến trúc tổng thể Hosting Provider

```
 Website bán hàng (WooCommerce)          Khách hàng                 Nhân viên ITSO
        │ ITSO Billing Adapter               │                          │
        │ (WP plugin)                        │ my.itso.vn               │ admin.itso.vn (IP allowlist + MFA)
        ▼                                    ▼                          ▼
┌────────────────────────── CONTROL PLANE (máy chủ riêng, không chứa site khách) ─────────────────┐
│  Provisioning API  /api/provisioning/v1   Customer Portal API   Admin API  /api/v1            │
│        └──────────────┬──────────────────────────┴──────────────────┘                          │
│              Laravel core: Customer · Service · Subscription mirror · Lifecycle engine        │
│              Placement Engine · Jobs/Outbox · Audit · Notifications · Policy                  │
│              PostgreSQL (itso) · Redis · Workers · Scheduler · itso-gateway · Internal CA     │
└──────────────┬──────────────────────────┬───────────────────────────────┬───────────────────┘
               │ mTLS (agent kết nối ra)  │                               │
     ┌─────────▼────────┐       ┌─────────▼────────┐             ┌────────▼─────────┐
     │ Node shared-01   │       │ Node shared-02   │   …         │ Node internal-01 │
     │ itso-agent       │       │ itso-agent       │             │ site của công ty  │
     │ Nginx, PHP-FPM   │       │ …                │             │                  │
     │ per account,     │       └──────────────────┘             └──────────────────┘
     │ MariaDB, quota,  │       ┌──────────────────┐             ┌──────────────────┐
     │ sandbox          │       │ Backup node /    │             │ Docker hosting   │
     └──────────────────┘       │ S3 Object Lock   │             │ (VM cô lập, sau) │
                                └──────────────────┘             └──────────────────┘
```

**Thay đổi so với kiến trúc single-server:**
- **Control plane tách khỏi node hosting** ở giai đoạn Beta trở đi. Bản Internal Alpha vẫn cho phép cài all-in-one bằng một lệnh.
- Installer có vai trò cài đặt: `install.sh --role all-in-one` (mặc định, giống aaPanel), `--role control-plane`, và `--role node --join <token>` (thêm node bằng một lệnh).
- Mọi node đều do agent quản lý qua mTLS, agent chủ động kết nối ra control plane. Node không mở port quản trị inbound.

## 2. Admin Panel và Customer Portal

| | Admin Panel | Customer Portal |
|---|---|---|
| Origin | `admin.<domain>` | `my.<domain>` (thương hiệu ITSO) |
| Người dùng | SUPER_ADMIN, ADMIN, SUPPORT, BILLING_OPERATOR (mới) | CUSTOMER_OWNER, CUSTOMER_MEMBER (sub-user) |
| Truy cập | IP allowlist/VPN, MFA bắt buộc, session ngắn | Public, WAF, rate limit, CAPTCHA sau N lần sai, MFA tùy chọn (bắt buộc nếu có SSH) |
| Laravel guard | `admin` (bảng `staff_users`) | `customer` (bảng `customer_users`) |
| Cookie/session | Riêng biệt (khác tên, khác domain), `SameSite=Strict` | Riêng biệt |
| Route | `/api/v1/admin/*` | `/api/v1/portal/*` |
| Frontend | Một codebase React, hai entry build (`admin`, `portal`), dùng chung design system | |

Nhân viên và khách nằm ở **hai bảng danh tính khác nhau**, nên lỗi phân quyền không thể biến một khách thành nhân viên. Nhân viên vào portal của khách chỉ qua cơ chế **support access** (xem §10).

## 3. Mô hình dữ liệu dịch vụ

```
Customer ─┬─< CustomerUser (owner, members)
          ├─< Subscription ──1:1── HostingService ──1:1── HostingAccount ──< Website, Database, SFTP, Cron, …
          │        │                     │                      │
          │   (bản sao trạng thái     (thực thể bán:        (hiện thực kỹ thuật trên
          │    billing: chu kỳ,        gói, trạng thái       1 node: Linux UID/GID,
          │    hạn, external_id)       lifecycle, ngày)      slice, quota, PHP pool)
          └─< DataRetentionRecord, AbuseCase, SupportAccessGrant
HostingPackage ─< HostingPackageVersion (bất biến) ─< HostingService (gắn với version)
ServerGroup ─< Server(node) ─< HostingAccount
```

| Thực thể | Ý nghĩa | Bảng chính (cột tiêu biểu) |
|---|---|---|
| **Customer** | Pháp nhân/cá nhân mua dịch vụ | `customers` (uuid, type, name, tax_code, email, phone, country, status, external_refs jsonb, data_region, created_via) |
| **CustomerUser** | Người đăng nhập portal | `customer_users` (customer_id, email, role owner/member, permissions, mfa) |
| **Hosting Package** | Đặc tả kỹ thuật của gói | `hosting_packages` (code duy nhất, tên, product_line shared/docker/internal, visibility) |
| **Package Version** | Giá trị giới hạn bất biến | `hosting_package_versions` (package_id, version, limits jsonb + cột chính, placement_requirements jsonb, created_at) |
| **Hosting Service** | Một dịch vụ đã bán cho khách | `hosting_services` (uuid, customer_id, package_version_id, primary_domain, lifecycle_state, state_reason, activated_at, suspended_at, terminate_after, purge_after, legal_hold, external_service_id, source billing/admin) |
| **Subscription** | **Bản sao** trạng thái thương mại từ billing, panel không tính tiền | `subscriptions` (service_id, billing_system, external_subscription_id, cycle, current_period_end/next_due_date, status active/overdue/cancelled, last_synced_at) |
| **Hosting Account** | Hiện thực trên node | `hosting_accounts` (đã có, thêm `service_id`, `server_id`, `placement_decision_id`) |
| **Service Lifecycle** | Lịch sử chuyển trạng thái | `service_lifecycle_events` (service_id, from, to, reason, actor_type staff/customer/billing/system, actor_id, job_id, at) |

**Nguồn sự thật:** billing quyết định **tiền và hạn thanh toán**. Panel quyết định **trạng thái kỹ thuật**. Panel không bao giờ nhận số tiền và không tin số tiền gửi tới.

## 4. Service Lifecycle

```
             create                 job ok
 (none) ──────────► PENDING ──► PROVISIONING ──────► ACTIVE ◄──────────────┐
                        │            │ fail               │  renew          │ unsuspend
                        │            ▼                    │ (gia hạn ngày)  │
                        │         FAILED ──retry──┐       ├── overdue ──► OVERDUE (grace) ──┐
                        │                         │       │                                  │
                        └─ cancel ─► CANCELLED    │       └── suspend(reason) ──► SUSPENDED ◄┘
                                                  │                                 │ terminate
                                                  └► PROVISIONING                   ▼
                                                                         TERMINATED (dữ liệu giữ lại)
                                                                                    │ hết hạn giữ & không legal hold
                                                                                    ▼
                                                                         PURGING ──► PURGED (biên bản xóa)
```

- Các lý do suspend: `overdue`, `abuse`, `admin`, `customer_request`, `security`. Lý do quyết định ai được mở lại: suspend vì abuse thì billing **không** tự mở được, chỉ staff mở.
- Mọi chuyển trạng thái đều idempotent (gọi lại cùng lệnh không lỗi) và ghi `service_lifecycle_events` cùng audit.

### 4.1 Quy trình quá hạn (mặc định, cấu hình được theo gói)
| Mốc | Hành động |
|---|---|
| D-7, D-3, D-1 | Billing gửi nhắc gia hạn (panel gửi thay nếu billing không gửi) |
| D+0 | Billing báo `overdue` → trạng thái OVERDUE, banner trong portal |
| D+3 (grace) | **Suspend**: site hiện trang "tạm ngưng", tắt SFTP/SSH/cron, portal chỉ còn xem và thanh toán. Dữ liệu và backup còn nguyên |
| D+30 | **Terminate**: gỡ cấu hình phục vụ, khóa account, giữ dữ liệu ở trạng thái đóng băng (snapshot cuối cùng) |
| D+30 → D+60 | **Thời gian giữ dữ liệu**: khách có thể yêu cầu khôi phục (có phí theo chính sách của ITSO) |
| D+60 | **Purge có kiểm soát**: job 2 bước (lên lịch → SUPER_ADMIN/hệ thống xác nhận) xóa home, DB, SFTP, cron, cert, và repo backup per account (sau khi hết hạn immutable), rồi sinh **biên bản xóa** (danh sách đối tượng, hash, thời điểm) |
| Legal hold | Cờ `legal_hold` chặn mọi purge cho tới khi gỡ cờ (có audit) |

Khách tự hủy dịch vụ cũng đi theo nhánh terminate → retention → purge, với mốc thời gian riêng.

## 5. Provisioning API (`/api/provisioning/v1`)

| Chủ đề | Thiết kế |
|---|---|
| Client | Mỗi hệ thống tích hợp là một `integration_client` (vd "woocommerce-itso.vn") có `client_id`, scope, IP allowlist, và gói được phép bán |
| Xác thực | Mỗi request ký **HMAC-SHA256** (`X-ITSO-Client`, `X-ITSO-Timestamp`, `X-ITSO-Signature` trên method+path+body hash), lệch ±300s, chống replay bằng nonce. Có thể bổ sung mTLS. Khóa xoay vòng được (2 khóa song song) |
| Idempotency | `Idempotency-Key` bắt buộc. Khóa nghiệp vụ `external_service_id` là duy nhất cho mỗi client, nên gọi tạo lại không sinh dịch vụ thứ hai |
| Bất đồng bộ | Trả `202` kèm `service_id` và `job_id`. Kết quả báo qua webhook và qua `GET` |
| Phân tách | Client chỉ thấy customer/service do chính nó tạo (`created_via`) |

| Endpoint | Mô tả |
|---|---|
| `PUT /customers/{external_customer_id}` | Upsert khách (tên, email, điện thoại, mã số thuế) |
| `POST /services` | Tạo dịch vụ: `external_service_id`, `customer`, `package_code`, `primary_domain`, `server_group`/`region` (tùy chọn), `period_end` → PENDING → placement → PROVISIONING |
| `POST /services/{id}:activate` | Kích hoạt dịch vụ đã tạo nhưng đang chờ (vd chờ thanh toán) |
| `POST /services/{id}:renew` | `{period_end}`: gia hạn; nếu đang OVERDUE/SUSPENDED(overdue) thì tự mở lại |
| `POST /services/{id}:mark-overdue` | Bắt đầu thời gian grace |
| `POST /services/{id}:suspend` | `{reason}` |
| `POST /services/{id}:unsuspend` | Chỉ mở được suspend do chính lý do của billing |
| `POST /services/{id}:terminate` | `{mode: end_of_retention}` |
| `POST /services/{id}:change-package` | Nâng/hạ gói. Placement kiểm tra lại; nếu node hiện tại không đủ thì báo `requires_migration` |
| `GET /services/{id}` | Trạng thái, lifecycle, tài nguyên chính |
| `GET /services/{id}/usage` | Mức dùng (cho tính phí theo sử dụng nếu cần) |
| `POST /services/{id}/sso-links` | Link đăng nhập portal **dùng một lần, sống 60 giây**, cho nút "Quản lý hosting" trên website bán hàng |
| `GET /packages` | Danh sách gói client được phép bán, để đồng bộ sản phẩm |

**Webhook ra** (`service.provisioned`, `service.failed`, `service.suspended`, `service.unsuspended`, `service.terminated`, `service.purged`, `quota.threshold`): ký HMAC, gửi theo **transactional outbox** (bảng `outbox_events`), retry với backoff tối đa 24 giờ, có trang xem và gửi lại trong Admin.

## 6. Billing Adapter (không gắn cứng thanh toán vào lõi)

```
WooCommerce (+ WooCommerce Subscriptions)
   │ hook: order paid / renewal paid / on-hold / cancelled / expired
   ▼
ITSO Billing Adapter for WooCommerce (WP plugin, repo: integrations/woocommerce)
   │ ánh xạ: product meta itso_package_code, period → Provisioning API (HMAC)
   │ nhận webhook từ panel → cập nhật order note / trạng thái
   ▼
ITSO Provisioning API
```

| Sự kiện WooCommerce | Lệnh Provisioning |
|---|---|
| Đơn hàng đầu tiên chuyển "processing/completed" | `PUT customers` + `POST services` |
| Gia hạn thanh toán thành công | `:renew {period_end}` |
| Subscription chuyển "on-hold" (quá hạn) | `:mark-overdue` (panel tự suspend sau grace) |
| Subscription "cancelled" / "expired" | `:terminate` |
| Khách đổi biến thể sản phẩm (switch) | `:change-package` |
| Nút "Quản lý hosting" trong My Account | `:sso-links` → chuyển hướng |

- **Chú ý:** WooCommerce Subscriptions là extension trả phí. Nếu không dùng, adapter phải tự quản chu kỳ gia hạn, việc này phức tạp hơn và cần quyết định riêng (D-34).
- Adapter là một **thành phần ngoài lõi**, giữ credential có scope hẹp. Nếu website WooCommerce bị hack, kẻ tấn công chỉ thao tác được dịch vụ do client đó tạo, không chạm được server.
- Hệ thống thanh toán khác (WHMCS, Odoo, phần mềm tự viết) chỉ cần gọi cùng Provisioning API. Có thể viết thêm adapter sau.

## 7. Server Placement Engine

| Bước | Nội dung |
|---|---|
| Đầu vào | `placement_requirements` của gói (product_line, server_group/region, PHP versions, DB engine, tính năng), dung lượng cần cấp phát (CPU, RAM, disk, inode, số account) |
| **Lọc** | Node `online`, không `draining/maintenance`, đúng group/role (shared/internal/docker), có đủ tính năng, chưa vượt `max_accounts`, không vượt **tỷ lệ overcommit** của group (vd CPU 4:1, RAM 1.5:1, disk 1:1) tính trên tổng quota đã cấp |
| **Chấm điểm** | Có trọng số: phần dư cấp phát (40%), tải thực tế p95 trong 7 ngày (30%), disk thực còn trống (20%), số account (10%). Tie-break theo `server_id` để kết quả luôn xác định |
| **Giữ chỗ** | Bản ghi `capacity_reservations` tạo trong transaction (`SELECT … FOR UPDATE` trên `server_capacity`), tránh hai đơn hàng cùng lúc lấy chỗ cuối cùng. Hủy giữ chỗ nếu provisioning lỗi |
| Giải thích | `placement_decisions` lưu ứng viên, điểm, lý do loại. Có `POST /admin/placement:dry-run` để admin xem trước |
| Can thiệp | Admin chỉ định node thủ công, đặt node `draining` (không nhận mới), pin khách vào một group |
| Không có node phù hợp | Dịch vụ ở PENDING với `state_reason=no_capacity`, cảnh báo admin, billing nhận webhook `service.failed{retryable}` |
| Sau này | Di chuyển account giữa các node (rsync + DB dump + đổi DNS/IP), cân bằng tải lại. Thuộc giai đoạn Production |

## 8. Hosting Package (đầy đủ)

| Nhóm | Giới hạn | Thực thi |
|---|---|---|
| Tài nguyên | CPU (%), RAM (MB), swap, **processes** (TasksMax), **entry processes / PHP workers** (pm.max_children), IO weight + IO bandwidth | cgroups v2, systemd slice, PHP-FPM |
| Lưu trữ | Disk (MB), **inode** | Kernel user quota (block + inode) |
| Số lượng | Website, addon domain, subdomain, parked/alias domain, database, DB user, SFTP/FTP account, cron job, sub-user | Panel (transaction) |
| Mạng | Băng thông/tháng (soft), kết nối ra ngoài/giây, SMTP relay mail/giờ | Đo log Nginx, nftables, relay |
| DB | `MAX_USER_CONNECTIONS`, `max_statement_time`, dung lượng DB (tính vào disk hiển thị) | MariaDB/PostgreSQL |
| Backup | Tần suất, số bản giữ, quota backup khách tự tạo, cho phép tự restore/tải về | Restic repo per account |
| Quyền | SSH (jail), FTPS, phiên bản PHP được phép, giới hạn php.ini, Node.js app (sau), Docker (**không** cho shared) | Agent, policy |
| Vòng đời | Thời gian grace, thời gian giữ dữ liệu sau terminate | Lifecycle engine |
| Placement | product_line, server_group, region | Placement Engine |

Package **có version**: sửa gói tạo version mới. Dịch vụ cũ giữ version cũ cho tới khi admin chạy "migrate to version" (job hàng loạt có báo cáo).

## 9. Cách ly khách hàng (tổng hợp)

| Lớp | Thiết kế |
|---|---|
| Linux UID/GID | Một UID/GID cho mỗi account, cấp từ dải `20000–59999` (riêng mỗi node), không tái sử dụng UID trong 90 ngày sau purge (tránh file mồ côi bị gán chủ mới) |
| PHP-FPM | Master riêng cho mỗi account, chạy dưới UID account, nằm trong slice của account, sandbox systemd (D-12, D-29) |
| cgroups v2 | `itso-acct-<id>.slice`: CPUQuota, MemoryHigh/Max, TasksMax, IOWeight, IO*BandwidthMax |
| Filesystem quota | User quota block + inode. Node chỉ được nhận khách khi quota đã bật (điều kiện để node `ready`) |
| Database | Mỗi account có user riêng với tiền tố `acctname_`, chỉ có quyền trên DB của mình, không có quyền global, giới hạn tài nguyên per user. PostgreSQL: `REVOKE CONNECT … FROM PUBLIC`, `pg_hba` theo DB/role |
| SFTP | OpenSSH `internal-sftp`, `ChrootDirectory` vào home (home thuộc root), tài khoản phụ chroot vào thư mục con |
| Sandbox | `ProtectSystem=strict`, `ProtectHome=tmpfs` + BindPaths, `ProtectProc=invisible`, `PrivateTmp`, `NoNewPrivileges`, seccomp |
| Mạng | Egress per UID (chặn 25, chặn dải nội bộ/metadata, rate limit) |
| Panel | Guard tách biệt, mọi truy vấn portal giới hạn theo `customer_id` (global scope + test), có thể thêm RLS PostgreSQL |
| Backup | Repo restic và mật khẩu riêng cho mỗi account |

## 10. Hỗ trợ kỹ thuật và kiểm soát truy cập dữ liệu khách

- Vai trò **SUPPORT** mặc định chỉ xem metadata: trạng thái dịch vụ, log lỗi đã che dữ liệu, usage. Không mở được file, DB hay email của khách.
- **Support Access Grant:** truy cập dữ liệu khách cần (a) khách bấm cho phép trong portal (phạm vi + thời hạn, vd 24 giờ), hoặc (b) **break-glass** khi khẩn cấp: nhân viên ghi lý do, SUPER_ADMIN duyệt, khách được thông báo sau.
- Phiên impersonate có banner rõ ràng, giới hạn thời gian, mọi thao tác ghi audit với `impersonator_id`. Terminal/xem file trong phiên này được ghi lại.
- **Bảo vệ dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP):** sổ đăng ký hoạt động xử lý dữ liệu, tối thiểu hóa dữ liệu thu thập, mã hóa PII nhạy cảm, xuất dữ liệu theo yêu cầu của khách, bảng thời gian lưu giữ (audit 12 tháng, log truy cập 90 ngày, dữ liệu sau terminate theo §4.1), quy trình thông báo khi có sự cố rò rỉ.

## 11. Docker Hosting (dòng sản phẩm riêng, cách ly riêng)

- **Shared hosting node không bao giờ chạy Docker của khách.** Khách không có socket, không có root, không chạm hệ thống quản trị.
- Docker Hosting cho khách là một **product line riêng** chạy trên **node riêng**. Có hai phương án:
  - (A, khuyến nghị) **Mỗi khách một VM** (KVM qua libvirt/Proxmox) chạy Docker bên trong. Agent quản lý VM, khách có thể có root trong VM của mình. Ranh giới cách ly là hypervisor.
  - (B) Rootless Podman/Docker cho từng khách trên node container, kèm user namespace và gVisor. Rẻ hơn nhưng ranh giới yếu hơn kernel dùng chung.
- Ở giai đoạn Alpha/Beta, Docker chỉ dùng cho **ứng dụng do admin quản lý**. Docker Hosting cho khách được thiết kế chi tiết sau khi phát hành Production (D-38).

## 12. Roadmap 3 giai đoạn (thay thế danh sách Phase trước)

| Giai đoạn | Phase | Nội dung | Mốc |
|---|---|---|---|
| **A. Internal Alpha** | 1 | Foundation (contracts gồm cả Provisioning API khung) | |
| | 2 | Complete UI Demo: **Admin Panel + Customer Portal** (hai entry), dữ liệu demo nhất quán | |
| | 3 | Identity tách staff/customer, RBAC, Customer/Package version/Service/Subscription/Account (dữ liệu), Lifecycle engine (chưa có billing), Jobs, Audit, Outbox | |
| | 4 | Go Agent, Installer (`all-in-one`), CLI, cách ly (UID, slice, quota, sandbox, egress) | |
| | 5 | Website / Nginx / PHP / SSL | |
| | 6 | Database / File Manager / SFTP / Cron | |
| | 7 | Security Center (firewall, Fail2ban, WAF, malware, FIM, SSH, terminal) | |
| | 8 | Backup per account, offsite immutable, restore, DR cơ bản | **v0.1.0-alpha**: chỉ dùng nội bộ |
| **B. Hosting Provider Beta** | 9 | Multi-server: control plane tách riêng, `--role node --join`, mTLS, CA nội bộ, server groups, capacity, **Placement Engine** | |
| | 10 | Customer Portal hoàn chỉnh, sub-users, Service Lifecycle đầy đủ (quá hạn, thông báo, retention, purge có biên bản), Support Access, PDPD | |
| | 11 | **Provisioning API** + webhook outbox + SSO link + **Billing Adapter WooCommerce** | |
| | 12 | Abuse & Compliance, monitoring/alerts cho provider, **Beta Gate** (bộ test isolation + priv-esc nội bộ, DR drill) | **v0.5.0-beta**: khách thử nghiệm miễn phí, **chưa thu phí** |
| **C. Production Release** | 13 | WordPress Toolkit, Software catalog, DNS (provider API, PowerDNS tùy chọn), Git deploy | |
| | 14 | Docker cho app do admin quản lý; thiết kế Docker Hosting trên VM cô lập | |
| | 15 | Production Hardening + **Paid Customer Gate** (pentest độc lập, upgrade/rollback drill, DR drill có đo RTO/RPO, chaos, SLA, status page, quy trình sự cố) | **v1.0.0**: mở bán trả phí |

So với bản trước: multi-server đưa lên Phase 9 (trước đây là 11/12) vì Hosting Provider cần nó trước khi có khách. Docker xuống Phase 14 vì không bán cho khách shared. Tổng: **15 Phase, khoảng 60 prompt**.

## 13. Paid Customer Gate (điều kiện bắt buộc trước khi nhận khách trả phí)

Không triển khai khách trả phí nếu **bất kỳ** mục nào dưới đây chưa đạt (yêu cầu số 15):

| # | Kiểm thử | Tiêu chí đạt |
|---|---|---|
| PG1 | **Isolation** | Bộ test tự động trên cụm ≥ 2 node: account A không đọc/ghi/liệt kê được file, tiến trình, DB, socket, backup của B. Bao gồm qua PHP, cron, SFTP, SSH jail, File Manager. 100% pass |
| PG2 | **Resource enforcement** | CPU/RAM/process/IO/disk/inode bị chặn đúng giới hạn, không ảnh hưởng account khác |
| PG3 | **Privilege escalation** | Pentest độc lập (bên thứ ba) + test nội bộ: từ webshell, từ tài khoản khách, từ Provisioning client bị lộ khóa, từ Laravel RCE giả định. Không còn lỗi High/Critical |
| PG4 | **Backup/Restore** | Restore ngẫu nhiên 10 account trên node khác thành công. Panel không xóa được backup immutable |
| PG5 | **Upgrade** | Nâng cấp control plane và agent qua ≥ 3 phiên bản liên tiếp, rollback giữa chừng, không gián đoạn site khách |
| PG6 | **Disaster recovery** | Mất control plane: dựng lại từ backup, các node kết nối lại. Mất một node: khôi phục toàn bộ account sang node khác. Đạt RTO/RPO đã công bố |
| PG7 | **Lifecycle** | Kịch bản quá hạn → suspend → terminate → purge chạy đúng mốc thời gian, có biên bản xóa. Legal hold chặn được purge |
| PG8 | **Vận hành** | Runbook sự cố, giám sát và cảnh báo 24/7, quy trình abuse, ToS và chính sách dữ liệu đã được pháp lý duyệt |
