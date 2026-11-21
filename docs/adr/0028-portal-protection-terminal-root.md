# ADR 0028: Bảo vệ đăng nhập, IP allowlist không tự khóa, Terminal root theo policy máy chủ

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 7)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-81, D-75, R11

## Bối cảnh

R11: dò mật khẩu Portal, khóa nhầm Admin bằng allowlist. Terminal root (ADR 0022 để Phase 7) là quyền cao nhất; nếu panel bị chiếm vẫn không được bật nó.

## Quyết định

1. **CAPTCHA tự host** kiểu proof-of-work: `GET /auth/captcha` trả `{challenge, difficulty, expires_at}`; challenge = dữ liệu ngẫu nhiên + hạn + HMAC (khóa ứng dụng), dùng một lần (Redis), 5 phút. Trình duyệt tìm `nonce` để `sha256("challenge:nonce")` có `difficulty` bit 0 đầu (Web Worker). Bật khi IP hoặc email đã sai ≥ `portal_captcha_after_failures` (mặc định 3; 0 = luôn bật); thiếu/sai → 422 `captcha_required`. Không gọi dịch vụ ngoài.
2. **MFA bắt buộc cho USER** (tùy chọn `portal_mfa_required`): bật thì USER chưa có MFA bị chuyển tới màn đăng ký MFA sau đăng nhập.
3. **IP allowlist Admin:** `PUT /security/ip-allowlist` từ chối danh sách không chứa IP hiện tại (`would_lock_out`); cứu hộ bằng `itso allowlist reset` trên máy chủ (CLI, không qua web).
4. **Terminal root:** op riêng `pty.open.root` (giữ nguyên schema `pty.open` của Phase 6). Agent chỉ mở khi `/etc/itso/policy.json` có `terminal.root=true`; file này chỉ đổi bằng `itso policy set terminal.root on|off` trên máy chủ (root), panel không có op ghi policy. Người mở: SUPER_ADMIN + step-up ≤ 10 phút. `pty.policy` cho panel đọc policy để hiển thị.
5. **Ghi phiên:** agent ghi asciicast v2 vào `/var/lib/itso/recordings/<session_uuid>.cast` (root 0600, giới hạn 50 MB/phiên, quá thì dừng ghi và đánh dấu `truncated`); mặc định ghi phiên root, phiên account tùy policy (`record_user`). Panel đọc qua `pty.recording.read{session_uuid, offset, max_bytes}` theo trang, phát lại trong Admin (SUPER_ADMIN + step-up). Metadata ở `terminal_recordings`.
6. **pty.list** trả phiên đang sống (thay cho đoán theo mốc 12 giờ ở Phase 6); `itso:terminal-reap` đóng phiên không còn trong danh sách.

## Hệ quả

- Panel bị chiếm không bật được root shell và không xóa được bản ghi (chỉ có op đọc).
- Kiểm thử: PoW (độ khó, dùng lại, hết hạn), allowlist loại IP hiện tại bị từ chối, `pty.open.root` khi policy tắt → `op_disabled`, bản ghi đọc theo offset; VM: root terminal bị từ chối khi policy tắt, mở được và có bản ghi khi bật bằng CLI.
