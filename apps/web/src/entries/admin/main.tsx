import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/shared/lib/query';
import { App } from './App';
import '@/shared/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
