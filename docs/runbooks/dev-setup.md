# Dev setup — chạy ITSO Panel trên máy lập trình viên

Mục tiêu: clone sạch → `make setup && make dev` → mở `/admin/` và `/portal/` thấy trạng thái API và mock agent, trong **≤ 15 phút** (thường dưới 5 phút khi đã có công cụ).

> Đây là môi trường **dev**. Không dùng cho production hay VM test. `make dev` chỉ nghe trên `127.0.0.1` và unix socket, không đổi cấu hình máy, không cần root.

## 1. Thành phần khi chạy `make dev`

| Tiến trình | Địa chỉ | Ghi chú |
|---|---|---|
| Vite (apps/web) | `http://127.0.0.1:5173/admin/`, `/portal/` | Proxy `/api` sang Laravel |
| Laravel (apps/api) | `http://127.0.0.1:8000/api/v1/...` | `php artisan serve` |
| Mock agent (agent/) | `unix:/tmp/itso-mock-agent.sock` | Chỉ `system.ping`, `system.info`, dữ liệu giả |
| PostgreSQL 16, Redis 7 | `127.0.0.1:5432`, `127.0.0.1:6379` | **Tùy chọn** ở Prompt 1.5: thiếu thì trang Admin báo đỏ dòng tương ứng, phần còn lại vẫn chạy |

Trang **Admin** hiện: API health, ping mock agent, PostgreSQL, Redis (`GET /api/v1/admin/system/status`, chỉ bật khi `APP_ENV=local|testing` cho tới khi có auth ở Phase 3).
Trang **Portal** chỉ hiện API health: chi tiết agent và hạ tầng là thông tin Admin-only, không lộ qua portal.

## 2. Công cụ cần có

| Công cụ | Phiên bản | Kiểm tra |
|---|---|---|
| Git, GNU Make, Bash | bất kỳ bản mới | `make --version` |
| Node.js | 22 LTS (≥ 22.12) | `node -v` |
| pnpm | 10 (qua corepack, đi kèm Node) | `corepack pnpm -v` |
| PHP | 8.3+ với `pdo_pgsql`, `pdo_sqlite`, `redis`, `curl`, `mbstring`, `xml` | `php -m` |
| Composer | 2.x | `composer -V` |
| Go | 1.24+ | `go version` |
| Docker (tùy chọn) | Engine + Compose v2 | `docker compose version` |

`make setup` tự kiểm tra phiên bản và báo thiếu gì.

## 3. Ubuntu 24.04

```bash
sudo apt update
sudo apt install -y git make curl unzip ca-certificates \
  php8.3-cli php8.3-pgsql php8.3-sqlite3 php8.3-redis php8.3-curl php8.3-mbstring php8.3-xml php8.3-zip php8.3-intl

# Composer (https://getcomposer.org/download/ — kiểm tra chữ ký theo hướng dẫn trên trang)
# Node.js 22 LTS: dùng NodeSource hoặc nvm; sau đó bật corepack:
corepack enable

# Go 1.24+: tải tarball chính thức từ https://go.dev/dl/ rồi thêm /usr/local/go/bin vào PATH
```

Sau đó:

```bash
git clone <repo> itso-panel && cd itso-panel
make setup     # pnpm install, composer install, tạo apps/api/.env + APP_KEY, build mock agent
make dev       # Ctrl+C để dừng cả ba tiến trình
```

### PostgreSQL 16 + Redis 7

**Cách A — Docker (khuyến nghị cho dev):**

```bash
make services-up     # docker-compose.dev.yml: postgres:16-alpine + redis:7-alpine, chỉ bind 127.0.0.1
make services-down   # tắt, giữ dữ liệu
```

**Cách B — không dùng Docker:** cài gói của Ubuntu và tạo user/DB khớp `apps/api/.env`:

```bash
sudo apt install -y postgresql-16 redis-server
sudo -u postgres psql -c "CREATE ROLE itso LOGIN PASSWORD 'itso_dev_only';"
sudo -u postgres createdb -O itso itso
```

Mật khẩu `itso_dev_only` chỉ là giá trị dev mặc định trong `.env.example`. Đổi trong `apps/api/.env` nếu muốn.

## 4. Windows (WSL2)

Khuyến nghị chạy mọi thứ **trong WSL2 Ubuntu 24.04**:

1. PowerShell (Admin): `wsl --install -d Ubuntu-24.04`, khởi động lại, tạo user Linux.
2. Trong Ubuntu (WSL): làm đúng mục 3. Đặt repo trong ổ Linux (`~/src/itso-panel`), **không** đặt dưới `/mnt/c` (chậm và lỗi quyền file).
3. Từ PowerShell có thể gọi qua script chuyển tiếp: `.\scripts\dev.ps1 setup`, `.\scripts\dev.ps1 dev`.
4. Mở trình duyệt Windows: `http://127.0.0.1:5173/admin/` (WSL2 tự chuyển tiếp localhost).
5. Docker: dùng Docker Desktop với WSL integration, hoặc cài PostgreSQL/Redis trong WSL theo Cách B.

Chạy mock agent **trên Windows native** (không qua WSL) chỉ dùng khi cần thử: agent nghe TCP loopback.

```powershell
cd agent; go run ./cmd/itso-mock-agent -listen tcp:127.0.0.1:7810
```

Khi đó trong `apps/api/.env` đặt `ITSO_AGENT_SOCKET=` (rỗng) và `ITSO_AGENT_URL=http://127.0.0.1:7810`.

## 5. Lệnh thường dùng

| Việc | Lệnh |
|---|---|
| Test web + api + agent + chặn exec | `make test` |
| Lint (ESLint, Prettier, tsc, Pint, Larastan, gofmt, go vet, chặn exec) | `make lint` |
| Fuzz parser envelope (CI chạy 30 giây) | `make test-fuzz` hoặc `make test-fuzz FUZZTIME=2m` |
| Build web + mock agent | `make build` |
| Chỉ test một phần | `make test-web`, `make test-api`, `make test-agent` |

## 6. Biến môi trường dev

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ITSO_AGENT_SOCKET` | `/tmp/itso-mock-agent.sock` | Socket mock agent (`make dev` và Laravel dùng chung) |
| `ITSO_AGENT_URL` | rỗng | Dùng thay socket (Windows native) |
| `API_PORT` | `8000` | Cổng `php artisan serve` |
| `ITSO_API_URL` | `http://127.0.0.1:8000` | Đích proxy `/api` của Vite |

## 7. Sự cố thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| `Port 5173 is already in use` | Tắt tiến trình Vite cũ (`make dev` cũ chưa dừng) |
| Dòng Agent đỏ `AgentUnavailable` | Mock agent chưa chạy hoặc `ITSO_AGENT_SOCKET` ở `.env` khác với `make dev` |
| Dòng PostgreSQL/Redis đỏ | Chưa bật dịch vụ: `make services-up` hoặc Cách B |
| `composer install` báo `Could not authenticate against github.com` | Mạng chặn tải zip từ GitHub; tạo GitHub token (chỉ quyền đọc public) và `composer config -g github-oauth.github.com <token>`, hoặc thử mạng khác |
| WSL chậm | Repo đang nằm dưới `/mnt/c` → chuyển vào `~` |
