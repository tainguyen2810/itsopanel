# Review bảo mật Security Center (Phase 7, Prompt 7.7)

- **Ngày:** 2026-11-21 · **Phạm vi:** tường lửa nftables safe-apply, SSH hardening, fail2ban, WAF ModSecurity + CRS, quét/cách ly mã độc, FIM, điểm bảo mật, CAPTCHA Portal, IP allowlist, terminal root + ghi phiên (Laravel `app/Domain/Security/*`, `app/Auth/{Captcha,AuthFailureLog}`, controller `Security/*`, agent `ops/{firewall,safe,sshd_hardening,fail2ban,waf,malware,fim,pty}.go`, `internal/term`, `internal/policy`).
- **Quyết định liên quan:** D-76 → D-81, ADR 0023–0028, threat model `docs/security/threat-model.md`.
- **Cách review:** đọc code theo từng đường vào, đối chiếu với test tự động (Pest `Phase7/*`, Go `ops/*_test`, `term/record_test`, Vitest, Playwright demo và e2e stack thật `e2e-real/phase7.spec.ts`); phần chỉ kernel/dịch vụ thật kiểm được ghi **chờ VM** (`tests/vm/phase7.sh`).

## 1. Ranh giới tin cậy

```text
Trình duyệt ──HTTPS──► Laravel (user itso, không chạy lệnh) ──HMAC/unix socket──► itso-agent (root)
   │ CAPTCHA PoW (Web Worker)          │ quyền security.* + step-up            │ validate lại (JSON Schema + Go)
   │                                   │ IP client = REMOTE_ADDR               ├─ nft -f / sshd -t / fail2ban-client
   └─ WebSocket terminal ──► itso-gateway (itso-gw) ──peercred──► agent stream ─┴─ systemd-run (uid account / root)
```

1. **Laravel** chỉ dựng tham số kiểu hóa (rule tường lửa, khóa sshd cố định, jail trong danh sách, mode WAF, đường dẫn tương đối). Không có ô "cấu hình tự do". Quyền: `security.read/write` (ADMIN theo phạm vi server) và `security.server` (chỉ SUPER_ADMIN) cho tường lửa, SSH, fail2ban, FIM baseline, bản ghi terminal.
2. **Agent** validate lại mọi tham số và giữ bất biến an toàn độc lập với panel: chống tự khóa (cổng SSH + panel từ IP client luôn mở), một lần chờ xác nhận cho mỗi loại, token chỉ lưu sha256, policy root đọc từ file root 0600.
3. **Hoàn tác không phụ thuộc panel:** timer systemd tạm thời (`systemd-run --on-active`) gọi `itso-agent safe-rollback`, vẫn chạy khi panel/agent chết. Ngoài timer, mọi op cùng loại và lúc agent khởi động đều kiểm hạn.

## 2. Các mối đe dọa và biện pháp

| # | Tấn công / rủi ro | Biện pháp | Kiểm bằng |
|---|---|---|---|
| T1 | Áp tường lửa tự khóa (chặn SSH/panel của chính mình) | Kiểm ở Laravel (`FirewallRuleset::check`, bản xem trước `lockout_risk` + UI chặn nút áp dụng) **và** ở agent (`net/netip`, `would_lock_out`); ruleset luôn có rule cho cổng SSH + panel từ IP client trước rule người dùng | Pest `FirewallTest` (golden PHP == Go), Go `firewall_test`, Vitest demo; e2e stack thật (xem trước có cổng mới) |
| T2 | Mất kết nối sau khi áp dụng (rule sai, panel chết) | Safe-apply: hạn 30–600 giây, timer systemd hoàn tác, quá hạn + 15 giây ân hạn panel đánh dấu `rolled_back` + sự kiện high + thông báo; confirm muộn → 409 | Pest; e2e stack thật (không xác nhận → `rolled_back`, confirm muộn 409, sự kiện high); **VM S1** (dừng agent, timer tự hoàn tác) |
| T3 | Lộ/đoán token xác nhận | 32 byte ngẫu nhiên, chỉ trả một lần, agent lưu sha256, so sánh hằng thời gian; panel giữ token trong cache mã hóa, không vào job params/log/audit; sai token → `precondition_failed` | Pest (token không có trong jobs/job_steps/job_logs/audit_logs/firewall_applies); Go `safe_test`; **VM S1** (token sai bị từ chối) |
| T4 | Chèn cú pháp nft/sshd qua comment, cổng, CIDR | Comment chặn ký tự điều khiển, `"` và `\`; cổng/khoảng cổng theo regex + 1–65535; CIDR chuẩn hóa bằng `netip`; sshd chỉ nhận tập khóa cố định, `sshd -t` trước khi reload | evil-inputs `firewall_rule`/`cidr` dùng chung Laravel + agent; Go golden |
| T5 | Tắt đăng nhập mật khẩu khi chưa có khóa SSH | Agent đếm khóa của user quản trị; 0 khóa → `would_lock_out`; panel chặn trước | Pest `SecurityCenterTest`; e2e stack thật (SSH hardening); sửa ở 7.7: gốc sandbox thiếu user `root` khiến mọi thay đổi SSH lỗi trong dev/e2e |
| T6 | fail2ban tự khóa admin / ban sai IP | `ignoreip` = IP allowlist của panel; jail `itso-panel` đọc `/var/log/itso/auth.log` do panel ghi (chỉ dòng `ip=<IP hợp lệ>`, không email/mật khẩu); unban kiểm IP bằng `Net::ip` + agent | Pest `AuthProtectionTest` (failregex, không lộ email), Vitest; **VM S2** |
| T7 | Bỏ qua WAF / tắt WAF trái phép | Mode chỉ Off/DetectionOnly/On, paranoia 1–4, loại trừ chỉ id rule 6 số; include theo glob trong vhost do agent sinh; `nginx -t` lỗi → khôi phục; mặc định DetectionOnly trước khi chặn; thao tác ghi audit | Go `security2_test`; Pest `ProtectionTest`; e2e stack thật (bật chặn + sự kiện); **VM S3** |
| T8 | Log WAF giả/độc hại (dòng dài, JSON hỏng, Host lạ) | Đọc theo con trỏ inode:offset, giới hạn 4 MiB/lượt, bỏ dòng hỏng, gán website chỉ theo `server_name` của vhost do agent sinh, IP parse bằng netip, cắt message/URI | Go `TestWafEvents`; Pest (55 sự kiện, `waf.burst`) |
| T9 | Quét mã độc thành đường đọc file người khác / root | `clamdscan --fdpass` + yara chạy dưới **uid account** trong slice account (Nice 19, IO idle, CPUQuota 50%); target là `RelPath`; không theo symlink | Go (symlink tới file hệ thống không bị theo, argv golden); **VM S4** |
| T10 | Cách ly/khôi phục/xóa sai file | Helper uid account, kiểm `expected_sha256` trước khi chuyển, không theo symlink, khôi phục không ghi đè trừ `overwrite`, xóa theo sha256; xóa ở Portal cần step-up | Go `security2_test`; Pest; e2e stack thật (EICAR → cách ly → khôi phục); **VM S4** |
| T11 | Kẻ tấn công sửa file hệ thống rồi giấu (FIM) | Baseline giữ ở agent (root 0600), không nhận baseline từ panel; rebaseline cần SUPER_ADMIN + step-up; thư mục agent tự thay đổi bị bỏ qua có chủ đích (danh sách cố định) | Go `fim` test; Pest; e2e stack thật; **VM S5** |
| T12 | Dò mật khẩu Portal bằng bot | CAPTCHA PoW sau 3 lần sai (theo email **hoặc** IP, 60 phút), challenge HMAC `APP_KEY` gắn realm + hạn 5 phút, dùng một lần (`Cache::add`), nonce ≤ 12 chữ số; vẫn có khóa lũy tiến Phase 3 | Pest `AuthProtectionTest`, Vitest `captcha.test.ts`; e2e stack thật (422 `captcha_required`, lời giải sai bị từ chối, UI tự giải rồi đăng nhập) |
| T13 | IP allowlist khóa chính admin | Danh sách mới không chứa IP hiện tại → `would_lock_out`; CIDR chuẩn hóa; khôi phục bằng `itso allowlist reset` trên máy chủ (artisan, argv cố định) | Pest; Go `install_test` |
| T14 | Root shell qua panel | Mặc định **tắt**; chỉ bật bằng `itso policy set terminal.root on` trên máy chủ (file policy root 0600, agent chặn ở registry + handler); chỉ SUPER_ADMIN realm Admin, step-up ≤ 10 phút kể cả khi `step_up_seconds` dài hơn; phiên root luôn ghi; ADMIN không thấy phiên root | Go `pty_test` (policy tắt chặn cả khi Deps cấu hình sai); Pest `TerminalRootTest`; e2e stack thật (policy tắt → 409 kèm hướng dẫn CLI); **VM S7** |
| T15 | Lộ bản ghi phiên (mật khẩu gõ, dữ liệu nhạy cảm) | Chỉ ghi output (không ghi phím gõ, mật khẩu không hiện thì không bị ghi); file 0600 root `O_EXCL|O_NOFOLLOW`; xem cần SUPER_ADMIN + step-up, audit mỗi lượt xem; 50 MB → cắt + đóng phiên | Go `record_test`; Pest; **VM S7** |
| T16 | Ticket terminal bị dùng lại / lộ | 32 byte, 30 giây, một lần, không lưu DB/audit, `Cache-Control: no-store`; socket stream kiểm peercred `itso-gw` | Pest `TerminalTest`; Go `term_test`; VM Phase 6 S7 |

## 3. Kết quả

- Không tìm thấy lỗ hổng mới trong mã Phase 7 khi review theo bảng trên.
- **Lỗi tìm thấy và sửa ở 7.7 (môi trường dev/e2e, không phải máy thật):** gốc agent sandbox không có user/group `root` như Ubuntu, nên `sshd.config.apply` trả `not_found` ("không có user quản trị root") và mọi thay đổi SSH trong dev/e2e đều lỗi. Sửa: `Sim.SeedBase()` thêm `root` vào `/etc/passwd`, `/etc/group` của gốc sandbox (không ghi đè, không lặp), test `TestSimSeedBase`.
- **Phát hiện ở 7.6 (đã sửa trước review):** trang SSH, fail2ban và điểm bảo mật không gửi `?server=` mà API bắt buộc; các endpoint bans, FIM changes, xem trước tường lửa, sự kiện WAF chưa được UI dùng.

## 4. Rủi ro còn lại / đề xuất

1. **Reverse proxy phía trước panel:** IP client lấy từ `REMOTE_ADDR` (không cấu hình trusted proxy). Panel mặc định nhận kết nối trực tiếp (FrankenPHP), nên đúng. Nếu sau này đặt proxy/CDN phía trước mà không cấu hình trusted proxy, mọi IP sẽ là IP proxy: fail2ban jail `itso-panel` có thể ban chính proxy, và rule chống tự khóa sẽ mở cho proxy thay vì admin. Ghi vào runbook Phase 7; cấu hình trusted proxy khi có nhu cầu (Phase sau).
2. **Root terminal là quyền root đầy đủ** khi đã bật: biện pháp là giới hạn người dùng + step-up + ghi phiên, không phải cô lập. Khuyến nghị giữ tắt, chỉ bật tạm khi cần.
3. **Bản ghi phiên lưu trên máy chủ** tới khi xóa thủ công; chưa có chính sách giữ/xoay vòng (đề xuất Phase 8 cùng retention backup).
4. **CAPTCHA PoW** làm chậm bot, không chặn được kẻ có nhiều CPU; khóa lũy tiến và fail2ban vẫn là lớp chính.
5. **FIM** phát hiện sau sự việc (mỗi giờ, phút 53) và baseline nằm trên chính máy chủ: root bị chiếm có thể sửa baseline. Đề xuất sau: gửi hash baseline về panel để đối chiếu.
6. **Chờ VM:** `tests/vm/phase7.sh` S0–S7 chưa chạy (container không có KVM/systemd).
