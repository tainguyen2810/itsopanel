# 13 — Tiêu chí nghiệm thu & Rủi ro kỹ thuật

## A. Tiêu chí nghiệm thu

### A.1 Nghiệm thu chung (mọi Phase)
| # | Tiêu chí | Cách kiểm |
|---|---|---|
| G1 | CI xanh: lint, type-check, test, build cả web/api/agent/contracts | GitHub Actions |
| G2 | Không hồi quy: toàn bộ test Phase trước xanh; screenshot không vỡ | CI + so sánh ảnh |
| G3 | Contracts cập nhật trước code; codegen không diff | CI job contracts |
| G4 | Laravel không có lời gọi thực thi lệnh; user `itso` không có sudo | grep CI; `sudo -l -U itso` trên VM |
| G5 | Mọi mutation có audit log, mọi thao tác Linux trả Job ID | test tự động |
| G6 | Tài liệu: runbook chạy thử, README module, ADR | review |
| G7 | `PHASE_STATUS.md`, `TEST_REPORT.md`, báo cáo Phase cập nhật | review |

### A.2 Nghiệm thu `v0.1.0-alpha` (cuối Phase 8)
| # | Tiêu chí |
|---|---|
| R1 | Cài trên VM Ubuntu 24.04 sạch bằng 1 lệnh trong ≤ 10 phút; wizard hoàn tất không cần terminal |
| R2 | Không cần cài tay Laravel/Node/Composer/Go/PostgreSQL; không bắt buộc Docker |
| R3 | SA tạo gói, ADMIN, USER, account; USER đăng nhập chỉ thấy tài nguyên của mình (ma trận quyền 100% pass) |
| R4 | Giới hạn CPU/RAM/tasks/disk có hiệu lực ở kernel (bảng test `07` §9 pass) |
| R5 | USER tạo site PHP + HTTPS hợp lệ, DB, file upload, SFTP, cron — tất cả chạy dưới uid riêng |
| R6 | Bộ test tấn công (traversal, symlink, zip slip, injection, CSRF, XSS cơ bản, chroot escape) bị chặn 100% |
| R7 | Firewall + SSH thay đổi có rollback tự động; không thể tự khóa qua panel |
| R8 | Backup theo lịch lên ≥ 2 đích, 1 append-only; restore site/DB thành công; diễn tập DR thành công |
| R9 | Update → rollback → update thành công; uninstall giữ nguyên `/home` và DB hosting, site vẫn phục vụ |
| R10 | UI VI/EN, Light/Dark, 1440/390 px; screenshot trong `docs/screenshots/` chụp từ app thật |
| R11 | Không có lỗ hổng High/Critical đã biết chưa xử lý trong dependency (audit tools) |

### A.3 Chỉ số vận hành mục tiêu (đo trên VM tham chiếu 4 vCPU/8 GB, đoán ban đầu, sẽ hiệu chỉnh)
- API p95 < 300 ms cho list (≤ 200 account); tạo site end-to-end < 60 s (không tính ACME); panel RAM < 600 MB khi rảnh; agent RAM < 60 MB.

## B. Rủi ro kỹ thuật (xếp theo mức độ)

| # | Rủi ro | Khả năng | Ảnh hưởng | Giảm thiểu | Phase |
|---|---|---|---|---|---|
| K1 | **Phạm vi quá lớn** so với nguồn lực (aaPanel Pro + cPanel) | Cao | Cao | Milestone rõ, v0.1 = lõi 8 Phase; cắt FTP thuần, DNS server, mail; P2 để sau | Mọi |
| K2 | **Lỗ hổng trong Agent root** (injection, symlink, path) → chiếm toàn server | Trung bình | Rất cao | Typed ops, không shell, hạ quyền, openat2, fuzz, test vectors chung, review bảo mật bắt buộc cho PR chạm agent | 4–9 |
| K3 | **Isolation giữa site sai** (permission, /proc, PHP-FPM chung) | Trung bình | Cao | FPM master per account, ACL, hidepid, test isolation tự động trên VM | 4–6 |
| K4 | **Disk quota không bật được** trên ext4 `/` mà không reboot | Cao | Trung bình | Phát hiện ở preflight, hướng dẫn + reboot một lần, chế độ soft enforcement có cảnh báo | 4 |
| K5 | **Panel phụ thuộc runtime hosting** (PHP/Nginx) → gỡ PHP làm chết panel | Cao nếu không xử lý | Cao | Runtime riêng FrankenPHP (D-01), PG/Redis riêng (D-02/03) | 4 |
| K6 | **Tự khóa server** do firewall/SSH | Trung bình | Cao | Safe-apply với timer rollback độc lập; CLI recovery | 4, 7 |
| K7 | **Docker vượt firewall** | Cao nếu không xử lý | Cao | `ip=127.0.0.1`, DOCKER-USER, test từ ngoài | 9 |
| K8 | **Backup không khôi phục được / bị xóa** bởi ransomware | Trung bình | Rất cao | Restore test định kỳ, append-only/Object Lock, mật khẩu repo lưu offline | 8 |
| K9 | **Update hỏng giữa chừng** (mất điện) | Thấp–TB | Cao | Release dir + symlink nguyên tử, migration expand-only, pre-update dump, auto-rollback | 4, 12 |
| K10 | **Phụ thuộc bên thứ ba** (PPA ondrej, ModSecurity, FrankenPHP build) thay đổi/ngừng | Trung bình | Trung bình | Pin version, phương án dự phòng (PHP-FPM riêng, Coraza), theo dõi | 4, 5, 7 |
| K11 | **UI demo trôi khỏi API thật** | Trung bình | Trung bình | MSW theo OpenAPI, dataset demo dùng chung cho seeder | 2–3 |
| K12 | **Tài nguyên DB dùng chung không giới hạn được** (MySQL của account A làm chậm B) | Cao | Trung bình | Giới hạn kết nối/query per user, giám sát slow query, ghi rõ là giới hạn mềm | 6 |
| K13 | **ClamAV tốn RAM** trên server nhỏ | Cao | Thấp–TB | On-demand mặc định, daemon tùy chọn khi RAM ≥ 4 GB | 7 |
| K14 | **Multi-server làm đổi kiến trúc muộn** | Thấp (đã thiết kế sẵn) | Cao | `server_id` từ đầu, transport tách khỏi op, agent declarative | 3, 11 |
| K15 | **Claude Code trôi phạm vi / mất ngữ cảnh** giữa phiên | Trung bình | Trung bình | `PHASE_STATUS.md` + commit nhỏ + prompt phạm vi hẹp + dừng cuối prompt | Mọi |
