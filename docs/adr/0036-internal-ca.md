# ADR 0036: CA nội bộ, chứng chỉ node và token join

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng kế hoạch Phase 9)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-90, D-89

## Quyết định

1. **CA:** ECDSA P-256, tự ký, hạn 10 năm, tạo lúc cài control plane/all-in-one. Khóa `/etc/itso/pki/ca.key` root 0600, chỉ agent local đọc; chứng chỉ CA `/etc/itso/pki/ca.pem` 0644 (relay đọc). Laravel và relay không bao giờ giữ khóa CA.
2. **Op `pki.sign_csr`** (rủi ro critical, chỉ bật trên agent local của control plane qua policy): nhận `server_uuid`, CSR, `ttl_days ≤ 30`. Agent kiểm CSR: chữ ký hợp lệ, khóa ECDSA P-256, CN đúng `server_uuid` (lúc join node chưa biết uuid: CSR dùng CN cố định `itso-enroll`, chứng chỉ cấp ra luôn có CN = `server_uuid`; xoay vòng bắt buộc CN = `server_uuid`), bỏ mọi extension xin thêm (SAN, IsCA, KeyUsage lạ); cấp chứng chỉ client (`ExtKeyUsageClientAuth`), serial ngẫu nhiên 128 bit.
3. **Chứng chỉ node 30 ngày**, khóa riêng sinh và nằm trên node. Agent tự xoay khi qua 2/3 hạn qua op `agent.cert.rotate` hai pha (node sinh khóa + CSR → panel ký bằng `pki.sign_csr` → node cài chứng chỉ khớp khóa chờ). Bản cũ được đánh dấu `superseded` trong `agent_certificates`. Hết hạn → relay từ chối (`cert_expired`), cần `itso node rejoin`.
4. **Token join:** 32 byte ngẫu nhiên (`itso_enr_` + base64url), hạn mặc định 1 giờ (5–1440 phút), dùng một lần, DB chỉ lưu sha256 (`agent_enrollment_tokens.token_hash`, CHECK định dạng hex). Token chỉ hiện một lần khi tạo; lệnh join kèm `--ca-sha256`. Sai/hết hạn/đã dùng → `enrollment_invalid`.
5. **Thu hồi:** "Thu hồi node" (SUPER_ADMIN + step-up, chỉ khi server không còn account) đặt `agents.connection='revoked'`, `revoked_at`, ghi `agent_certificates.revoked_at`; relay nạp lại danh sách thu hồi và cắt kết nối ngay.

## Hệ quả

- Không cần PKI ngoài; mọi chứng chỉ truy vết được qua `agent_certificates` và audit.
- Mất khóa CA = phải phát hành lại cho mọi node (`itso node rejoin`); khóa CA nằm trong backup cấu hình máy panel (mã hóa age, D-84).
