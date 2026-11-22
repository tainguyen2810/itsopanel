# ADR 0040: Docker không vượt qua tường lửa (chain DOCKER-USER)

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 10)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-95, D-77 (bảng `inet itso`), D-94

## Bối cảnh

Docker chèn rule NAT/forward trước tường lửa của panel: publish `0.0.0.0:8080` sẽ mở cổng ra Internet dù nftables của panel chặn. daemon.json đã bind mặc định 127.0.0.1 nhưng YAML vẫn có thể ghi `0.0.0.0:`.

## Quyết định

1. Op `docker.firewall.sync` ghi lại toàn bộ chain `DOCKER-USER` (iptables-nft, nguyên tử bằng `iptables-restore --noflush` cho riêng chain):
   - `RETURN` cho `ctstate ESTABLISHED,RELATED` và traffic giữa các bridge nội bộ;
   - `ACCEPT` cho từng cổng SUPER_ADMIN mở rõ ràng (`firewall_rules` có `scope=docker`, nguồn CIDR bắt buộc);
   - `DROP` mọi traffic từ interface public tới container.
2. Chạy lại sau mỗi lần Docker restart: unit `itso-docker-user.service` (After/PartOf=docker.service) gọi agent op.
3. Không đụng bảng `inet itso` của panel và bảng của Docker ngoài chain `DOCKER-USER`.
4. Validator (ADR 0041) vẫn viết lại mọi `ports` thành `127.0.0.1:<cổng cấp>`; chain là lớp phòng thủ thứ hai.

## Hệ quả

- Test bắt buộc trên VM: publish `0.0.0.0:8080` bằng tay → từ máy khác không vào được; cổng mở bằng panel vào được từ đúng CIDR.
- Kiểm tra `docker_user_chain` hiện trên trang Docker của server.
