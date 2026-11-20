import { describe, expect, it } from 'vitest';
import {
  certDaysLeft,
  cronSchema,
  databaseSchema,
  gitRepoSchema,
  sftpSchema,
  splitLines,
  sshKeySchema,
  websiteSchema,
} from '../forms';

/** Lỗi đầu tiên theo từng trường (giống FormField chỉ hiện một lỗi). */
const errors = (r: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => {
  const out: Record<string, string> = {};
  for (const i of r.error?.issues ?? []) out[i.path.join('.')] ??= i.message;
  return out;
};

describe('websiteSchema', () => {
  const base = {
    hosting_account_uuid: 'a',
    primary_domain: 'Shop.AnPhat.vn ',
    type: 'php' as const,
    php_version: '8.3',
    document_root: 'public',
    ssl_mode: 'acme' as const,
    proxy_target: '',
  };
  it('chuẩn hóa domain về chữ thường', () => {
    const r = websiteSchema.safeParse(base);
    expect(r.success && r.data.primary_domain).toBe('shop.anphat.vn');
  });
  it.each([
    [{ document_root: '../etc' }, 'document_root', 'admin:sites.errors.relPath'],
    [{ document_root: '/var/www' }, 'document_root', 'admin:sites.errors.relPath'],
    [{ primary_domain: 'localhost' }, 'primary_domain', 'admin:sites.errors.domain'],
    [{ php_version: '' }, 'php_version', 'form.required'],
    [
      { type: 'proxy', proxy_target: 'http://10.0.0.5:80' },
      'proxy_target',
      'admin:sites.errors.proxy',
    ],
  ])('%o → lỗi %s', (patch, path, msg) => {
    expect(errors(websiteSchema.safeParse({ ...base, ...patch }))[path]).toBe(msg);
  });
  it('proxy chỉ tới 127.0.0.1 hợp lệ', () => {
    expect(
      websiteSchema.safeParse({ ...base, type: 'proxy', proxy_target: 'http://127.0.0.1:3000' })
        .success,
    ).toBe(true);
  });
});

describe('tên có tiền tố username', () => {
  it('database phải bắt đầu bằng "<username>_"', () => {
    const s = databaseSchema('anphat');
    const ok = {
      hosting_account_uuid: 'a',
      engine: 'mariadb',
      name: 'anphat_crm',
      create_user: true,
    };
    expect(s.safeParse(ok).success).toBe(true);
    expect(errors(s.safeParse({ ...ok, name: 'crm' })).name).toBe(
      'admin:sites.errors.prefix|anphat',
    );
    expect(errors(s.safeParse({ ...ok, name: 'Anphat_X' })).name).toBe('admin:sites.errors.dbName');
  });
  it('SFTP: tiền tố + thư mục gốc trong home', () => {
    const s = sftpSchema('anphat');
    const ok = {
      hosting_account_uuid: 'a',
      username: 'anphat_dev',
      protocol: 'sftp',
      root_path: 'sites',
      read_only: false,
    };
    expect(s.safeParse(ok).success).toBe(true);
    expect(errors(s.safeParse({ ...ok, root_path: '../lehoa' })).root_path).toBe(
      'admin:sites.errors.relPath',
    );
  });
});

describe('cron, SSH key, Git', () => {
  it('cron: biểu thức sai và lệnh nhiều dòng bị chặn', () => {
    const ok = {
      hosting_account_uuid: 'a',
      schedule: '*/15 * * * *',
      command: 'php artisan schedule:run',
      working_dir: '.',
      enabled: true,
    };
    expect(cronSchema.safeParse(ok).success).toBe(true);
    expect(errors(cronSchema.safeParse({ ...ok, schedule: '61 * * * *' })).schedule).toBe(
      'admin:sites.errors.cron',
    );
    expect(errors(cronSchema.safeParse({ ...ok, command: 'a\nrm -rf /' })).command).toBe(
      'admin:sites.errors.oneLine',
    );
  });
  it('SSH key: chỉ nhận khóa công khai OpenSSH', () => {
    const ok = {
      hosting_account_uuid: 'a',
      name: 'laptop',
      public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdef bao@laptop',
    };
    expect(sshKeySchema.safeParse(ok).success).toBe(true);
    expect(
      sshKeySchema.safeParse({ ...ok, public_key: '-----BEGIN OPENSSH PRIVATE KEY-----' }).success,
    ).toBe(false);
  });
  it('Git: URL repo, branch, đường dẫn dùng chung', () => {
    const ok = {
      website_uuid: 'w',
      repo_url: 'git@github.com:itso/web.git',
      branch: 'main',
      build_command: '',
      shared_paths: '.env\nstorage',
      auto_deploy: false,
      keep_releases: 5,
    };
    expect(gitRepoSchema.safeParse(ok).success).toBe(true);
    expect(errors(gitRepoSchema.safeParse({ ...ok, repo_url: 'ftp://x' })).repo_url).toBe(
      'admin:sites.errors.repoUrl',
    );
    expect(
      errors(gitRepoSchema.safeParse({ ...ok, shared_paths: '.env\n../../etc' })).shared_paths,
    ).toBe('admin:sites.errors.relPath');
    expect(errors(gitRepoSchema.safeParse({ ...ok, keep_releases: 30 })).keep_releases).toBe(
      'admin:packages.errors.max|20',
    );
    expect(splitLines(' .env \n\n storage ')).toEqual(['.env', 'storage']);
  });
});

it('certDaysLeft: số ngày còn lại (âm khi đã hết hạn)', () => {
  const now = Date.parse('2026-11-20T00:00:00+07:00');
  expect(certDaysLeft('2026-11-30T00:00:00+07:00', now)).toBe(10);
  expect(certDaysLeft('2026-11-18T00:00:00+07:00', now)).toBe(-2);
  expect(certDaysLeft(null, now)).toBeNull();
});
