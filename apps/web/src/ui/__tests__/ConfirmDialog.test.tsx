import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ConfirmDialog } from '@/ui';

function setup(onConfirm = vi.fn(), onOpenChange = vi.fn()) {
  renderWithProviders(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Xóa tài khoản hosting"
      confirmName="anphat"
      confirmLabel="Xóa"
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  it('là alertdialog có tiêu đề, nút xác nhận tắt khi chưa gõ tên', () => {
    setup();
    expect(screen.getByRole('alertdialog', { name: 'Xóa tài khoản hosting' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xóa' })).toBeDisabled();
  });

  it('gõ sai tên: vẫn tắt và báo chưa khớp; gõ đúng: bật và gọi onConfirm', async () => {
    const { onConfirm, onOpenChange } = setup();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'AnPhat' } });
    expect(screen.getByRole('button', { name: 'Xóa' })).toBeDisabled();
    expect(screen.getByText('Tên chưa khớp')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: ' anphat ' } });
    const btn = screen.getByRole('button', { name: 'Xóa' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('Enter trong ô nhập chỉ xác nhận khi tên khớp', async () => {
    const { onConfirm } = setup();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'sai' } });
    fireEvent.submit(input.closest('form')!);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'anphat' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('Hủy đóng hộp thoại mà không xác nhận', () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
