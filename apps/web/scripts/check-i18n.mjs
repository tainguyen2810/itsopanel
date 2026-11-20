#!/usr/bin/env node
// Phát hiện key i18n thiếu/thừa giữa vi và en, giá trị rỗng, và biến {{x}} không khớp.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/shared/i18n/locales');
const LANGS = ['vi', 'en'];
const flat = (obj, p = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]],
  );
const vars = (s) =>
  [...String(s).matchAll(/\{\{\s*(\w+)/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

const problems = [];
const nsByLang = Object.fromEntries(
  LANGS.map((l) => [
    l,
    readdirSync(join(DIR, l))
      .filter((f) => f.endsWith('.json'))
      .sort(),
  ]),
);
const allNs = [...new Set(Object.values(nsByLang).flat())];
let keys = 0;
for (const ns of allNs) {
  const maps = {};
  for (const l of LANGS) {
    if (!nsByLang[l].includes(ns)) {
      problems.push(`${l}: thiếu namespace ${ns}`);
      maps[l] = new Map();
      continue;
    }
    maps[l] = new Map(flat(JSON.parse(readFileSync(join(DIR, l, ns), 'utf8'))));
  }
  const union = new Set(LANGS.flatMap((l) => [...maps[l].keys()]));
  for (const k of union) {
    keys++;
    for (const l of LANGS) {
      if (!maps[l].has(k)) problems.push(`${l}/${ns}: thiếu key "${k}"`);
      else if (typeof maps[l].get(k) !== 'string' || maps[l].get(k).trim() === '')
        problems.push(`${l}/${ns}: key "${k}" rỗng`);
    }
    const v = LANGS.filter((l) => maps[l].has(k)).map((l) => vars(maps[l].get(k)));
    if (new Set(v).size > 1)
      problems.push(`${ns}: key "${k}" có biến {{…}} khác nhau giữa các ngôn ngữ`);
  }
}
if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  console.error(`check-i18n: ${problems.length} vấn đề`);
  process.exit(1);
}
console.log(`check-i18n: OK — ${allNs.length} namespace, ${keys} key, 0 thiếu (vi = en)`);
