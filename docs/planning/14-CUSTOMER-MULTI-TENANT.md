# 14 — Điều chỉnh cho mục đích: công ty **và khách hàng** sử dụng

> **⚠ PHẦN LỚN DEFERRED (2026-11-20):** chưa có khách bên ngoài. Vẫn áp dụng: §3 cô lập mạnh hơn (sandbox, egress, IO limits), §7 backup repo theo account. Các phần portal thương mại, abuse case, provisioning, branding theo đại lý: DEFERRED.

> **Lưu ý:** phần lớn nội dung vẫn hiệu lực, nhưng các phần về billing, roadmap và Docker đã được `15-HOSTING-PROVIDER.md` thay thế.
>
> Cập nhật 2026-11-20. Bối cảnh mới: ITSO Panel phục vụ cả website nội bộ của công ty lẫn **khách hàng bên ngoài**. Vẫn không xây license server/marketplace/affiliate. Tài liệu này **ghi đè** các phần liên quan trong 01–13 khi có khác biệt.

## 1. Điều gì thay đổi về bản chất

| Trước (nội bộ) | Nay (công ty + khách hàng) | Hệ quả thiết kế |
|---|---|---|
| USER là nhân viên, "tin tưởng một phần" | USER là **khách hàng không tin cậy**, có thể cố ý tấn công hoặc bị hack | Cô lập phải giả định hàng xóm là kẻ tấn công: sandbox per account, egress filtering, jail SSH |
| Panel có thể giới hạn bằng IP allowlist | Khách truy cập từ Internet bất kỳ | Tách **Admin area** (allowlist) và **Customer portal** (public, có WAF, rate limit, CAPTCHA) |
| Sự cố ảnh hưởng nội bộ | Sự cố ảnh hưởng khách, uy tín, hợp đồng | Cần pentest độc lập trước khi nhận khách; SLA, thông báo sự cố |
| Không cần billing | Có quan hệ thương mại | Không xây billing, **không có Provisioning API**: nhân viên tạo và quản lý tài khoản khách bằng tay trong panel (D-24, đã chốt) |
| Không cần pháp lý dữ liệu | Lưu dữ liệu cá nhân của khách | Tuân thủ **Nghị định 13/2023/NĐ-CP** về bảo vệ dữ liệu cá nhân: quyền truy cập của nhân viên phải có log, xóa dữ liệu khi chấm dứt hợp đồng |
| Abuse là chuyện hiếm | Spam, phishing, malware, đào coin, DDoS đi ra là chuyện thường gặp | Module **Abuse & Compliance** mới |
| Branding ITSO cố định | Khách nhìn thấy panel | White-label cơ bản: logo, màu, domain portal, email template |

## 2. Mô hình tenant mới

```
Tổ chức vận hành (ITSO / công ty)
├── SUPER_ADMIN              toàn quyền
├── ADMIN                    quản lý server/khách được giao (vd: phòng kỹ thuật, nhóm CSKH)
├── SUPPORT  (vai trò mới)   xem + hỗ trợ khách; impersonate có lý do, có thời hạn, ghi audit, báo khách
│
├── Khách hàng nội bộ (Customer: "Công ty — IT nội bộ")  → server nhóm "internal"
└── Khách hàng bên ngoài (Customer)                         → server nhóm "customer"
    ├── USER chủ tài khoản (owner)
    ├── Sub-user (vai trò mới, P1): developer / chỉ file / chỉ DB / chỉ xem — do owner tạo
    └── Hosting account(s) → websites, DB, SFTP, cron, backup …
```

- Thêm thực thể **Customer** (khách hàng/hợp đồng) đứng trên USER: một khách có thể có nhiều user và nhiều hosting account. Quota, backup, abuse case, trạng thái hợp đồng gắn với Customer/Account.
- **Nhóm server** (`server_groups`: internal, customer-shared, customer-dedicated). Khuyến nghị mạnh: **website nội bộ của công ty không đặt chung server với khách** (D-28). Điều này làm multi-server quan trọng hơn trước.

## 3. Cô lập tenant mạnh hơn

Bổ sung lên trên thiết kế ở `07-HOSTING-ISOLATION.md` (uid riêng, slice, quota, PHP-FPM riêng):

| Lớp | Biện pháp | Ghi chú |
|---|---|---|
| **Sandbox tiến trình** (D-29) | Mọi unit của account (PHP-FPM, cron, app) chạy với systemd sandboxing: `ProtectSystem=strict`, `ProtectHome=tmpfs` + `BindPaths=/home/<acct>`, `PrivateTmp=yes`, `PrivateDevices=yes`, `NoNewPrivileges=yes`, `ProtectProc=invisible`, `RestrictSUIDSGID=yes`, `RestrictNamespaces=yes`, `SystemCallFilter=@system-service`, `ReadOnlyPaths=/etc` (trừ file cần) | Kiểu "CageFS" nhưng dùng công cụ có sẵn của systemd, chi phí gần bằng 0. Account không nhìn thấy `/home` của người khác dù sai permission |
| **SSH shell cho khách** | Mặc định **tắt**. Khi gói cho phép: shell chạy trong jail (bubblewrap/systemd-run với cùng sandbox, chỉ thấy home + `/usr` read-only), đặt trong slice của account | SFTP chroot vẫn là mặc định |
| **Egress filtering per uid** | nftables `meta skuid`: chặn port 25 ra ngoài với mọi uid hosting; giới hạn tốc độ kết nối mới ra ngoài; chặn truy cập metadata/IP nội bộ | Chống spam, chống pivot vào mạng công ty |
| **Mạng nội bộ** | Server khách không có route tới mạng nội bộ công ty (VLAN/firewall tầng mạng) | Quyết định hạ tầng, ngoài panel nhưng ghi vào checklist |
| **Noisy neighbor** | `IOWeight` + `IOReadBandwidthMax/IOWriteBandwidthMax` bắt buộc trên server khách; MySQL `MAX_USER_CONNECTIONS` + `max_statement_time` per user; chính sách oversell (tổng quota ≤ X% tài nguyên) | |
| **DB** | Cân nhắc MariaDB riêng cho từng khách "dedicated" (P2); shared vẫn dùng giới hạn per user | |
| **Docker** | Khách **không** dùng Docker trên server shared ở v0.x; chỉ trên server dedicated của khách đó (D-18 thắt chặt) | |

## 4. Customer portal (tự phục vụ)

| Nhóm | Chức năng | Ưu tiên |
|---|---|---|
| Truy cập | Domain portal riêng (vd `my.itso.vn`), đăng nhập, quên mật khẩu, MFA (khuyến khích; bắt buộc nếu bật Docker/SSH), quản lý phiên | P0 |
| Tổng quan | Usage so với quota (disk, inode, CPU, RAM, băng thông, DB), trạng thái site, cert sắp hết hạn | P0 |
| Tự phục vụ | Website, domain, SSL, DB, File Manager, SFTP, cron, backup/restore của mình, PHP version, WordPress | P0 |
| Yêu cầu | **Yêu cầu nâng/đổi gói** (admin duyệt trong panel), yêu cầu thêm tài nguyên | P1 |
| Sub-user | Owner mời thành viên, gán quyền giới hạn | P1 |
| Hỗ trợ | Nút "Gửi yêu cầu hỗ trợ" mở hệ thống ticket bên ngoài (link/email có kèm mã tài khoản); **đồng ý cho nhân viên truy cập** (support access grant có thời hạn) | P1 |
| Thông báo | Email/in-app: quota 80/100%, cert, backup lỗi, tạm ngưng, bảo trì, sự cố | P0 |
| Pháp lý | Chấp nhận Điều khoản sử dụng/Chính sách dữ liệu lần đầu đăng nhập (lưu phiên bản + thời điểm) | P0 |
| Dữ liệu | Xuất toàn bộ dữ liệu của mình (backup tải về) | P1 |

**Không có:** tự đăng ký tài khoản công khai (chỉ admin tạo), thanh toán trong panel.

## 5. ~~Cấp tài khoản khách hàng: admin tạo tay (D-24)~~ — ĐÃ THAY bởi Provisioning API + Billing Adapter, xem 15-HOSTING-PROVIDER.md §5–6

- Không có Provisioning API, không có webhook cho hệ thống billing. Việc tính tiền nằm hoàn toàn ngoài panel.
- Luồng trong panel cho ADMIN/SUPPORT: **Tạo khách hàng → tạo user owner (gửi email mời đặt mật khẩu) → tạo hosting account (chọn gói, nhóm server)**, gói gọn trong một wizard.
- Thao tác vòng đời bằng tay: tạm ngưng (kèm lý do hiển thị cho khách, vd "quá hạn thanh toán"), mở lại, đổi gói, chấm dứt hợp đồng.
- Hỗ trợ việc tính tiền bên ngoài: cột **ngày hết hạn hợp đồng** (chỉ để nhắc), danh sách "sắp hết hạn" cho admin, xuất CSV usage theo tháng.
- API token có scope (đã có ở Phase 3) vẫn tồn tại cho tự động hóa nội bộ, nhưng không có endpoint provisioning riêng. Có thể bổ sung sau nếu cần.

## 6. Abuse & Compliance (module mới, số 31)

| Chức năng | Mô tả |
|---|---|
| Phát hiện | CPU cao kéo dài (đào coin), nhiều kết nối ra ngoài, gửi mail qua PHP, file malware/phishing (ClamAV/YARA + chữ ký phishing kit), WAF/Fail2ban cho thấy site bị dùng tấn công, báo cáo từ bên ngoài |
| Abuse case | Ticket nội bộ: nguồn, bằng chứng (đã che dữ liệu nhạy cảm), account liên quan, trạng thái, hạn xử lý, người xử lý |
| Hành động theo bậc | Cảnh báo khách → giới hạn (giảm CPU, chặn egress) → tạm ngưng site → tạm ngưng account; mọi bước có lý do hiển thị cho khách |
| Mail | Không chạy mail server (D-17 giữ). PHP `mail()` mặc định **tắt** trên server khách; nếu cần, gửi qua SMTP relay có xác thực với **giới hạn số mail/giờ theo gói** |
| Abuse inbox | Địa chỉ `abuse@` và form tiếp nhận ngoài (tích hợp email → case) — P1 |
| Chấm dứt hợp đồng | Terminate → giữ dữ liệu N ngày (cấu hình, vd 30) → xóa account, DB, **và backup** sau khi hết hạn immutable; tạo biên bản xóa |
| Truy cập của nhân viên | Impersonate/xem file khách cần lý do + support grant (nếu bật chế độ nghiêm) + audit + thông báo khách |
| Lưu vết pháp lý | Audit log, log truy cập panel giữ theo chính sách (vd 12 tháng), xuất được khi có yêu cầu hợp pháp |

## 7. Quota và backup theo khách hàng

| Hạng mục | Thiết kế mới |
|---|---|
| Quota | Đặt ở **hosting account** (kernel) và có tổng hợp ở **customer** (hiển thị, cảnh báo). Thêm: inode limit, bandwidth tháng (đo từ log Nginx, soft — vượt thì cảnh báo/giới hạn tốc độ), mail/giờ, số sub-user |
| Backup repo | **Một restic repo riêng cho mỗi hosting account** trên server khách (D-23), mật khẩu riêng. Mất dedupe giữa khách nhưng: cô lập dữ liệu khi restore, xóa được sạch khi chấm dứt hợp đồng, tính quota chính xác. Server nội bộ vẫn dùng repo chung |
| Backup do công ty vận hành | Lịch hệ thống (DR, không tính vào quota khách) tách khỏi **backup khách tự tạo** (tính vào `backup_quota`) |
| Retention | Gói quy định số bản giữ; immutable window toàn hệ thống (vd 14 ngày) phải **ngắn hơn** thời gian giữ dữ liệu sau terminate để xóa được đúng cam kết |
| Restore self-service | Khách tự restore site/DB/file từ snapshot của mình; restore ghi đè có xác nhận + bản pre-restore |
| Tải về | Khách tải bản backup (tar.gz tạo từ snapshot, link ký ngắn hạn), giới hạn số lần/ngày |

## 8. Branding (white-label cơ bản) — D-30

- v0.x: **một brand cho toàn hệ thống** do SA cấu hình: tên sản phẩm, logo sáng/tối, favicon, màu chủ đạo (token Tailwind), domain portal, trang đăng nhập, trang suspend, trang lỗi mặc định của site, email template (VI/EN), chân trang điều khoản/hỗ trợ.
- Tách **domain Admin** (vd `admin.itso.vn`, allowlist IP) và **domain Customer portal** (`my.itso.vn`) — cùng ứng dụng, khác chính sách (D-25).
- Branding theo từng ADMIN/đại lý: P2, chỉ khi thực sự có đại lý (hiện không có reseller billing).
- UI demo Phase 2 cần có thêm bộ màn hình Customer portal và trang cấu hình branding.

## 9. Thay đổi lộ trình

Thêm **một Phase mới "Customer Readiness"** ngay sau Backup; các Phase sau dịch xuống. Tổng: **13 Phase**.

| Phase | Tên | Thay đổi |
|---|---|---|
| 1 | Foundation | + tài liệu threat model khách hàng |
| 2 | Complete UI Demo | + Customer portal, Branding, Abuse case, wizard tạo khách hàng, vai trò SUPPORT |
| 3 | Auth, RBAC, … | + bảng `customers`, `server_groups`, vai trò SUPPORT, chấp nhận ToS, tách admin/customer origin |
| 4 | Agent, Installer, … | + **systemd sandboxing per account** (D-29), egress nft per uid, IO limits bắt buộc |
| 5–6 | Hosting core | + chặn `mail()`, jail SSH, inode quota |
| 7 | Security Center | + phát hiện abuse cơ bản (CPU, egress, phishing) |
| 8 | Backup & Restore | + repo per account, backup khách tự phục vụ, tải backup, xóa khi terminate → **v0.1.0-alpha (chỉ dùng nội bộ)** |
| **9 (mới)** | **Customer Readiness** | Customer portal hoàn chỉnh, sub-users, support access grant, Abuse & Compliance, wizard tạo khách hàng thủ công + nhắc hạn hợp đồng, branding, thông báo khách, chính sách dữ liệu/ToS, **pentest độc lập** → **v0.2.0-beta (nhận khách thử nghiệm có chọn lọc)** |
| 10 | Docker | Chỉ SA/AD và server dedicated của khách |
| 11 | WordPress / Software / DNS / Git | WordPress Toolkit ưu tiên cao hơn (khách cần nhiều) |
| 12 | Monitoring / Multi-server | Multi-server cần trước khi có nhiều khách (tách internal/customer) |
| 13 | Production Hardening | + SLA, status page, quy trình sự cố → **v1.0** |

**Lưu ý thứ tự:** nếu muốn tách server nội bộ và server khách ngay từ đầu, cần đưa phần multi-server tối thiểu (agent remote qua mTLS) lên **trước Phase 9**. Phương án thay thế rẻ hơn: mỗi server cài một panel độc lập cho tới Phase 12. Đây là quyết định D-28.

## 10. Rủi ro mới

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| K16 | Khách dùng hosting để spam/phishing → IP server bị blacklist, ảnh hưởng mọi khách và website công ty | Chặn port 25, tắt `mail()`, giới hạn relay, quét phishing, tách server nội bộ |
| K17 | Một khách thoát sandbox → đọc dữ liệu khách khác | Sandbox systemd + uid + quota + pentest độc lập trước khi nhận khách |
| K18 | Panel public bị tấn công hàng loạt (credential stuffing) | Rate limit, CAPTCHA sau N lần sai, MFA, WAF trước portal, phát hiện đăng nhập bất thường |
| K19 | Rủi ro pháp lý dữ liệu cá nhân | Chính sách dữ liệu, log truy cập nhân viên, quy trình xóa, ToS có phiên bản |
| K20 | Kỳ vọng của khách vượt phạm vi (email, DNS hosting, hỗ trợ 24/7) | Nói rõ trong gói dịch vụ; email dùng dịch vụ ngoài; DNS hosted là quyết định riêng |
