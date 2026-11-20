# Kết nối repo ITSO Panel với GitHub

Repo hiện là **Git local** (D-51). Tài liệu này hướng dẫn người quản trị tự đưa repo lên GitHub khi cần. Claude **không** tự tạo repo, thêm remote hay push.

> Chỉ làm khi đã có quyết định đưa mã lên GitHub. Repo nên là **private** (panel nội bộ).

## 1. Chuẩn bị

1. Kiểm tra repo sạch và xanh:

   ```bash
   git status            # không còn thay đổi chưa commit
   make check            # 0 FAIL
   ```

2. Kiểm tra không có secret trong lịch sử: `.env`, khóa, chứng chỉ đều nằm trong `.gitignore`.

   ```bash
   git log --all --name-only --format= | sort -u | grep -Ei '(^|/)\.env$|\.pem$|\.key$|id_rsa' || echo "OK: không thấy file nhạy cảm"
   ```

3. Trên GitHub, tạo repository **rỗng** (không tạo README, `.gitignore` hay LICENSE để tránh xung đột lịch sử), chế độ **Private**. Ví dụ: `<org>/itso-panel`.

## 2. Thêm remote và push

Dùng SSH (khuyến nghị) hoặc HTTPS với token có quyền `repo`:

```bash
git remote add origin git@github.com:<org>/itso-panel.git
git remote -v

git push -u origin main
git push -u origin phase-1        # nhánh Phase đang làm (nếu còn)
```

Nếu đã có remote cũ: `git remote set-url origin <url-mới>`.

## 3. Bật GitHub Actions

1. Vào **Settings → Actions → General**: chọn "Allow all actions" hoặc chỉ cho phép action của GitHub và `shivammathur/setup-php`.
2. **Workflow permissions**: "Read repository contents" (CI chỉ cần quyền đọc, file đã khai `permissions: contents: read`).
3. Push một commit bất kỳ hoặc vào tab **Actions → CI → Run workflow** để chạy lần đầu.

Workflow `.github/workflows/ci.yml` gồm 7 job:

| Job | Nội dung | Tương đương local |
|---|---|---|
| structure | Cấu trúc repo | `make structure` |
| docs | markdownlint, link nội bộ, Mermaid | `make docs-check` |
| database | Áp schema + test SQL trên service PostgreSQL 16 | `make db-verify` |
| contracts | Sinh lại không diff, Redocly, ajv, codegen | `make contracts-check`, `make codegen-check` |
| web | Token, ESLint, Prettier, tsc, i18n, Vitest, build, Playwright + axe | `make lint-web test-web build-web test-e2e` |
| api | Pint, PHPStan/Larastan, Pest (SQLite và PostgreSQL 16 + Redis 7), cấm lệnh hệ thống | `make lint-api test-api test-api-pg no-exec` |
| agent | gofmt, vet, staticcheck, `test -race`, fuzz 30 giây | `make lint-agent test-agent test-fuzz` |

Ảnh chụp Playwright được lưu thành artifact `design-system-screenshots` (14 ngày).

CI không cần secret nào. Mật khẩu PostgreSQL trong workflow (`itso_ci_only`) chỉ dùng cho container dịch vụ tạm của job.

## 4. Bảo vệ nhánh (khuyến nghị)

**Settings → Branches → Add rule** cho `main`:

- Require a pull request before merging.
- Require status checks to pass: chọn 7 job của CI.
- Không cho force push, không cho xóa nhánh.

Quy ước nhánh giữ nguyên như `CLAUDE.md`: làm trên `phase-<N>`, merge vào `main` khi Phase được duyệt.

## 5. Sau khi kết nối

- Cập nhật `DECISIONS.md` (D-51: đã kết nối GitHub, ngày, tên repo) và `PHASE_STATUS.md`.
- Nếu dùng Claude Code trên web với repo này: kết nối GitHub cho tài khoản Claude và cài Claude GitHub App vào repo.

## Sự cố thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| `rejected … fetch first` khi push | Repo GitHub không rỗng. Tạo lại repo rỗng, hoặc `git pull --rebase origin main` nếu cố ý giữ commit trên GitHub |
| Job `web` lỗi tải Chromium | Thử chạy lại job; bước `playwright install --with-deps chromium` cần mạng tới CDN của Playwright |
| Job `api` lỗi kết nối PostgreSQL | Service chưa sẵn sàng: kiểm `options: --health-cmd` và cổng `5432:5432` |
| `codegen-check` đỏ | Contracts đã đổi mà chưa sinh lại: `make codegen`, commit file sinh |
