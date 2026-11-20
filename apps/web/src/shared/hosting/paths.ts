/**
 * Đường dẫn trong File Manager: luôn TƯƠNG ĐỐI với home của account (RelPath trong contract).
 * `.` là thư mục gốc. Không cho thoát khỏi home bằng `..` hay đường dẫn tuyệt đối khác home.
 * Agent kiểm lại sau khi chuẩn hóa và theo symlink (lỗi `path_outside_home`); đây là lớp chặn sớm ở UI.
 */

// Ký tự điều khiển (NUL, xuống dòng, DEL…) không được có trong tên file.
// eslint-disable-next-line no-control-regex -- chủ đích: chặn ký tự điều khiển
const CONTROL = /[\x00-\x1f\x7f]/;

/** Tên file/thư mục hợp lệ cho một phần đường dẫn. */
export function isValidName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !CONTROL.test(name)
  );
}

/**
 * Chuẩn hóa đường dẫn người dùng nhập về RelPath. Nhận dạng tương đối (`sites/a`), tuyệt đối trong home
 * (`/home/anphat/sites/a` khi biết `home`) hoặc `~/sites/a`. Trả `null` nếu ra ngoài home hoặc không hợp lệ.
 */
export function normalizePath(input: string, home?: string): string | null {
  let p = input.trim();
  if (p === '' || CONTROL.test(p) || p.length > 4096) return p === '' ? '.' : null;
  if (p === '~') p = '.';
  else if (p.startsWith('~/')) p = p.slice(2);
  else if (p.startsWith('/')) {
    if (!home) return null;
    const h = home.replace(/\/+$/, '');
    if (p === h) p = '.';
    else if (p.startsWith(`${h}/`)) p = p.slice(h.length + 1);
    else return null;
  }
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length === 0 ? '.' : out.join('/');
}

export function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

export function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return p === '.' || i < 0 ? '.' : p.slice(0, i);
}

export function baseName(p: string): string {
  return p === '.' ? '.' : (p.split('/').at(-1) ?? p);
}

/** Các mốc breadcrumb: [['.', 'home'], ['sites', 'sites'], ['sites/a', 'a']]. */
export function crumbs(p: string, rootLabel: string): [string, string][] {
  const out: [string, string][] = [['.', rootLabel]];
  if (p === '.') return out;
  const segs = p.split('/');
  segs.forEach((s, i) => out.push([segs.slice(0, i + 1).join('/'), s]));
  return out;
}

/** `a` nằm trong (hoặc là) thư mục `dir`? Dùng để chặn chuyển thư mục vào chính nó. */
export function isInside(a: string, dir: string): boolean {
  return dir === '.' || a === dir || a.startsWith(`${dir}/`);
}

/** File văn bản mở được trong trình soạn thảo (theo đuôi file). */
export function isTextFile(name: string): boolean {
  return /\.(php|html?|css|js|mjs|ts|json|md|txt|env|ya?ml|xml|ini|conf|log|sh|py|sql|htaccess|svg)$|^\.(env|htaccess|bashrc|profile|gitignore)$/i.test(
    name,
  );
}

/** Quyền dạng 0755 → rwxr-xr-x. */
export function modeString(mode: string): string {
  const m = mode.slice(-3);
  return [...m]
    .map((d) => {
      const n = Number(d);
      return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
    })
    .join('');
}

export const MODE_RE = /^0?[0-7]{3}$/;
