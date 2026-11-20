import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { readStorage, writeStorage } from '@/shared/lib/storage';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'itso.theme';

interface ThemeState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);
const QUERY = '(prefers-color-scheme: dark)';

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
    ? 'dark'
    : 'light';
}

function isTheme(v: string | null): v is Theme {
  return v === 'light' || v === 'dark' || v === 'system';
}

/** Theme light/dark/system. Lớp `.dark` trên <html> do public/theme-init.js đặt sẵn trước khi React chạy. */
export function ThemeProvider({
  children,
  defaultTheme = 'system',
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readStorage(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : defaultTheme;
  });
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? system : theme;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
  }, [resolvedTheme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    writeStorage(THEME_STORAGE_KEY, t);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme phải nằm trong <ThemeProvider>');
  return ctx;
}
