# ADR 0051: Sự kiện job realtime qua SSE

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-106

## Quyết định

1. Job handler phát sự kiện (bước, tiến độ, trạng thái) lên Redis pub/sub kênh `itso:job:<uuid>`.
2. Endpoint `GET /jobs/{id}/events` (`text/event-stream`): kiểm quyền như `GET /jobs/{id}`, giữ kết nối tối đa 5 phút, heartbeat 15 giây, `id:` tăng dần để client nối lại bằng `Last-Event-ID`; sự kiện đầu là snapshot hiện tại.
3. Client: EventSource, lỗi thì quay về poll như cũ.
4. Dashboard và chuông thông báo vẫn poll 30 giây. Không WebSocket. Log container realtime: DEFERRED.
