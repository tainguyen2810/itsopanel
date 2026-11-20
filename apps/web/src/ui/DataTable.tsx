import { useMemo, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { Checkbox } from './Checkbox';
import { EmptyState } from './Feedback';
import { Input } from './Input';
import { Pagination } from './Navigation';

export type { ColumnDef } from '@tanstack/react-table';

interface Props<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  /** Khóa ổn định của dòng (uuid). */
  getRowId: (row: T) => string;
  /** Nhãn cột "chính" hiển thị làm tiêu đề thẻ ở mobile. */
  primaryColumnId?: string;
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  filterable?: boolean;
  pageSize?: number;
  caption: string;
  toolbar?: ReactNode;
  empty?: ReactNode;
}

/**
 * Bảng dữ liệu: sắp xếp, lọc toàn cục, chọn dòng, phân trang phía client.
 * < 768px tự chuyển thành danh sách thẻ (mỗi dòng một thẻ, nhãn cột bên trái).
 */
export function DataTable<T>({
  data,
  columns,
  getRowId,
  primaryColumnId,
  selectable = false,
  onSelectionChange,
  filterable = true,
  pageSize = 10,
  caption,
  toolbar,
  empty,
}: Props<T>) {
  const { t } = useTranslation('common');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const allColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return columns;
    const select: ColumnDef<T, unknown> = {
      id: '__select',
      enableSorting: false,
      header: ({ table }) => (
        <Checkbox
          aria-label={t('table.selectAll')}
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected()
                ? 'indeterminate'
                : false
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(v === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={t('table.selectRow')}
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(v === true)}
        />
      ),
    };
    return [select, ...columns];
  }, [columns, selectable, t]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table trả hàm không memo được; component này không dùng React Compiler.
  const table = useReactTable({
    data,
    columns: allColumns,
    getRowId,
    state: { sorting, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(rowSelection) : updater;
      setRowSelection(next);
      onSelectionChange?.(Object.keys(next).filter((k) => next[k]));
    },
    enableRowSelection: selectable,
    sortDescFirst: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const rows = table.getRowModel().rows;
  const selectedCount = Object.values(rowSelection).filter(Boolean).length;
  const headerLabel = (id: string): string => {
    const h = table.getColumn(id)?.columnDef.header;
    return typeof h === 'string' ? h : id;
  };

  return (
    <div className="flex flex-col gap-3">
      {(filterable || toolbar !== undefined || selectedCount > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {filterable && (
            <div className="relative w-full sm:w-64">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
              />
              <Input
                value={globalFilter}
                onChange={(e) => {
                  setGlobalFilter(e.target.value);
                  table.setPageIndex(0);
                }}
                placeholder={t('table.filter')}
                aria-label={t('table.filter')}
                className="pl-8"
              />
            </div>
          )}
          {selectedCount > 0 && (
            <span className="text-sm text-muted" aria-live="polite">
              {t('table.selected', { count: selectedCount })}
            </span>
          )}
          <div className="ml-auto flex gap-2">{toolbar}</div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border">
          {empty ?? (
            <EmptyState
              icon={Search}
              title={globalFilter ? t('state.noResults') : t('state.empty')}
            />
          )}
        </div>
      ) : (
        <>
          {/* Bảng ≥ md */}
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
            <table className="w-full border-collapse text-base">
              <caption className="sr-only">{caption}</caption>
              <thead className="bg-surface-2 text-left text-sm text-muted">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => {
                      const sorted = h.column.getIsSorted();
                      return (
                        <th
                          key={h.id}
                          scope="col"
                          aria-sort={
                            sorted === 'asc'
                              ? 'ascending'
                              : sorted === 'desc'
                                ? 'descending'
                                : undefined
                          }
                          className={cn(
                            'px-3 py-2 font-medium whitespace-nowrap',
                            h.column.id === '__select' && 'w-10',
                          )}
                        >
                          {h.isPlaceholder ? null : h.column.getCanSort() ? (
                            <button
                              type="button"
                              onClick={h.column.getToggleSortingHandler()}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-xs hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              {flexRender(h.column.columnDef.header, h.getContext())}
                              {sorted === 'asc' ? (
                                <ArrowUp aria-hidden className="size-3.5" />
                              ) : sorted === 'desc' ? (
                                <ArrowDown aria-hidden className="size-3.5" />
                              ) : (
                                <ArrowUpDown aria-hidden className="size-3.5 opacity-50" />
                              )}
                            </button>
                          ) : (
                            flexRender(h.column.columnDef.header, h.getContext())
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    data-state={r.getIsSelected() ? 'selected' : undefined}
                    className="border-t border-border hover:bg-surface-hover data-[state=selected]:bg-primary-soft"
                  >
                    {r.getVisibleCells().map((c) => (
                      <td key={c.id} className="px-3 py-2.5 align-middle whitespace-nowrap">
                        {flexRender(c.column.columnDef.cell, c.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Thẻ < md */}
          <ul className="flex flex-col gap-2 md:hidden" aria-label={caption}>
            {rows.map((r) => {
              const cells = r.getVisibleCells();
              const select = cells.find((c) => c.column.id === '__select');
              const primary =
                cells.find((c) => c.column.id === primaryColumnId) ??
                cells.find((c) => c.column.id !== '__select');
              return (
                <li
                  key={r.id}
                  data-state={r.getIsSelected() ? 'selected' : undefined}
                  className="rounded-lg border border-border bg-surface p-3 data-[state=selected]:border-primary"
                >
                  <div className="mb-2 flex items-center gap-2 font-medium">
                    {select && flexRender(select.column.columnDef.cell, select.getContext())}
                    {primary && flexRender(primary.column.columnDef.cell, primary.getContext())}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {cells
                      .filter((c) => c !== select && c !== primary)
                      .map((c) => (
                        <div key={c.id} className="contents">
                          <dt className="text-muted">{headerLabel(c.column.id)}</dt>
                          <dd className="min-w-0 text-right">
                            {flexRender(c.column.columnDef.cell, c.getContext())}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {table.getPageCount() > 1 && (
        <Pagination
          className="self-end"
          page={table.getState().pagination.pageIndex + 1}
          pageCount={table.getPageCount()}
          onPageChange={(p) => table.setPageIndex(p - 1)}
        />
      )}
    </div>
  );
}
