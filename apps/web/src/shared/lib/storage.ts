/** localStorage an toàn: trình duyệt chặn storage (private mode, iframe) thì trả null / bỏ qua. */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* bỏ qua: lựa chọn chỉ sống trong phiên */
  }
}
