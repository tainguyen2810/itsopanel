# TEST_REPORT — ITSO Panel

> Cập nhật cuối mỗi prompt và cuối mỗi Phase. Ghi lệnh chạy thật và kết quả thật, không ước lượng.

## Phase hiện tại: 0 — Planning
Chưa có code, chưa có test.

## Mẫu cho mỗi lần cập nhật
### <Ngày> — Phase N / Prompt N.x — commit `<sha>`
| Bộ test | Lệnh | Số test | Pass | Fail | Skip | Coverage |
|---|---|---|---|---|---|---|
| Web unit | `pnpm --filter web test` | | | | | |
| API feature | `cd apps/api && ./vendor/bin/pest` | | | | | |
| Agent | `cd agent && go test -race ./...` | | | | | |
| Contracts | `make contracts-check` | | | | | |
| E2E | `pnpm --filter web e2e --trace off` | | | | | |
| VM integration | `make vm-test PHASE=N` | | | | | |

**Lỗi còn mở:** …
**Test bị bỏ qua và lý do:** … (không được skip để "cho xanh")
**Acceptance criteria:** bảng ✓/✗ + bằng chứng.
