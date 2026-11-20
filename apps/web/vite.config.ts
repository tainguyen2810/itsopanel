/// <reference types="vitest/config" />
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// Hai entry: /admin/ (Private Admin Panel) và /portal/ (User Hosting Portal).
// Dev: /api được proxy sang Laravel (php artisan serve, cổng 8000).
const API = process.env.ITSO_API_URL ?? 'http://127.0.0.1:8000';

// /admin → /admin/, /portal → /portal/, / → /admin/ (dev và preview).
function entryRedirects(): Plugin {
  const map: Record<string, string> = {
    '/': '/admin/',
    '/admin': '/admin/',
    '/portal': '/portal/',
    '/design': '/design/',
  };
  const mw = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const to = req.url === undefined ? undefined : map[req.url.split('?')[0] ?? ''];
    if (to === undefined) return next();
    res.statusCode = 302;
    res.setHeader('Location', to);
    res.end();
  };
  return {
    name: 'itso-entry-redirects',
    configureServer: (s) => void s.middlewares.use(mw),
    configurePreviewServer: (s) => void s.middlewares.use(mw),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), entryRedirects()],
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
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
  build: {
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
});
