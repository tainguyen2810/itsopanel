#!/usr/bin/env node
// Sinh TypeScript types từ OpenAPI (contracts/openapi) → src/api/generated/<realm>/schema.ts.
// Chạy: node scripts/codegen.mjs [--check]   (hoặc `make codegen` / `make codegen-check` ở gốc repo)
// --check: không ghi file, báo lỗi nếu file sinh lệch với contracts.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const repo = resolve(web, '../..');
const check = process.argv.includes('--check');

const REALMS = [
  { name: 'admin', spec: 'contracts/openapi/itso-admin-v1.yaml' },
  { name: 'portal', spec: 'contracts/openapi/itso-portal-v1.yaml' },
];

const banner = (spec) =>
  `// SINH TỰ ĐỘNG từ ${spec} bằng openapi-typescript — KHÔNG sửa tay.\n` +
  `// Sửa contracts rồi chạy: make codegen\n\n`;

let drift = 0;
for (const r of REALMS) {
  const ast = await openapiTS(pathToFileURL(resolve(repo, r.spec)), {
    alphabetize: false,
    exportType: false,
    defaultNonNullable: true,
    silent: true,
  });
  const out = banner(r.spec) + astToString(ast);
  const file = resolve(web, `src/api/generated/${r.name}/schema.ts`);
  const rel = file.slice(repo.length + 1);
  if (check) {
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (cur !== out) {
      drift++;
      console.error(`✗ ${rel} lệch với ${r.spec} — chạy: make codegen`);
    } else console.log(`✓ ${rel} khớp ${r.spec}`);
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out);
    console.log(`✓ sinh ${rel}`);
  }
}
process.exit(drift ? 1 : 0);
