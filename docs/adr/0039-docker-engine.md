# ADR 0039: Cài và cấu hình Docker Engine

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 10)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-94, D-18/D-38 (Docker cho khách: DEFERRED), D-100

## Bối cảnh

Phase 10 cho quản trị viên chạy ứng dụng nội bộ bằng Docker trên server do panel quản lý. Người dùng hosting (USER) không có đường nào tới Docker. Socket Docker tương đương quyền root, nên chỉ agent được chạm.

## Quyết định

1. **Gói từ kho Ubuntu:** recipe `docker` cài `docker.io` + `docker-compose-v2` của Ubuntu 24.04, không thêm kho Docker Inc. Bật qua `POST /servers/{id}/docker:enable` (SUPER_ADMIN, step-up), job `docker.enable`: `software.install` → `docker.host.configure` → `docker.firewall.sync`.
2. **daemon.json do panel quản lý:** `{"ip":"127.0.0.1","userland-proxy":false,"live-restore":true,"iptables":true,"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}`. Ghi nguyên tử (tmp + rename), so sánh trước khi restart, lệch thì báo `drift`.
3. **Nhóm `docker` rỗng:** `docker.host.status` báo thành viên; `docker.host.configure` gỡ thành viên (trừ khi không có). Socket `root:root 0660`.
4. **Engine API:** agent dùng client Go tự viết qua unix socket `/var/run/docker.sock`, ghim API ≥ 1.43; không gọi CLI `docker` cho thao tác container/image/volume/network. `docker compose` chạy bằng argv qua runner (`docker compose -p itso_<uuid> -f /var/lib/itso/compose/<uuid>/compose.yaml …`), không qua shell.
5. **Thư mục project:** `/var/lib/itso/compose/<uuid>/` root 0700, chứa `compose.yaml` đã validate và `.env` 0600.

## Hệ quả

- Không phụ thuộc kho ngoài; bản Docker theo chu kỳ Ubuntu (đủ cho ứng dụng nội bộ).
- Test trong container dùng Docker Engine API giả trên unix socket; hành vi thật ở `tests/vm/phase10.sh` (chờ VM).
