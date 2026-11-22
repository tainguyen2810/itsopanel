# ADR 0034: Vai trò cài đặt và topology nhiều máy chủ

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng kế hoạch Phase 9)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-88, D-89, D-90, D-63 (installer), D-65 (release ký)

## Bối cảnh

Đến Phase 8, panel và agent chạy cùng một máy (server "local"). Phase 9 thêm máy chủ hosting khác mà không biến mỗi máy thành một panel riêng, và không mở cổng quản trị inbound trên máy hosting.

## Quyết định

1. **Ba vai trò** chọn lúc cài, lưu ở `/etc/itso/node.json` và cột `servers.node_role`:
   - `all-in-one` (mặc định, giữ hành vi Phase 4–8): panel + agent + runtime hosting trên một máy. Server local có `node_role=all_in_one`, `transport=local`.
   - `control-plane`: panel + relay + agent local (chỉ để ký CSR và quản lý máy panel), không nhận account hosting (`accepting_new_accounts=false` mặc định).
   - `node`: chỉ `itso-agent` + runtime hosting (nginx, PHP-FPM, MariaDB/PostgreSQL theo role tag, restic). Không cài Laravel, PostgreSQL panel, Redis, itso-relay.
2. **Join:** `install.sh --role node --join https://<panel>:28444 --token <token> --ca-sha256 <pin>`. Installer tải CA từ relay, so sha256 với `--ca-sha256` (sai → dừng, không gửi token), sinh khóa ECDSA P-256 trên node, gửi CSR + token, nhận chứng chỉ + khóa HMAC riêng (ghi 0600 dưới `/etc/itso/`), bật `itso-agent` ở chế độ node.
3. **CLI trên node:** `itso node status` (vai trò, server_uuid, relay, trạng thái kết nối, hạn chứng chỉ), `itso node rejoin --token … --ca-sha256 …` (cấp lại chứng chỉ khi bị thu hồi/mất, giữ server_uuid nếu panel cho phép), `itso node leave` (xóa chứng chỉ, khóa HMAC, dừng agent; không xóa dữ liệu hosting).
4. **Máy panel** vẫn là một server trong danh sách (all-in-one hoặc control-plane); danh sách server hiển thị vai trò, kênh (local / mTLS qua relay) và trạng thái kết nối.

## Hệ quả

- Cài đặt Phase 4–8 nâng cấp lên Phase 9 không đổi hành vi: migration đặt `node_role='all_in_one'` cho server có sẵn.
- Node không có dữ liệu panel; mất node chỉ mất dữ liệu hosting của node đó (khôi phục từ repo restic, D-93).
- Phần cần systemd/kernel thật (cài node trên VM thứ hai, join, leave) kiểm bằng `tests/vm/phase9.sh` (chờ VM).
