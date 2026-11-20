# 02 — Kiến trúc đề xuất

> **Phạm vi chốt 2026-11-20 (nội bộ):** bản tổng hợp hiện hành nằm ở `seed/ARCHITECTURE.md`. File này vẫn là chi tiết kỹ thuật; phần nào mâu thuẫn thì theo `seed/ARCHITECTURE.md`.

> Tài liệu này là nguồn cho `ARCHITECTURE.md` ở gốc repository.
>
> **Cập nhật 2026-11-20 (Hosting Provider):** sơ đồ §1 mô tả bản Internal Alpha all-in-one. Kiến trúc đích là control plane riêng cùng nhiều node; xem §11 và `15-HOSTING-PROVIDER.md`.

## 1. Sơ đồ tổng thể

```
                         Trình duyệt (React SPA)
                                 │  HTTPS :<panel_port>  (cookie session + CSRF)
                                 ▼
┌──────────────────────── Máy chủ điều khiển (control plane) ────────────────────────┐
│  itso-web  (FrankenPHP/Caddy: TLS, phục vụ SPA tĩnh, reverse proxy)                 │
│     ├── /api/v1/*  ──► itso-api  (Laravel Octane, user: itso, không root)           │
│     └── /ws, /sse  ──► itso-gateway (Go, user: itso-gw, không root)                 │
│                                                                                     │
│  itso-api ──► PostgreSQL cluster "itso" (unix socket)   ◄── desired/observed/jobs   │
│      │    ──► itso-redis (unix socket)  ◄── queue, cache, locks, rate-limit         │
│      ▼                                                                              │
│  itso-worker (Laravel queue workers / Horizon)  ──► AgentClient (typed ops)         │
│  itso-scheduler (Laravel schedule:work)                                             │
└──────────────────────────────────────┬──────────────────────────────────────────────┘
                                       │ Local: unix socket /run/itso/agent.sock (SO_PEERCRED)
                                       │ Remote (Phase 11): mTLS, agent kết nối ra ngoài
                                       ▼
┌──────────────────────── Máy chủ được quản lý (mỗi server 1 agent) ──────────────────┐
│  itso-agent (Go, root, systemd hardened)                                            │
│     ├── Operation Registry (typed ops + JSON Schema)                                │
│     ├── Policy Engine (local policy /etc/itso/agent-policy.yaml, root-only)         │
│     ├── Executors: platform/ubuntu2404 (apt, systemd D-Bus, nft, users, quota, fs)  │
│     ├── Reconcilers: nginx, php-fpm, slices, cron timers, firewall                  │
│     ├── Collectors: metrics, service health, drift                                  │
│     └── Audit log local (append-only, hash chain)                                   │
│                                                                                     │
│  Hosting runtime: nginx · php-fpm@ver-acct · mariadb/mysql · postgresql main ·      │
│                   redis · docker (tùy chọn) · openssh (sftp) · nftables · fail2ban   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Single-server (v0.1): control plane và managed server là **cùng một máy**, giao tiếp qua unix socket. Multi-server (Phase 11): control plane gọi agent từ xa qua mTLS; mọi bảng đã có `server_id` từ Phase 3.

## 2. Thành phần và ranh giới trách nhiệm

| Thành phần | Ngôn ngữ | User Linux | Trách nhiệm | Không được làm |
|---|---|---|---|---|
| **Frontend** (`apps/web`) | React/TS | — (file tĩnh) | UI, i18n, theme, gọi API, hiển thị job | Chứa secret, logic phân quyền cuối cùng |
| **API** (`apps/api`) | Laravel | `itso` | Auth, RBAC, validation nghiệp vụ, desired state, tạo job, audit | Chạy lệnh hệ thống, đọc file hosting, giữ root |
| **Worker** | Laravel | `itso` | Thực thi job: gọi agent, cập nhật observed state, retry | Như API |
| **Scheduler** | Laravel | `itso` | Lịch backup, drift check, cleanup, cảnh báo | Như API |
| **Gateway** (`agent/cmd/itso-gateway`) | Go | `itso-gw` | WebSocket/SSE: terminal, log tail, job progress; xác thực ticket ngắn hạn do API cấp | Tự quyết định quyền |
| **Agent** (`agent/cmd/itso-agent`) | Go | `root` (hardened) | Thao tác đặc quyền qua typed ops, reconcile, metrics | Nhận lệnh shell tùy ý, path tùy ý |
| **CLI** (`agent/cmd/itso`) | Go | root (sudo) | Install/repair/update/rollback/uninstall, reset admin, bật/tắt policy nguy hiểm | — |
| **Installer** (`installer/install.sh`) | Bash | root | Bootstrap tối thiểu rồi giao cho `itso install` | Logic phức tạp (đưa vào CLI Go) |
| **Database** | PostgreSQL 16 cluster `itso` | `postgres` | Lưu trạng thái panel | Phục vụ database của USER |
| **Queue/Cache** | Redis `itso-redis` | `itso-redis` | Queue, lock, cache, rate limit | Phục vụ website |

**Nguyên tắc vàng:** Bash installer chỉ làm phần "có Go binary chạy được"; mọi logic còn lại nằm trong `itso` CLI (Go) để test được và idempotent.

## 3. Luồng thao tác bất đồng bộ (ví dụ: tạo website)

```
1. SPA  POST /api/v1/websites  (Idempotency-Key: uuid)
2. API  : Policy check (user sở hữu hosting account? còn quota website/domain?)
         → ghi websites (desired, spec_version=1, status=pending)
         → ghi jobs (type=website.provision, state=queued) + audit_logs
         → trả 202 {job_id, website_id}
3. Worker lấy job → build JobPlan gồm các bước typed op:
         system.user.ensure → fs.site_layout.ensure → php.pool.apply → nginx.vhost.apply
         → nginx.reload (sau nginx -t) → cert.issue (nếu bật SSL)
4. Mỗi bước gọi Agent: {op, op_id (= job_id:step), params, deadline}
         Agent: validate schema → policy → thực thi idempotent → trả kết quả + observed facts
5. Worker cập nhật job_steps, websites.observed_* ; phát event qua Redis pub/sub
6. Gateway đẩy tiến độ cho SPA qua SSE; SPA invalidate TanStack Query
7. Lỗi: retry theo chính sách của bước; bước không thể retry → chạy compensation
         (vd: xóa vhost vừa tạo) → job failed, giữ log chi tiết
```

## 4. Desired State · Observed State · Job State

| Loại | Ý nghĩa | Nơi lưu | Ai ghi |
|---|---|---|---|
| **Desired** | Người dùng *muốn* hệ thống thế nào (site có domain X, PHP 8.3, SSL bật) | Cột cấu hình trong bảng tài nguyên + `spec_version` (tăng mỗi lần đổi) | API |
| **Observed** | Agent *thấy* hệ thống thực sự thế nào | `observed_version`, `observed_status`, `observed_at`, `observed_facts jsonb`, `drift jsonb` | Worker (từ kết quả agent) |
| **Job** | Tiến trình đưa observed về desired | `jobs`, `job_steps`, `job_logs` | Worker |

- Tài nguyên "ổn định" khi `observed_version == spec_version` và `observed_status = ready`.
- **Drift detection:** scheduler định kỳ gọi `*.inspect` → nếu khác desired, đánh dấu `drift` và cảnh báo; không tự sửa trừ khi bật `auto_reconcile`.
- Agent **không giữ desired state lâu dài**; nó nhận spec đầy đủ mỗi lần apply (declarative, idempotent) → dễ multi-server và dễ repair (`itso repair` = re-apply toàn bộ desired state).

## 5. Bố cục hệ thống tệp trên server

| Đường dẫn | Nội dung | Update ghi đè? | Uninstall xóa? |
|---|---|---|---|
| `/opt/itso/releases/<version>/` | api, web dist, binaries, runtime | Thêm bản mới | Có |
| `/opt/itso/current` → symlink | bản đang chạy (đổi nguyên tử khi update/rollback) | Có | Có |
| `/etc/itso/` | `itso.yaml`, `agent-policy.yaml`, PKI agent, `.env` của API | Không (merge) | Hỏi (mặc định giữ bản sao) |
| `/var/lib/itso/` | PostgreSQL cluster panel, master key, state agent | Không | Chỉ khi `--purge-panel-data` |
| `/var/log/itso/` | log panel, audit local | Không | Hỏi |
| `/var/backups/itso/` | backup trước update, local restic repo | Không | **Không bao giờ** tự xóa |
| `/home/<account>/` | dữ liệu hosting | Không | **Không bao giờ** |
| `/var/lib/mysql`, `/var/lib/postgresql/16/main` | DB của hosting | Không | **Không bao giờ** |
| `/etc/nginx/sites-itso/` | vhost do panel sinh | Re-render | Giữ (tắt include) |

## 6. Cô lập hosting account (tóm tắt — chi tiết ở `07-HOSTING-ISOLATION.md`)

- 1 hosting account = 1 Linux user + group riêng, home `/home/<acct>`.
- 1 systemd slice `itso-acct-<id>.slice` chứa: PHP-FPM master riêng của account (`itso-php@<ver>-<acct>.service`), cron timers, managed apps.
- Giới hạn: `CPUQuota`, `MemoryMax/MemoryHigh`, `TasksMax`, `IOWeight` trên slice; disk bằng **ext4/XFS user quota**.
- Nginx dùng chung (www-data) nhưng chỉ đọc static qua ACL; PHP chạy dưới user của account.

## 7. Cấu trúc repository (monorepo)

```
itso-panel/
├── PROJECT_PLAN.md  ARCHITECTURE.md  ROADMAP.md  PHASE_STATUS.md  DECISIONS.md  TEST_REPORT.md
├── CLAUDE.md                         # quy tắc làm việc cho Claude Code
├── apps/
│   ├── web/                          # React + Vite + shadcn/ui
│   └── api/                          # Laravel
├── agent/                            # Go module: github.com/<org>/itso-panel/agent
│   ├── cmd/itso-agent/  cmd/itso/  cmd/itso-gateway/  cmd/itso-mock-agent/
│   ├── internal/ops/<domain>/        # typed operations
│   ├── internal/platform/ubuntu2404/
│   ├── internal/policy/  internal/transport/  internal/audit/
│   └── templates/                    # nginx, php-fpm, systemd (embed)
├── contracts/
│   ├── openapi/itso-api-v1.yaml      # nguồn sự thật cho REST
│   └── agent-ops/*.schema.json       # nguồn sự thật cho typed ops → codegen Go/PHP/TS
├── installer/  install.sh, wizard notes
├── packaging/  systemd units, build scripts, release manifest
├── demo/       seed dữ liệu demo nhất quán (JSON) dùng chung cho MSW và Laravel seeder
├── docs/  planning/  adr/  screenshots/  runbooks/
└── .github/workflows/                # CI: lint, test, build, e2e, screenshot
```

## 8. Dịch vụ systemd

| Unit | Mô tả |
|---|---|
| `itso-agent.service` | Agent root, socket `/run/itso/agent.sock` (0660 root:itso-agent-clients) |
| `itso-web.service` | FrankenPHP/Caddy + Laravel Octane |
| `itso-worker@.service` | Queue workers (nhiều instance) |
| `itso-scheduler.service` | Laravel scheduler |
| `itso-gateway.service` | WebSocket/SSE |
| `postgresql@16-itso.service` | DB panel |
| `itso-redis.service` | Redis panel |
| `itso.target` | Gom toàn bộ để start/stop cùng lúc |

## 9. Giao tiếp Agent

- **Local:** HTTP/1.1 JSON trên unix socket. Agent kiểm tra `SO_PEERCRED` (uid phải thuộc group `itso-agent-clients`: `itso`, `itso-gw`) **và** chữ ký HMAC của request bằng khóa trong `/etc/itso/agent-client.key` (0640 root:itso) — chống một tiến trình khác chạy dưới user `itso` bị lợi dụng chỉ bằng socket.
- **Remote (Phase 11):** agent **chủ động kết nối ra** control plane (gRPC/HTTP2 + mTLS, cert ngắn hạn do CA nội bộ của panel cấp, xoay vòng tự động). Không phải mở port trên server được quản lý.
- **Envelope chung:** `{op, op_id, version, params, deadline, requested_by{user_id, role}, trace_id}`. `op_id` dùng cho idempotency phía agent (cache kết quả 24h).
- Stream (log, terminal): agent ↔ gateway qua socket riêng `/run/itso/agent-stream.sock`, mở bằng ticket một lần.

## 10. Quyết định kiến trúc then chốt
Xem `DECISIONS.md` (seed). Tóm tắt: D-01 runtime panel riêng (FrankenPHP), D-02 PostgreSQL cluster riêng, D-03 Redis riêng, D-06 CLI Go, D-07 gateway Go, D-10 nftables trực tiếp, D-12 PHP-FPM master per account, D-13 agent root + policy local, D-14 contracts-first.

## 11. Kiến trúc đích: Hosting Provider (cập nhật 2026-11-20)

| Chủ đề | Thay đổi |
|---|---|
| Topology | **Control plane** (Laravel, PostgreSQL, Redis, gateway, CA nội bộ) chạy trên máy riêng, không chứa site khách. **Node** (shared / internal / backup / docker-VM) chỉ chạy agent và hosting runtime. Alpha vẫn cài all-in-one được |
| Installer | `--role all-in-one` (mặc định) · `--role control-plane` · `--role node --join <token>` |
| Giao tiếp agent | mTLS, agent kết nối ra control plane (từ Phase 9). Unix socket chỉ còn dùng cho all-in-one |
| Mặt API | 3 bề mặt trên cùng control plane: **Admin API** `/api/v1/admin/*` (origin admin, IP allowlist, MFA), **Portal API** `/api/v1/portal/*` (origin my, public), **Provisioning API** `/api/provisioning/v1` (HMAC client, IP allowlist) |
| Danh tính | Hai guard và hai bảng: `staff_users` (SUPER_ADMIN, ADMIN, SUPPORT, BILLING_OPERATOR) và `customer_users` (OWNER, MEMBER) |
| Miền nghiệp vụ mới | Customer · HostingPackage + PackageVersion · HostingService · Subscription (bản sao billing) · HostingAccount · Lifecycle engine · Placement Engine · Outbox/Webhook · SupportAccessGrant · DataRetention |
| Billing | **Ngoài lõi**: Billing Adapter (plugin WooCommerce, sau này thêm adapter khác) gọi Provisioning API. Lõi không xử lý tiền |
| Frontend | Một codebase React, hai entry build `admin` và `portal`, dùng chung design system |
| Docker Hosting | Product line riêng trên VM cô lập theo từng khách (sau v1.0). Shared node không chạy Docker của khách |
| Cấu trúc repo | Thêm `integrations/woocommerce/` (WP plugin), `apps/web/src/entries/{admin,portal}`, `contracts/openapi/itso-provisioning-v1.yaml` |

Luồng bán hàng điển hình:
```
Khách thanh toán trên WooCommerce → Adapter: PUT customer + POST service (Idempotency-Key)
→ Lifecycle: PENDING → Placement Engine chọn node + giữ chỗ → PROVISIONING (jobs → agent trên node)
→ ACTIVE → outbox gửi webhook service.provisioned → Adapter ghi chú đơn hàng, gửi email chào mừng có SSO link
```
