# agent

Go module `itso.local/agent`. Prompt 1.5 có **mock agent** cho dev; Phase 4 có agent thật (`itso-agent`); CLI `itso` ở Prompt 4.4; `itso-gateway` ở Phase 6.

## itso-mock-agent

- HTTP JSON `POST /v1/ops`: nhận envelope theo `contracts/agent-ops/envelope.schema.json`, trả result theo `result.schema.json`.
- Nghe `unix:/path.sock` (Linux, quyền 0660) hoặc `tcp:127.0.0.1:port` (Windows dev; chỉ chấp nhận địa chỉ loopback).
- Op: `system.ping`, `system.info` (dữ liệu giả từ `contracts/examples/demo-dataset.json`); từ Prompt 3.4: `account.ensure`, `account.suspend`, `account.unsuspend`, `account.remove`, `quota.apply`, `quota.report` trên kho account trong bộ nhớ (`internal/mock/accounts.go`; params/result theo struct sinh `types_gen.go`, không đụng hệ thống thật). Op ngoài catalog → `unknown_op`; op trong catalog nhưng mock không hỗ trợ → `op_disabled`.
- Kiểm tra: schema envelope + params, `ts` lệch tối đa ±60 giây, `deadline`, nonce chống replay, cache kết quả theo `op_id` (idempotent).
- **Không có op nào chạy lệnh hệ thống**; `make no-exec` chặn `os/exec`, `syscall.Exec`, `sh -c` trong `agent/`.

```bash
go run ./cmd/itso-mock-agent -listen unix:/tmp/itso-mock-agent.sock
```

## itso-agent (Phase 4)

- Chạy root, nghe `unix:/run/itso/agent.sock` (group `itso-agent-clients`). Mỗi request: SO_PEERCRED (uid trong allowlist) → HMAC-SHA256 (D-66, khóa `/etc/itso/agent.key`) → schema + chính sách cục bộ `/etc/itso/agent-policy.yaml` → handler → audit cục bộ có chuỗi băm (`/var/log/itso/agent-audit.jsonl`).
- **Lớp nền tảng** (`internal/platform`, D-63): lệnh hệ thống chỉ qua `Runner` với argv và bảng binary đường dẫn tuyệt đối (`Bins`); không shell. File hệ thống qua `FS` (ghi atomic, `O_NOFOLLOW`, gốc cấu hình được). Chỉ package này được import `os/exec` (`make no-exec`).
- **Op thật** (`internal/ops`, Prompt 4.3): `system.ping/info/hostname.set/reboot`, `service.status/control` (allowlist tên), `account.ensure/limits.apply/suspend/unsuspend`, `quota.apply/report` (kernel hoặc soft), `metrics.snapshot/cgroup`, `software.install/remove` (recipe allowlist, apt từ kho Ubuntu, không URL), `audit.tail`, `op.cancel`. `account.remove` ở Phase 8 (cần snapshot backup cuối, D-46).
  - Mọi tham số kiểm lại bằng `internal/validate` trước khi chạy lệnh.
  - Idempotent: đọc trạng thái trước (`/etc/passwd`, `/etc/group`, `/etc/shadow`, `getfacl`, `systemctl is-active`, `dpkg-query`, `repquota`), chỉ ghi khi khác.
  - Slice account `itso-acct-<uid>.slice` (cha `itso-acct.slice` → `itso.slice`, suy ra từ tên) và phiên SSH `user-<uid>.slice` (50%): drop-in `50-itso.conf`, xem ADR 0011.
- `--sandbox --root <thư mục>`: runner giả `ops.Sim` mô phỏng useradd/groupadd/usermod/gpasswd/ACL/systemctl/apt/quota lên `/etc`, `/home` giả trong thư mục đó; `/proc`, `/sys` đọc từ máy thật. Không chạy lệnh nào. Dùng cho dev/e2e.

```bash
go run ./cmd/itso-agent --sandbox --root /tmp/itso-sandbox --listen unix:/tmp/itso-agent.sock \
  --key-file /tmp/agent.key --audit-log /tmp/itso-sandbox/audit.jsonl --policy /tmp/itso-sandbox/policy.yaml
```

## itso (CLI quản trị, Prompt 4.4)

Logic ở `internal/install` (test được trên gốc giả + runner giả), lệnh ở `cmd/itso`. Lệnh hệ thống chỉ qua `platform.Runner`; thao tác DB/artisan chạy dưới uid `postgres`/`itso` bằng `Cmd.As` (setresuid, không su/sudo).

| Lệnh | Việc |
|---|---|
| `itso preflight` · `itso install [--dry-run] [--yes] [--port N] [--no-firewall] [--release-dir D]` | Kiểm 10 §3 rồi chạy 9 bước 10 §4 có checkpoint `/var/lib/itso/install-state.json`; chạy lại bỏ qua bước đã xong, secret không bị sinh lại |
| `itso status` · `itso doctor` · `itso url` · `itso setup-code` | Trạng thái, kiểm sâu, URL, mã thiết lập một lần (lưu băm SHA-256, 60 phút) |
| `itso update --release-dir D` · `itso rollback` | Kiểm chữ ký Ed25519 + sha256 → pg_dump + sao lưu /etc/itso → giải nén `releases/<ver>` → migrate → đổi symlink `current` → kiểm sức khỏe, lỗi thì tự rollback; giữ 3 bản |
| `itso repair [--fix]` | Kiểm checksums.txt của release, unit systemd, quyền file khóa |
| `itso uninstall [--purge-panel-data --confirm-hostname H]` | Gỡ panel, giữ `/home` và dữ liệu hosting, đổi tên `/etc/itso` |
| `itso admin reset-password EMAIL` · `itso admin reset-mfa EMAIL` · `itso policy get` · `itso policy set` · `itso logs DỊCH_VỤ` | Khôi phục truy cập (artisan argv cố định), policy agent, journal |

`--sandbox --root DIR`: chạy trên gốc giả với runner giả (dev/test). Bản build thường không có khóa công khai phát hành nên từ chối mọi release; `make release` nhúng khóa bằng `-ldflags`.

## Schema nhúng

`go:embed` không đọc được ngoài module, nên `internal/contracts/data/` là **bản sao** từ `contracts/` (nguồn sự thật). Sau khi đổi contracts:

```bash
go generate ./internal/contracts
```

Test `TestEmbeddedCopyMatchesContracts` báo lỗi nếu bản sao lệch.

## Test

| Việc | Lệnh |
|---|---|
| Unit + race | `go test -race ./...` (`make test-agent`) |
| Golden argv + file của op thật (ghi lại khi đổi có chủ đích) | `go test ./internal/ops -update` rồi xem `git diff internal/ops/testdata` |
| Bộ test contract dùng chung mock + agent thật | `internal/contracttest` (gọi từ `internal/mock` và `internal/ops`) |
| Fuzz parser envelope 30 giây | `make test-fuzz` |
| Lint | `make lint-agent` (gofmt, go vet) |
