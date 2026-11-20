import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, toCsv } from '../csv';

describe('CSV xuất nhật ký', () => {
  it('ô theo RFC 4180', () => {
    expect(csvCell('abc')).toBe('abc');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('2 dòng\nthứ hai')).toBe('"2 dòng\nthứ hai"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(false)).toBe('false');
  });
  it('chặn chèn công thức (CSV injection) nhưng giữ số âm', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell(-5)).toBe('-5');
  });
  it('toCsv → parseCsv khứ hồi, có tiêu đề và tiếng Việt', () => {
    const header = ['at', 'actor', 'action', 'result'];
    const rows = [
      ['2026-11-20T08:00:00+07:00', 'Trần Minh', 'website.update', 'success'],
      ['2026-11-20T09:00:00+07:00', 'Lê "Hòa", kế toán', 'auth.login\nretry', 'failure'],
    ];
    const text = toCsv(header, rows);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')[0]).toBe('at,actor,action,result');
    expect(parseCsv(text)).toEqual([header, ...rows]);
  });
  it('parseCsv chấp nhận CRLF và dòng cuối không xuống dòng', () => {
    expect(parseCsv('a,b\r\n1,"x,y"')).toEqual([
      ['a', 'b'],
      ['1', 'x,y'],
    ]);
  });
});
