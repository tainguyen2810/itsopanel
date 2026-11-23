# Chính sách cập nhật và bảo mật bản phát hành (Prompt 12.6)

Áp dụng cho ITSO Panel từ `v1.0.0-rc.1`. Hệ thống dùng nội bộ: "người dùng" ở đây là đội vận hành và các bộ phận được cấp
tài khoản Hosting. Quyết định liên quan: D-65 (ký release), D-113 (offline installer), D-114 (journal cập nhật).

## 1. Kênh phát hành

| Kênh | Phiên bản | Dùng cho | Hỗ trợ |
|---|---|---|---|
| `stable` | `X.Y.Z` | Máy chủ production | Bản mới nhất và bản minor ngay trước (vá bảo mật) |
| `rc` | `X.Y.Z-rc.N` | Máy staging, VM kiểm thử Gate | Chỉ bản rc mới nhất |
| `beta` / `alpha` | `X.Y.Z-beta`, `-alpha` | Thử tính năng (các Phase trước v1.0) | Không hỗ trợ sau khi có `stable` |

- `itso update` chỉ nhận bản có `min_from_version` ≤ bản đang chạy và từ chối hạ phiên bản (`itso rollback` là đường duy
  nhất để quay về, và chỉ về bản ngay trước đã giữ ở `/opt/itso/releases`).
- Bản có `breaking_db: true` trong manifest: phải backup panel (`itso backup`) trước; quay lại = khôi phục backup, không
  `rollback` thường. Mặc định mọi migration là expand/contract (chỉ thêm) để rollback giữ được dữ liệu.
- Máy không có mạng: dùng `itso-<ver>-offline.tar` (`make release-offline`), cài bằng `install.sh --offline`; cập nhật bằng
  `itso update --release-dir <thư mục giải nén bundle>` (manifest vẫn kiểm chữ ký như bản online).

## 2. Thời hạn vá

Mức độ theo CVSS v3.1 của thành phần bị ảnh hưởng, tính từ lúc đội biết lỗ hổng (báo cáo nội bộ, advisory upstream,
kết quả `govulncheck`/`composer audit`/`pnpm audit` trước phát hành, §5).

| Mức | Ví dụ | Bản vá phát hành | Cài lên production |
|---|---|---|---|
| Critical (9.0–10) | RCE không cần đăng nhập, vượt cách ly account, lộ khóa agent | ≤ 48 giờ | ≤ 24 giờ sau khi phát hành |
| High (7.0–8.9) | Leo quyền ADMIN → SUPER_ADMIN, đọc dữ liệu account khác khi đã đăng nhập | ≤ 7 ngày | ≤ 3 ngày |
| Medium (4.0–6.9) | XSS cần tương tác, lộ thông tin cấu hình không bí mật | Bản minor kế tiếp, ≤ 30 ngày | Theo lịch bảo trì |
| Low (< 4.0) | Header thiếu, thông báo lỗi lộ phiên bản | Khi tiện | Theo lịch bảo trì |

- Gói hệ điều hành (nginx, PHP, MariaDB, PostgreSQL, OpenSSH…) đi theo `unattended-upgrades` của Ubuntu (kênh security);
  Security Center báo gói cần cập nhật. Bundle offline phải sinh lại lock (`--update-lock`) khi có bản vá High/Critical
  của gói trong `packaging/offline-packages.list`.
- Khi chưa vá kịp: ghi biện pháp tạm (tắt tính năng qua cài đặt, chặn đường dẫn ở Caddy, giới hạn allowlist IP admin) vào
  ticket và thông báo nội bộ.

## 3. Ký bản phát hành

- `make release` ký `manifest.json` (phiên bản, sha256 từng file, `min_from_version`, `breaking_db`) bằng Ed25519 →
  `manifest.sig`. `make release-offline` ký thêm `offline-manifest.json` (sha256 từng `.deb`, `Packages`, `manifest.json`)
  bằng **cùng khóa**.
- Khóa công khai nhúng trong `install.sh` và trong binary `itso` (`-X main.releasePubKey`), nên `itso update` kiểm bằng khóa
  của bản **đang chạy**, không bằng khóa đi kèm bản mới.
- Khóa riêng: chỉ trên máy build phát hành (file 0600, ngoài repo, biến `ITSO_RELEASE_KEY`), có bản sao mã hóa ở két
  offline do 2 người giữ. Không bao giờ nằm trong repo, CI công khai, ticket hay tin nhắn. Khóa DEV tự sinh ở
  `build/release-key/` chỉ để thử; bản build bằng khóa DEV không được cài lên production.
- Mỗi lần phát hành ghi vào `docs/releases/<ver>.md`: sha256 của `manifest.json`, tarball, bundle offline và fingerprint
  khóa công khai (`openssl pkey -pubin -in release.pub.pem -outform DER | sha256sum`).

## 4. Xoay khóa ký

**Định kỳ (mỗi 2 năm) hoặc khi đổi người giữ khóa:**

1. Sinh khóa mới K2 trên máy build (không mạng nếu có thể).
2. Phát hành **bản cầu nối** ký bằng khóa cũ K1, trong đó binary `itso` và `install.sh` nhúng K2.
3. Các máy cập nhật qua bản cầu nối (kiểm bằng K1 đang chạy) → từ đó tin K2.
4. Các bản sau ký bằng K2. Giữ K1 thêm 90 ngày cho máy chậm cập nhật, rồi hủy (ghi biên bản).

**Khóa bị lộ (Critical):**

1. Ngừng phát hành bằng K1; sinh K2.
2. Phát hành bản mới ký K2. Máy đang chạy **không** tin K2, nên cập nhật thủ công: đội vận hành tải bundle qua kênh nội bộ
   đã xác thực, đối chiếu sha256 với giá trị công bố trên kênh thứ hai (gặp trực tiếp/điện thoại), rồi chạy
   `install.sh` mới (nhúng K2) với `--release-dir`.
3. Rà nhật ký phát hành: mọi bản ký bằng K1 sau thời điểm nghi lộ coi là không tin cậy.

## 5. SBOM và kiểm phụ thuộc

- `make release` sinh `sbom.json` (`scripts/sbom.py`, JSON tối giản): module Go, gói Composer (không dev), dependency npm
  trực tiếp của web; bundle offline có thêm danh sách `.deb` khóa phiên bản trong `offline-manifest.json`. Chuyển sang định
  dạng CycloneDX: lộ trình v1.x.
- Trước mỗi bản phát hành, người phát hành chạy `govulncheck ./...` (agent), `composer audit --no-dev` (api),
  `pnpm audit --prod` (web) và ghi kết quả vào `docs/releases/<ver>.md`; còn mức High/Critical chưa có biện pháp thì không
  phát hành. Đưa các lệnh này vào CI (cần mạng tới cơ sở dữ liệu lỗ hổng): lộ trình v1.x.
- Phụ thuộc mới phải qua review (giấy phép, người bảo trì, số phụ thuộc kéo theo); không thêm phụ thuộc chỉ để tiện.

## 6. Báo lỗi bảo mật nội bộ

1. Ai phát hiện lỗ hổng (nhân viên, đội vận hành, người dùng Hosting) báo **riêng** cho nhóm phụ trách ITSO Panel qua kênh
   bảo mật nội bộ (không đăng nhóm chat chung, không mở issue công khai trên GitHub). Kèm: phiên bản (`itso version`),
   bước tái hiện, ảnh hưởng dự kiến.
2. Nhóm phụ trách xác nhận đã nhận trong 1 ngày làm việc, đánh giá mức độ theo bảng §2, mở ticket hạn chế quyền xem.
3. Sửa trên nhánh riêng, có test tái hiện; review bởi người thứ hai; phát hành theo thời hạn §2.
4. Sau khi vá: ghi vào `docs/releases/<ver>.md` (mô tả mức độ, không kèm mã khai thác), cập nhật `docs/security/threat-model.md`
   nếu là lớp lỗi mới, và kiểm audit log xem lỗ hổng đã bị khai thác chưa.

## 7. Quy trình cập nhật trên máy chủ

1. Đọc `docs/releases/<ver>.md` (thay đổi, `breaking_db`, bước thủ công nếu có).
2. `itso doctor` phải sạch; `itso backup` nếu `breaking_db` hoặc bản minor/major.
3. `itso update` (hoặc từ trang Cập nhật của panel). Journal `/var/lib/itso/update.journal` ghi từng bước; mất điện giữa
   chừng → `itso repair --fix` hoàn tất hoặc quay lại (ADR 0059).
4. Kiểm `itso doctor`, trang Sẵn sàng production, vài site account. Có vấn đề: `itso rollback`.
5. Site của account không bị gián đoạn khi cập nhật panel (nginx/PHP-FPM không phụ thuộc panel; kiểm bằng
   `tests/vm/upgrade-loop.sh`, tiêu chí 0 lỗi HTTP).
