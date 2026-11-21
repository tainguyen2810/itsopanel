import { defineConfig, devices } from '@playwright/test';

// E2E trên stack thật (Prompt 3.6, 4.6): Laravel + PostgreSQL + Redis + itso-agent --sandbox + Vite (không MSW).
// Cần `make dev` đang chạy và DB đã seed DemoSeeder (xem docs/runbooks/phase-3-demo.md).
// Chạy: `make test-e2e-real`. Các test tạo dữ liệu với hậu tố ngẫu nhiên nên chạy lại được.
export default defineConfig({
  testDir: 'e2e-real',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.ITSO_E2E_BASE ?? 'http://127.0.0.1:5173',
    trace: 'off',
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
  },
});
