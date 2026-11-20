import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';

/** Khung trang không có shell (đăng nhập, MFA, cài đặt lần đầu): logo, thẻ giữa màn hình, đổi ngôn ngữ. */
export function AuthLayout({
  title,
  description,
  area,
  wide = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  area: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation('shell');
  const lang = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  return (
    <div className="flex min-h-dvh flex-col items-center bg-bg px-4 py-10 text-fg">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-md bg-primary text-primary-fg">
          <ShieldCheck aria-hidden className="size-5" />
        </span>
        <span className="leading-tight">
          <span className="block font-semibold">{t('brand')}</span>
          <span className="block text-xs text-muted">{area}</span>
        </span>
      </div>
      <main id="main" className={wide ? 'w-full max-w-3xl' : 'w-full max-w-md'}>
        <Card className="p-6 sm:p-8">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description !== undefined && <p className="mt-1 text-base text-muted">{description}</p>}
          <div className="mt-6">{children}</div>
        </Card>
      </main>
      <Button
        variant="ghost"
        size="sm"
        className="mt-6"
        onClick={() => void i18n.changeLanguage(lang === 'vi' ? 'en' : 'vi')}
      >
        {lang === 'vi' ? 'English' : 'Tiếng Việt'}
      </Button>
    </div>
  );
}
