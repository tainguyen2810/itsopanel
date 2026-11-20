import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { useUrlState } from '@/shared/page/useUrlState';
import { AppLink } from '@/ui/AppLink';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { EmptyState } from '@/ui/Feedback';
import { Input } from '@/ui/Input';
import { createSearch } from '../search';

/** Trang tìm kiếm đầy đủ (/search?q=…): cùng nguồn với Ctrl+K. */
export default function SearchPage() {
  const { t } = useTranslation('admin');
  const [url, setUrl] = useUrlState();
  const q = url.q ?? '';
  const [draft, setDraft] = useState(q);
  useEffect(() => {
    const h = setTimeout(() => {
      if (draft !== q) setUrl({ q: draft });
    }, 250);
    return () => clearTimeout(h);
  }, [draft, q, setUrl]);
  const search = useMemo(() => createSearch(t), [t]);
  const res = useQuery({
    queryKey: ['admin', 'search', q],
    queryFn: () => search(q),
    enabled: q.trim().length >= 2,
  });
  const groups = (res.data ?? []).filter((g) => g.hits.length > 0);
  return (
    <>
      <PageHeader title={t('search.title')} description={t('search.description')} />
      <div className="relative mb-4 max-w-xl">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
        />
        <Input
          type="search"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.title')}
          className="h-11 pl-9 text-md"
        />
      </div>
      {q.trim().length < 2 ? (
        <EmptyState icon={Search} title={t('search.typeMore')} />
      ) : res.isPending ? (
        <TableSkeleton rows={4} />
      ) : res.isError ? (
        <ErrorState error={res.error} onRetry={() => void res.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState icon={Search} title={t('search.noResults', { q })} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <Card key={g.key}>
              <CardHeader title={`${g.label} (${g.hits.length})`} />
              <CardContent>
                <ul className="flex flex-col divide-y divide-border">
                  {g.hits.map((h) => (
                    <li key={h.id} className="py-2">
                      <AppLink
                        href={h.href}
                        className="font-medium text-primary-text hover:underline"
                      >
                        {h.label}
                      </AppLink>
                      {h.sub && <p className="text-sm text-muted">{h.sub}</p>}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
