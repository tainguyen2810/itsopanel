import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/Tabs';
import { PageHeader } from './PageHeader';
import { useUrlState } from './useUrlState';

export interface DetailTab {
  value: string;
  label: string;
  content: ReactNode;
}

interface Props {
  title: ReactNode;
  crumb?: string;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  nav?: ReactNode;
  tabs: DetailTab[];
}

/** Trang chi tiết: PageHeader + Tabs đồng bộ với `?tab=` trên URL. */
export function DetailPage({ tabs, ...header }: Props) {
  const [url, setUrl] = useUrlState();
  const first = tabs[0]?.value ?? '';
  const current = tabs.some((t) => t.value === url.tab) ? (url.tab as string) : first;
  return (
    <>
      <PageHeader {...header} />
      <Tabs value={current} onValueChange={(v) => setUrl({ tab: v === first ? undefined : v })}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {tabs.map((t) => (
          <TabsContent key={t.value} value={t.value} className="mt-4">
            {t.content}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
