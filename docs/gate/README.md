# docs/gate

Bằng chứng kiểm thử cho Production Gate G1–G8 (D-47). Mỗi file: tiêu chí đo được, phần đã kiểm tự động trong container,
lệnh chạy trên VM và bằng chứng. Chạy cả bộ: `tests/vm/gate.sh` (xem đầu file). Trang **Hệ thống › Sẵn sàng production**
đọc trạng thái đã ghi bằng `php artisan itso:gate-record`.

| Gate | Nội dung | Trạng thái (2026-11-23) |
|---|---|---|
| [G1](G1.md) | Cách ly account trên ≥ 2 server | pending_vm |
| [G2](G2.md) | Quota | pending_vm |
| [G3](G3.md) | Leo thang đặc quyền | pending_vm (+ pentest độc lập, D-50) |
| [G4](G4.md) | Backup/Restore | pending_vm |
| [G5](G5.md) | Nâng cấp 3 phiên bản | pending_vm |
| [G6](G6.md) | Disaster recovery | pending_vm |
| [G7](G7.md) | Chuyển account | pending_vm |
| [G8](G8.md) | Gỡ cài đặt | pending_vm |

`v1.0.0-rc.1` phát hành khi mọi phần kiểm tự động xanh; `v1.0.0` chỉ khi cả 8 bài có bằng chứng VM `pass`.
