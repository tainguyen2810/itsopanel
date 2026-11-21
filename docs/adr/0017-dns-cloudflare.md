# ADR 0017: DNS qua Cloudflare API từ Laravel

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 5)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-70

## Bối cảnh

ROADMAP gốc đưa DNS provider (Cloudflare) vào Phase 5. Quản lý DNS là gọi API bên ngoài, không cần quyền root hay thao tác Linux.

## Quyết định

1. Laravel gọi `https://api.cloudflare.com/client/v4` bằng HTTP client (base URL cố định, timeout 10 s, không theo redirect). Không qua agent. Không vi phạm quy tắc "Laravel không chạy lệnh hệ thống" vì đây là HTTP.
2. Provider: chỉ `cloudflare`. API token (quyền Zone:Read, DNS:Edit) kiểm bằng `GET /user/tokens/verify` khi thêm, lưu mã hóa (`Crypt`) trong `dns_providers.credentials_encrypted`, không bao giờ trả về API hay log.
3. Zone: gắn zone đã có trong tài khoản Cloudflare (`GET /zones?name=`), lưu `external_id`, tùy chọn gắn hosting account (ADMIN chỉ thấy zone của account trong phạm vi). Bỏ zone khỏi panel không xóa trên Cloudflare.
4. Record: thêm/sửa/xóa chạy bằng job với bước của panel `dns.records.apply` (worker gọi Cloudflare trước, thành công mới ghi DB; lỗi → job failed, DB không đổi). `itso:dns-sync` đồng bộ record từ Cloudflare (Cloudflare là nguồn sự thật).
5. Chỉ Admin realm (sitemap: Portal không quản lý DNS ở bản này).

## Hệ quả

- Test bằng `Http::fake`; không cần mạng.
- Thêm provider khác (PowerDNS…) sau này qua interface `DnsProvider` cùng hợp đồng.

## Sửa đổi khi hiện thực (Prompt 5.4)

- Bước panel: `config('itso.panel_steps')` ánh xạ op → lớp `PanelStep`; `JobRunner` chạy bước này trong worker thay vì gọi agent. Lỗi Cloudflare 4xx → `invalid_params` (không thử lại), 5xx/429/mạng → `dependency_unavailable` (thử lại theo backoff).
- Quyền mới: `dns.read`, `dns.write` (ADMIN có, theo phạm vi account), `dns.providers` (chỉ SUPER_ADMIN; xóa provider cần step-up).
- Cloudflare lỗi tạm thời khi thêm provider/zone hoặc đồng bộ → 409 `precondition_failed` (không đổi DB). Record loại panel chưa quản lý (HTTPS, SVCB…) giữ nguyên trên Cloudflare, không đồng bộ về.
