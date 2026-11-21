# ADR 0028: Bảo vệ đăng nhập, IP allowlist không tự khóa, Terminal root theo policy máy chủ

- **Trạng thái:** Accepted (2026-11-21, cùng Phase 7)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-81, D-75, R11

## Bối cảnh

R11: dò mật khẩu Portal, khóa nhầm Admin bằng allowlist. Terminal root (ADR 0022 để Phase 7) là quyền cao nhất; nếu panel bị chiếm vẫn không được bật nó.

## Quyết định

1. **CAPTCHA tự host** kiểu proof-of-work: `GET /auth/captcha` trả `{challenge, difficulty, expires_at}`; challenge = dữ liệu ngẫu nhiên + hạn + HMAC (khóa ứng dụng), dùng một lần (Redis), 5 phút. Trình duyệt tìm `nonce` để `sha256("challenge:nonce")` có `difficulty` bit 0 đầu (Web Worker). Bật khi IP hoặc email đã sai ≥ `portal_captcha_after_failures` (mặc định 3; 0 = luôn bật); thiếu/sai → 422 `captcha_required`. Không gọi dịch vụ ngoài.
2. **MFA bắt buộc cho USER** (tùy chọn `portal_mfa_required`): bật thì USER chưa có MFA bị chuyển tới màn đăng ký MFA sau đăng nhập.
3. **IP allowlist Admin:** `PUT /security/ip-allowlist` từ chối danh sách không chứa IP hiện tại (`would_lock_out`); cứu hộ bằng `itso allowlist reset` trên máy chủ (CLI, không qua web).
4. **Terminal root:** op riêng `pty.open.root` (giữ nguyên schema `pty.open` của Phase 6). Agent chỉ mở khi policy cục bộ `/etc/itso/agent-policy.yaml` (file policy agent có từ Phase 4, root 0600; bản kế hoạch ghi `policy.json`, gộp vào file sẵn có để không có hai nguồn policy) có `root_terminal: true` (và không bị `ops.pty.open.root: false`); file này chỉ đổi bằng `itso policy set terminal.root on|off` trên máy chủ (root, khởi động lại agent), panel không có op ghi policy. Registry chặn op khi policy tắt (`op_disabled`) và handler kiểm lại. Người mở: SUPER_ADMIN ở realm Admin + step-up ≤ 10 phút (giới hạn 10 phút áp cả khi `step_up_seconds` cấu hình dài hơn). `pty.policy` cho panel đọc policy để hiển thị.
5. **Ghi phiên:** agent ghi asciicast v2 (chỉ output `o`, không ghi phím gõ) vào `/var/lib/itso/recordings/<session_uuid>.cast` (thư mục 0700, file 0600, O_EXCL|O_NOFOLLOW), giới hạn 50 MB/phiên: chạm giới hạn thì ghi marker `m` = `itso:truncated` và **đóng phiên** (lý do `limit`) để không có phiên root chạy mà không được ghi; không tạo được file ghi → không mở phiên. Phiên root luôn ghi, phiên account theo policy (`itso policy set terminal.record_user on`). Panel đọc qua `pty.recording.read{session_uuid, offset, max_bytes}` theo trang, phát lại trong Admin (SUPER_ADMIN + step-up). Metadata ở `terminal_recordings`.
6. **pty.list** trả phiên đang sống, gồm phiên đã cấp ticket chưa ATTACH (thay cho đoán theo mốc 12 giờ ở Phase 6); `itso:terminal-reap` (5 phút) đóng phiên không còn trong danh sách và cũ hơn 2 phút; agent không trả lời thì quay về luật 12 giờ.
7. **Cứu hộ allowlist:** `itso allowlist reset` gọi `artisan itso:allowlist-reset` (xóa `ip_allowlist` scope admin, ghi audit).

## Hệ quả

- Panel bị chiếm không bật được root shell và không xóa được bản ghi (chỉ có op đọc).
- Kiểm thử: PoW (độ khó, dùng lại, hết hạn), allowlist loại IP hiện tại bị từ chối, `pty.open.root` khi policy tắt → `op_disabled`, bản ghi đọc theo offset; VM: root terminal bị từ chối khi policy tắt, mở được và có bản ghi khi bật bằng CLI.
