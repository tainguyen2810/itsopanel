# ADR 0023: Tường lửa nftables, bảng riêng và safe-apply có hoàn tác

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 7)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-76, D-13, D-63

## Bối cảnh

Tự khóa máy chủ là rủi ro số 1 của Phase 7 (11-ROADMAP). Ubuntu 24.04 dùng nftables; Docker và fail2ban cũng ghi rule vào nftables nên panel không được `flush ruleset`. Panel và agent đều có thể chết giữa chừng, nên cơ chế hoàn tác không được phụ thuộc vào tiến trình của chúng.

## Quyết định

1. **Phạm vi:** panel chỉ quản lý `table inet itso`. Ruleset sinh từ `firewall_rules` bằng template Go (không ghép chuỗi tự do): `policy drop` cho input, luôn có loopback, `ct state established,related`, ICMP giới hạn tốc độ, cổng SSH hiện tại và cổng panel. Rule chỉ có các trường kiểu hóa (`FirewallRule`: priority, action accept|drop|reject, direction, protocol, ports dạng số, source CIDR, comment không ký tự điều khiển/nháy).
2. **Bất biến chống tự khóa** kiểm ở **cả** Laravel và agent (`net/netip`): không rule nào drop/reject cổng SSH hoặc cổng panel với nguồn chứa `client_ip` của người áp dụng, không xóa rule hệ thống cho hai cổng này. Vi phạm → lỗi `would_lock_out` (422 ở API, mã lỗi agent).
3. **Safe-apply** (`firewall.apply{apply_id, rules, anti_lockout{ssh_port, panel_port, client_ip}, confirm_within_sec}`):
   1. sinh ruleset → `nft -c -f` (kiểm cú pháp) → lưu ruleset cũ vào `/var/lib/itso/firewall/<apply_id>.prev` (root 0600);
   2. `nft -f` áp dụng;
   3. hẹn hoàn tác bằng transient timer `systemd-run --on-active=<N>s --unit=itso-fw-rollback` chạy `itso-agent fw-rollback <apply_id>` (sống sót khi agent/panel chết);
   4. trả `token` ngẫu nhiên 32 byte; Laravel chỉ lưu `sha256(token)` trong `firewall_applies`.
4. **Xác nhận:** trình duyệt gọi `POST /servers/{id}/firewall:confirm` bằng **request mới** (chứng minh còn kết nối tới panel qua tường lửa mới) → `firewall.confirm{apply_id, token}` → agent dừng timer. Token sai → `precondition_failed`. Không xác nhận → timer khôi phục ruleset cũ, ghi `security_events` (`firewall.rolled_back`).
5. **Một lần chờ:** mỗi máy chủ chỉ một safe-apply `pending_confirm` cho mỗi loại (unique index một phần trên `firewall_applies`).
6. **Trạng thái/xem trước:** `firewall.status` (bảng có tồn tại, sha256 ruleset, lần chờ); API `GET /firewall/preview` sinh ruleset không áp dụng, `GET /firewall/status`.

## Hệ quả

- Không đụng rule của Docker/fail2ban; gỡ panel chỉ cần `nft delete table inet itso`.
- Kiểm thử: golden ruleset, vector độc (cổng SSH từ IP hiện tại, CIDR lạ, cổng ngoài 1–65535, chèn lệnh vào `ports`/`comment`), runner giả cho `nft`/`systemd-run`; VM (`tests/vm/phase7.sh`): mất kết nối → tự hoàn tác.
- Cần IP thật của người dùng: Laravel lấy từ request sau proxy tin cậy (TrustProxies), không nhận từ body.
