import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/Button';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Input } from '@/ui/Input';
import { Select, type SelectOption } from '@/ui/Select';
import { PageHeader } from './PageHeader';
import { ErrorState, TableSkeleton } from './states';
import { useUrlState } from './useUrlState';

export interface ListFilter {
  /** Tên tham số trên URL và trong `filter[<key>]` của API. */
  key: string;
  label: string;
  options: SelectOption[];
}

export interface ListQuery {
  q?: string;
  filters: Record<string, string>;
}

interface Props<T> {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  queryKey: QueryKey;
  /** Gọi API danh sách với q và filter[...] (tham số contract). */
  fetch: (query: ListQuery) => Promise<T[]>;
  columns: ColumnDef<T, unknown>[];
  getRowId: (row: T) => string;
  primaryColumnId?: string;
  filters?: ListFilter[];
  search?: boolean;
  empty?: ReactNode;
  /** Nội dung phía trên bảng (thẻ thống kê…). */
  children?: ReactNode;
  /** Không render PageHeader (dùng trong tab của trang chi tiết). */
  embedded?: boolean;
}

const ALL = '__all';

/** Trang danh sách: PageHeader + tìm kiếm/bộ lọc lưu trên URL + DataTable + trạng thái tải/lỗi/rỗng. */
export function ListPage<T>({
  title,
  description,
  actions,
  queryKey,
  fetch,
  columns,
  getRowId,
  primaryColumnId,
  filters = [],
  search = true,
  empty,
  children,
  embedded = false,
}: Props<T>) {
  const { t } = useTranslation('common');
  const [url, setUrl] = useUrlState();
  const q = url.q ?? '';
  const active: Record<string, string> = {};
  for (const f of filters) {
    const v = url[f.key];
    if (v) active[f.key] = v;
  }
  // Ô tìm kiếm cập nhật URL sau 250 ms để không gọi API mỗi phím.
  const [draft, setDraft] = useState(q);
  const [seenQ, setSeenQ] = useState(q);
  if (seenQ !== q) {
    // URL đổi từ bên ngoài (back/forward, xóa bộ lọc): đồng bộ ô tìm kiếm.
    setSeenQ(q);
    setDraft(q);
  }
  useEffect(() => {
    if (draft === q) return;
    const h = setTimeout(() => setUrl({ q: draft }), 250);
    return () => clearTimeout(h);
  }, [draft, q, setUrl]);

  const query = useQuery({
    queryKey: [...queryKey, { q, ...active }],
    queryFn: () => fetch({ ...(q ? { q } : {}), filters: active }),
  });
  const filtered = q !== '' || Object.keys(active).length > 0;

  const toolbar = (
    <div className="flex w-full flex-wrap items-center gap-2">
      {search && (
        <div className="relative w-full sm:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('actions.search')}
            aria-label={t('actions.search')}
            className="pl-8"
          />
        </div>
      )}
      {filters.map((f) => (
        <Select
          key={f.key}
          aria-label={f.label}
          className="w-full sm:w-44"
          value={active[f.key] ?? ALL}
          onValueChange={(v) => setUrl({ [f.key]: v === ALL ? undefined : v })}
          options={[{ value: ALL, label: `${f.label}: ${t('table.all')}` }, ...f.options]}
        />
      ))}
      {filtered && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft('');
            setUrl(
              Object.fromEntries([['q', undefined], ...filters.map((f) => [f.key, undefined])]),
            );
          }}
        >
          <X aria-hidden />
          {t('actions.clearFilter')}
        </Button>
      )}
    </div>
  );

  return (
    <>
      {!embedded && <PageHeader title={title} description={description} actions={actions} />}
      {children}
      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <DataTable
          data={query.data}
          columns={columns}
          getRowId={getRowId}
          caption={title}
          filterable={false}
          toolbar={search || filters.length > 0 ? toolbar : undefined}
          {...(primaryColumnId ? { primaryColumnId } : {})}
          {...(empty !== undefined && !filtered ? { empty } : {})}
        />
      )}
    </>
  );
}
