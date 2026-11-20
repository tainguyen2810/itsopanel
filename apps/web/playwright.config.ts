import { defineConfig, devices } from '@playwright/test';

// Kiểm thử trực quan Design System (Prompt 1.6). Chạy: pnpm e2e (luôn --trace off, trừ khi debug).
// Dùng dev server vì trang /design/ chỉ có ở dev. API được giả lập bằng page.route trong test.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'off',
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 2,
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js',
    url: 'http://127.0.0.1:5173/design/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
