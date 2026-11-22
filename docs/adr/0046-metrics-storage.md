# ADR 0046: Lưu metrics trong PostgreSQL

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-101, D-12 (PostgreSQL)

## Bối cảnh

Phase 11 cần số liệu server (CPU, RAM, swap, disk, inode, IO, network, load) và theo hosting account (cgroup: CPU, RAM, IO, tasks) với biểu đồ từ 1 giờ tới 90 ngày. Hệ thống dùng nội bộ, quy mô vài server × ≤ 200 account/server.

## Quyết định

1. **Không thêm TSDB** (Prometheus, VictoriaMetrics, TimescaleDB). Dùng PostgreSQL sẵn có.
2. `metric_samples`: partition theo ngày (RANGE `sampled_at`), mẫu 1 phút, giữ 7 ngày. Xóa bằng `DROP` partition (không `DELETE`). `itso:metrics-prune` hằng ngày tạo trước partition 2 ngày tới và drop partition quá 7 ngày.
3. `metric_rollups`: 1 giờ (min/avg/max/count), unique `(server_id, hosting_account_id, metric, bucket)`, giữ 90 ngày. `itso:metrics-rollup` mỗi giờ, idempotent (upsert), chạy bù các giờ còn thiếu.
4. **Thu thập:** server qua op `metrics.snapshot` mỗi phút (mở rộng swap, inode, IO, network). Account qua `metrics.cgroup` mỗi 5 phút, **một lần gọi mỗi server** trả mọi slice `itso-acct-*`.
5. **API chọn nguồn theo khoảng:** ≤ 24 giờ đọc samples, > 24 giờ đọc rollup; trường `source` cho UI; tối đa ~500 điểm mỗi series (gộp theo bước).

## Hệ quả

- Ước tính 200 account × 12 mẫu/giờ + server ≈ 60 nghìn dòng/giờ: vừa với PostgreSQL, partition giữ chỉ mục nhỏ.
- Không có truy vấn PromQL; biểu đồ chỉ theo các metric định nghĩa trong contract.
- Server mất kết nối: series dừng ở mẫu cuối, UI hiện banner.
