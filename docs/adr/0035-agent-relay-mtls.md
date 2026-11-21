# ADR 0035: Kênh agent từ xa qua itso-relay (mTLS, node kết nối ra)

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng kế hoạch Phase 9)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-89, D-66 (HMAC envelope), D-90, D-91

## Quyết định

1. **itso-relay** (Go, user `itso-relay` không root, systemd hardening) chạy trên control plane:
   - Nghe `:28444` TLS 1.3, yêu cầu chứng chỉ client do CA nội bộ cấp (`tls.RequireAndVerifyClientCert`). CN chứng chỉ = `server_uuid`; fingerprint nằm trong danh sách thu hồi → từ chối bắt tay. Một kết nối mỗi `server_uuid` (kết nối mới thay kết nối cũ).
   - Endpoint không mTLS duy nhất: `GET /v1/ca` (trả CA PEM để installer ghim sha256) và `POST /v1/enroll` (chuyển tiếp tới Laravel `POST /api/v1/internal/nodes:enroll` qua 127.0.0.1, ký `X-Itso-Relay-Signature`; giới hạn 10 lần/10 phút/IP).
   - Phía panel: unix socket `/run/itso/relay.sock` (0660, nhóm `itso`), Laravel gửi `{server_uuid, envelope}` và nhận kết quả; `GET /status` trả trạng thái từng node (connected, last_seen, fingerprint).
   - Giới hạn: envelope ≤ 1 MiB, kết quả ≤ 8 MiB, tối đa 32 op đồng thời mỗi node, timeout theo deadline của envelope.
2. **Agent chế độ node** quay số ra relay (WebSocket trên TLS mTLS), ping mỗi 20 giây, reconnect lũy thừa (1 → 60 giây, jitter). Envelope nhận được đi qua **cùng** dispatcher/validate/policy như socket local. Node không mở cổng quản trị inbound.
3. **Khóa HMAC riêng mỗi server:** envelope vẫn ký HMAC (D-66) nhưng bằng khóa của server đó (lưu `agents.hmac_key_encrypted`, mã hóa bằng APP_KEY; trên node `/etc/itso/agent.key` 0600). Relay chỉ chuyển byte; relay bị chiếm không giả được op cho node (không có khóa) và không đọc được bí mật (bí mật vẫn đi qua tham chiếu như Phase 6–8, giải ngay trước khi gửi, không log).
4. **Laravel `AgentClient`** chọn kênh theo `agents.transport`: `local` → socket agent như cũ; `mtls` → `relay.sock`. Op_id idempotent: gửi lại sau reconnect không chạy hai lần (agent nhớ kết quả theo op_id như Phase 4).

## Hệ quả

- Tường lửa node chỉ cần đi ra cổng 28444 tới control plane; control plane mở 28444 inbound.
- Mất relay = mọi node `unreachable` nhưng website trên node vẫn chạy; job chuyển `waiting_agent` (D-91).
- Dev/CI: `make dev` chạy thêm relay + một agent node sandbox qua mTLS loopback để e2e có 2 server thật.
