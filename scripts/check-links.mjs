#!/usr/bin/env node
// Kiểm tra link nội bộ (tương đối) trong tài liệu Markdown, chạy offline.
// Bỏ qua link http(s), mailto và anchor thuần (#...). Kiểm tra file đích tồn tại.
// Dùng: node scripts/check-links.mjs [thư mục gốc]
import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = resolve(process.argv[2] ?? ".");
// .dev/.cache/build: dữ liệu chạy (sandbox agent có thể chứa symlink hỏng từ fixture import), không phải tài liệu.
const IGNORE_DIRS = new Set(["node_modules", ".git", "vendor", "dist", ".dev", ".cache", "build"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = lstatSync(p); // không theo symlink
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".md")) yield p;
  }
}

const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let checked = 0;
const broken = [];

for (const file of walk(root)) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(linkRe)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const pathPart = decodeURIComponent(target.split("#")[0]);
    if (!pathPart) continue;
    checked++;
    const abs = resolve(dirname(file), pathPart);
    if (!existsSync(abs)) broken.push(`${relative(root, file)} → ${target}`);
  }
}

if (broken.length) {
  console.error(`THẤT BẠI: ${broken.length}/${checked} link nội bộ hỏng:`);
  for (const b of broken) console.error("  " + b);
  process.exit(1);
}
console.log(`OK: ${checked} link nội bộ hợp lệ.`);
