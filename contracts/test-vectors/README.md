# contracts/test-vectors

`evil-inputs.json` (sinh từ `contracts/tools/gen_vectors.py`): input độc hại theo nhóm (domain, username, path, tên DB, cron, lệnh cron, giá trị Nginx, header, phiên bản PHP) kèm `expect` (`reject`/`accept`) và `layer`:

- `schema`: JSON Schema trong `agent-ops/defs.schema.json` phải tự quyết định đúng (kiểm ở `make contracts-check`).
- `semantic`: tầng nghiệp vụ Laravel và Go agent bắt buộc từ chối; test Phase 3–6 dùng lại các vector này.
