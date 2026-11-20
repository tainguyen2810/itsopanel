export type CsvCell = string | number | boolean | null | undefined;

/** Ký tự đầu ô khiến Excel/LibreOffice hiểu là công thức (CSV injection). */
const FORMULA = /^[=+\-@\t\r]/;

/** Một ô CSV theo RFC 4180: bọc nháy kép khi cần, nhân đôi nháy kép, chặn chèn công thức. */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Bảng → văn bản CSV (dòng kết thúc bằng \n, có dòng tiêu đề). */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Đọc CSV (dùng cho test và xem trước): hỗ trợ ô có nháy kép, dấu phẩy và xuống dòng. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

/** Tải văn bản về máy dưới dạng file (trình duyệt). */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  // BOM để Excel đọc đúng tiếng Việt UTF-8.
  const blob = new Blob(['\uFEFF', text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
