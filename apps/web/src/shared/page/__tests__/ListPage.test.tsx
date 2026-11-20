import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { RoutedApp } from '@/shared/routing/RoutedApp';
import { renderWithProviders } from '@/test/render';
import { ListPage, type ListQuery } from '../ListPage';

interface Row {
  uuid: string;
  name: string;
}
const ROWS: Row[] = [
  { uuid: '1', name: 'srv-hn-01' },
  { uuid: '2', name: 'srv-hcm-01' },
];
const fetchRows = vi.fn((q: ListQuery) =>
  Promise.resolve(ROWS.filter((r) => !q.q || r.name.includes(q.q))),
);

function TestList() {
  return (
    <ListPage<Row>
      title="Máy chủ"
      queryKey={['test', 'servers']}
      fetch={fetchRows}
      getRowId={(r) => r.uuid}
      columns={[{ accessorKey: 'name', header: 'Tên' }]}
      filters={[
        {
          key: 'status',
          label: 'Trạng thái',
          options: [
            { value: 'online', label: 'Trực tuyến' },
            { value: 'offline', label: 'Mất kết nối' },
          ],
        },
      ]}
    />
  );
}

function setup(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  renderWithProviders(
    <RoutedApp
      realm="admin"
      homeId="servers"
      fetchJob={() => Promise.reject(new Error('không dùng'))}
      defs={[{ id: 'servers', path: '/servers', nav: 'servers' }]}
      pages={{ servers: () => Promise.resolve({ default: TestList }) }}
      history={history}
    />,
  );
  return history;
}

describe('ListPage', () => {
  it('đọc q và bộ lọc từ URL, gửi theo tham số contract', async () => {
    fetchRows.mockClear();
    setup('/admin/servers?q=hn&status=online');
    expect(await screen.findAllByText('srv-hn-01')).not.toHaveLength(0);
    expect(screen.queryByText('srv-hcm-01')).toBeNull();
    expect(fetchRows).toHaveBeenLastCalledWith({ q: 'hn', filters: { status: 'online' } });
    expect(screen.getByRole('searchbox', { name: 'Tìm kiếm' })).toHaveValue('hn');
  });

  it('gõ tìm kiếm cập nhật URL; xóa bộ lọc làm sạch URL', async () => {
    const history = setup('/admin/servers?status=offline');
    const box = await screen.findByRole('searchbox', { name: 'Tìm kiếm' });
    fireEvent.change(box, { target: { value: 'hcm' } });
    await waitFor(() => expect(history.location.search).toContain('q=hcm'));
    expect(history.location.search).toContain('status=offline');
    await waitFor(() => expect(screen.queryByText('srv-hn-01')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Xóa bộ lọc' }));
    await waitFor(() => expect(history.location.search).toBe(''));
  });
});
