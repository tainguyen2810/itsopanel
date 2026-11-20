import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { renderWithProviders } from '@/test/render';
import { Button, FormField, Input } from '@/ui';

const schema = z.object({
  name: z.string().min(1, 'form.required').min(3, 'form.minLength|3'),
  email: z.email('form.email'),
});
type V = z.infer<typeof schema>;

function Sample({ onValid }: { onValid: (v: V) => void }) {
  const { control, handleSubmit } = useForm<V>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '' },
  });
  return (
    <form noValidate onSubmit={handleSubmit(onValid)}>
      <FormField
        control={control}
        name="name"
        label="Tên máy chủ"
        description="Chữ thường và số"
        render={(f) => (
          <Input
            {...f}
            value={String(f.value ?? '')}
            onChange={(e) => f.onChange(e.target.value)}
          />
        )}
      />
      <FormField
        control={control}
        name="email"
        label="Email"
        render={(f) => (
          <Input
            {...f}
            value={String(f.value ?? '')}
            onChange={(e) => f.onChange(e.target.value)}
          />
        )}
      />
      <Button type="submit">Gửi</Button>
    </form>
  );
}

describe('FormField', () => {
  it('liên kết nhãn và mô tả với input', () => {
    renderWithProviders(<Sample onValid={vi.fn()} />);
    const input = screen.getByLabelText('Tên máy chủ');
    expect(input).toHaveAccessibleDescription('Chữ thường và số');
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('hiện lỗi zod đã dịch, đặt aria-invalid, không gọi submit', async () => {
    const onValid = vi.fn();
    renderWithProviders(<Sample onValid={onValid} />);
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByText('Bắt buộc nhập')).toBeInTheDocument();
    expect(screen.getByText('Email không hợp lệ')).toBeInTheDocument();
    expect(screen.getByLabelText('Tên máy chủ')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Tên máy chủ')).toHaveAccessibleDescription(/Bắt buộc nhập/);
    expect(onValid).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Tên máy chủ'), { target: { value: 'ab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByText('Tối thiểu 3 ký tự')).toBeInTheDocument();
  });

  it('gọi submit khi hợp lệ', async () => {
    const onValid = vi.fn();
    renderWithProviders(<Sample onValid={onValid} />);
    fireEvent.change(screen.getByLabelText('Tên máy chủ'), { target: { value: 'srv-hn-03' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@itso.local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() =>
      expect(onValid).toHaveBeenCalledWith(
        { name: 'srv-hn-03', email: 'ops@itso.local' },
        expect.anything(),
      ),
    );
  });
});
