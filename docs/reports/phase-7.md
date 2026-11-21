# Báo cáo Phase 7: Security Center

- **Trạng thái:** ✱ **CHỜ DUYỆT**. Hoàn tất phần làm được không cần VM. Nhánh `phase-7`, merge `--no-ff` vào `main` ở Git local (không push, không remote). Tiêu chí cần kernel/systemd/dịch vụ thật được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`tests/vm/phase7.sh`).
- **Thời gian:** 2026-11-21.
- **Cách làm:** từ Phase 7 làm **mockup trước khi code** (7.0, ảnh ở `docs/screenshots/phase-7/`), rồi như Phase 4–6: code và test với runner giả, agent `--sandbox` (nft/sshd/fail2ban/clamdscan/yara mô phỏng ở tầng lệnh, file thật dưới gốc sandbox) và stack cloud thật (PostgreSQL 16 + Redis + Laravel + Vite + itso-gateway).
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Agent không có op chạy lệnh tùy ý, không `sh -c`; quét mã độc và cách ly chạy dưới uid account. Billing/WooCommerce/thanh toán: OUT OF SCOPE.
- **Quyết định đề xuất chờ duyệt:** D-76 (tường lửa nftables safe-apply), D-77 (SSH hardening + fail2ban), D-78 (WAF ModSecurity + CRS), D-79 (quét mã độc + cách ly), D-80 (FIM + điểm bảo mật), D-81 (CAPTCHA tự host, IP allowlist, terminal root theo policy + ghi phiên). ADR 0023 → 0028.

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 7.0 Mockup | Security Center trên bản demo (tổng quan + điểm, tường lửa safe-apply, SSH, fail2ban, WAF, mã độc, FIM, phiên terminal, Portal Bảo vệ), ảnh light/dark/390 px | 000014c |
| 7.1 Contracts | ADR 0023–0028; 22 op agent Phase 7, lỗi `would_lock_out`, recipe fail2ban/clamav/yara/modsecurity, 31 vector độc mới; OpenAPI +7; DBML + migration 12 bảng | 11d776e |
| 7.2 Agent (1) | `firewall.apply/confirm/status` (bảng `inet itso`, chống tự khóa, timer hoàn tác), `sshd.config.apply/confirm`, `fail2ban.apply/status/unban`; safe-apply dùng chung | 76c27f7 |
| 7.3 Agent (2) | `waf.apply/events`, `malware.scan/quarantine/restore/delete`, `fim.baseline/check`, `security.audit`; rule YARA kèm bản phát hành | 5e8565e |
| 7.4 Panel API | Domain/Security (ruleset PHP khớp golden agent, safe-apply, SSH, fail2ban, WAF + đồng bộ sự kiện, mã độc, FIM, điểm, sự kiện → thông báo), 32 endpoint admin + 5 portal, CAPTCHA PoW, `auth.log` cho fail2ban, IP allowlist chống tự khóa, nền bảo mật khi xong wizard | cc0074a |
| 7.5 Terminal root | Policy `terminal.root`/`record_user` (`itso policy set … on/off`), `pty.open.root` (SUPER_ADMIN + step-up ≤ 10 phút), ghi asciicast 0600 (50 MB → cắt), `pty.list`, `pty.recording.read`, `itso allowlist reset` | 9ce6ef9 |
| 7.6 UI | Bộ chọn máy chủ (`?server=`), gỡ chặn IP fail2ban, FIM changes, xem trước ruleset + chặn khi `lockout_risk`, đếm ngược khôi phục từ status, sự kiện WAF theo website, phát lại bản ghi phân trang, wizard → xác nhận tường lửa | cd3b467 |
| 7.7 Tích hợp | e2e stack thật Phase 7 (5 luồng); sửa lỗi sandbox thiếu user root (§4); `tests/vm/phase7.sh` S0–S7; review bảo mật; runbook | (commit 7.7) |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent | `agent/internal/ops/{firewall,safe,sshd_hardening,fail2ban,waf,malware,fim,pty,sandbox_security}.go`, `agent/internal/term/record.go`, `agent/internal/policy/` |
| Panel | `apps/api/app/Domain/Security/`, `app/Domain/Terminal/`, `app/Auth/{Captcha,AuthFailureLog}.php`, `app/Http/Controllers/Api/V1/Security/` |
| UI | `apps/web/src/entries/admin/security/`, `entries/admin/servers/{ServerFirewallPage,ServerTerminalPage}.tsx`, `src/shared/auth/{Captcha,captcha}.ts*` |
| Test VM | `tests/vm/phase7.sh` |
| E2E | `apps/web/e2e-real/phase7.spec.ts`, `apps/web/e2e/demo-security7.spec.ts` |
| Bảo mật · vận hành | `docs/security/security-center-review.md`, `docs/runbooks/phase-7-security-center.md` |

## 3. Cách chạy thử

- Dev: `make dev` (agent sandbox + gateway), seed `DemoSeeder`, rồi `make test-e2e-real`. Reset DB thì xóa luôn `.dev/agent-sandbox/root` (uid/gid sandbox cũ trùng với account mới).
- Demo không cần backend: `make dev-demo` (MSW).
- VM: sau `run-all.sh --no-uninstall`, chạy `bash tests/vm/phase7.sh --client-ip <IP>`.

## 4. Kết quả test

@@CHECK@@

E2E stack thật Phase 7 (`e2e-real/phase7.spec.ts`, 5 luồng):

1. Tường lửa: thêm rule qua UI → hộp áp dụng có ruleset xem trước chứa cổng mới → đếm ngược → "Giữ cấu hình mới" → `confirmed` (agent cũng `confirmed`); áp dụng lần nữa không xác nhận (30 giây) → panel `rolled_back`, confirm muộn 409, sự kiện high `firewall.rolled_back`; op kế tiếp ở agent hoàn tác rồi áp cấu hình sạch.
2. SSH hardening: thiếu `server` → 422; đổi MaxAuthTries → job safe-apply → xác nhận → giá trị mới trên API và UI.
3. WAF + mã độc: tạo website tĩnh → WAF mặc định Ghi nhận → bật Chặn (file rule trên máy) → request SQLi trong audit log ModSecurity → `itso:waf-events-sync` → sự kiện `942100 blocked` trên API và tab WAF; EICAR trong thư mục site → quét → finding clamav → cách ly (file biến mất) → khôi phục (file trở lại).
4. FIM: baseline → thêm file `/usr/local/bin`, sửa `/etc/ssh/sshd_config.d` → `itso:fim-check` → added/modified trên API và trang FIM.
5. CAPTCHA + root: Portal sai mật khẩu tới ngưỡng → 422 `captcha_required` kể cả mật khẩu đúng, lời giải giả bị từ chối, UI tự giải PoW rồi đăng nhập được; Admin không đòi CAPTCHA; policy root tắt → `root_enabled=false`, mở root → 409 `precondition_failed` kèm hướng dẫn `itso policy set`.

**Lỗi tìm thấy nhờ e2e stack thật (đã sửa, có test hồi quy):** gốc agent sandbox không có user `root` như Ubuntu, nên `sshd.config.apply` trả `not_found` ("không có user quản trị root"): mọi thay đổi SSH trong dev/e2e đều lỗi. Sửa bằng `Sim.SeedBase()` + `TestSimSeedBase`. Máy thật không bị (Ubuntu luôn có root).

**Lần chạy đầu toàn bộ e2e đỏ 1/17 do môi trường:** DB được `migrate:fresh` nhưng gốc sandbox giữ account của lần chạy trước → agent từ chối gid trùng (`already_exists`, đúng hành vi). Xóa gốc sandbox cùng lúc reset DB rồi chạy lại.

## 5. Tiêu chí nghiệm thu Phase 7 (11-ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Điểm bảo mật mặc định sau cài ≥ 80/100 | ✓ (dữ kiện mô phỏng) · **chờ VM** | Pest: dữ kiện sau cài → 80/100 hạng B, tổng trọng số 100. VM S6: `itso:security-audit` trên máy vừa cài |
| Mọi thay đổi firewall/SSH có rollback tự động | ✓ (code + sandbox) · **chờ VM** | Go `safe_test` (đồng hồ giả, khởi động lại agent), Pest (hết hạn → `rolled_back` + sự kiện + thông báo), e2e stack thật (không xác nhận → `rolled_back`). VM S1: dừng agent giữa chừng, timer systemd tự hoàn tác cả firewall và sshd |
| Malware scan không đẩy load > ngưỡng | ✓ (cấu hình) · **chờ VM** | Golden argv `systemd-run` (slice account, Nice 19, IO idle, CPUQuota 50%). VM S4: quét 3 000 file + EICAR, site 200 suốt lúc quét, ghi load + latency |
| Test: không tự khóa SSH/panel (mất kết nối → rollback) | ✓ · **chờ VM** | Chống tự khóa ở Laravel + agent (vector dùng chung), UI chặn nút khi `lockout_risk`; VM S1 |
| Test: OWASP payload bị WAF chặn | ✓ (sandbox) · **chờ VM** | e2e sự kiện blocked; VM S3: SQLi/XSS/traversal 403 khi On, 200 khi DetectionOnly |
| Test: EICAR | ✓ (sandbox) · **chờ VM** | e2e stack thật; VM S4 với clamd thật |
| Test: ticket terminal dùng lại bị từ chối | ✓ | Go `term_test` (Phase 6), Pest `TerminalTest` |
| Test: root terminal bị từ chối khi policy tắt dù panel yêu cầu | ✓ · **chờ VM** | Go `pty_test` (registry + handler, cả khi Deps cấu hình sai), Pest, e2e 409; VM S7 |

## 6. Lệch so với kế hoạch (đã ghi trong ADR/PHASE_STATUS)

- Root terminal là op riêng `pty.open.root` (giữ schema `pty.open` Phase 6); ghi phiên vào bảng mới `terminal_recordings` thay vì thêm cột (migration Phase 6 đã phát hành không sửa).
- File policy giữ YAML có sẵn `/etc/itso/agent-policy.yaml` (kế hoạch ghi policy.json), ADR 0028.
- CAPTCHA chỉ áp cho Portal (Admin đã có MFA bắt buộc + khóa lũy tiến).
- Cổng panel mặc định giữ 8443 trong config; installer ghi `ITSO_PANEL_PORT`.

## 7. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 + 5 + 6 + 7 và dán kết quả vào mục 5.
- Reverse proxy phía trước panel cần cấu hình trusted proxy (fail2ban/anti-lockout dựa trên `REMOTE_ADDR`), xem review §4.
- Bản ghi phiên terminal chưa có xoay vòng/giữ tự động; FIM baseline nằm trên chính máy chủ.
- Còn từ Phase 6: `itso:uploads-prune` (dọn staging upload) và reconcile DB lạ ngoài panel chưa làm.
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 8. Bước tiếp theo

Chờ duyệt Phase 7 và D-76 → D-81. **Không** bắt đầu Phase 8 khi chưa được duyệt.
