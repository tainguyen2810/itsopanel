import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from '../ThemeProvider';

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme('dark')}>dark</button>
      <button onClick={() => setTheme('light')}>light</button>
      <button onClick={() => setTheme('system')}>system</button>
    </div>
  );
}

function mockSystem(dark: boolean) {
  const listeners: (() => void)[] = [];
  const mq = {
    matches: dark,
    addEventListener: (_: string, cb: () => void) => listeners.push(cb),
    removeEventListener: vi.fn(),
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mq as unknown as MediaQueryList);
  return {
    set(v: boolean) {
      mq.matches = v;
      listeners.forEach((l) => l());
    },
  };
}

describe('ThemeProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mặc định theo hệ thống và cập nhật khi hệ thống đổi', () => {
    const sys = mockSystem(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    act(() => sys.set(false));
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('đặt theme: đổi lớp .dark và lưu vào localStorage', () => {
    mockSystem(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText('dark'));
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    fireEvent.click(screen.getByText('light'));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('đọc lựa chọn đã lưu khi khởi động', () => {
    mockSystem(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('storage bị chặn (ném lỗi) vẫn chạy bình thường', () => {
    mockSystem(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    fireEvent.click(screen.getByText('dark'));
    expect(document.documentElement).toHaveClass('dark');
  });

  it('bỏ qua giá trị rác trong storage', () => {
    mockSystem(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, '<script>');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });
});
