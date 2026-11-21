import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { JobView, type Job } from '../JobDrawer';

const job = (over: Partial<Job>): Job =>
  ({
    uuid: 'j1',
    type: 'website.update',
    state: 'failed',
    progress: 50,
    resource: { type: 'website', uuid: 'w1' },
    steps: [
      { seq: 1, op: 'nginx.vhost.apply', state: 'failed', started_at: null, finished_at: null },
    ],
    attempts: 1,
    max_attempts: 1,
    timeout_sec: 120,
    error: {
      code: 'config_test_failed',
      message: 'nginx: [emerg] unknown directive "gzipp" in /etc/nginx/sites-enabled/x.conf:12',
      step: 1,
    },
    server: null,
    requested_by: null,
    created_at: '2026-11-21T08:00:00+07:00',
    started_at: null,
    finished_at: null,
    links: { self: '/j1', events: '/j1/events' },
    ...over,
  }) as Job;

describe('JobView', () => {
  it('nginx -t lỗi: giải thích đã hoàn tác và hiện dòng lỗi kỹ thuật', () => {
    renderWithProviders(<JobView job={job({})} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Cấu hình mới không qua kiểm tra (nginx -t / php-fpm -t)');
    expect(alert).toHaveTextContent('Panel đã hoàn tác về cấu hình cũ');
    expect(screen.getByTestId('job-error-message')).toHaveTextContent('unknown directive "gzipp"');
  });

  it('mã lạ: tiêu đề chung, vẫn có thông báo gốc', () => {
    renderWithProviders(
      <JobView job={job({ error: { code: 'replay_rejected', message: 'nonce cũ', step: 1 } })} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tác vụ thất bại');
    expect(screen.getByTestId('job-error-message')).toHaveTextContent('replay_rejected: nonce cũ');
  });

  it('job thành công: không có cảnh báo lỗi', () => {
    renderWithProviders(<JobView job={job({ state: 'succeeded', error: null })} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
