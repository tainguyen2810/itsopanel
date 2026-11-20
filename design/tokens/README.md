# design/tokens

`tokens.json` là **nguồn sự thật** của Design System: màu Light/Dark, font, cỡ chữ, độ đậm, spacing, radius, shadow, z-index, breakpoint và danh sách cặp màu phải kiểm tương phản.

## Quy trình sửa token

1. Sửa `tokens.json`.
2. `make tokens`: sinh lại `apps/web/src/shared/styles/tokens.css`.
3. `make tokens-check`: kiểm file sinh khớp nguồn và mọi cặp màu đạt WCAG AA.
4. Commit cả `tokens.json` và `tokens.css`. `make lint` báo lỗi nếu hai file lệch nhau.

Không sửa tay `tokens.css` (Prettier cũng bỏ qua file này).

## File sinh ra chứa gì

| Phần | Ý nghĩa |
|---|---|
| `:root { --itso-* }` | Giá trị Light (mặc định) |
| `:root.dark { --itso-* }` | Giá trị Dark, bật bằng class `.dark` trên `<html>` |
| `@custom-variant dark` | Biến thể `dark:` của Tailwind theo class `.dark` |
| `@theme inline { --color-*: var(--itso-*) }` | "Preset" Tailwind v4: sinh class `bg-surface`, `text-muted`, `border-border`… Bảng màu mặc định của Tailwind bị xóa (`--color-*: initial`) |
| `--z-*` | Thứ tự lớp: `sticky` < `sidebar` < `topbar` < `overlay` < `drawer` < `modal` < `popover` < `toast` < `tooltip` |

Tailwind v4 không còn preset JavaScript, nên preset là khối `@theme inline` trong CSS.

## Tên màu

| Nhóm | Token |
|---|---|
| Nền | `bg`, `sidebar`, `surface`, `surface-2`, `surface-hover` |
| Viền | `border`, `border-strong`, `input` (viền ô nhập, ≥ 3:1) |
| Chữ | `fg`, `muted`, `subtle` |
| Thương hiệu | `primary`, `primary-hover`, `primary-fg`, `primary-soft`, `primary-text`, `accent`, `accent-soft`, `accent-text` |
| Trạng thái | `success`, `warning`, `danger`, `info`, mỗi màu có `-fg` (chữ trên nền đặc), `-soft` (nền nhạt), `-text` (chữ màu trên nền thường) |
| Khác | `ring` (focus), `overlay`, `chart-1` … `chart-8` |

Nguyên tắc dùng màu: [design/docs/README.md](../docs/README.md).
