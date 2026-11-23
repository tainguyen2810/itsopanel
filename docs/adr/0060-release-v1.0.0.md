# ADR 0060: Phát hành v1.0.0-rc.1, điều kiện v1.0.0

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-115, D-47, D-50

## Quyết định

1. Cuối Phase 12: `make release` + `make release-offline`, release notes `docs/releases/v1.0.0-rc.1.md`, tag **local** `v1.0.0-rc.1` trên `main` sau merge (người dùng chọn trên thẻ quyết định 2026-11-23).
2. **`v1.0.0` chỉ gắn khi** `docs/gate/G1.md … G8.md` có bằng chứng chạy trên VM đạt và không còn lỗ hổng High/Critical mở; làm ở prompt riêng sau khi chạy `tests/vm/gate.sh`.
3. Pentest độc lập vẫn bắt buộc trước khi mở cho khách ngoài (D-50), không chặn `v1.0.0` nội bộ.
