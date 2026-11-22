import { describe, expect, it } from 'vitest';
import { isOutdated, updateBody } from '@/shared/hosting/pages/WordPressDetailPage';
import { blockingFindings, lineDiff, type Validation } from '../docker/validation';
import { conflictWith, softwareActions } from '../servers/ServerSoftwarePage';

const finding = (rule: string, severity: 'error' | 'warning', overridable = true) => ({
  rule,
  severity,
  service: 'app',
  path: `services.app.${rule}`,
  message: rule,
  overridable,
});

describe('Compose: lỗi chặn và diff revision', () => {
  const v: Validation = {
    ok: false,
    findings: [
      finding('privileged', 'error'),
      finding('docker_socket', 'error', false),
      finding('missing_limits', 'warning'),
    ],
    rewrites: [],
    overrides: [],
    validated_yaml: null,
  };
  it('cảnh báo không chặn; override chỉ trừ rule được chọn', () => {
    expect(blockingFindings(v).map((f) => f.rule)).toEqual(['privileged', 'docker_socket']);
    expect(blockingFindings(v, ['privileged']).map((f) => f.rule)).toEqual(['docker_socket']);
  });
  it('lineDiff theo LCS: dòng giữ, thêm, bớt', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nx\nc\n');
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
    expect(lineDiff('a', 'a')).toEqual([{ kind: 'same', text: 'a' }]);
  });
});

describe('Software Manager', () => {
  const sw = (key: string, installed: string | null, conflicts: string[] = []) => ({
    key,
    installed_version: installed,
    conflicts,
  });
  it('hành động theo trạng thái', () => {
    expect(softwareActions({ state: 'available' })).toEqual(['install']);
    expect(softwareActions({ state: 'failed' })).toEqual(['install']);
    expect(softwareActions({ state: 'upgradable' })).toEqual(['upgrade', 'remove']);
    expect(softwareActions({ state: 'installed' })).toEqual(['remove']);
    expect(softwareActions({ state: 'installing' })).toEqual([]);
  });
  it('xung đột Redis ↔ Valkey chỉ khi bên kia đang cài', () => {
    const all = [sw('redis', '7.0.15', ['valkey']), sw('valkey', null, ['redis'])];
    type S = Parameters<typeof conflictWith>[0];
    expect(conflictWith(all[1] as unknown as S, all as unknown as S[])?.key).toBe('redis');
    const none = [sw('redis', null, ['valkey']), sw('valkey', null, ['redis'])];
    expect(conflictWith(none[1] as unknown as S, none as unknown as S[])).toBeUndefined();
  });
});

describe('WordPress Toolkit', () => {
  it('chọn thành phần → body cập nhật', () => {
    expect(updateBody(new Set(['core', 'plugin:wordpress-seo', 'theme:astra']))).toEqual({
      core: true,
      plugins: ['wordpress-seo'],
      themes: ['astra'],
    });
    expect(updateBody(new Set(['plugin:a']))).toEqual({ core: false, plugins: ['a'], themes: [] });
  });
  it('có bản mới khi latest khác version (null = không có trên wordpress.org)', () => {
    expect(isOutdated({ version: '1.0', latest_version: '1.1' })).toBe(true);
    expect(isOutdated({ version: '1.0', latest_version: '1.0' })).toBe(false);
    expect(isOutdated({ version: '1.0', latest_version: null })).toBe(false);
  });
});
