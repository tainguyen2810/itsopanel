# Báo cáo Phase 4: Go Agent, Installer, CLI, cách ly và quota

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM. Nhánh `phase-4`, merge `--no-ff` vào `main` ở Git local (không push, không remote). Các tiêu chí cần máy Linux thật được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`make test-vm`).
- **Thời gian:** 2026-11-21.
- **Cách làm đã chọn:** "Làm trước, VM test sau". Code và test chạy với runner giả, sandbox, và stack cloud thật (PostgreSQL 16 + Redis + Laravel + itso-agent `--sandbox`). Container cloud không có KVM/systemd/cgroup v2 nên chưa chạy được trên VM.
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Agent không có op chạy lệnh tùy ý, không dùng `sh -c`. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.
- **Quyết định đề xuất chờ duyệt:** D-63 (lớp nền tảng Runner/FS), D-64 (slice + quota, có sửa: cha của slice suy ra từ tên), D-65 (ký release Ed25519), D-66 (HMAC + SO_PEERCRED cho caller của agent).

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 4.1 Spike + contracts | ADR slice/SSH/quota (0011), contracts op Phase 4 (`account.limits.apply`, `account.remove`, `metrics.cgroup`, `software.install/remove`, `system.hostname.set`, `audit.tail`…), 112 vector độc | 69ce0ef |
| 4.2 Agent core | `cmd/itso-agent`: unix socket + SO_PEERCRED + HMAC (D-66), policy YAML cục bộ, audit JSONL hash-chain, lớp nền tảng `platform.Runner`/`FS` (thật `ubuntu2404`, giả cho test), validators dùng chung + fuzz; Laravel `AgentClient` ký HMAC | 6a44671 |
| 4.3 Ops thật | system.info/ping/reboot/hostname.set, service.status/control (allowlist), account.ensure/limits.apply/suspend/unsuspend/remove, quota.apply/report, metrics.snapshot/cgroup, software.install/remove (recipe allowlist), audit.tail, op.cancel; golden argv/file cho 15 op | c5bffe0 |
| 4.4 CLI + installer | CLI `itso` (install, status, doctor, url, setup-code, admin reset, policy, update/rollback/repair, uninstall, logs), `install.sh` kiểm chữ ký, `make release` (tar + manifest + Ed25519 + SBOM), unit systemd (`itso.target`, agent, web, worker, scheduler, slice) | 28bb3fc |
| 4.5 Panel | Bảng Phase 4, thẻ Nền tảng trên Server detail, dịch vụ/phần mềm/reboot qua job, metrics server/account, usage từ snapshot, `/system/updates`, wizard cài đặt lần đầu (mã một lần, bước 0–3, 6, 9) nối API thật | 4bda07a, ab61378 |
| 4.6 Tích hợp | Bộ test VM `tests/vm/` (Multipass + Vagrant, enforcement, cài 2 lần, agent từ chối, update → rollback, uninstall); `make dev` chạy itso-agent `--sandbox` (mock vẫn dùng được bằng `ITSO_DEV_AGENT=mock`); Playwright stack thật với agent sandbox (thêm Server detail, usage); job dịch vụ đặt tên theo hành động (`service.restart`…) cho khớp nhãn UI | (commit 4.6) |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/cmd/itso-agent`, `agent/internal/{server,auth,policy,audit,platform,ops,registry,validate}` |
| CLI + installer | `agent/cmd/itso`, `agent/internal/install`, `packaging/install.sh.in`, `packaging/systemd/` |
| Release | `scripts/release.sh`, `scripts/sbom.py` |
| Panel Phase 4 | `apps/api/app/Domain/{Servers,Setup}/`, `app/Http/Controllers/Api/V1/Admin/{ServerOps,Setup,System}Controller.php` |
| UI | `apps/web/src/entries/admin/install/`, `src/entries/admin/servers/ServerDetailPage.tsx` |
| Bộ test VM | `tests/vm/` (`run-all.sh`, `enforcement.sh`, `multipass.sh`, `Vagrantfile`, `lib/`) |
| E2E stack thật | `apps/web/e2e-real/{helpers,phase3.spec,phase4.spec}.ts` |
| Runbook | `docs/runbooks/phase-4-vm-test.md` |

## 3. Cách chạy thử

- Dev: `make dev` (Laravel + queue + Vite + itso-agent `--sandbox`; khóa HMAC và gốc sandbox ở `.dev/agent-sandbox/`, không commit), seed `DemoSeeder`, rồi `make test-e2e-real`.
- VM: `make release && make test-vm` (xem `docs/runbooks/phase-4-vm-test.md`).

## 4. Kết quả test

`make check` (2026-11-21, PostgreSQL 16 + Redis cục bộ): **KẾT_QUẢ_CHECK**. Chi tiết ở `TEST_REPORT.md` (Prompt 4.6).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | SỐ_PEST |
| Go (race, 12 package) | PASS |
| Vitest | SỐ_VITEST |
| Playwright (demo MSW + Design System) | SỐ_E2E |
| Playwright stack thật + agent sandbox (`make test-e2e-real`) | 6/6 |
| Installer (`make test-installer`) · unit systemd (`make units-check`) | 8/8 · 12 unit |
| pint, phpstan, ESLint, Prettier, tsc, i18n, gofmt, go vet, no-exec | xanh |

E2E stack thật với agent thật ở chế độ sandbox (ký HMAC như máy thật, runner giả, không chạy lệnh hệ thống):

1. Bốn luồng Phase 3 (MFA, tạo user → gói → account → job → khóa/mở, phạm vi Portal, sai realm) chạy qua itso-agent sandbox thay cho mock: PASS.
2. Server detail: thẻ Nền tảng hiện "Sandbox (không đổi máy thật)", kiến trúc amd64; khởi động lại nginx tạo job `service.restart` → op `service.control` → thành công; tab Tài nguyên hiện dung lượng đã cấp.
3. Account: tab Tổng quan hiện mức sử dụng (đĩa, inode, CPU, RAM) từ snapshot `itso:usage-refresh`; API usage trả 200.

Kiểm tay agent sandbox: op `system.exec` → `unknown_op`; tham số sai → `invalid_params`; không ký hoặc ký sai → `unauthorized_caller`; audit JSONL ghi từng op với `op_id` và `params_hash`.

## 5. Tiêu chí nghiệm thu Phase 4 (11-ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Cài sạch ≤ 10 phút trên VM 2 vCPU/2 GB | **chờ VM** | Script V1 trong `tests/vm/run-all.sh` đo thời gian. Đã kiểm trên container: install.sh kiểm chữ ký/sha, `itso install` dừng đúng khi thiếu systemd/cgroup v2, cài lại tiếp từ bước hỏng (test Go `internal/install`) |
| Mọi test enforcement đạt (CPU, RAM/OOM, TasksMax, quota đĩa, cách ly /home, ps) | **chờ VM** | Script E1–E7 trong `tests/vm/enforcement.sh`. Đã kiểm với runner giả: golden argv/drop-in slice, quyền home 0750, soft quota đo được, đọc cgroup đúng |
| `sudo -l -U itso` rỗng | **chờ VM** | Script E8. Installer không tạo file sudoers nào (test Go) |
| Agent từ chối op không có trong registry và tham số sai | ✓ (sandbox) · VM: chờ | Test Go (registry, schema, 112 vector độc, 0 lệnh chạy), kiểm tay trên agent sandbox, script A1–A5 cho VM |

## 6. Còn lại / rủi ro

- **Chạy bộ test VM** và dán kết quả vào mục 5 (người dùng chọn nơi chạy: máy có Multipass hoặc Vagrant).
- Release chưa có `frankenphp` (cần tải bản upstream lúc đóng gói), manifest ghi `missing_components`; cài trên VM sẽ báo thiếu web server cho tới khi bổ sung.
- `shellcheck` và `staticcheck` không có trên container (bước staticcheck trong `make check` là SKIP).
- Coverage %: vẫn không đo được (không có pcov/xdebug), như Phase 3.

## 7. Bước tiếp theo

Chờ duyệt Phase 4 và D-63 → D-66. **Không** bắt đầu Phase 5 khi chưa được duyệt.
