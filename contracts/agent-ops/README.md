# contracts/agent-ops

JSON Schema 2020-12 cho giao tiếp worker → Go agent, **sinh tự động** từ `contracts/tools/gen_agent_ops.py`.

| File | Vai trò |
|---|---|
| `envelope.schema.json` | Request: `v`, `op`, `op_id` (`job_uuid:seq:attempt`), `params`, `deadline`, `ts`, `nonce`, `requested_by`; `params` được kiểm theo schema của op |
| `result.schema.json` | Kết quả: `ok`, `data`, `error{code, message, retryable}`, `duration_ms`, `cached` |
| `errors.schema.json`, `errors.json` | Mã lỗi và việc có retry hay không |
| `defs.schema.json` | Kiểu dùng chung (Domain, Username, RelPath, Uid, Limits...), trùng mẫu với OpenAPI |
| `ops/<op>.schema.json` | `$defs.params` và `$defs.result` của từng op |
| `catalog.json` | Danh mục op: domain, mức rủi ro, mặc định bật/tắt, Phase, chạy dưới root hay UID account, timeout |
| `examples/` | Envelope mẫu hợp lệ (`valid-*`) và không hợp lệ (`invalid-*`, `envelopes.json` ghi lý do) |

Không có op "chạy lệnh tùy ý". Op `fs.*`, `cron.run_once` chạy dưới UID account. `backup.forget` mặc định tắt.
