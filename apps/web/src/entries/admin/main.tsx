import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '@/shared/AppProviders';
import { App } from './App';
import '@/shared/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
