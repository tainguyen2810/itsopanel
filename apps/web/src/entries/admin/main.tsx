import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { adminApi } from '@/api/admin';
import { realmMiddleware } from '@/api/realm-http';
import { DEMO, startDemoIfEnabled } from '@/shared/demoMode';
import { AppProviders } from '@/shared/AppProviders';
import { App } from './App';
import '@/shared/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root not found');

await startDemoIfEnabled();
// API thật: realm header, CSRF double-submit, 401 → đăng nhập lại (D-58).
if (!DEMO) adminApi.use(realmMiddleware('admin'));

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
