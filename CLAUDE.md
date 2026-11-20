# CLAUDE.md — Quy tắc làm việc cho ITSO Panel

ITSO Panel là hệ thống quản trị máy chủ và Hosting **dùng nội bộ** (Ubuntu 24.04, React + Laravel + PostgreSQL + Redis + Go agent). Trả lời người dùng bằng **tiếng Việt**.

## 1. Mở phiên mới: làm theo đúng thứ tự
1. Đọc `PHASE_STATUS.md`: Phase hiện tại, prompt hiện tại, task đang `✱`, commit cuối.
2. Chạy `git status` và `git log --oneline -5`, đối chiếu với commit cuối trong `PHASE_STATUS.md`.
   - Nếu có thay đổi chưa commit: xem lại diff, chạy test liên quan, rồi commit hoặc hoàn tác. Không chắc thì hỏi người dùng.
3. Tiếp tục task `✱` của prompt hiện tại. **Không** bắt đầu task ngoài prompt hiện tại.

## 2. Quy tắc bắt buộc
- **Không tự chuyển Phase hoặc Prompt.** Cuối mỗi prompt: cập nhật `PHASE_STATUS.md` và `TEST_REPORT.md`, commit, báo cáo, rồi **dừng chờ duyệt**.
- **Contracts trước code:** sửa `contracts/` (OpenAPI, JSON Schema) trước khi hiện thực endpoint/op; chạy codegen; không để diff.
- **Laravel không bao giờ chạy lệnh hệ thống:** cấm `exec`, `shell_exec`, `proc_open`, `system`, `passthru`, backtick trong `apps/api/app`. Mọi thao tác Linux đi qua Go Agent bằng typed operation.
- **Agent:** không có op "chạy lệnh tùy ý"; không dùng `sh -c`; validate lại mọi tham số; thao tác dữ liệu của account chạy dưới UID account.
- **Không thay đổi cấu hình máy chủ thật, không deploy,** trừ khi prompt của Phase cho phép rõ ràng (Phase 4+ chỉ trên VM test).
- **Không skip/disable test để cho xanh.** Ghi lệnh và kết quả thật vào `TEST_REPORT.md`.
- **Không đưa billing/WooCommerce/thanh toán/storefront** vào code (OUT OF SCOPE). Public Provisioning API: DEFERRED.
- Không commit secret (`.env`, key, cert).

## 3. Git
- Nhánh làm việc: `phase-<N>`; `main` chỉ nhận merge khi Phase được duyệt.
- Commit nhỏ sau mỗi task, Conventional Commits có scope Phase: `feat(p1): …`, `chore(p1): …`, `docs(p1): …`, `test(p1): …`.
- Repo đang là **Git local** (D-51). Kết nối GitHub theo `docs/runbooks/connect-github.md` khi người dùng yêu cầu. Không tự tạo remote hay push.

## 4. Lệnh
| Việc | Lệnh | Có từ |
|---|---|---|
| Xem lệnh | `make help` | 1.1 |
| Kiểm tra cấu trúc repo | `make structure` (`scripts/check-structure.sh`) | 1.1 |
| Cài dependency | `make setup` | 1.5 |
| Chạy dev (web + api + mock agent) | `make dev` | 1.5 |
| Test / Lint / Build | `make test` · `make lint` · `make build` | 1.5 |
| Codegen từ contracts | `make codegen` · `make codegen-check` | 1.7 |
| Toàn bộ kiểm tra | `make check` | 1.7 |

## 5. Tài liệu
- Gốc repo: `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `DECISIONS.md`, `DATABASE.md`, `API.md`, `PHASE_STATUS.md`, `TEST_REPORT.md`.
- Prompt Phase 1: `docs/planning/seed/PHASE_1_PROMPTS.md`.
- Chi tiết kỹ thuật: `docs/planning/01–13`. Lịch sử định hướng đã hoãn: `docs/planning/14`, `15`.
- Khi tài liệu mâu thuẫn: file ở gốc repo > `docs/planning/seed/` > `docs/planning/01–13`.
