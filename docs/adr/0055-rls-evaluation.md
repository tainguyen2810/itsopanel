# ADR 0055: Đánh giá Row-Level Security PostgreSQL

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-110, D-02 (phạm vi ở tầng ứng dụng)

## Bối cảnh

Phạm vi dữ liệu (USER chỉ thấy account mình, ADMIN theo server/account được giao) đang làm ở tầng ứng dụng (`Access::*`). RLS của PostgreSQL là lớp phòng thủ thứ hai nếu có lỗi ở code.

## Đánh giá

- Panel, worker, scheduler, migration dùng **chung một DB role**; job runner và scheduler chạy không có người dùng (cần bypass), migration cần quyền chủ bảng. RLS đòi `SET LOCAL itso.user_id` trong mọi transaction và chính sách cho từng bảng phạm vi account (≈ 25 bảng).
- Rủi ro: quên `SET LOCAL` trong job → truy vấn trả rỗng (lỗi im lặng), hoặc dùng role `BYPASSRLS` cho worker → mất tác dụng phần lớn. Chi phí đo thật (12.4) — xem bảng số liệu dưới: không đáng kể so với một request API; chi phí thật nằm ở độ phức tạp vận hành.

## Số liệu đo (2026-11-23, PostgreSQL 16 trong container phát triển)

Bảng giả lập `sites` 60 600 dòng (600 dòng của 200 account + 60 000 dòng nền), index theo `account_id`/`owner_id`; mỗi lượt
`SELECT count(*) … WHERE account_id = $1`, 20 000 lượt trong PL/pgSQL, role không có `BYPASSRLS`:

| Cấu hình | ms/truy vấn |
|---|---|
| Không RLS (owner) | 0,0049 |
| Không RLS (role ứng dụng) | 0,0057 |
| RLS `owner_id = current_setting('itso.user_id')` | 0,0079 (+0,002) |
| RLS theo bảng phạm vi (`account_id IN (SELECT … FROM scopes WHERE user_id = …)`) | 0,0306 (+0,025) |

Request API điển hình chạy 10–40 truy vấn → RLS thêm < 1 ms/request kể cả chính sách theo phạm vi. Hiệu năng không phải lý do
từ chối; lý do là vận hành (bên dưới).

## Quyết định

1. **Không bật RLS ở v1.0.** Giữ phạm vi ở tầng ứng dụng.
2. Thêm lưới an toàn tự động (12.4, đã làm): `tests/Feature/Phase12/RouteMatrixTest.php` sinh từ danh sách route — mọi route admin/portal có `{id}` gọi bằng actor ngoài phạm vi với id thật phải trả 404/403 (≥ 250 route); route ghi Admin thiếu `itso.perm` làm test đỏ (ngoại lệ có lý do).
3. Xem lại khi có nhiều DB role tách biệt (panel/worker) hoặc khi mở cho khách ngoài (cùng thời điểm pentest D-50).
