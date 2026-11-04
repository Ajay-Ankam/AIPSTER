// Captures every prototype page at 1440, 1024, 768 and 390 widths in light and
// dark, writes WebP screenshots and prints an overflow report per capture.
// Usage: node capture.mjs <direction-dir> [page.html ...]
// Needs Playwright (PLAYWRIGHT_MODULE overrides the import specifier, e.g. a
// global install path) and cwebp; CHROMIUM_PATH selects a Chromium build.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const here = dirname(fileURLToPath(import.meta.url));
const [direction, ...pages] = process.argv.slice(2);
if (!direction) throw new Error('usage: node capture.mjs <direction-dir> [page.html ...]');
const list = pages.length ? pages : ['index.html', 'app.html'];
const sizes = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const out = join(here, 'screenshots');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const report = [];
for (const page of list) {
  const name = page.replace(/\.html$/, '') === 'index' ? 'landing' : page.replace(/\.html$/, '');
  for (const scheme of ['light', 'dark']) {
    for (const [width, height] of sizes) {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce', deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      await p.goto(pathToFileURL(resolve(here, direction, page)).href, { waitUntil: 'load' });
      await p.waitForTimeout(300);
      const overflow = await p.evaluate(() => {
        const doc = document.documentElement;
        const wide = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > doc.clientWidth + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed') {
            const scroller = el.closest('[data-scroll-x]');
            if (!scroller) wide.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')));
          }
        }
        return { docOverflow: doc.scrollWidth - doc.clientWidth, offenders: [...new Set(wide)].slice(0, 6) };
      });
      const tmp = join(out, `.${direction}-${name}-${width}-${scheme}.png`);
      const file = join(out, `${direction}-${name}-${width}-${scheme}.webp`);
      await p.screenshot({ path: tmp, fullPage: true });
      execFileSync('cwebp', ['-quiet', '-q', '72', tmp, '-o', file]);
      rmSync(tmp);
      report.push({ file: file.slice(here.length + 1), ...overflow });
      await ctx.close();
    }
  }
}
await browser.close();
for (const r of report) console.log(`${r.docOverflow > 0 || r.offenders.length ? 'OVERFLOW' : 'ok      '} ${r.file} docOverflow=${r.docOverflow}${r.offenders.length ? ' offenders=' + r.offenders.join(',') : ''}`);
