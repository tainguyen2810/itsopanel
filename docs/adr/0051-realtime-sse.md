# ADR 0051: Sự kiện job realtime qua SSE

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-106

## Quyết định

1. Job handler phát sự kiện (bước, tiến độ, trạng thái) lên Redis pub/sub kênh `itso:job:<uuid>`.
2. Endpoint `GET /jobs/{id}/events` (`text/event-stream`): kiểm quyền như `GET /jobs/{id}`, giữ kết nối tối đa 5 phút, heartbeat 15 giây, `id:` tăng dần để client nối lại bằng `Last-Event-ID`; sự kiện đầu là snapshot hiện tại.
3. Client: EventSource, lỗi thì quay về poll như cũ.
4. Dashboard và chuông thông báo vẫn poll 30 giây. Không WebSocket. Log container realtime: DEFERRED.

## Ghi chú hiện thực (11.6)

- Mọi thay đổi bước/trạng thái của JobRunner đều ghi một dòng `job_logs`; model `JobLog` phát mỗi dòng lên Redis `PUBLISH itso:job:<uuid>` (lỗi Redis không làm hỏng job).
- Endpoint SSE đọc `job_logs` (nguồn sự thật có thứ tự) mỗi giây thay vì giữ một kết nối SUBSCRIBE: `id:` = seq log nên `Last-Event-ID` nối lại không mất sự kiện kể cả khi tin pub/sub bị lỡ; snapshot `event: job` gửi đầu luồng và mỗi khi trạng thái/tiến độ đổi (kể cả `cancel_requested` không kèm log). Đóng khi job kết thúc hoặc sau `itso.sse.max_sec` (300).
- Mỗi luồng giữ một worker PHP tối đa 5 phút; client chỉ mở luồng khi đang xem job (drawer theo dõi, trang chi tiết job), lỗi lặp lại thì quay về poll 2 giây.
