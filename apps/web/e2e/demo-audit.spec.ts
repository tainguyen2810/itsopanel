import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { ADMIN_ROUTES } from '../src/entries/admin/routes';
import { PORTAL_ROUTES } from '../src/entries/portal/routes';
import { asPersona, data, expect, test, urlOf } from './demo';

// Prompt 2.8: mọi route của sitemap (Admin + Portal) ở chế độ demo:
// - axe 0 lỗi critical/serious (light và dark);
// - 390px không tràn ngang;
// - giao diện tiếng Anh không lẫn tiếng Việt, trừ dữ liệu: dataset demo và mọi nội dung API trả về
//   (log job, thông báo, lý do… do máy chủ sinh), cùng tên ngôn ngữ "Tiếng Việt" trong menu ngôn ngữ.
const SA = '01938a01-0001-7000-8000-000001000001';
const VI = /[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i;
const DATA = JSON.stringify(data).normalize('NFC');
const ENDONYMS = ['Tiếng Việt'];

/** Ghi lại nội dung mọi response /api/ của trang (dữ liệu máy chủ, không phải chuỗi giao diện). */
function recordApi(page: Page) {
  const bodies: string[] = [];
  page.on('response', (r) => {
    if (!r.url().includes('/api/')) return;
    r.text()
      .then((t) => bodies.push(t))
      .catch(() => undefined);
  });
  return bodies;
}

async function open(page: Page, realm: 'admin' | 'portal', url: string, lang: 'vi' | 'en') {
  await page.addInitScript((l) => localStorage.setItem('itso.lang', l), lang);
  if (realm === 'admin') await asPersona(page, 'admin', SA);
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Đoạn chữ hiển thị có dấu tiếng Việt mà không đến từ dữ liệu demo. */
async function vietnameseUi(page: Page, api: string[]): Promise<string[]> {
  const known = (DATA + decode(api.join('\n'))).normalize('NFC');
  const texts = await page.evaluate(() => {
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      const t = (n.textContent ?? '').trim();
      if (!el || !t || el.closest('script,style,[aria-hidden="true"]')) continue;
      if (el.getClientRects().length === 0) continue;
      out.push(t);
    }
    for (const el of document.querySelectorAll('[aria-label],[placeholder],[title]')) {
      for (const a of ['aria-label', 'placeholder', 'title'])
        if (el.getAttribute(a)) out.push(el.getAttribute(a) ?? '');
    }
    return out;
  });
  return [...new Set(texts)].filter(
    (t) => VI.test(t) && !ENDONYMS.includes(t) && !fromData(t, known),
  );
}

/** Bỏ escape \uXXXX của JSON để so khớp chữ có dấu. */
function decode(s: string) {
  return s.replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Chữ thuộc dữ liệu: cả đoạn, hoặc mọi cụm có dấu trong đoạn, đều xuất hiện trong dataset. */
function fromData(t: string, known: string): boolean {
  const s = t.normalize('NFC');
  if (known.includes(s)) return true;
  const words = s.split(/[\s,.:;!?()·"'“”/|—–-]+/).filter((w) => VI.test(w));
  return words.every((w) => known.includes(w));
}

for (const [realm, defs] of [
  ['admin', ADMIN_ROUTES],
  ['portal', PORTAL_ROUTES],
] as const) {
  test.describe(`kiểm tra tổng ${realm}`, () => {
    for (const def of defs.filter((d) => d.redirect === undefined)) {
      const url = urlOf(realm, def);
      test(`${url}`, async ({ page }) => {
        // EN, 390px, light: tràn ngang + chuỗi cứng tiếng Việt + axe.
        await page.setViewportSize({ width: 390, height: 844 });
        const api = recordApi(page);
        await open(page, realm, url, 'en');
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, 'tràn ngang ở 390px').toBeLessThanOrEqual(0);
        expect(await vietnameseUi(page, api), 'chuỗi tiếng Việt trong giao diện EN').toEqual([]);

        for (const theme of ['light', 'dark'] as const) {
          await page.evaluate((t) => localStorage.setItem('itso.theme', t), theme);
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.reload();
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await page.waitForLoadState('networkidle');
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
          const bad = results.violations
            .filter((v) => v.impact === 'critical' || v.impact === 'serious')
            .map(
              (v) =>
                `${v.id}: ${v.nodes
                  .map((n) => n.target.join(' '))
                  .slice(0, 3)
                  .join(' | ')}`,
            );
          expect(bad, `axe ${theme}`).toEqual([]);
        }
      });
    }
  });
}
