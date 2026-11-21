# Runbook Phase 7: Security Center

Runbook cho người vận hành panel nội bộ. Áp dụng cho bản Phase 7 (Ubuntu 24.04, nftables, OpenSSH, fail2ban, ModSecurity v3 + OWASP CRS, ClamAV + YARA từ kho Ubuntu).

## 1. Chuẩn bị

| Việc | Cách làm |
|---|---|
| Cài phần mềm | Máy chủ → Phần mềm: recipe `fail2ban`, `modsecurity` (kèm CRS), `clamav`, `yara`. Thiếu gói thì trang tương ứng báo "chưa cài", WAF trả `available=false` |
| Sau wizard cài đặt | Wizard áp nền bảo mật (tường lửa mặc định, fail2ban 3 jail, SSH hardening) rồi đưa tới trang **Tường lửa** để bấm "Giữ cấu hình mới" trong thời hạn. Không bấm thì máy tự hoàn tác |
| Quyền | Xem: `security.read` (ADMIN theo phạm vi server). Sửa WAF/quét/cách ly: `security.write`. Tường lửa, SSH, fail2ban, FIM baseline, bản ghi terminal: chỉ SUPER_ADMIN (`security.server`) + xác thực lại MFA |
| Kết nối | Panel nhận kết nối trực tiếp (không proxy). **Nếu đặt reverse proxy/CDN phía trước:** phải cấu hình trusted proxy trước, nếu không fail2ban có thể ban IP proxy và rule chống tự khóa mở cho proxy thay vì admin |

## 2. Tường lửa (nftables, bảng `inet itso`)

1. Máy chủ → Tường lửa → Thêm rule (ưu tiên, accept/drop/reject, in/out, giao thức, cổng, nguồn CIDR). Rule chỉ là nháp tới khi áp dụng.
2. **Áp dụng:** hộp thoại hiện ruleset sẽ áp dụng và cảnh báo. Có `lockout_risk` (rule chặn SSH/panel từ IP đang dùng) thì nút bị khóa. Chọn thời gian tự hoàn tác (30–600 giây).
3. Trong thời hạn, bấm **Giữ cấu hình mới**. Mất kết nối hoặc không bấm: timer systemd `itso-fw-rollback` khôi phục ruleset đã xác nhận trước đó, panel ghi sự kiện high `firewall.rolled_back` và gửi thông báo.
4. Panel chỉ quản lý bảng `inet itso`; bảng của Docker/fail2ban không bị đụng. Kiểm tay: `nft list table inet itso`.

**Tự khóa mất SSH:** dùng console của nhà cung cấp VM, `nft delete table inet itso` (mở hết) rồi áp dụng lại từ panel.

## 3. SSH hardening

- Bảo mật → SSH (chọn máy chủ nếu có nhiều): cổng, đăng nhập mật khẩu, PermitRootLogin (`no` / `prohibit-password`), MaxAuthTries, AllowGroups. Cũng là safe-apply: bấm xác nhận trong thời hạn.
- Đổi cổng: panel mở cổng mới trên tường lửa trước, cổng cũ vẫn mở tới khi xác nhận; một nút xác nhận cho cả hai.
- Tắt đăng nhập mật khẩu khi user quản trị (mặc định `root`, `ITSO_SSH_ADMIN_USER`) chưa có khóa SSH → bị từ chối (`would_lock_out`).
- File quản lý: `/etc/ssh/sshd_config.d/10-itso-hardening.conf` (luôn `sshd -t` trước khi reload).

## 4. Fail2ban

| Jail | Nguồn log | Ghi chú |
|---|---|---|
| `sshd` | journal sshd | Mặc định maxretry 5, findtime 10 phút, bantime 1 giờ |
| `itso-panel` | `/var/log/itso/auth.log` (panel ghi `itso-auth failed ip=<IP>`, không có email/mật khẩu) | Đăng nhập panel sai |
| `pure-ftpd` | journal | Chỉ bật khi có FTPS |

- `ignoreip` = IP allowlist của panel. Danh sách IP đang bị chặn: Bảo mật → Fail2ban → "IP đang bị chặn" → **Gỡ chặn**.
- Tay: `fail2ban-client status sshd`, `fail2ban-client set sshd unbanip <IP>`.

## 5. WAF (ModSecurity + CRS)

- Website → tab WAF: bật, chế độ **Ghi nhận** (DetectionOnly, mặc định khi bật lần đầu) hoặc **Chặn** (On), paranoia 1–4, loại trừ rule theo id 6 số.
- Quy trình khuyến nghị: bật Ghi nhận ≥ 7 ngày, xem "Sự kiện WAF" của website, loại trừ rule báo nhầm, rồi chuyển Chặn.
- Sự kiện đồng bộ mỗi phút (`itso:waf-events-sync`) từ `/var/log/itso/waf/audit.log`. ≥ 20 request bị chặn từ một IP trong một lượt → sự kiện `waf.burst`.
- `nginx -t` lỗi sau khi đổi → agent tự khôi phục file WAF cũ.

## 6. Quét mã độc và cách ly

- Website → Quét (hoặc Portal → Bảo vệ → Quét): clamdscan + YARA chạy dưới uid account trong slice account (Nice 19, IO idle, CPU tối đa 50%), file > 25 MB bỏ qua.
- Kết quả: Bảo mật → Mã độc. **Cách ly** chuyển file vào vùng cách ly (kiểm sha256 trước), **Khôi phục** về đường dẫn cũ (không ghi đè file mới trùng tên), **Xóa** vĩnh viễn (Portal cần MFA lại).
- Báo nhầm: khôi phục rồi báo cho người quản trị để thêm ngoại lệ YARA trong bản phát hành sau.

## 7. FIM và điểm bảo mật

- FIM kiểm mỗi giờ (phút 53, `itso:fim-check`): `/etc/ssh`, `/etc/nginx`, `/etc/itso`, sudoers, passwd/group, unit `itso*`, `/opt/itso/current/{bin,share}`, `/usr/local/bin`. Thay đổi hiện ở Bảo mật → FIM.
- Thay đổi hợp lệ (cập nhật gói, sửa tay có chủ đích): SUPER_ADMIN bấm **Tạo lại baseline** (cần MFA lại).
- Điểm bảo mật tính lại mỗi 6 giờ (`itso:security-audit`) từ dữ kiện agent (sshd, tường lửa, fail2ban, cập nhật, gói). Bảng trọng số: `SecurityScore::WEIGHTS`.

## 8. CAPTCHA Portal và IP allowlist

- Cài đặt → Bảo mật: số lần sai trước khi Portal đòi CAPTCHA (0–10, mặc định 3, 0 = luôn đòi). CAPTCHA tự host (proof-of-work trong trình duyệt), không gọi dịch vụ ngoài. Realm Admin không dùng CAPTCHA (đã có MFA bắt buộc + khóa lũy tiến).
- IP allowlist (realm Admin/API): danh sách mới phải chứa IP đang dùng. Tự khóa: trên máy chủ chạy `itso allowlist reset` (xóa danh sách, ghi audit).

## 9. Terminal root và bản ghi phiên

| Việc | Lệnh / cách làm |
|---|---|
| Bật root terminal | Trên máy chủ: `itso policy set terminal.root on` rồi `systemctl restart itso-agent`. Mặc định **tắt** |
| Tắt | `itso policy set terminal.root off` + restart agent |
| Ghi phiên account | `itso policy set terminal.record_user on` (phiên root luôn ghi) |
| Dùng | Máy chủ → Terminal → chế độ Root (chỉ SUPER_ADMIN, MFA lại ≤ 10 phút) |
| Xem bản ghi | Bảo mật → Phiên terminal → Phát lại (SUPER_ADMIN + MFA lại, mỗi lượt xem ghi audit) |
| File bản ghi | `/var/lib/itso/recordings/<session_uuid>.cast` (asciicast v2, root 0600, chỉ output). 50 MB → cắt và đóng phiên. Chưa có xoay vòng tự động: xóa tay file cũ khi cần |

Policy tắt mà vẫn chọn Root → 409 kèm hướng dẫn lệnh bật.

## 10. Sự cố thường gặp

| Hiện tượng | Xử lý |
|---|---|
| "Không có thay đổi chờ xác nhận" khi bấm Giữ | Đã quá hạn và đã hoàn tác; áp dụng lại |
| "còn lần áp dụng … chờ xác nhận" | Mỗi loại (tường lửa, SSH) chỉ một lần chờ; xác nhận hoặc chờ hết hạn |
| SSH lỗi `would_lock_out` | Thêm khóa SSH cho user quản trị trước khi tắt mật khẩu |
| WAF "chưa cài" | Cài recipe `modsecurity`; kiểm `/etc/nginx/modules-enabled/50-mod-http-modsecurity.conf` |
| Không thấy sự kiện WAF | `tail /var/log/itso/waf/audit.log`; chạy `itso:waf-events-sync` bằng tay (user itso) |
| Admin bị fail2ban ban | Từ console: `fail2ban-client set itso-panel unbanip <IP>`; thêm IP vào allowlist |

## 11. Kiểm thử

- Tự động: `make test-api-pg` (Pest `Phase7/*`), `make test-agent`, `make test-e2e-real` (`e2e-real/phase7.spec.ts`).
- VM: `bash tests/vm/phase7.sh --client-ip <IP>` (xem `tests/vm/README.md`). Review bảo mật: `docs/security/security-center-review.md`.
