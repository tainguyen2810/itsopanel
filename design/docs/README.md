# Nguyên tắc Design System ITSO Panel

Áp dụng cho mọi màn hình Admin và Portal. Component nằm ở `apps/web/src/ui`, shell ở `apps/web/src/shared/shell`. Xem trực tiếp mọi component ở light/dark, VI/EN: chạy `make dev` rồi mở `http://127.0.0.1:5173/design/` (chỉ có ở dev, không nằm trong bản build).

Ảnh chụp tham chiếu: `docs/screenshots/design-system/` (sinh bởi `make test-e2e`).

## 1. Màu

- **Chỉ dùng token.** Viết `bg-surface`, `text-muted`, `border-border`, `text-danger-text`. ESLint chặn `#hex`, `rgb()`, `hsl()`, `oklch()`, class bảng màu Tailwind (`bg-red-500`) và màu tùy ý (`bg-[#…]`) trong `src/`.
- Cần màu thật trong JavaScript (biểu đồ, SVG): dùng chuỗi `var(--itso-chart-1)` hoặc hàm `chartColor(i)`, không chép giá trị hex.
- Chữ trên nền đặc của trạng thái dùng `-fg` (`bg-danger text-danger-fg`). Chữ màu trên nền thường dùng `-text`. Nền nhạt cho badge, alert dùng `-soft` đi với `-text`.
- **Màu không bao giờ là tín hiệu duy nhất.** Trạng thái luôn có chữ (StatusBadge), biểu tượng hoặc cả hai.
- Light là mặc định của `:root`, Dark bật bằng class `.dark` trên `<html>`. Mockup gốc là Dark (navy, xanh dương, xanh lá, tím, vàng); Light suy ra từ cùng bảng màu.

| Ý nghĩa | Token | Dùng cho |
|---|---|---|
| Thành công, đang chạy | `success` | Dịch vụ chạy, job xong, SSL còn hạn |
| Cảnh báo | `warning` | Sắp hết dung lượng, SSL sắp hết hạn, drift cấu hình |
| Lỗi, nguy hiểm | `danger` | Job lỗi, dịch vụ dừng, nút xóa |
| Thông tin, đang xử lý | `info` | Job đang chạy, thông báo trung tính |
| Thương hiệu, hành động chính | `primary` | Nút chính, link, mục menu đang chọn |
| Nhấn phụ | `accent` | Vai trò, nhãn phân loại |

## 2. Trạng thái (desired / observed)

Hệ thống lưu trạng thái mong muốn (`desired`) và trạng thái agent quan sát được (`observed`). `StatusBadge` thể hiện cả hai:

| Trạng thái | Tone |
|---|---|
| `active`, `succeeded`, `online` | success |
| `provisioning`, `running` | info |
| `suspended`, `degraded` | warning |
| `failed`, `offline` | danger |
| `pending`, `queued`, `cancelled`, `terminated` | neutral |

Bảng này nằm ở `TONE` trong `src/ui/Badge.tsx`; thêm trạng thái mới thì thêm cả chuỗi `status.<tên>` ở VI và EN.

Khi truyền `desiredVersion` mà `observedVersion` khác (hoặc chưa có), badge thứ hai hiện "Lệch cấu hình" (tone warning). Khớp nhau thì hiện "Đã đồng bộ". Di chuột vào để xem hai phiên bản.

Thao tác dài trả `202` kèm `JobAccepted`; hiển thị bằng `JobProgress` (thanh tiến độ và từng bước theo op agent).

## 3. Spacing, kích thước, bố cục

- Đơn vị spacing là `0.25rem` (4 px). Dùng các bước `1, 1.5, 2, 3, 4, 5, 6, 8`. Khoảng cách trong thẻ là `px-5 py-4`, giữa các thẻ là `gap-4` (mobile) đến `gap-6` (desktop).
- Radius: `sm` cho ô nhập nhỏ, `md` cho nút và ô nhập, `lg` cho thẻ và dialog, `full` cho badge và avatar.
- Cỡ chữ gốc là `base` (14 px). Tiêu đề trang `2xl`, tiêu đề thẻ `md`, chữ phụ `xs` hoặc `sm` với `text-muted`.
- Font Be Vietnam Pro tự host (`@fontsource`), không gọi Google Fonts lúc chạy. Mã, tên op, đường dẫn dùng font mono.
- Breakpoint: dưới `lg` (1024 px) sidebar thành drawer. Dưới `md` (768 px) bảng DataTable thành danh sách thẻ. Không có cuộn ngang ở 390 px (Playwright kiểm).
- Lớp chồng theo token `--z-*`, không viết số z-index trực tiếp.

## 4. Hành vi thành phần

- **Thao tác phá hủy** (xóa website, xóa database, khôi phục backup) dùng `ConfirmDialog` với `confirmName`: người dùng gõ đúng tên tài nguyên thì nút mới bật.
- **Form** dùng `FormField` (react-hook-form + zod). Thông báo lỗi là key i18n, không viết chuỗi cứng.
- **Bảng** dùng `DataTable`: sắp xếp, tìm kiếm, chọn dòng, phân trang, card ở mobile.
- **Rỗng, đang tải, lỗi**: `EmptyState`, `Skeleton`, `Alert`. Không để màn hình trắng.
- **Thông báo ngắn** dùng `toast` (sonner). Lỗi cần người dùng xử lý dùng `Alert` trong trang.

## 5. Theme và ngôn ngữ

- `ThemeProvider`: `light`, `dark`, `system` (theo `prefers-color-scheme`). Lựa chọn lưu ở `localStorage['itso.theme']`; storage lỗi (chế độ riêng tư) thì vẫn chạy với mặc định.
- `public/theme-init.js` chạy trong `<head>` trước React nên không nháy sai theme. Là file tĩnh, không phải script inline, để CSP chặt sau này vẫn chạy.
- i18n: tiếng Việt mặc định, có tiếng Anh. Key theo namespace (`common`, `shell`, `design`, `status`; module mới thêm namespace riêng). `pnpm i18n:check` (nằm trong `make lint`) báo key thiếu, giá trị rỗng, biến `{{…}}` lệch giữa VI và EN.
- Số, ngày, dung lượng định dạng theo locale qua `shared/i18n/format.ts` (`formatBytes` dùng cơ số 1024).

## 6. Accessibility (WCAG 2.2 AA)

- Tương phản: chữ ≥ 4.5:1, thành phần giao diện (viền ô nhập, focus ring, màu biểu đồ) ≥ 3:1. `make tokens-check` kiểm mọi cặp khai báo trong `tokens.json`.
- Mọi phần tử tương tác dùng được bằng bàn phím và có focus ring (`outline-ring`). Radix lo bẫy focus, phím Esc, `aria-*` cho dialog, menu, select.
- Nút chỉ có biểu tượng phải có `aria-label`. Nút có chữ hiển thị thì tên truy cập phải chứa chữ đó (dùng `sr-only` để bổ sung, không ghi đè bằng `aria-label` khác chữ).
- Có link "Bỏ qua đến nội dung chính" và `<main id="main">`. Mỗi trang có một `h1`.
- Tôn trọng `prefers-reduced-motion`: tắt animation.
- Playwright chạy axe-core trên `/design`, AdminShell, PortalShell × light/dark × VI/EN: yêu cầu 0 lỗi `critical` và `serious`.

## 7. Thêm component mới

1. Viết trong `src/ui/`, chỉ dùng token, export từ `src/ui/index.ts`.
2. Thêm ví dụ vào trang `/design` và chuỗi vào cả `locales/vi` và `locales/en`.
3. Có logic thì viết Vitest. Có bố cục phụ thuộc kích thước thì kiểm bằng Playwright.
4. `make lint && make test && make test-e2e`.
