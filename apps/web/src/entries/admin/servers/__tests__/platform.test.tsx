import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import data from '../../../../../../../contracts/examples/demo-dataset.json' with { type: 'json' };
import { renderWithProviders } from '@/test/render';
import { Platform } from '../ServerDetailPage';

type Server = Parameters<typeof Platform>[0]['s'];
const servers = data.servers as unknown as Server[];

// Prompt 4.5: Server detail hiện sự thật nền tảng agent báo (system.info).
describe('Server detail: thẻ Nền tảng', () => {
  it('quota kernel, cgroup v2, systemd, kiến trúc và chế độ agent', () => {
    renderWithProviders(<Platform s={servers[0] as Server} />);
    expect(screen.getByText('Kernel (chặn cứng)')).toBeInTheDocument();
    expect(screen.getByText('amd64')).toBeInTheDocument();
    expect(screen.getByText('Thật')).toBeInTheDocument();
  });

  it('quota mềm hiện cảnh báo; agent chưa báo → thông báo rõ', () => {
    renderWithProviders(<Platform s={servers[1] as Server} />);
    expect(screen.getByText('Mềm (đo và cảnh báo)')).toBeInTheDocument();
    renderWithProviders(<Platform s={servers[2] as Server} />);
    expect(screen.getByText('Agent chưa báo thông tin nền tảng.')).toBeInTheDocument();
  });

  it('tiếng Anh', () => {
    renderWithProviders(<Platform s={servers[0] as Server} />, { lang: 'en' });
    expect(screen.getByText('Kernel (hard limit)')).toBeInTheDocument();
  });
});
