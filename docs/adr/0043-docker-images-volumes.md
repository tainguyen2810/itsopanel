# ADR 0043: Cập nhật image có rollback, registry, backup volume

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 10)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-98, D-82…D-87 (backup Phase 8), D-69/D-71 (bí mật)

## Quyết định

1. **Cập nhật image** (`POST /compose-projects/{id}:update-images`, op `docker.image.update`): pull theo tag → so digest → nếu mới: tag image đang chạy thành `itso-rollback/<project>-<service>:<yyyymmddhhmmss>` → recreate service → chờ health tối đa 60 giây (container `running`, healthcheck `healthy` nếu khai báo) → lỗi thì tự quay về image cũ và báo `rolled_back`. Giữ 2 bản rollback mỗi service; `docker.image.prune` không xóa bản rollback còn giữ.
2. **Quay lại thủ công** (`:rollback-images`, op `docker.image.rollback`).
3. **Registry:** mật khẩu mã hóa ở DB (Laravel `Crypt`), gửi agent qua `secret_ref` của vault agent khi lưu/đổi/kiểm (`docker.registry.login`); không vào params job hay audit.
4. **Backup volume:** chính sách Phase 8 thêm phạm vi `compose_project` và nội dung `docker_volumes`; `volume_consistency`: `pause` (mặc định: tạm dừng container dùng volume trong lúc snapshot) hoặc `none`. restic backup `/var/lib/docker/volumes/<name>/_data`; restore vào volume mới hoặc ghi đè khi container đã dừng (item `volume:<name>`).
5. Xóa volume đang được container dùng → `in_use` (API 409 `resource_locked`).
