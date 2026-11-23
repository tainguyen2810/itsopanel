# ADR 0054: Kiểm CIS Ubuntu 24.04 chỉ đọc

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-109, ADR 0033 (điểm bảo mật)

## Quyết định

1. Op `cis.audit` (rủi ro thấp, chỉ đọc): khoảng 40 mục CIS Ubuntu 24.04 **L1** liên quan máy chủ hosting (mount option `/tmp`, AppArmor, ASLR, core dump setuid, dịch vụ không cần, quyền cron, sysctl mạng, tường lửa, SSH, pam_pwquality, UID 0, mật khẩu rỗng, auditd, journald, quyền file hệ thống, unattended-upgrades, bản vá chờ). Mỗi mục: `pass | fail | na` + bằng chứng rút gọn ≤ 500 ký tự (không đọc nội dung file nhạy cảm như `/etc/shadow`, chỉ quyền/chủ).
2. **Không tự sửa.** Mục sửa được có `fix_href` trỏ tới recipe hiện có (SSH, tường lửa, phần mềm). Điểm CIS = pass / (pass + fail), `na` không tính.
3. Lưu `cis_results` (một bản mới nhất mỗi server + lịch sử 30 lượt); điểm CIS là một mục trong điểm bảo mật (D-80) và trang Sẵn sàng production.

## Lý do

Tự sửa CIS trên máy hosting dễ làm gãy dịch vụ (vd. tắt IP forwarding khi có Docker); chỉ đọc cho bằng chứng mà không rủi ro.
