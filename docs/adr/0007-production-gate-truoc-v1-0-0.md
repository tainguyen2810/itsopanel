# ADR 0007: Production Gate trước v1.0.0

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-47

## Bối cảnh

Hệ thống nhiều người dùng; lỗi cách ly hoặc backup có hậu quả nghiêm trọng.

## Quyết định

8 bài kiểm tra G1–G8: isolation, quota, privilege escalation, backup/restore, upgrade, disaster recovery, migration, uninstall. Mỗi bài có tiêu chí đo được và bằng chứng (lệnh, log, kết quả, ảnh) lưu ở `docs/gate/G<n>.md`. Chưa đạt đủ thì không phát hành v1.0.0.

## Hệ quả

- Tích cực: Có tiêu chuẩn phát hành khách quan.
- Đánh đổi: Phase 12 cần môi trường test nhiều VM.
