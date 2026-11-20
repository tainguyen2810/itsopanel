/** true khi chạy `pnpm dev:demo` / `build:demo` (API giả lập MSW). Hằng số lúc build. */
export const DEMO = import.meta.env.VITE_DEMO === '1';

/**
 * Bật API giả lập trước khi render (chỉ chế độ demo). Ở build thường nhánh này bị loại bỏ
 * hoàn toàn nên bundle không chứa MSW (kiểm bằng scripts/check-no-msw.sh).
 */
export async function startDemoIfEnabled(): Promise<void> {
  if (import.meta.env.VITE_DEMO === '1') {
    const { startDemo } = await import('@/demo/browser');
    await startDemo();
  }
}
