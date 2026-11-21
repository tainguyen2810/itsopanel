# ADR 0022: Terminal cho USER chạy trong jail qua itso-gateway

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 6)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-75, D-07, D-21, D-66

## Bối cảnh

ROADMAP gốc đưa Terminal cho USER vào Phase 6. Terminal là kết nối dài hai chiều; Laravel (FrankenPHP, request ngắn) không hợp giữ WebSocket (D-07). Shell của khách là mã không tin cậy, phải nằm trong uid + slice của account (D-21) và không thấy file hệ thống nhạy cảm. Panel bị chiếm vẫn không được mở shell root (06 §1.5).

## Quyết định

1. **Điều kiện mở:** gói hiện hành `ssh_allowed`, account không bị khóa, người mở có quyền trên account và đã step-up MFA (`x-itso-step-up`). Chỉ `mode=account` ở Phase 6; `mode=root` trả 409 `not_available` (Phase 7, policy cục bộ).
2. **Luồng:**
   1. `POST /terminal/sessions` (Laravel) ghi `terminal_sessions`, gọi agent `pty.open{account, session_uuid, cols, rows, idle_timeout_sec}`.
   2. Agent kiểm uid ≥ 20000 (khoảng account), shell của user là `/bin/bash` (gói có SSH), ≤ 2 phiên (chờ + mở)/account, sinh **ticket ngẫu nhiên 32 byte**, hạn 30 s, dùng một lần, gắn với account + session; trả `ticket`.
   3. Laravel trả `{ticket, ws_url: wss://<host>/gateway/terminal, session_uuid}`.
   4. Trình duyệt mở WebSocket `/gateway/terminal?ticket=…` tới **itso-gateway** (Go, user `itso-gw`, không đặc quyền). Gateway không đọc DB, không quyết định quyền: nó mở `/run/itso/agent-stream.sock` (peercred `itso-gw` theo allowlist D-66) và gửi `ATTACH <ticket>`.
   5. Agent đổi ticket lấy phiên (xóa ticket ngay), chạy shell, chuyển byte hai chiều; khung điều khiển JSON `{"type":"resize","cols","rows"}`. Trên socket stream: `[1 byte loại][4 byte độ dài][payload]` (0 dữ liệu, 1 resize, 2 exit); gateway đóng WebSocket bằng mã 4403 (ticket sai/đã dùng), 4410 (hết hạn), 4408 (nhàn rỗi).
3. **Jail:** agent cấp pty (`/dev/ptmx`), chạy `systemd-run --pty --quiet --collect --service-type=exec --uid=<uid> --gid=<gid> --slice=itso-acct-<uid>.slice -p ProtectSystem=strict -p ProtectHome=tmpfs -p BindPaths=/home/<user> -p PrivateTmp=yes -p PrivateDevices=yes -p NoNewPrivileges=yes -p RestrictSUIDSGID=yes -p ProtectKernelTunables=yes -p ProtectControlGroups=yes -p ProtectProc=invisible --working-directory=/home/<user> -E HOME=/home/<user> -E TERM=xterm-256color /bin/bash -l`, stdio là slave của pty. Account chỉ thấy home của mình, `/tmp` riêng, không thấy tiến trình khác.
4. **Giới hạn phiên:** nhàn rỗi 15 phút (không có byte vào) → đóng; sống tối đa 12 giờ kể cả khi còn gõ; ticket hết hạn → `expired`; đóng WebSocket → kill transient unit (`systemctl stop itso-term-<session>.service`). Gateway không ghi DB, nên `terminal_sessions.ended_at/ended_reason` do `itso:terminal-reap` (mỗi giờ) đóng theo mốc 12 giờ; trạng thái phiên sống theo thời gian thực cần op liệt kê phiên (để Phase 7). Không ghi lại nội dung phiên ở Phase 6 (`recording_ref` null; Phase 7).
5. **Dev/sandbox:** agent `--sandbox` dùng shell giả trong tiến trình (prompt `user@itso:~$`, lệnh `whoami`, `pwd`, `echo`, `exit`) để e2e chạy không cần systemd.

## Hệ quả

- Quyền quyết ở Laravel + agent (ticket chỉ agent cấp), gateway bị chiếm cũng không mở được phiên khi không có ticket hợp lệ.
- "Jail" dựa trên namespace của systemd (đã có trên Ubuntu 24.04), không cần container.
- Kiểm thử: Go (ticket dùng lại/hết hạn, uid 0, golden argv, gateway nối hai chiều), Pest (gói không SSH, khóa, step-up); VM: shell không thấy `/home/<khác>`, `/etc/shadow` không đọc được, tiến trình nằm trong slice.
