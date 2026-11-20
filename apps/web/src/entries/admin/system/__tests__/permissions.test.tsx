import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import data from '../../../../../../../contracts/examples/demo-dataset.json' with { type: 'json' };
import { renderWithProviders } from '@/test/render';
import { changeRows } from '../AuditPage';
import { PERMISSIONS, allows, permissionMatrix } from '../permissions';
import { RoleMatrix } from '../RolesPage';

type Roles = Parameters<typeof RoleMatrix>[0]['roles'];
const roles = data.roles as Roles;

describe('allows: so khớp quyền', () => {
  it.each([
    [['*'], 'settings.write', true],
    [['websites.*'], 'websites.write', true],
    [['websites.*'], 'websitesx.read', false],
    [['backups.read'], 'backups.restore', false],
    // Không suy diễn write ⇒ read.
    [['servers.write'], 'servers.read', false],
    [[], 'own.read', false],
  ])('%j → %s = %s', (perms, key, ok) => {
    expect(allows(perms, key)).toBe(ok);
  });
});

describe('permissionMatrix với vai trò mẫu', () => {
  const m = permissionMatrix(roles);
  const cell = (perm: string, role: string) =>
    m.find((r) => r.perm === perm)?.cells.find((c) => c.role === role)?.allowed;

  it('đủ mọi quyền, mỗi hàng một ô cho từng vai trò', () => {
    expect(m.map((r) => r.perm)).toEqual(PERMISSIONS);
    expect(m.every((r) => r.cells.length === roles.length)).toBe(true);
  });
  it('SUPER_ADMIN có mọi quyền; ADMIN không quản người dùng/cài đặt; USER chỉ own.*', () => {
    expect(m.every((r) => cell(r.perm, 'SUPER_ADMIN'))).toBe(true);
    expect(cell('websites.write', 'ADMIN')).toBe(true);
    expect(cell('backups.read', 'ADMIN')).toBe(true);
    expect(cell('backups.restore', 'ADMIN')).toBe(false);
    expect(cell('users.write', 'ADMIN')).toBe(false);
    expect(cell('settings.read', 'ADMIN')).toBe(false);
    expect(m.filter((r) => cell(r.perm, 'USER')).map((r) => r.perm)).toEqual([
      'own.read',
      'own.write',
    ]);
  });
});

describe('RoleMatrix hiển thị', () => {
  it('cột theo vai trò, ô có/không đọc được bằng trình đọc màn hình, chỉ xem', () => {
    renderWithProviders(<RoleMatrix roles={roles} />);
    const table = screen.getByRole('table', { name: 'Ma trận quyền theo vai trò' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers.join('|')).toMatch(/Super Admin.*\|Admin.*\|Người dùng/);

    const row = within(table).getByRole('row', { name: /users\.write/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((c) => c.getAttribute('data-allowed'))).toEqual(['true', 'false', 'false']);
    expect(cells.map((c) => c.textContent)).toEqual(['Có', 'Không', 'Không']);

    const allowed = table.querySelectorAll('td[data-allowed="true"]').length;
    const expected = permissionMatrix(roles)
      .flatMap((r) => r.cells)
      .filter((c) => c.allowed);
    expect(allowed).toBe(expected.length);
    // Ma trận chỉ xem: không có ô nhập hay nút nào.
    expect(within(table).queryByRole('checkbox')).toBeNull();
    expect(within(table).queryByRole('button')).toBeNull();
  });
});

describe('changeRows (chi tiết nhật ký)', () => {
  it('cặp [cũ, mới] tách hai cột, giá trị đơn chỉ có cột mới', () => {
    expect(
      changeRows({ php_version: ['8.2', '8.3'], ssl: [null, true], note: 'x', tags: ['a'] }),
    ).toEqual([
      ['php_version', '8.2', '8.3'],
      ['ssl', '—', 'true'],
      ['note', '', 'x'],
      ['tags', '', '["a"]'],
    ]);
    expect(changeRows(null)).toEqual([]);
  });
});
