# Review bảo mật nhiều máy chủ (Phase 9, Prompt 9.8)

- **Ngày:** 2026-11-22 · **Phạm vi:** itso-relay (mTLS, enroll, revocation), agent chế độ node, CA nội bộ (`pki.sign_csr`, `agent.cert.rotate`), token join, `AgentClient` chọn kênh, job chờ node (`waiting_agent`), gợi ý vị trí, chuyển account giữa server (`app/Domain/Migration/*`, op `migrate.*`), khôi phục chéo server, installer `--role node` và lệnh `itso node …`.
- **Quyết định liên quan:** D-88 → D-93, ADR 0034–0036, threat model `docs/security/threat-model.md`.
- **Cách review:** đọc code theo từng đường vào và đối chiếu với test tự động: Pest `Phase9/*` (relay giả theo schema), Go `relay/*_test`, `pki/*_test`, `ops/migrate_test` (restic thật), installer test, Vitest + Playwright demo, và e2e stack thật `e2e-real/phase9.spec.ts` (relay thật + agent node sandbox qua mTLS loopback, 4 luồng). Phần cần 3 máy, tường lửa, systemd và WordPress thật ghi **chờ VM** (`tests/vm/phase9.sh` N0–N6).

## 1. Ranh giới tin cậy

```text
Trình duyệt ─HTTPS─► Laravel (itso) ─HMAC riêng server─► relay.sock (0660 itso-relay) ─► itso-relay (user itso-relay)
                         │ khóa HMAC mỗi node mã hóa APP_KEY                     │ TLS 1.3, client cert theo CA nội bộ
                         │ bí mật = tham chiếu, giải ngay trước khi gửi           │ CN = server_uuid, danh sách thu hồi
                         └─HMAC─► itso-agent local (root, giữ ca.key)            ▼
                                     └─ pki.sign_csr (chỉ bật ở control plane) ◄─ WebSocket do NODE quay ra :28444
                                                                                  itso-agent --mode node (root, /etc/itso/agent.key)
```

1. **Relay chỉ chuyển byte.** Envelope vẫn ký HMAC (D-66) bằng khóa riêng của server đích, có `ts` + `nonce` chống replay (`auth.Verifier`). Relay không giữ khóa HMAC nào, không giữ khóa CA, không giải được bí mật.
2. **Node không mở cổng quản trị.** Agent node chỉ quay số ra `control-plane:28444`; envelope nhận về đi qua cùng dispatcher/validate/policy như socket local.
3. **Khóa CA chỉ ở agent local của control plane** (`/etc/itso/pki/ca.key` root 0600). Laravel xin ký qua op `pki.sign_csr`; agent tự kiểm CSR, bỏ extension xin thêm, ép CN = `server_uuid`, hạn ≤ 30 ngày.

## 2. Các mối đe dọa và biện pháp

| # | Tấn công / rủi ro | Biện pháp | Kiểm bằng |
|---|---|---|---|
| M1 | Relay bị chiếm → ra lệnh cho node | Không có khóa HMAC của node → envelope giả bị agent từ chối; replay bị chặn theo nonce + cửa sổ thời gian; op_id idempotent nên gửi lại không chạy hai lần | Go `relay_test` (`TestWrongServerKeyRejectedByAgent`, `TestReconnectKeepsOpIDIdempotent`), `auth` test; Pest `AgentTransportTest` |
| M2 | Relay bị chiếm → chặn/đọc lưu lượng | Bí mật không có trong params (tham chiếu `{"$secret"}` giải ở Laravel ngay trước khi gửi); relay chặn được kết nối = **mất quản lý, không mất dữ liệu** (website node vẫn chạy, job `waiting_agent` có hạn) | Pest (jobs/job_steps/audit không chứa bí mật); e2e stack thật (node dừng → `waiting_agent` → chạy tiếp) |
| M3 | Giả mạo node khi join (MITM) | Installer tải CA từ `/v1/ca`, so sha256 với `--ca-sha256`; sai → dừng và **không gửi token**; sau đó mọi kết nối TLS ghim CA | Go `install/node_test` (`TestJoinRejectsWrongPinBeforeSendingToken`); e2e stack thật (pin sai bị từ chối) |
| M4 | Lộ / dùng lại token join | 32 byte ngẫu nhiên, một lần, hạn 5–1440 phút, DB chỉ lưu sha256; enroll giới hạn 10 lần/10 phút/IP; relay ký `X-Itso-Relay-Signature` khi chuyển tiếp | Pest `NodeTest` (token đã dùng/hết hạn → `enrollment_invalid`); Go `TestEnrollForwardSignedAndRateLimited`; e2e (dùng lại token bị từ chối) |
| M5 | Chứng chỉ node bị lộ | Hạn 30 ngày, xoay ở 2/3 hạn (hai pha, khóa mới sinh trên node); "Thu hồi node" (SA + step-up, chỉ khi không còn account) ghi revocation, relay nạp lại và cắt kết nối | Pest `NodeTest` (revoke → push revocations); Go `relay_test` (`TestRevocationCutsAndBlocks`, `TestRejectsBadCertificates`); e2e (thu hồi → job mới bị từ chối); **VM N3, N6** |
| M6 | Lạm dụng `pki.sign_csr` để cấp chứng chỉ tùy ý | Op rủi ro critical, agent chế độ node từ chối (`op_disabled`), chỉ agent local control plane ký; CSR phải ECDSA P-256, chữ ký đúng; chứng chỉ chỉ có `ExtKeyUsageClientAuth`, CN do panel quyết định, bỏ SAN/IsCA | Go `pki_test` (`TestEnrollCSRGetsServerUUID`), `ops/pki_test` (agent chế độ node trả `op_disabled`) |
| M7 | Lệnh chuyển account bị dùng để đọc/ghi dữ liệu tùy ý | Dữ liệu chỉ đi qua repo restic của account (backup ở nguồn, restore ở đích); op `migrate.*` không nhận host/đường dẫn tự do; đích dựng lại account với **cùng username + UID**, khôi phục dưới uid account; preflight ở đích chặn username/UID/domain/DB đã thuộc account khác | Go `ops/migrate_test` (restic thật, ownership, uid trùng bị chặn); Pest `MigrationTest` |
| M8 | Đích không đạt điều kiện nhưng vẫn bị ghi (đổi trạng thái giữa preflight và lúc chạy) | Đầu chặng đích chạy lại `migrate.preflight` với `enforce=true`: còn mục chặn → op lỗi `precondition_failed`, job dừng **trước** `account.ensure`; lượt chuyển `failed`, account mở lại ở nguồn | Go `TestMigratePreflight` (enforce); Pest `MigrationTest` (repo chưa khởi tạo + đích chặn) — phát hiện qua e2e 9.8 |
| M9 | Ghi dữ liệu trong lúc chuyển gây lệch | Account `migrating`: mọi thao tác ghi (Admin/Portal) trả 409; cutover chỉ khi kiểm chứng (checksum file/DB, ownership, HTTP, cron) đạt; nguồn bị khóa (trang bảo trì) và giữ `keep_source_days` trước khi dọn | Pest `MigrationTest`; e2e stack thật (cron → 409, cutover → nội dung site ở đích khớp nguồn) |
| M10 | ADMIN vượt phạm vi qua chuyển/khôi phục chéo server | Cần quyền trên **cả** server nguồn và đích (`accounts.write` + scope); danh sách lượt chuyển chỉ hiện khi cả hai server trong phạm vi; dọn nguồn sớm chỉ SUPER_ADMIN | Pest `MigrationTest` (ADMIN thiếu scope đích → 422/404), MSW + Vitest |
| M11 | Node mất kết nối → job treo vô hạn hoặc chạy lại hai lần | `waiting_agent` có hạn (30 phút; op đọc 2 phút) rồi `failed agent_unreachable`; khi node quay lại `itso:relay-sync` đẩy lại job với **cùng op_id** | Pest `NodeTest`; e2e stack thật; **VM N2** |
| M12 | Dồn account vào server sắp đầy | Gợi ý vị trí loại server còn < 15% đĩa sau khi cấp (hiện lý do); ở wizard chuyển, SA/ADMIN vẫn chọn được server bị loại nhưng lý do hiện rõ, preflight ở đích kiểm đĩa thật | Pest `NodeTest` (gợi ý vị trí); e2e stack thật (wizard chọn server bị loại vì đĩa) |

## 3. Giới hạn đã biết (chấp nhận ở Phase 9)

1. **Relay là điểm tập trung:** mất relay = mọi node không quản lý được (website vẫn chạy). Chưa có relay dự phòng; theo dõi bằng `itso node status`, cảnh báo server offline trên UI. Ghi vào backlog Phase 10+ nếu cần HA.
2. **UID theo server:** UidAllocator cấp UID theo từng server, nên chuyển account cần UID + username còn trống ở đích; trùng → preflight chặn, phải xử lý tay. Chưa có dải UID toàn cụm.
3. **Chứng chỉ TLS website không chuyển theo:** đích cấp lại ACME sau cutover (wizard hiện ghi chú); trong khoảng DNS chưa trỏ, HTTPS ở đích có thể dùng chứng chỉ tạm.
4. **Kiểm chứng HTTP trong sandbox dev bỏ qua** (không có nginx, `migrate.verify` ghi "sandbox: bỏ qua"); máy thật luôn kiểm HTTP 200 + nội dung — **chờ VM N4**.
5. **Sandbox dev dùng chung một MariaDB** cho node và server local, nên e2e lượt hoàn tác dùng account không DB (hoàn tác xóa DB đã khôi phục ở đích sẽ xóa luôn DB nguồn trong sandbox). Máy thật mỗi server có MariaDB riêng — Pest + Go phủ hoàn tác có DB.
6. **Cổng 28444 mở inbound trên control plane** cho enroll + kết nối node; `/v1/ca` và `/v1/enroll` là endpoint không mTLS duy nhất, có giới hạn tần suất.

## 4. Kết luận

Không còn lỗi mức cao mở. Ba lỗi tìm được qua e2e stack thật ở 9.8 đã sửa kèm test: (1) account chưa backup lần nào bị preflight chặn nhầm (repo chưa khởi tạo → giờ là cảnh báo, chặng đích kiểm lại); (2) chặng đích vẫn dựng account khi `migrate.preflight` báo chặn (giờ `enforce=true` dừng job, M8); (3) bộ lọc trạng thái `waiting_agent` trên trang Tác vụ trả 422. Các mục cần máy thật: **chờ VM** `tests/vm/phase9.sh` (N0–N6).
