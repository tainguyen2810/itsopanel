import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader } from '@/ui/Card';

/** Thẻ trạng thái môi trường dev (từ Prompt 1.5), nay nằm trong app shell. */
export function StatusPanel({ children }: { children: ReactNode }) {
  const { t } = useTranslation('status');
  return (
    <Card className="max-w-xl">
      <CardHeader title={t('title')} />
      <CardContent>
        <ul className="divide-y divide-border">{children}</ul>
      </CardContent>
    </Card>
  );
}
