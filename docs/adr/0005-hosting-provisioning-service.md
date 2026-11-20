# ADR 0005: Hosting Provisioning Service

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-49

## Bối cảnh

Vòng đời account được gọi từ Admin Panel, CLI, scheduler, và có thể từ một Public API trong tương lai. Logic phân tán sẽ dẫn tới bỏ sót kiểm tra quota, audit.

## Quyết định

Một domain service `app/Domain/Hosting/ProvisioningService` là nơi duy nhất thực hiện create, changePackage, suspend, unsuspend, migrate, terminate, schedulePurge, confirmPurge. Mỗi method kiểm tra quyền và quota, ghi desired state, tạo Job, ghi audit. Chưa mở API công khai; `/api/provisioning/*` chỉ giữ chỗ.

## Hệ quả

- Tích cực: Một chỗ để test và audit.
- Đánh đổi: Public API sau này chỉ là controller mỏng.
