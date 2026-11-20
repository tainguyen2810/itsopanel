// Tiện ích dùng chung cho gen-tokens và check-contrast.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TOKENS_PATH = resolve(ROOT, 'design/tokens/tokens.json');
export const THEMES = ['light', 'dark'];
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/;

export function loadTokens() {
  const t = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  const errors = [];
  for (const k of ['font', 'fontSize', 'fontWeight', 'spacing', 'radius', 'zIndex', 'breakpoint', 'themes', 'contrast']) {
    if (!(k in t)) errors.push(`thiếu khóa "${k}"`);
  }
  const keys = THEMES.map((th) => Object.keys(t.themes?.[th]?.color ?? {}).sort().join(','));
  if (keys[0] !== keys[1]) errors.push('light và dark phải có cùng danh sách màu');
  const shadowKeys = THEMES.map((th) => Object.keys(t.themes?.[th]?.shadow ?? {}).sort().join(','));
  if (shadowKeys[0] !== shadowKeys[1]) errors.push('light và dark phải có cùng danh sách shadow');
  for (const th of THEMES) {
    for (const [name, v] of Object.entries(t.themes?.[th]?.color ?? {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) errors.push(`${th}.${name}: tên màu không hợp lệ`);
      if (!HEX.test(v)) errors.push(`${th}.${name}: "${v}" phải là #rrggbb hoặc #rrggbbaa chữ thường`);
    }
  }
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    if (!(`chart-${n}` in (t.themes?.dark?.color ?? {}))) errors.push(`thiếu chart-${n}`);
  }
  for (const req of ['bg', 'surface', 'border', 'fg', 'muted', 'primary', 'success', 'warning', 'danger', 'info']) {
    if (!(req in (t.themes?.dark?.color ?? {}))) errors.push(`thiếu màu bắt buộc "${req}"`);
  }
  if (errors.length) {
    throw new Error('tokens.json không hợp lệ:\n  - ' + errors.join('\n  - '));
  }
  return t;
}

/** Độ chói tương đối WCAG 2.x. */
export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
