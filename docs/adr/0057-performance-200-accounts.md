# ADR 0057: Hiệu năng ở 200 account/server

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-112

## Quyết định

1. Bộ seed tổng hợp `PerfSeeder` (chỉ chạy ở môi trường local/testing): 200 account × 3 website × 2 DB, 7 ngày metrics (server mỗi phút, account mỗi 5 phút), 10 nghìn job, 100 nghìn audit.
2. Lệnh `itso:bench` đo qua HTTP kernel nội bộ (không mạng) và lệnh lịch: p50/p95/max, ghi `docs/perf/phase-12.md`.
3. Mục tiêu: API danh sách p95 ≤ 300 ms; chi tiết p95 ≤ 200 ms; `alerts-evaluate` ≤ 10 giây/lượt; insert `metric_samples` của 200 account ≤ 5 giây/phút. Không đạt thì ghi rõ và phương án.
4. Sửa điểm nóng bằng index, eager load (chặn N+1 bằng test đếm truy vấn), phân trang cursor có sẵn.
