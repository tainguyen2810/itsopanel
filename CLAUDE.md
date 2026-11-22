# CLAUDE.md — Quy tắc làm việc cho ITSO Panel

ITSO Panel là hệ thống quản trị máy chủ và Hosting **dùng nội bộ** (Ubuntu 24.04, React + Laravel + PostgreSQL + Redis + Go agent). Trả lời người dùng bằng **tiếng Việt**.

## 1. Mở phiên mới: làm theo đúng thứ tự

1. Đọc `PHASE_STATUS.md`: Phase hiện tại, prompt hiện tại, task đang `✱`, commit cuối.
2. Chạy `git status` và `git log --oneline -5`, đối chiếu với commit cuối trong `PHASE_STATUS.md`.
   - Nếu có thay đổi chưa commit: xem lại diff, chạy test liên quan, rồi commit hoặc hoàn tác. Không chắc thì hỏi người dùng.
3. Tiếp tục task `✱` của prompt hiện tại. **Không** bắt đầu task ngoài prompt hiện tại.

## 2. Quy tắc bắt buộc

- **Không tự chuyển Phase hoặc Prompt.** Cuối mỗi prompt: cập nhật `PHASE_STATUS.md` và `TEST_REPORT.md`, commit, báo cáo, rồi **dừng chờ duyệt**.
- **Contracts trước code:** sửa `contracts/` (OpenAPI, JSON Schema) trước khi hiện thực endpoint/op; chạy `make contracts` rồi `make codegen`; `make codegen-check` phải xanh. Không sửa tay file sinh (`src/api/generated`, `types_gen.go`, `tokens.css`).
- **UI:** chỉ dùng token màu (ESLint chặn màu cứng); chuỗi giao diện qua i18n có cả VI và EN; nguyên tắc ở `design/docs/README.md`.
- **Laravel không bao giờ chạy lệnh hệ thống:** cấm `exec`, `shell_exec`, `proc_open`, `system`, `passthru`, backtick trong `apps/api/app`. Mọi thao tác Linux đi qua Go Agent bằng typed operation.
- **Agent:** không có op "chạy lệnh tùy ý"; không dùng `sh -c`; validate lại mọi tham số; thao tác dữ liệu của account chạy dưới UID account.
- **Không thay đổi cấu hình máy chủ thật, không deploy,** trừ khi prompt của Phase cho phép rõ ràng (Phase 4+ chỉ trên VM test).
- **Không skip/disable test để cho xanh.** Ghi lệnh và kết quả thật vào `TEST_REPORT.md`.
- **Không đưa billing/WooCommerce/thanh toán/storefront** vào code (OUT OF SCOPE). Public Provisioning API: DEFERRED.
- Không commit secret (`.env`, key, cert).

## 3. Git

- Nhánh làm việc: `phase-<N>`; `main` chỉ nhận merge khi Phase được duyệt.
- Commit nhỏ sau mỗi task, Conventional Commits có scope Phase: `feat(p1): …`, `chore(p1): …`, `docs(p1): …`, `test(p1): …`.
- Từ 2026-11-22 repo có remote `github` = `https://github.com/tainguyen2810/itsopanel` (D-51, người dùng yêu cầu). Sau mỗi commit cuối prompt: đẩy nhánh `phase-<N>`; sau khi merge: đẩy `main`. Không force push, không tạo remote khác. Tag bị proxy môi trường cloud chặn (HTTP 403) nên giữ local.

## 4. Lệnh

| Việc | Lệnh | Có từ |
|---|---|---|
| Xem lệnh | `make help` | 1.1 |
| Kiểm tra cấu trúc repo | `make structure` (`scripts/check-structure.sh`) | 1.1 |
| Sinh schema / ERD / kiểm chứng DB | `make db-schema` · `make db-erd` · `make db-verify` | 1.3 |
| Sinh / kiểm / dựng docs contracts | `make contracts` · `make contracts-check` · `make contracts-docs` | 1.4 |
| Cài dependency | `make setup` | 1.5 |
| Chạy dev (web + api + agent sandbox; `ITSO_DEV_AGENT=mock` dùng mock) | `make dev` | 1.5 / 4.6 |
| Test / Lint / Build | `make test` · `make lint` · `make build` | 1.5 |
| PostgreSQL + Redis dev (Docker, tùy chọn) · fuzz agent | `make services-up` · `make test-fuzz` | 1.5 |
| Token màu · Playwright · cập nhật ảnh Design System | `make tokens` / `make tokens-check` · `make test-e2e` · `make screenshots` | 1.6 |
| Pest với PostgreSQL + Redis thật | `make test-api-pg` | 1.7 |
| Codegen từ contracts | `make codegen` · `make codegen-check` | 1.7 |
| Toàn bộ kiểm tra (như CI, in bảng kết quả) | `make check` | 1.7 |
| Giao diện demo (API giả lập MSW theo OpenAPI, không cần Laravel) · build demo + kiểm build thường không có MSW | `make dev-demo` · `make build-demo` | 2.1 |
| Đóng gói release ký Ed25519 · kiểm unit systemd · test install.sh | `make release` · `make units-check` · `make test-installer` | 4.4 |
| Playwright stack thật (agent sandbox) · kiểm thử VM Ubuntu 24.04 (Multipass) | `make test-e2e-real` · `make test-vm` | 4.6 |

## 5. Tài liệu

- Gốc repo: `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `DECISIONS.md`, `DATABASE.md`, `API.md`, `PHASE_STATUS.md`, `TEST_REPORT.md`.
- Prompt Phase 1: `docs/planning/seed/PHASE_1_PROMPTS.md`. Prompt Phase 2: `docs/planning/seed/PHASE_2_PROMPTS.md`. Prompt Phase 3: `docs/planning/seed/PHASE_3_PROMPTS.md`. Prompt Phase 4: `docs/planning/seed/PHASE_4_PROMPTS.md`. Prompt Phase 5: `docs/planning/seed/PHASE_5_PROMPTS.md`. Prompt Phase 6: `docs/planning/seed/PHASE_6_PROMPTS.md`. Prompt Phase 7: `docs/planning/seed/PHASE_7_PROMPTS.md` (từ Phase 7: mockup trước khi code). Prompt Phase 8: `docs/planning/seed/PHASE_8_PROMPTS.md`. Prompt Phase 9: `docs/planning/seed/PHASE_9_PROMPTS.md`. Prompt Phase 10: `docs/planning/seed/PHASE_10_PROMPTS.md`. Prompt Phase 11: `docs/planning/seed/PHASE_11_PROMPTS.md`.
- Chi tiết kỹ thuật: `docs/planning/01–13`. Lịch sử định hướng đã hoãn: `docs/planning/14`, `15`.
- Khi tài liệu mâu thuẫn: file ở gốc repo > `docs/planning/seed/` > `docs/planning/01–13`.
