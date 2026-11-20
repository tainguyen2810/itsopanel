#!/usr/bin/env node
// Kiểm tương phản WCAG AA cho các cặp khai báo trong tokens.json (cả Light và Dark).
// text ≥ 4.5:1 (SC 1.4.3), ui ≥ 3:1 (SC 1.4.11). Màu có alpha bị từ chối trong cặp kiểm.
import { THEMES, contrast, loadTokens } from './tokens-lib.mjs';

const t = loadTokens();
const MIN = { text: 4.5, ui: 3 };
let fail = 0;
let total = 0;
for (const th of THEMES) {
  const c = t.themes[th].color;
  for (const kind of ['text', 'ui']) {
    for (const [fg, bg] of t.contrast[kind]) {
      total++;
      if (!(fg in c) || !(bg in c)) {
        console.error(`✗ ${th}: cặp ${fg}/${bg} tham chiếu màu không tồn tại`);
        fail++;
        continue;
      }
      if (c[fg].length !== 7 || c[bg].length !== 7) {
        console.error(`✗ ${th}: ${fg}/${bg} có alpha, không kiểm được`);
        fail++;
        continue;
      }
      const r = contrast(c[fg], c[bg]);
      const ok = r >= MIN[kind];
      if (!ok) fail++;
      if (!ok || process.argv.includes('-v')) {
        console.log(`${ok ? '✓' : '✗'} ${th.padEnd(5)} ${kind.padEnd(4)} ${`${fg}/${bg}`.padEnd(30)} ${r.toFixed(2)}:1 (cần ${MIN[kind]})`);
      }
    }
  }
}
if (fail) {
  console.error(`check-contrast: ${fail}/${total} cặp KHÔNG đạt WCAG AA`);
  process.exit(1);
}
console.log(`check-contrast: ${total}/${total} cặp đạt WCAG AA (light + dark)`);
