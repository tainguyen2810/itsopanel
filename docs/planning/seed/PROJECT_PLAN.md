# PROJECT_PLAN — ITSO Panel (`itso-panel`)

> **Kế hoạch đã được APPROVED ngày 2026-11-20.** Phạm vi chính thức chốt cùng ngày ("FINAL PROJECT SCOPE UPDATE"). Phạm vi này thay thế định hướng Hosting Provider và bán hosting công khai trước đó (xem `DECISIONS.md`, mục lịch sử).

## 1. Định vị
ITSO Panel là **hệ thống quản trị máy chủ và Hosting dùng NỘI BỘ**, do ITSO tự cài đặt và vận hành trên Ubuntu.
- Không phải website bán hosting, không phải nền tảng SaaS thương mại, không có license server.
- Nếu sau này ITSO bán hosting, website bán hàng sẽ là **một dự án riêng**, kết nối với ITSO Panel qua API. Kiến trúc hiện tại giữ sẵn chỗ cho việc đó nhưng chưa triển khai.

## 2. Chức năng trong phạm vi
Server Management · Multi-server Management · Website Management · Nginx/PHP/MySQL · Database Manager · File Manager · FTP/SFTP · DNS & SSL · Security Center · Firewall & WAF · Malware Scanner · Backup & Restore · Docker Manager · WordPress Toolkit · Monitoring · Cron Jobs · Terminal · Users & Roles · Hosting Packages · Hosting Accounts · Resource Quotas · Audit Logs · Installer & Wizard · CLI `itso`.

## 3. Quản lý Hosting nội bộ
Super Admin có thể: tạo Hosting Package · tạo tài khoản · cấp gói thủ công · giới hạn CPU/RAM/disk/inode/process · giới hạn website/database/domain · tạm khóa và mở khóa tài khoản · chuyển gói · **chuyển tài khoản giữa các server** · xem tài nguyên đã dùng · backup/restore theo tài khoản.
USER chỉ quản lý tài nguyên được cấp, qua **User Hosting Portal**.

## 4. Giao diện
- **Private Admin Panel**: chỉ truy cập từ IP allowlist hoặc VPN, bắt buộc MFA.
- **User Hosting Portal**: truy cập qua Internet sau khi được cấp tài khoản. Có xác thực, phân quyền, MFA, rate limit, CAPTCHA khi đăng nhập sai nhiều lần, và WAF.
- Không có giao diện đăng ký mua hosting hay thanh toán.

## 5. Ngoài phạm vi (OUT OF SCOPE / DEFERRED)
WooCommerce · WooCommerce Subscriptions · Public Hosting Storefront · Orders & Billing · Payment Gateway · Subscription Billing · Automatic Payment Renewal · Sales Invoices · Affiliate · Commercial License Server · Public Provisioning API · HMAC integration với website bán hàng · Billing Adapter · Docker Hosting cho USER · Email server.

## 6. Chuẩn bị cho tương lai (không triển khai bây giờ)
- **Hosting Provisioning Service** là một lớp domain service trong Laravel. Đây là nơi duy nhất chứa logic tạo, đổi gói, khóa, mở khóa, chuyển server và xóa tài khoản. Admin Panel, CLI và API nội bộ đều gọi qua lớp này. Một Public Provisioning API sau này chỉ cần bọc lớp này lại.
- REST API `/api/v1` thiết kế theo contracts-first. Đường dẫn `/api/provisioning/*` được **giữ chỗ**, chưa mở.

## 7. Deployment (giữ nguyên)
Cài bằng một lệnh như aaPanel · Ubuntu 24.04 LTS · cài native · không bắt buộc Docker · Web Installation Wizard · CLI `itso` · systemd services · backup và cập nhật an toàn (có rollback). Mặc định cài all-in-one; thêm server bằng `install.sh --role node --join <token>`.

## 8. Nguyên tắc
1. Chỉ Go Agent có đặc quyền. Laravel và frontend không có root, không chạy lệnh hệ thống.
2. Agent chỉ nhận typed operations, không có shell tùy ý, và không tin caller.
3. Giới hạn tài nguyên được thực thi ở kernel (cgroups v2, quota), không chỉ lưu trong DB.
4. Desired / Observed / Job state tách bạch. Thao tác Linux luôn bất đồng bộ và trả về Job ID.
5. Contracts-first: OpenAPI cho API, JSON Schema cho agent.
6. Hệ thống nhiều người dùng: USER được coi là không tin cậy. Cách ly, quota, backup và bảo mật giữ ở mức đầy đủ.
7. Update và uninstall không bao giờ xóa dữ liệu website. Xóa tài khoản: giữ dữ liệu 30 ngày, có cảnh báo, audit, xác minh backup khôi phục được, rồi mới purge 2 bước có biên bản (D-46).
8. Pentest độc lập không bắt buộc cho Alpha nội bộ, nhưng bắt buộc trước khi mở bán hosting cho khách bên ngoài (D-50).
9. Mỗi Phase kết thúc bằng báo cáo và dừng chờ duyệt. Không tự chuyển Phase.

## 9. Lộ trình
12 Phase (`ROADMAP.md`). Phase 1 = Foundation, Architecture, Database, API Contracts, Design System. Phase 2 = demo UI hoàn chỉnh (ưu tiên). Bắt đầu bằng **Git local**, kết nối GitHub sau.
- Phase 1–8 → **v0.1.0-alpha**: một server, dùng nội bộ.
- Phase 9–11 → **v0.5.0-beta**: nhiều server, chuyển tài khoản, Docker, WordPress, Monitoring.
- Phase 12 → **v1.0.0**: dùng production nội bộ, sau khi qua Production Gate.

## 10. Tài liệu
`ARCHITECTURE.md` · `ROADMAP.md` · `DECISIONS.md` · `DATABASE.md` · `API.md` · `PHASE_STATUS.md` · `TEST_REPORT.md`. Chi tiết kỹ thuật nằm ở `docs/planning/01–13`. Các file 14 và 15 là lịch sử của các định hướng đã hoãn.
