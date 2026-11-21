# ADR 0025: WAF ModSecurity v3 + OWASP CRS theo website

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 7)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-78, D-67

## Bối cảnh

Website khách thường là WordPress/PHP tự viết; WAF chặn được lớp tấn công phổ biến nhưng false positive làm hỏng site. Vhost sinh từ template (ADR 0014) không cho snippet tự do; WAF phải giữ nguyên tắc đó.

## Quyết định

1. Gói từ kho Ubuntu 24.04: `libnginx-mod-http-modsecurity`, `modsecurity-crs` (recipe `modsecurity`). Thiếu gói → `waf.apply` trả `available=false`, website hiển thị `waf: unavailable`. Coraza: DEFERRED.
2. Template vhost có khối `modsecurity on; modsecurity_rules_file /etc/itso/waf/<website_uuid>.conf;`. File này agent sinh từ tham số kiểu hóa: `mode` (`DetectionOnly`|`On`|`Off` → `SecRuleEngine`), `paranoia_level` 1–4, `rule_exclusions` là **số nguyên** (`SecRuleRemoveById`). Không có ô cấu hình tự do; vector "rule id không phải số" bị schema chặn.
3. Website mới: `DetectionOnly`; `waf_settings.detection_since` + 7 ngày → panel nhắc chuyển `On` (tùy chọn `auto_block`).
4. Sự kiện: audit log JSON của ModSecurity (`/var/log/itso/waf/audit.log`, root 0640). `waf.events{cursor, limit}` đọc theo con trỏ `inode:offset`, trả sự kiện đã chuẩn hóa (rule id, severity, IP, method, URI cắt 2048 ký tự, detected|blocked). Laravel ghi `waf_events` (partition tháng) và `security_events` mức high/critical.
5. Áp dụng: `waf.apply` ghi file → `nginx -t` → reload; lỗi → hoàn tác (như vhost).

## Hệ quả

- Không cần dịch vụ WAF riêng; chi phí CPU nằm trong worker nginx.
- Kiểm thử: golden conf, rule id chuỗi bị từ chối, parser audit log (dòng hỏng bỏ qua, con trỏ khi log xoay); VM: payload SQLi/XSS mẫu bị chặn ở mode `On`, chỉ ghi nhận ở `DetectionOnly`.
