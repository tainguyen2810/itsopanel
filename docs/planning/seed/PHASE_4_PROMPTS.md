# Phase 4 — Go Agent, Installer, CLI, thực thi giới hạn: prompt chi tiết

> Viết ngày 2026-11-21, sau khi Phase 3 hoàn tất và người dùng yêu cầu "tiếp tục với Phase 4". Nguồn: `ROADMAP.md`, `docs/planning/11-ROADMAP.md` §Phase 4, `12-PHASE-PROMPTS.md` (4.1–4.6), `06-AGENT-SECURITY.md`, `07-HOSTING-ISOLATION.md`, `10-INSTALLER.md`, `contracts/agent-ops/catalog.json`, `database/schema/itso.dbml`.
> Nhánh `phase-4`. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.

## Mục tiêu Phase 4

Agent thật (`itso-agent`) cho Ubuntu 24.04: socket Unix + SO_PEERCRED + HMAC, registry op có kiểu, policy cục bộ, audit cục bộ hash-chain, các op account/slice/quota/system/service/metrics/software (recipe). CLI `itso` (install, status, doctor, admin reset, policy, update/rollback/repair khung, uninstall) + `install.sh` + đóng gói release có ký. Panel: bảng Phase 4, API server/services/software/metrics/usage thật, Wizard cài đặt (bước 0–3, 6, 9). Mock agent vẫn giữ cho dev/test.

## Ràng buộc môi trường (quan trọng)

- Container cloud **không có KVM, systemd không phải PID 1**, không có Docker daemon → **không chạy được VM, không áp slice/quota thật ở đây**. Quy tắc dự án: không đổi cấu hình máy chủ thật; Phase 4+ chỉ chạy thật trên VM test.
- Cách làm: agent có **lớp nền tảng** (D-63): mọi lệnh hệ thống đi qua `Runner` (argv cố định, đường dẫn tuyệt đối, không shell) và mọi file hệ thống đi qua `FS` có gốc cấu hình được (`--root`). Test dùng runner giả ghi lại argv + thư mục tạm làm gốc (golden test), không đụng hệ thống. Chế độ `--sandbox` của agent thật dùng runner giả để chạy stack dev/e2e với transport, HMAC, policy, audit **thật**.
- Bộ test VM (Multipass/Vagrant + script enforcement theo `07-HOSTING-ISOLATION.md` §9, installer chạy 2 lần, uninstall giữ `/home`, update→rollback) được viết đủ và chạy được bằng một lệnh; **kết quả VM ghi vào báo cáo khi có VM** (người dùng chọn nơi chạy). Tiêu chí nghiệm thu cần VM được đánh dấu rõ "chờ VM" nếu chưa chạy.

## Quyết định kỹ thuật dùng trong Phase 4 (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-63 | Lớp nền tảng agent | `platform.Runner` (exec argv, đường dẫn binary tuyệt đối từ bảng cố định, env tối giản, timeout theo ctx; cấm `sh`, `bash`, `-c`) + `platform.FS` (gốc cấu hình được, ghi atomic: file tạm + fsync + rename, `O_NOFOLLOW`) ; agent thật dùng `ubuntu2404`, test/dev dùng `fake` | Test được không cần root/VM; một điểm kiểm soát lệnh hệ thống |
| D-64 | Slice và quota | Slice `itso-acct-<uid>.slice` dưới `itso-hosting.slice`, drop-in `/etc/systemd/system/itso-acct-<uid>.slice.d/50-itso.conf` (CPUQuota, MemoryMax, MemoryHigh=90%, MemorySwapMax, TasksMax, IOWeight); phiên SSH: drop-in tương tự cho `user-<uid>.slice` với 50% giới hạn (phương án (a) của 07 §3). Disk: user quota kernel bằng `setquota -u` (block + inode, soft = 95% hard); filesystem không bật quota → chế độ `soft` (đo, cảnh báo) và báo `quota_mode` trong `system.info` | Khuyến nghị sơ bộ của 07; đơn giản, đảo ngược được |
| D-65 | Ký release | Ed25519; `manifest.json` (phiên bản, sha256 từng file) ký bằng khóa riêng ngoài repo; `install.sh` kiểm bằng `openssl pkeyutl -verify -rawin` (OpenSSL 3 có sẵn trên Ubuntu 24.04) với public key nhúng; khóa dev sinh tạm khi build cục bộ, không commit khóa riêng | Không cần cài minisign trên máy sạch |
| D-66 | Xác thực caller của agent | HMAC-SHA256 trên `v1\n{method}\n{path}\n{ts}\n{nonce}\n{sha256(body)}` (header `X-ITSO-Signature`, `X-ITSO-Timestamp`, `X-ITSO-Nonce`), khóa trong `/etc/itso/agent.key` (0640 root:itso-agent-clients); SO_PEERCRED: uid ∈ allowlist (`itso`, `itso-gw`, root cho CLI); lệch giờ ±60 s, nonce cache | Theo 06 §3, cụ thể hóa định dạng |

Giữ nguyên: Laravel không chạy lệnh hệ thống (`check-no-exec`); agent không có op chạy lệnh tùy ý; contract trước code (`make contracts` → `make codegen`).

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 4.1 | Spike (tài liệu + kiểm trên container những gì kiểm được) → ADR slice/SSH/quota; contracts op Phase 4 (bổ sung op còn thiếu, `account.limits.apply`, `account.remove`, `metrics.cgroup`, `software.install/remove`, `system.hostname.set`, `audit.tail` đặc tả đầy đủ); test-vectors evil inputs mới | 0,5 ngày |
| 4.2 | Agent core: `cmd/itso-agent`, transport socket + peercred + HMAC, policy cục bộ YAML, audit cục bộ hash-chain, lớp nền tảng (Runner/FS, fake), validators dùng chung + fuzz; Laravel `AgentClient` ký HMAC | 1 ngày |
| 4.3 | Ops thật: system.info/ping/reboot/hostname.set, service.status/control (allowlist), account.ensure/limits.apply/suspend/unsuspend/remove, quota.apply/report, metrics.snapshot/cgroup, software.install/remove (recipe allowlist), audit.tail, op.cancel; golden test argv/file với runner giả | 1 ngày |
| 4.4 | CLI `itso` (install, status, doctor, url/setup-code, admin reset-password/reset-mfa, policy get/set, update/rollback/repair khung, uninstall, logs), `install.sh`, `make release` (tar + manifest + ký Ed25519 + SBOM tối thiểu), systemd units (`itso.target`, agent, web FrankenPHP, worker, scheduler) | 1 ngày |
| 4.5 | Panel: migration Phase 4 (agent_enrollment_tokens, server_services, software_catalog, server_software, account_usage_snapshots, metric_samples), API `/servers/{id}` đầy đủ, services, software (cơ bản), `/hosting-accounts/{id}/usage` từ snapshot, `/metrics/servers/{id}`, `/system/updates`, Wizard (mã thiết lập, bước 0–3, 6, 9); UI Server detail, Account usage, Wizard nối API thật | 1 ngày |
| 4.6 | Bộ test VM (Multipass + Vagrant, script enforcement, installer 2 lần, uninstall, update→rollback), e2e stack thật với agent thật `--sandbox`, `make check`, báo cáo Phase 4, merge | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p4)`, `test(p4)`, `docs(p4)`; đồng bộ bản sao lưu.

---

## Prompt 4.1 — Spike và contracts

```
[ITSO Panel] Prompt 4.1 — Spike slice/SSH/quota → ADR, contracts op Phase 4
Phạm vi: docs/adr/0011-slice-account-va-phien-ssh.md, 0012-disk-quota.md (phương án, lệnh chính xác, unit/drop-in mẫu,
rủi ro, cách kiểm trên VM), 0013-lop-nen-tang-agent.md (D-63); kiểm trên container những gì kiểm được
(cgroup v2 có/không, quota tools, systemd-analyze verify unit nếu có). Contracts: đặc tả đủ schema cho
account.limits.apply, account.remove, metrics.cgroup, system.hostname.set, software.install/remove (recipe enum),
audit.tail; cập nhật catalog (phase/status/risk/default_enabled/runs_as); test-vectors evil inputs cho
username, slice name, service name, recipe, hostname. make contracts → make codegen → codegen-check xanh.
Kiểm thử: contracts-check, examples hợp lệ/không hợp lệ cho op mới, Go types_gen test.
```

## Prompt 4.2 — Agent core

```
[ITSO Panel] Prompt 4.2 — itso-agent: transport, xác thực, policy, audit, lớp nền tảng
Phạm vi: agent/cmd/itso-agent (flags: --listen, --key-file, --policy, --audit-log, --root, --sandbox,
--allow-uid); listener Unix 0660 + SO_PEERCRED (uid allowlist) ; HMAC D-66 + ts ±60s + nonce; policy YAML
(/etc/itso/agent-policy.yaml root 0600: bật/tắt op, root_terminal=false, docker=false, backup_forget=false;
quyền file sai → từ chối khởi động); audit JSONL hash-chain (ts, op, op_id, caller_uid, requested_by,
params_hash, result, prev_hash) + lệnh verify; internal/platform (Runner argv-only với bảng binary cố định,
FS gốc cấu hình được, ghi atomic, fake runner ghi argv); internal/validate (username, uid range, slice, service,
hostname, recipe, size) + fuzz; giữ itso-mock-agent. Laravel AgentClient ký HMAC (config itso.agent.key_file),
test FakeAgent kiểm chữ ký.
Kiểm thử: Go unit (peercred từ chối uid lạ, HMAC sai/thiếu/lệch giờ/nonce lặp, policy tắt op → op_disabled,
policy file quyền rộng → từ chối, audit chain + phát hiện sửa), fuzz validators, Pest AgentClient ký đúng.
```

## Prompt 4.3 — Ops thật

```
[ITSO Panel] Prompt 4.3 — Ops system/service/account/quota/metrics/software
Phạm vi: handler thật cho op Phase 4 trong catalog qua platform: account.ensure (groupadd/useradd -u -g -d -s
-M, home root:acct 0750 + ACL www-data --x, layout 07 §5, slice drop-in D-64), account.limits.apply,
account.suspend/unsuspend (usermod -L/-U, group itso-suspended, dừng slice), account.remove (giữ home nếu
keep_home), quota.apply (setquota) / quota.report (repquota/quota -u hoặc soft mode du), system.info
(cgroup v2, quota_mode, os, kernel, cpu/ram/disk), system.ping, system.reboot (policy), system.hostname.set,
service.status/control (allowlist tên), metrics.snapshot (/proc, /sys/fs/cgroup), metrics.cgroup (cpu.stat,
memory.current, pids.current của slice account), software.install/remove (recipe allowlist: apt pin, không
URL tùy ý), audit.tail, op.cancel. Idempotent: chạy lại cùng tham số không đổi gì (so sánh trạng thái trước).
Kiểm thử: golden argv + file sinh ra cho từng op với runner giả; evil inputs bị từ chối trước khi chạy lệnh;
idempotent (lần 2 không có argv ghi); lỗi lệnh → mã lỗi đúng; mock agent và agent thật cùng qua bộ test
contract (examples).
```

## Prompt 4.4 — CLI, installer, release

```
[ITSO Panel] Prompt 4.4 — itso CLI, install.sh, release có ký, systemd units
Phạm vi: agent/cmd/itso: install (preflight 10 §3, các bước 10 §4 với checkpoint
/var/lib/itso/install-state.json, --dry-run, --yes, --port, --no-firewall, idempotent), status, doctor, url,
setup-code, admin reset-password/reset-mfa (gọi artisan qua argv cố định), policy get/set, update/rollback
(khung: manifest + checksum + symlink current + giữ 3 bản), repair (khung), uninstall (giữ /home, DB hosting,
đổi tên /etc/itso), logs. install.sh tối giản (kiểm root/OS/arch, tải manifest + chữ ký, openssl verify, sha256,
chạy itso install). make release: build web + api --no-dev + Go (CGO=0, -trimpath), tar.gz + manifest.json +
manifest.sig (Ed25519) + SBOM (danh sách dependency), khóa dev tạm. packaging/systemd: itso.target,
itso-agent.service (hardening 06 §4), itso-web.service (FrankenPHP), itso-worker@.service, itso-scheduler.timer.
Kiểm thử: preflight trên container (systemd không phải PID 1 → FAIL đúng), install --dry-run, install trên gốc
giả + runner giả chạy 2 lần (lần 2 không làm lại bước đã xong), uninstall giữ /home trên gốc giả, update →
rollback trên gốc giả, install.sh từ chối chữ ký sai/sha sai (bats-like bằng bash thuần), shellcheck nếu có.
```

## Prompt 4.5 — Panel nối agent thật

```
[ITSO Panel] Prompt 4.5 — Bảng Phase 4, API server/metrics/usage/software, Wizard
Phạm vi: make db-migrations PHASE=4 (6 bảng), model; /servers/{id} đầy đủ (facts từ system.info, quota_mode,
cgroup), /servers/{id}/services (+ :control qua job, allowlist), /servers/{id}/software (catalog + trạng thái,
cài qua job recipe), /hosting-accounts/{id}/usage đọc account_usage_snapshots (itso:usage-refresh ghi snapshot),
/metrics/servers/{id} (metric_samples, lệnh itso:metrics-collect), /system/updates (phiên bản hiện tại, kênh);
Wizard: mã thiết lập một lần (itso setup-code ghi hash), bước 0 (mã), 1 (ngôn ngữ, múi giờ), 2 (SA + TOTP bắt
buộc), 3 (truy cập panel: port, entrance path, allowlist), 6 (trạng thái disk quota), 9 (tổng kết, khóa wizard).
UI: Server detail, Account usage, Wizard dùng API thật (module khác vẫn "chưa có ở bản này").
Kiểm thử: Pest khớp OpenAPI cho mọi endpoint mới, ma trận quyền mở rộng, wizard một lần (dùng lại mã → 409,
sau khi khóa → 410/409), Vitest cho trang mới, contracts/codegen xanh.
```

## Prompt 4.6 — Tích hợp, VM harness, báo cáo

```
[ITSO Panel] Prompt 4.6 — VM harness, e2e agent thật (sandbox), báo cáo Phase 4
Phạm vi: tests/vm/ (multipass.sh, Vagrantfile, run-all.sh: cài từ release cục bộ, chạy 2 lần, bảng enforcement
07 §9 — stress-ng CPU, MemoryMax OOM, fork bomb TasksMax, dd EDQUOT, ls /home/B, ps aux, `sudo -l -U itso` rỗng,
agent từ chối op lạ/tham số sai, uninstall giữ /home, update→rollback; xuất bảng Markdown); make dev dùng
itso-agent --sandbox thay mock (giữ được mock bằng biến); Playwright stack thật chạy lại với agent thật sandbox
(+ trang Server detail, usage); make check xanh; docs/reports/phase-4.md (tiêu chí, phần "chờ VM" nếu chưa chạy);
runbook docs/runbooks/phase-4-vm-test.md; merge phase-4 → main (local); DỪNG trước Phase 5.
Tiêu chí nghiệm thu Phase 4 (11-ROADMAP): cài sạch ≤ 10 phút trên VM 2 vCPU/2 GB; mọi test enforcement đạt;
`sudo -l -U itso` rỗng; agent từ chối op không có trong registry và tham số sai.
```
