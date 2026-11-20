/// <reference types="vitest/config" />
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { msw } from 'msw/vite';
import { defineConfig, type Plugin } from 'vite';

// Hai entry: /admin/ (Private Admin Panel) và /portal/ (User Hosting Portal).
// Dev: /api được proxy sang Laravel (php artisan serve, cổng 8000).
const API = process.env.ITSO_API_URL ?? 'http://127.0.0.1:8000';

// /admin → /admin/, /portal → /portal/, / → /admin/ (dev và preview).
// Router phía client: /admin/servers/… trả admin/index.html (như try_files của Nginx ở production).
function entryRouting(): Plugin {
  const map: Record<string, string> = {
    '/': '/admin/',
    '/admin': '/admin/',
    '/portal': '/portal/',
    '/design': '/design/',
  };
  const mw = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0] ?? '';
    const to = map[path];
    if (to !== undefined) {
      res.statusCode = 302;
      res.setHeader('Location', to);
      res.end();
      return;
    }
    const entry = /^\/(admin|portal)\/[^.]*$/.exec(path)?.[1];
    const html = (req.headers.accept ?? '').includes('text/html');
    if (entry && html && path !== `/${entry}/`) req.url = `/${entry}/index.html`;
    next();
  };
  return {
    name: 'itso-entry-routing',
    configureServer: (s) => void s.middlewares.use(mw),
    configurePreviewServer: (s) => void s.middlewares.use(mw),
  };
}

// Chế độ demo (`--mode demo`): API giả lập bằng MSW theo OpenAPI, không cần Laravel.
// Build thường không có MSW: import động trong main.tsx bị loại vì VITE_DEMO là hằng số lúc build.
export default defineConfig(({ mode }) => ({
  // Cache riêng: chạy song song với dev server thường (Playwright) không ghi đè deps của nhau.
  ...(mode === 'demo' ? { cacheDir: 'node_modules/.vite-demo' } : {}),
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify(mode === 'demo' ? '1' : '') },
  plugins: [
    react(),
    tailwindcss(),
    entryRouting(),
    ...(mode === 'demo' ? [msw({ mode: 'worker-only' })] : []),
  ],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '@contracts': resolve(import.meta.dirname, '../../contracts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    ...(mode === 'demo' ? {} : { proxy: { '/api': { target: API, changeOrigin: false } } }),
  },
  build: {
    // Bản demo gói kèm dữ liệu mẫu và MSW nên chunk demo lớn hơn bình thường.
    ...(mode === 'demo' ? { outDir: 'dist-demo', chunkSizeWarningLimit: 1500 } : {}),
    rollupOptions: {
      input: {
        admin: resolve(import.meta.dirname, 'admin/index.html'),
        portal: resolve(import.meta.dirname, 'portal/index.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
