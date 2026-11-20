import { useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import { createI18n } from '@/shared/i18n';
import { createQueryClient } from '@/shared/lib/query';
import { ThemeProvider, type Theme } from '@/shared/theme/ThemeProvider';
import { Toaster } from '@/ui/Toast';
import { TooltipProvider } from '@/ui/Tooltip';
import type { QueryClient } from '@tanstack/react-query';

interface Props {
  children: ReactNode;
  /** Cho test: truyền instance riêng. */
  i18n?: I18n;
  queryClient?: QueryClient;
  defaultTheme?: Theme;
}

/** Provider dùng chung cho mọi entry (admin, portal, design). */
export function AppProviders({ children, i18n, queryClient, defaultTheme }: Props) {
  const [i18nInstance] = useState(() => i18n ?? createI18n());
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18nInstance}>
        <ThemeProvider {...(defaultTheme ? { defaultTheme } : {})}>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}
