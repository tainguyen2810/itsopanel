import { Toaster as Sonner, toast } from 'sonner';
import { useTheme } from '@/shared/theme/ThemeProvider';

export { toast };

/** Vùng hiển thị toast (đặt 1 lần trong shell). Màu theo token qua classNames. */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={resolvedTheme}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: 'bg-surface! text-fg! border! border-border-strong! shadow-lg! font-sans!',
          description: 'text-muted!',
          success: '[&_[data-icon]]:text-success-text!',
          error: '[&_[data-icon]]:text-danger-text!',
          warning: '[&_[data-icon]]:text-warning-text!',
          info: '[&_[data-icon]]:text-info-text!',
          closeButton: 'bg-surface! border-border-strong! text-muted!',
        },
      }}
    />
  );
}
