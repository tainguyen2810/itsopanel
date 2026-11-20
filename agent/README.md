# agent

Go module `itso.local/agent`. Prompt 1.5 có **mock agent** cho dev; agent thật (`itso-agent`), CLI `itso` và `itso-gateway` ở Phase 4.

## itso-mock-agent

- HTTP JSON `POST /v1/ops`: nhận envelope theo `contracts/agent-ops/envelope.schema.json`, trả result theo `result.schema.json`.
- Nghe `unix:/path.sock` (Linux, quyền 0660) hoặc `tcp:127.0.0.1:port` (Windows dev; chỉ chấp nhận địa chỉ loopback).
- Op: `system.ping`, `system.info` (dữ liệu giả từ `contracts/examples/demo-dataset.json`). Op ngoài catalog → `unknown_op`; op trong catalog nhưng mock không hỗ trợ → `op_disabled`.
- Kiểm tra: schema envelope + params, `ts` lệch tối đa ±60 giây, `deadline`, nonce chống replay, cache kết quả theo `op_id` (idempotent).
- **Không có op nào chạy lệnh hệ thống**; `make no-exec` chặn `os/exec`, `syscall.Exec`, `sh -c` trong `agent/`.

```bash
go run ./cmd/itso-mock-agent -listen unix:/tmp/itso-mock-agent.sock
```

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
| Fuzz parser envelope 30 giây | `make test-fuzz` |
| Lint | `make lint-agent` (gofmt, go vet) |
