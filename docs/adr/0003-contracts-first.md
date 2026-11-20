# ADR 0003: Contracts-first

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-14

## Bối cảnh

UI demo (Phase 2) được dựng trước backend thật. Nếu không có contract chung, UI sẽ trôi khỏi API, agent sẽ trôi khỏi worker.

## Quyết định

`contracts/openapi/*.yaml` (OpenAPI 3.1) cho Admin API và Portal API; `contracts/agent-ops/*.schema.json` cho agent. Viết contract trước, code sau. Codegen sinh TypeScript và Go; CI fail nếu codegen tạo diff. Mock API của Phase 2 dùng cùng contract.

## Hệ quả

- Tích cực: UI, API và agent luôn khớp kiểu dữ liệu.
- Đánh đổi: Mỗi thay đổi API phải sửa contract trước, chậm hơn một chút.
