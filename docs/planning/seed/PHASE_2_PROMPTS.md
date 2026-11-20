# Phase 2 — Complete UI Demo: prompt chi tiết

> Viết ngày 2026-11-20, sau khi Phase 1 được duyệt. Nguồn: `ROADMAP.md` (dòng Phase 2), `docs/planning/11-ROADMAP.md` §Phase 2, `docs/ui/sitemap.md`, Design System Phase 1 (`design/docs/README.md`).
> Mốc: `v0.0.1-demo`. Nhánh `phase-2`. Không có trang mua hàng, thanh toán, billing (OUT OF SCOPE). Không có backend nghiệp vụ (Phase 3).

## Mục tiêu Phase 2

Demo **hoàn chỉnh** Private Admin Panel và User Hosting Portal chạy **không cần backend**: mọi mục sidebar mở được trang có nội dung thật, dữ liệu mẫu nhất quán giữa các trang, VI/EN, Light/Dark, 390–1440 px. API giả lập bằng MSW, **đúng theo OpenAPI** (type sinh ở Phase 1, response được kiểm bằng schema).

## Quyết định kỹ thuật dùng trong Phase 2

| Việc | Cách làm | Căn cứ |
|---|---|---|
| Routing | TanStack Router, khai báo route bằng code (không plugin sinh file), mỗi entry một router (`/admin/*`, `/portal/*`) | D-05 |
| Mock API | MSW 2: service worker ở trình duyệt khi chạy demo, `msw/node` trong Vitest; handler có type theo `paths` sinh từ OpenAPI | D-05, D-14, D-55 |
| Dữ liệu demo | Một nguồn: `contracts/tools/demo.py` → `contracts/examples/demo-dataset.json` (cũng là example OpenAPI và nguồn `DemoSeeder` Phase 3); mở rộng đủ số liệu cho mọi trang | 11-ROADMAP §Phase 2 |
| Gọi API | openapi-fetch + TanStack Query qua client có type (`src/api`) | D-55 |
| Bản demo tĩnh | `pnpm build:demo` → `dist-demo/` (kèm MSW worker), chạy được trên hosting tĩnh; bản build thường **không** chứa MSW | 11-ROADMAP DoD |
| Vai trò demo | Switcher SA / AD (admin) và US (portal); guard theo vai trò, trang "không có quyền" | sitemap |

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 2.1 | Nền demo: router, MSW theo OpenAPI, dataset mở rộng + kiểm nhất quán, role switcher + guard, khung trang (list/detail/form, rỗng/tải/lỗi/không quyền), JobProgress drawer, smoke test mọi route | 1 ngày |
| 2.2 | Admin chung: Dashboard theo mockup, Jobs, Profile, Ctrl+K tìm thật, Login/MFA, Wizard cài đặt | 1 ngày |
| 2.3 | Hạ tầng: Servers (list, thêm, chi tiết + Nginx, PHP, phần mềm, firewall, Docker, terminal), Compose, Registries | 1 ngày |
| 2.4 | Hosting I: Gói hosting, Tài khoản hosting (list, wizard tạo, chi tiết nhiều tab, chuyển server, chờ purge) | 1 ngày |
| 2.5 | Hosting II: Website, Database, File Manager, SFTP/SSH, SSL, DNS, Cron, WordPress, Git deploy | 1,5 ngày |
| 2.6 | Bảo mật, Sao lưu/Khôi phục, Quản trị (Users, Roles, Monitoring, Alerts, Audit, Notifications, Settings) | 1,5 ngày |
| 2.7 | User Hosting Portal: mọi trang của USER | 1 ngày |
| 2.8 | Kiểm tra tổng: screenshot 1440/390 × light/dark trang chính, axe mọi route, số liệu nhất quán, `build:demo`, báo cáo Phase 2 | 0,5 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit nhỏ Conventional Commits `feat(p2)`, `test(p2)`, `docs(p2)`.

---

## Prompt 2.1 — Nền demo

```
[ITSO Panel] Prompt 2.1 — Nền demo (router, MSW, dataset, khung trang)
Phase 2. Chưa làm trang module (chỉ khung + trang mẫu để kiểm khung).

Phạm vi:
1. TanStack Router cho admin và portal: cây route đủ theo docs/ui/sitemap.md (route chưa làm
   ở prompt này trỏ tới trang tạm có tiêu đề, breadcrumb; prompt sau thay bằng trang thật).
   Sidebar dùng Link của router, active state, breadcrumb tự sinh.
2. Dataset: mở rộng contracts/tools/demo.py (≥ 3 server, ≥ 6 gói/phiên bản, ≥ 10 account,
   ≥ 20 website, DB, domain, cert, cron, backup, job, audit…), quan hệ đúng
   (account → server, gói, chủ; website → account…). `make contracts` + `make codegen` không diff.
   Script kiểm nhất quán: khóa ngoại tồn tại, số đếm tổng hợp (dashboard, usage) khớp dữ liệu chi tiết.
3. MSW: handler cho các endpoint UI dùng, type theo `paths` OpenAPI; phân trang/lọc/sắp xếp
   theo tham số trong contract; thao tác ghi trả 202 + JobAccepted và job chạy giả lập từng bước.
   Vitest: mọi response của handler validate theo schema OpenAPI (ajv).
4. Vai trò demo: switcher SA/AD trong admin (AD chỉ thấy phạm vi được giao), US trong portal; guard
   route theo vai trò → trang 403 thân thiện.
5. Khung trang: PageHeader, ListPage (DataTable + bộ lọc + URL state), DetailPage (Tabs theo URL),
   FormPage/FormDialog, trạng thái đang tải (Skeleton), rỗng, lỗi (Problem), không có quyền;
   JobProgress drawer toàn cục theo dõi job.
6. Chạy demo: `pnpm dev:demo` (MSW bật), `pnpm build:demo` → dist-demo; build thường không có MSW.

Kiểm thử: Vitest (handler theo schema, dataset nhất quán, guard, ListPage URL state);
Playwright smoke: mở mọi route admin/portal ở chế độ demo, không lỗi console, không 404.

Tiêu chí nghiệm thu:
- [ ] Mọi route trong sitemap tồn tại; smoke test xanh.
- [ ] Response MSW 100% hợp lệ theo OpenAPI; dataset nhất quán.
- [ ] Build thường không chứa MSW (kiểm bằng grep dist).
```

## Prompt 2.2 — Admin chung

```
[ITSO Panel] Prompt 2.2 — Dashboard, Jobs, Profile, tìm kiếm, đăng nhập, wizard cài đặt
Phạm vi: /dashboard theo mockup (StatCard, Gauge, Area/Bar/Donut, bảng server, hoạt động gần đây,
cảnh báo bảo mật) — số liệu lấy từ API mock và khớp các trang list; /jobs, /jobs/:id (bước, log, hủy/thử lại);
/profile (hồ sơ, mật khẩu, MFA, phiên); Ctrl+K tìm thật trên server/account/website/user;
/login, /login/mfa (demo, không xác thực thật); /install wizard 10 bước (chỉ giao diện).
Kiểm thử: Vitest logic (wizard, tìm kiếm); Playwright luồng dashboard → server; số trên dashboard = số dòng list.
```

## Prompt 2.3 — Hạ tầng

```
[ITSO Panel] Prompt 2.3 — Servers, dịch vụ, Docker, Compose
Phạm vi: /servers, /servers/new (lệnh join + chờ agent giả lập), /servers/:id (Tổng quan, Dịch vụ,
Tài nguyên, Agent, Accounts), /servers/:id/{nginx,php,software,firewall,docker,terminal},
/compose-projects(+/:id), /docker/registries. Firewall safe-apply có đếm ngược rollback; terminal là
mô phỏng (không chạy lệnh), ghi rõ policy; thao tác dịch vụ chạy JobProgress.
Kiểm thử: Vitest firewall countdown, form; Playwright luồng restart dịch vụ → job xong.
```

## Prompt 2.4 — Hosting I

```
[ITSO Panel] Prompt 2.4 — Gói hosting và tài khoản hosting
Phạm vi: /hosting-packages(+new, :id với lịch sử version, so sánh giới hạn); /hosting-accounts
(list, usage, vòng đời), /new wizard (user, gói, server có gợi ý, username), /:id Tabs (Tổng quan +
usage, Websites, Databases, SFTP, Cron, Backup, Vòng đời; khóa/mở, đổi gói, chuyển server, xóa với
ConfirmDialog gõ tên), /:id/migrate wizard (preflight, sync, kiểm tra, cutover, rollback),
/hosting-accounts/terminated (đếm ngược 30 ngày, backup đã xác minh, purge 2 bước — D-46).
Kiểm thử: Vitest validate form gói/wizard; Playwright tạo account → job → xuất hiện trong list.
```

## Prompt 2.5 — Hosting II

```
[ITSO Panel] Prompt 2.5 — Website, Database, File, SFTP, SSL, DNS, Cron, WordPress, Git
Phạm vi: /websites(+:id Tabs Tổng quan, Domain, PHP, SSL, Nginx, WAF, Log, Backup), /databases,
/files (2 pane trong home account, chọn account trước, chặn đường dẫn ngoài home), /sftp, /ssl,
/dns (zone, record), /cron (+ lịch sử chạy), /wordpress, /git-deployments.
Kiểm thử: Vitest đường dẫn File Manager, form record DNS, cron expr; Playwright tạo website → job.
```

## Prompt 2.6 — Bảo mật, sao lưu, quản trị

```
[ITSO Panel] Prompt 2.6 — Security, Backup/Restore, Users, Monitoring, Audit, Settings
Phạm vi: /security (+waf, malware, ssh, fail2ban, fim, allowlist), /backups (Đích, Chính sách, Lịch sử,
Kiểm chứng, checklist 3-2-1-1-0), /restores(+new wizard), /users(+:id, phạm vi ADMIN, impersonate có lý do),
/roles (ma trận chỉ xem), /monitoring(+alerts), /audit-logs (lọc, chi tiết, xuất CSV), /notifications,
/settings (Tabs).
Kiểm thử: Vitest ma trận quyền hiển thị, xuất CSV; Playwright restore wizard.
```

## Prompt 2.7 — User Hosting Portal

```
[ITSO Panel] Prompt 2.7 — Portal của USER
Phạm vi: mọi route mục B của sitemap: đăng nhập/quên mật khẩu, Tổng quan usage/quota, account,
websites(+new, :id), databases, files, sftp, cron, backups, wordpress, terminal (gói có SSH), jobs/:id,
notifications, profile. Chỉ dữ liệu của USER đang đăng nhập; không có route/menu admin, không mua hàng.
Kiểm thử: Vitest portal không gọi /admin/; Playwright đổi user demo → chỉ thấy dữ liệu của mình.
```

## Prompt 2.8 — Kiểm tra tổng và báo cáo

```
[ITSO Panel] Prompt 2.8 — Kiểm tra tổng Phase 2
Phạm vi: Playwright chụp trang chính 1440/390 × light/dark → docs/screenshots/phase-2/; axe trên mọi
route (0 critical/serious); kiểm không tràn ngang 390px mọi route; kiểm i18n không chuỗi cứng (EN không
lẫn tiếng Việt ngoài dữ liệu); số liệu nhất quán; `build:demo` chạy trên server tĩnh; docs/reports/phase-2.md;
ROADMAP/PHASE_STATUS/TEST_REPORT; make check xanh; merge phase-2 → main (local).
Tiêu chí nghiệm thu Phase 2:
- [ ] Mọi mục sidebar mở trang có nội dung thật (không "coming soon").
- [ ] Đổi VI/EN không còn chuỗi cứng; dark/light đúng; không tràn ngang 390px.
- [ ] Số liệu nhất quán giữa các trang.
- [ ] Screenshot trong repo; bản demo tĩnh build được; báo cáo.
Kết thúc: báo cáo Phase 2; DỪNG. Không bắt đầu Phase 3.
```
