#!/usr/bin/env node
// Sinh CSS variables (Light/Dark) + "preset" Tailwind v4 (@theme inline) từ design/tokens/tokens.json.
// Tailwind 4 không còn preset JS: preset là khối @theme trong CSS, ánh xạ utility → biến token.
// Dùng: node design/tools/gen-tokens.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadTokens } from './tokens-lib.mjs';

const OUT = resolve(ROOT, 'apps/web/src/shared/styles/tokens.css');
const t = loadTokens();
const q = (f) => (/[\s-]/.test(f) && !f.includes('-apple') && f !== 'sans-serif' && f !== 'system-ui' && f !== 'monospace' && !f.startsWith('ui-') ? `"${f}"` : f);
const fontStack = (list) => list.map((f) => (f.includes(' ') ? `"${f}"` : q(f))).join(', ');

const themeVars = (th) => {
  const c = t.themes[th].color;
  const s = t.themes[th].shadow;
  return [
    ...Object.entries(c).map(([k, v]) => `  --itso-${k}: ${v};`),
    ...Object.entries(s).map(([k, v]) => `  --itso-shadow-${k}: ${v};`),
    `  color-scheme: ${th};`,
  ].join('\n');
};

const colorNames = Object.keys(t.themes.dark.color);
const lines = [
  '/* TỰ SINH từ design/tokens/tokens.json bởi design/tools/gen-tokens.mjs — KHÔNG SỬA TAY. */',
  '',
  '/* Theme sáng là mặc định; .dark trên <html> bật theme tối (ThemeProvider + public/theme-init.js). */',
  ':root {',
  themeVars('light'),
  '}',
  '',
  ':root.dark {',
  themeVars('dark'),
  '}',
  '',
  '@custom-variant dark (&:where(.dark, .dark *));',
  '',
  '/* Preset Tailwind: chỉ màu token, bỏ toàn bộ bảng màu mặc định (bg-red-500… không tồn tại). */',
  '@theme inline {',
  '  --color-*: initial;',
  '  --color-transparent: transparent;',
  '  --color-current: currentColor;',
  ...colorNames.map((k) => `  --color-${k}: var(--itso-${k});`),
  `  --font-sans: ${fontStack(t.font.sans)};`,
  `  --font-mono: ${fontStack(t.font.mono)};`,
  ...Object.entries(t.fontSize).flatMap(([k, [size, lh]]) => [`  --text-${k}: ${size};`, `  --text-${k}--line-height: ${lh};`]),
  ...Object.entries(t.fontWeight).map(([k, v]) => `  --font-weight-${k}: ${v};`),
  `  --spacing: ${t.spacing};`,
  '  --radius-*: initial;',
  ...Object.entries(t.radius).map(([k, v]) => `  --radius-${k}: ${v};`),
  '  --shadow-*: initial;',
  ...Object.keys(t.themes.dark.shadow).map((k) => `  --shadow-${k}: var(--itso-shadow-${k});`),
  '  --breakpoint-*: initial;',
  ...Object.entries(t.breakpoint).map(([k, v]) => `  --breakpoint-${k}: ${v};`),
  '}',
  '',
  '/* z-index theo lớp (dùng: z-(--z-modal)). */',
  ':root {',
  ...Object.entries(t.zIndex).map(([k, v]) => `  --z-${k}: ${v};`),
  '}',
  '',
];
const css = lines.join('\n');

if (process.argv.includes('--check')) {
  let cur = '';
  try {
    cur = readFileSync(OUT, 'utf8');
  } catch {
    /* chưa có */
  }
  if (cur !== css) {
    console.error(`✗ ${OUT.replace(ROOT + '/', '')} lệch với tokens.json — chạy: node design/tools/gen-tokens.mjs`);
    process.exit(1);
  }
  console.log('✓ tokens.css khớp tokens.json');
} else {
  writeFileSync(OUT, css);
  console.log(`✓ sinh ${OUT.replace(ROOT + '/', '')} (${colorNames.length} màu × 2 theme)`);
}
