import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { DataTable, type ColumnDef } from '@/ui';

interface Row {
  name: string;
  cpu: number;
}
const rows: Row[] = [
  { name: 'srv-hn-01', cpu: 37 },
  { name: 'srv-hcm-01', cpu: 81 },
  { name: 'srv-hn-02', cpu: 12 },
];
const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: 'name', header: 'Tên' },
  { accessorKey: 'cpu', header: 'CPU' },
];

function tableRows() {
  const table = screen.getByRole('table');
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    );
}

describe('DataTable', () => {
  it('sắp xếp theo cột khi bấm tiêu đề, cập nhật aria-sort', () => {
    renderWithProviders(
      <DataTable caption="Máy chủ" data={rows} columns={columns} getRowId={(r) => r.name} />,
    );
    const cpuHeader = screen.getByRole('columnheader', { name: /CPU/ });
    fireEvent.click(within(cpuHeader).getByRole('button'));
    expect(cpuHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(tableRows().map((r) => r[1])).toEqual(['12', '37', '81']);
    fireEvent.click(within(cpuHeader).getByRole('button'));
    expect(cpuHeader).toHaveAttribute('aria-sort', 'descending');
    expect(tableRows().map((r) => r[1])).toEqual(['81', '37', '12']);
  });

  it('lọc toàn cục và hiện trạng thái không có kết quả', () => {
    renderWithProviders(
      <DataTable caption="Máy chủ" data={rows} columns={columns} getRowId={(r) => r.name} />,
    );
    const filter = screen.getByRole('textbox', { name: 'Lọc…' });
    fireEvent.change(filter, { target: { value: 'hcm' } });
    expect(tableRows()).toEqual([['srv-hcm-01', '81']]);
    fireEvent.change(filter, { target: { value: 'không-có' } });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Không có kết quả phù hợp')).toBeInTheDocument();
  });

  it('chọn dòng và chọn tất cả, báo id đã chọn', () => {
    const onSel = vi.fn();
    renderWithProviders(
      <DataTable
        caption="Máy chủ"
        data={rows}
        columns={columns}
        getRowId={(r) => r.name}
        selectable
        onSelectionChange={onSel}
      />,
    );
    const table = screen.getByRole('table');
    fireEvent.click(within(table).getAllByRole('checkbox', { name: 'Chọn dòng' })[0]!);
    expect(onSel).toHaveBeenLastCalledWith(['srv-hn-01']);
    expect(screen.getByText('Đã chọn 1 dòng')).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Chọn tất cả' }));
    expect(onSel).toHaveBeenLastCalledWith(['srv-hn-01', 'srv-hcm-01', 'srv-hn-02']);
  });

  it('có danh sách thẻ cho mobile với nhãn cột', () => {
    renderWithProviders(
      <DataTable
        caption="Máy chủ"
        data={rows}
        columns={columns}
        getRowId={(r) => r.name}
        primaryColumnId="name"
      />,
    );
    const list = screen.getByRole('list', { name: 'Máy chủ' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText('CPU')).toBeInTheDocument();
  });

  it('phân trang khi vượt pageSize', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `srv-${String(i).padStart(2, '0')}`,
      cpu: i,
    }));
    renderWithProviders(
      <DataTable
        caption="Máy chủ"
        data={many}
        columns={columns}
        getRowId={(r) => r.name}
        pageSize={5}
      />,
    );
    expect(tableRows()).toHaveLength(5);
    expect(screen.getByText('Trang 1 / 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    expect(screen.getByText('Trang 2 / 3')).toBeInTheDocument();
    expect(tableRows()[0]?.[0]).toBe('srv-05');
  });
});
