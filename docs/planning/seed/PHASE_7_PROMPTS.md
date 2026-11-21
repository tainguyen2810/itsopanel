# Phase 7 — Security Center: prompt chi tiết

> Viết ngày 2026-11-21, sau khi người dùng duyệt Phase 6 ("tiip nhé, mà quên làm mockup r"). Nguồn: `ROADMAP.md` (Phase 7), `docs/planning/11-ROADMAP.md` §Phase 7, `12-PHASE-PROMPTS.md` (7.1–7.5), `03-MODULES.md` (Security), `06-AGENT-SECURITY.md`, `07-HOSTING-ISOLATION.md`, `contracts/agent-ops/catalog.json` (op Phase 7 đang `declared`), OpenAPI `/security/*`, `/servers/{id}/firewall*`, `/websites/{id}/waf` đã đặc tả từ Phase 1, DBML nhóm `security`.
> Nhánh `phase-7`. Làm hàng loạt 7.0 → 7.7, tự merge local, DỪNG trước Phase 8. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.
> **Mới từ Phase 7:** mockup trước khi code. Prompt 7.0 dựng màn hình và trạng thái mới trên bản demo (MSW), chụp ảnh vào `docs/screenshots/phase-7/`; các prompt sau làm theo mockup đó.

## Mục tiêu Phase 7

Máy chủ cài xong có điểm bảo mật mặc định ≥ 80/100 và mọi thay đổi có thể tự khóa mình (firewall, SSH) đều tự hoàn tác khi mất kết nối. Gồm: firewall nftables (safe-apply + xác nhận), SSH hardening (safe-apply), Fail2ban (sshd, panel, ftp), WAF ModSecurity + OWASP CRS theo website (mặc định DetectionOnly 7 ngày), quét mã độc ClamAV + YARA dưới uid account + cách ly, FIM, điểm bảo mật, sự kiện bảo mật + thông báo trong panel, bảo vệ User Portal (CAPTCHA tự host, khóa lũy tiến đã có, tùy chọn bắt buộc MFA) và IP allowlist Admin không tự khóa được, Terminal root theo policy máy chủ + ghi phiên.

## Ràng buộc môi trường

- Như Phase 4–6: container không có systemd/KVM/nftables thật. Op mới đi qua lớp nền tảng (D-63), test bằng runner giả + gốc FS tạm (golden argv/file). `--sandbox` mô phỏng `nft`, `sshd -t/-T`, `fail2ban-client`, `clamdscan`, `yara`, nginx ModSecurity (sự kiện mẫu).
- Không cài nftables/fail2ban/ClamAV/ModSecurity vào container. Ruleset nft, cấu hình sshd/fail2ban/ModSecurity sinh ra được kiểm bằng golden test và bộ validator; trên VM chạy thật (`tests/vm/phase7.sh`): mất kết nối → rollback, EICAR, payload OWASP bị chặn, root terminal bị từ chối khi policy tắt.
- Gói Ubuntu 24.04 cần xác minh trên VM (S0): `nftables`, `fail2ban`, `clamav`, `clamav-daemon`, `yara`, `libnginx-mod-http-modsecurity`, `modsecurity-crs`. Thiếu gói WAF → website báo `waf: unavailable`; Coraza: DEFERRED.

## Quyết định kỹ thuật (ĐỀ XUẤT, ghi vào DECISIONS.md)

| Mã | Việc | Cách làm | Lý do |
|---|---|---|---|
| D-76 | Firewall | Panel chỉ quản lý bảng riêng `table inet itso` (không flush bảng khác: Docker, fail2ban). Ruleset sinh từ `firewall_rules` bằng template Go, mặc định `policy drop` cho input, luôn có: loopback, established/related, ICMP giới hạn, cổng SSH hiện tại, cổng panel. **Bất biến chống tự khóa** kiểm ở cả Laravel và agent: không được xóa/chặn cổng SSH và cổng panel với nguồn chứa IP của người đang áp dụng. Safe-apply: `nft -c -f` → lưu ruleset cũ → `nft -f` → hẹn hoàn tác bằng transient timer `itso-fw-rollback` (sống sót khi agent chết) sau 60–300 s → trình duyệt gọi `:confirm` bằng một **request mới** (chứng minh còn kết nối) → agent hủy timer. Không xác nhận → tự khôi phục, ghi `security_events` | Tự khóa server là rủi ro số 1 của Phase (11-ROADMAP); timer systemd vẫn chạy khi agent/panel chết |
| D-77 | SSH hardening + Fail2ban | `sshd.config.apply` ghi `/etc/ssh/sshd_config.d/10-itso-hardening.conf` từ tập khóa cố định (PermitRootLogin `prohibit-password`/`no`, PasswordAuthentication, MaxAuthTries, LoginGraceTime, X11/Agent forwarding, Port), `sshd -t` → reload → cùng cơ chế xác nhận/hoàn tác như D-76; tắt mật khẩu bị từ chối nếu không có khóa nào cho user quản trị; đổi port thì mở port mới ở firewall trước. Fail2ban: `jail.d/itso.conf` sinh từ template (sshd, `itso-panel` đọc `/var/log/itso/auth.log` do Laravel ghi dòng đăng nhập sai có IP, `pure-ftpd`), `banaction = nftables` bảng riêng; IP allowlist của panel vào `ignoreip`. Op `fail2ban.status`, `fail2ban.unban` | Fail2ban ở tầng mạng bổ sung cho khóa lũy tiến ở tầng ứng dụng |
| D-78 | WAF | ModSecurity v3 + OWASP CRS từ kho Ubuntu, bật theo website bằng khối `modsecurity` trong template vhost (D-67) trỏ tới `/etc/itso/waf/<website_uuid>.conf` (mode `DetectionOnly`/`On`/`Off`, paranoia 1–2, danh sách rule id loại trừ là số nguyên; không có ô cấu hình tự do). Website mới: `DetectionOnly`; sau 7 ngày panel báo để chuyển `On` (tùy chọn tự chuyển). Sự kiện: audit log JSON của ModSecurity, op `waf.events` đọc theo con trỏ → `waf_events` + `security_events` | Tránh false positive làm hỏng site; giữ nguyên tắc vhost không có snippet tự do |
| D-79 | Malware + cách ly | Quét chạy **dưới uid account** trong slice account, `Nice=19`, `IOSchedulingClass=idle`, giới hạn CPU: `clamdscan --fdpass` (clamd không cần đọc home) + `yara` với bộ rule webshell kèm panel. Cách ly: helper (uid account) mở file `O_NOFOLLOW` và chuyển fd cho agent root, agent chép vào `/var/lib/itso/quarantine/<uuid>` (0600 root) kèm sha256, helper xóa bản gốc; khôi phục = ngược lại qua helper (như `fs.upload.commit`). Chỉ Admin khôi phục; Portal quét, xem, cách ly/xóa file của mình | Root không đọc file của account (06 §5); quét không đẩy load quá ngưỡng |
| D-80 | FIM + điểm bảo mật + sự kiện | FIM viết bằng Go trong agent: baseline sha256/mode/owner cho danh sách đường dẫn cố định (`/etc/ssh`, `/etc/nginx`, `/etc/itso`, `/etc/sudoers*`, `/etc/passwd`, `/etc/systemd/system/itso*`, `/opt/itso`, `/usr/local/bin`), lưu ở agent (`/var/lib/itso/fim/baseline.json`, root 0600) và bản sao `fim_baselines`; so khớp với bản của agent (panel bị chiếm không sửa được baseline). `security.audit` thu thập dữ kiện (`sshd -T`, nft, fail2ban, unattended-upgrades, reboot-required, gói WAF/ClamAV); Laravel tính điểm theo bảng trọng số công khai trong code + MFA admin, WAF coverage, allowlist. Sự kiện mức cao → thông báo trong panel cho SUPER_ADMIN/ADMIN trong phạm vi (email/Telegram: Phase 11) | Điểm tính minh bạch, kiểm được bằng test; baseline nằm ngoài tầm panel |
| D-81 | Bảo vệ Portal + Admin + Terminal root | CAPTCHA tự host kiểu proof-of-work (thử thách HMAC + độ khó, Web Worker giải; không gọi dịch vụ ngoài) bật cho đăng nhập/quên mật khẩu khi IP/email đã sai ≥ 3 lần (cấu hình được: luôn bật); tùy chọn bắt buộc MFA cho USER. IP allowlist Admin: không lưu được danh sách loại IP hiện tại, có lệnh CLI `itso allowlist reset` trên máy chủ để cứu. Terminal root: chỉ khi `/etc/itso/policy.json` có `terminal.root=true` (chỉ bật bằng CLI `itso policy set` trên máy chủ; panel bị chiếm cũng không bật được), người mở là SUPER_ADMIN + step-up ≤ 10 phút; **ghi phiên** asciicast v2 do agent ghi vào `/var/lib/itso/recordings` (root 0600, giới hạn dung lượng), panel đọc bằng `pty.recording.read`, phát lại trong Admin; `pty.list` cho trạng thái phiên chính xác | R11 (CAPTCHA, khóa lũy tiến, allowlist); quyền root không phụ thuộc panel |

Giữ nguyên: Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code; mọi thay đổi máy chủ đi qua job + audit.

## Danh sách prompt

| Prompt | Nội dung | Ước lượng |
|---|---|---|
| 7.0 | **Mockup:** dựng màn hình/trạng thái Phase 7 trên bản demo (MSW, theo OpenAPI hiện có + phần sẽ thêm ở 7.1), chụp `docs/screenshots/phase-7/` 1440/390 × sáng/tối | 0,5 ngày |
| 7.1 | ADR 0023–0028 (D-76…D-81); contracts agent-ops (firewall, sshd hardening, fail2ban, waf, malware, quarantine, fim, security.audit, pty root/list/recording); OpenAPI rà lại; DBML + migration Phase 7 | 0,5 ngày |
| 7.2 | Agent: firewall nftables + rollback timer, sshd hardening, fail2ban; validator chống tự khóa; sandbox | 1,5 ngày |
| 7.3 | Agent: WAF (template vhost + file waf, sự kiện), malware (clamdscan/yara dưới uid), cách ly/khôi phục, FIM, security.audit | 1,5 ngày |
| 7.4 | Panel: firewall (safe-apply + confirm), SSH, Fail2ban, WAF, quét/cách ly, FIM, điểm bảo mật, sự kiện + thông báo, IP allowlist chống tự khóa, CAPTCHA + MFA bắt buộc cho Portal, ma trận quyền | 1,5 ngày |
| 7.5 | Terminal root theo policy + ghi phiên + `pty.list`, CLI `itso policy`/`itso allowlist reset` | 1 ngày |
| 7.6 | UI nối API thật theo mockup 7.0 (Admin + Portal), MSW theo hành vi mới | 1 ngày |
| 7.7 | Tích hợp: e2e stack thật + agent sandbox, `tests/vm/phase7.sh`, review bảo mật, `make check`, báo cáo, runbook, merge, DỪNG | 1 ngày |

Mỗi prompt: chỉ làm phạm vi của prompt; test + lint xanh; cập nhật `PHASE_STATUS.md`, `TEST_REPORT.md`; commit `feat(p7)`, `test(p7)`, `docs(p7)`; đồng bộ bản sao lưu.

## Prompt 7.0 — Mockup

```
[ITSO Panel] Prompt 7.0 — Mockup màn hình Security Center (trước khi code)
Phạm vi: chỉ bản demo (apps/web + src/demo + contracts/tools/demo.py), không đụng API/agent.
Màn hình và trạng thái:
- Admin Bảo mật › Tổng quan: điểm bảo mật có phân rã theo nhóm (mạng, SSH, web, mã độc, tài khoản), mục kiểm tra
  có nút "Sửa" dẫn tới tab tương ứng.
- Server › Tường lửa: bảng rule (system/user), thêm rule (cổng, giao thức, nguồn CIDR, hành động), xem trước diff
  ruleset, hộp thoại áp dụng cảnh báo chống tự khóa, banner đếm ngược "Xác nhận trong 120 giây nếu vẫn kết nối được",
  trạng thái đã hoàn tác.
- Bảo mật › SSH: form hardening (root login, mật khẩu, port, MaxAuthTries) + cảnh báo khi chưa có khóa, cùng banner
  xác nhận/hoàn tác.
- Bảo mật › Fail2ban: jail (sshd, itso-panel, pure-ftpd) bật/tắt, ngưỡng, danh sách IP bị chặn + gỡ chặn.
- Bảo mật › WAF + Website › WAF: chế độ (Tắt/Chỉ phát hiện/Chặn), paranoia, rule loại trừ, sự kiện, nhắc chuyển
  "Chặn" sau 7 ngày, trạng thái gói chưa cài.
- Bảo mật › Mã độc: lịch sử quét, quét theo account/website, kết quả (engine, chữ ký), cách ly; Cách ly: khôi phục/xóa.
- Bảo mật › Toàn vẹn file: baseline, thay đổi phát hiện, cập nhật baseline (step-up).
- Bảo mật › IP được phép: cảnh báo IP hiện tại không nằm trong danh sách (chặn lưu).
- Hệ thống › Cài đặt › Bảo vệ đăng nhập: CAPTCHA (khi sai ≥ N lần / luôn bật), bắt buộc MFA cho USER.
- Đăng nhập Portal có CAPTCHA proof-of-work (đang giải / đã xong).
- Terminal root: thông báo "policy máy chủ đang tắt", phiên root có nhãn "Đang ghi phiên"; Phiên terminal: danh sách
  + phát lại bản ghi.
- Portal › Bảo mật (mới): điểm của account, WAF website của mình (xem), quét mã độc account, kết quả + cách ly/xóa.
Chụp: e2e/screenshots-phase7.spec.ts, make screenshots → docs/screenshots/phase-7 (1440/390 × light/dark).
Kiểm thử: Vitest/Playwright demo + axe xanh; i18n vi = en; check_demo.py.
```

## Prompt 7.1 — ADR và contracts

```
[ITSO Panel] Prompt 7.1 — ADR Security Center, contracts Phase 7, migration
Phạm vi: docs/adr/0023-firewall-nftables-safe-apply.md (D-76), 0024-ssh-hardening-fail2ban.md (D-77),
0025-waf-modsecurity-crs.md (D-78), 0026-malware-quarantine.md (D-79), 0027-fim-security-score.md (D-80),
0028-portal-protection-terminal-root.md (D-81). Contracts agent-ops (declared → specified): firewall.apply
(rules + anti_lockout{ssh_port, panel_port, client_ip} + confirm_within_sec), firewall.confirm (token),
firewall.status, sshd.config.apply (+ confirm), fail2ban.apply, fail2ban.status, fail2ban.unban, waf.apply,
waf.events (cursor), malware.scan (account|website, engines), malware.quarantine, malware.restore,
malware.delete, fim.baseline, fim.check, security.audit, pty.open (mode root), pty.list, pty.recording.read
(offset); recipe enum: fail2ban, clamav, yara, modsecurity. Vector độc mới (rule chặn cổng SSH từ IP hiện tại,
CIDR lạ, port ngoài 1–65535, rule id WAF không phải số, đường dẫn quét `..`, token confirm sai).
OpenAPI: firewall preview/apply/confirm/status, ssh hardening apply/confirm, fail2ban jails/bans, website WAF +
events, malware scans/findings/quarantine (admin + portal), FIM baseline/changes, security score chi tiết,
auth captcha challenge, settings login-protection, terminal sessions recording. DBML: waf_settings, waf_events,
firewall_applies (token, deadline, status), fim_changes, security_settings; terminal_sessions.recording;
make db-schema, db-verify, db-migrations PHASE=7. make contracts → codegen → codegen-check.
```

## Prompt 7.2 — Agent: firewall, SSH, Fail2ban

```
[ITSO Panel] Prompt 7.2 — Agent: firewall nftables safe-apply, SSH hardening, Fail2ban
Phạm vi: agent/internal/ops/{firewall,sshd_hardening,fail2ban}.go, template nft/sshd/jail, validator chống tự khóa
(dùng chung với Laravel qua test vector), rollback bằng systemd-run --on-active (transient timer gọi
`itso-agent firewall-rollback <id>`), lưu trạng thái /var/lib/itso/firewall/, sandbox mô phỏng nft/sshd/fail2ban.
Kiểm thử: golden ruleset/config, chặn mọi biến thể tự khóa, confirm đúng/sai token, hết hạn → rollback (đồng hồ giả),
agent khởi động lại giữa chừng vẫn rollback, sshd -t lỗi → khôi phục, fuzz parser rule.
```

## Prompt 7.3 — Agent: WAF, malware, FIM, audit

```
[ITSO Panel] Prompt 7.3 — Agent: WAF, mã độc + cách ly, FIM, security.audit
Phạm vi: khối modsecurity trong template vhost + /etc/itso/waf/<uuid>.conf (nginx -t + hoàn tác như D-67), đọc audit
log JSON theo con trỏ; malware.scan chạy dưới uid account trong slice (clamdscan --fdpass, yara + rule kèm panel),
kết quả có giới hạn; quarantine/restore/delete qua helper + chuyển fd; fim.baseline/check bằng Go; security.audit.
Kiểm thử: golden vhost/waf, parser sự kiện mẫu, EICAR trong sandbox (engine giả), cách ly không theo symlink,
khôi phục không ghi đè khi đã có file (trừ khi overwrite), FIM phát hiện sửa/xóa/thêm/chmod.
```

## Prompt 7.4 — Panel API

```
[ITSO Panel] Prompt 7.4 — Panel: Security Center API
Phạm vi: Domain/Security (FirewallService + firewall_applies, SshHardening, Fail2ban, Waf, Malware, Fim,
SecurityScore, SecurityEvents → notifications), controller Admin + Portal theo OpenAPI, job + audit,
itso:waf-events-sync, itso:fim-check, itso:security-audit (scheduler), IP allowlist chống tự khóa, CAPTCHA PoW
(challenge HMAC, chống dùng lại bằng Redis), bắt buộc MFA cho USER, Laravel ghi /var/log/itso/auth.log cho Fail2ban,
ma trận quyền (security.* chỉ SUPER_ADMIN/ADMIN theo phạm vi; Portal chỉ account của mình).
Kiểm thử: Pest cho từng endpoint, bất biến chống tự khóa, confirm hết hạn, CAPTCHA sai/dùng lại, điểm bảo mật
mặc định ≥ 80 với dữ kiện sau cài, portal không thấy account khác.
```

## Prompt 7.5 — Terminal root + ghi phiên

```
[ITSO Panel] Prompt 7.5 — Terminal root theo policy, ghi phiên, pty.list
Phạm vi: agent policy.json (terminal.root, terminal.record_user), CLI `itso policy get|set`, `itso allowlist reset`;
pty.open mode root (từ chối khi policy tắt), ghi asciicast v2 (giới hạn dung lượng, đóng phiên khi vượt),
pty.list, pty.recording.read; Laravel: chỉ SUPER_ADMIN + step-up ≤ 10 phút, terminal-reap dùng pty.list,
API bản ghi. Kiểm thử: root bị từ chối khi policy tắt dù panel yêu cầu, ticket dùng lại bị từ chối, bản ghi đọc
theo offset, Admin thường không mở được root.
```

## Prompt 7.6 — UI

```
[ITSO Panel] Prompt 7.6 — UI Security Center nối API thật (theo mockup 7.0)
Phạm vi: các trang Admin Bảo mật, Server › Tường lửa, Website › WAF, Cài đặt bảo vệ đăng nhập, CAPTCHA ở trang
đăng nhập Admin/Portal (Web Worker), Terminal root + phát lại phiên, Portal › Bảo mật; MSW theo hành vi mới.
Kiểm thử: Vitest (đếm ngược xác nhận, CAPTCHA worker, player), Playwright demo + axe, i18n vi = en.
```

## Prompt 7.7 — Tích hợp và báo cáo

```
[ITSO Panel] Prompt 7.7 — e2e, VM Phase 7, review bảo mật, báo cáo, merge, DỪNG
Phạm vi: apps/web/e2e-real/phase7.spec.ts (firewall apply → confirm, không confirm → hoàn tác; SSH hardening;
WAF bật + sự kiện; quét EICAR → cách ly → khôi phục; FIM; CAPTCHA; terminal root bị từ chối), tests/vm/phase7.sh
(S0 gói, S1 mất kết nối → rollback firewall/SSH, S2 fail2ban chặn thật, S3 payload OWASP bị WAF chặn khi On,
S4 EICAR + load khi quét, S5 FIM, S6 điểm mặc định ≥ 80, S7 terminal root theo policy), docs/security/
security-center-review.md, runbook phase-7, make check, docs/reports/phase-7.md, merge --no-ff main, DỪNG.
```
