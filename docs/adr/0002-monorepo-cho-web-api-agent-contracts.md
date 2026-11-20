# ADR 0002: Monorepo cho web, api, agent, contracts

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-04

## Bối cảnh

Frontend, backend, agent và contracts thay đổi cùng nhau. Tách repo sẽ khó giữ đồng bộ phiên bản contract.

## Quyết định

Một repository: `apps/web`, `apps/api`, `agent`, `contracts`, `database`, `design`, `installer`, `packaging`, `docs`. Công cụ đơn giản: Makefile + pnpm workspace + Composer + Go module, không dùng monorepo tool phức tạp.

## Hệ quả

- Tích cực: Một commit có thể cập nhật contract và cả hai phía.
- Đánh đổi: CI phải chạy nhiều toolchain; cần tách job theo phần thay đổi.
