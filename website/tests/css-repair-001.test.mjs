// CSS-REPAIR-001 regression test: PR88 findings 1-3 (static CSS contract).
// Runs with plain node:test (no dependencies): `node --test website/tests/css-repair-001.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'public');
const appCss = await readFile(resolve(root, 'app', 'styles.css'), 'utf8');
const landingCss = await readFile(resolve(root, 'styles.css'), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('dark theme defines no self-referencing custom property (PR88 finding 3)', () => {
  for (const [name, css] of [['app/styles.css', appCss], ['styles.css', landingCss]]) {
    const selfRef = [...strip(css).matchAll(/(--[\w-]+)\s*:\s*var\(\s*\1\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(selfRef, [], `${name} must not define a token as itself (invalid at computed-value time)`);
  }
});

test('dark theme gives --accent-soft and --warn-line concrete values (PR88 finding 3)', () => {
  const dark = strip(appCss).match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*{([\s\S]*?)}\s*}/);
  assert.ok(dark, 'dark-theme block must exist in app/styles.css');
  for (const token of ['--accent-soft', '--warn-line']) {
    const def = dark[1].match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
    assert.ok(def, `${token} must be defined in the dark-theme block`);
    assert.match(def[1].trim(), /^#[0-9a-f]{3,8}$/i, `${token} must resolve to a concrete color, got: ${def[1].trim()}`);
  }
});

test('topology stacks to one column inside the sidebar layout at 1024px (PR88 finding 1)', () => {
  const css = strip(appCss);
  // Fixed columns (px) + minmax minimum (px) from .topo-map grid-template-columns.
  const grid = css.match(/\.topo-map\s*{[^}]*grid-template-columns\s*:\s*([^;]+);/);
  assert.ok(grid, '.topo-map grid must exist');
  const fixed = [...grid[1].matchAll(/(\d+)px/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const min = grid[1].match(/minmax\(\s*(\d+)px/);
  assert.ok(min, '.topo-map must keep a minmax minimum for the node column');
  const needed = fixed + Number(min[1]);
  // Fit boundary: panel content at 1024px is viewport - 352px (48 main pad +
  // 208 sidebar + 48 column gap + 48 card pad). The grid must provably NOT fit,
  // so the stacking rule below is required rather than decorative.
  const available = 1024 - 352;
  assert.ok(needed > available, `topo minimum (${needed}px) must exceed the ${available}px available at 1024px`);
  // A stacking rule must cover 1024px while the sidebar rail is active (>=960px).
  const stacked = [...css.matchAll(/@media[^{]*max-width\s*:\s*([\d.]+)px[^{]*{([\s\S]*?)(?=@media|$)/g)]
    .filter((m) => /#view-app[^{]*\.topo-map\s*{[^}]*grid-template-columns\s*:\s*1fr/.test(m[2])
      || (/\.topo-map\s*{[^}]*grid-template-columns\s*:\s*1fr/.test(m[2]) && Number(m[1]) >= 1024));
  assert.ok(stacked.length > 0, 'a one-column .topo-map rule must cover 1024px');
  const width = Math.max(...stacked.map((m) => Number(m[1])));
  assert.ok(width >= 1024 && width < 1440, `stacking breakpoint must cover 1024 but preserve the 1440 reference layout (got ${width}px)`);
});

test('landing header stacks at 768px (PR88 finding 2)', () => {
  const css = strip(landingCss);
  const stacked = [...css.matchAll(/@media[^{]*max-width\s*:\s*([\d.]+)px[^{]*{([\s\S]*?)(?=@media|$)/g)]
    .filter((m) => /\.app-topbar\s*{[^}]*flex-direction\s*:\s*column/.test(m[2]));
  assert.ok(stacked.length > 0, '.app-topbar must stack to a column under a breakpoint');
  const width = Math.max(...stacked.map((m) => Number(m[1])));
  assert.ok(width >= 768, `header stacking breakpoint must cover 768px (got ${width}px)`);
  // The split must preserve the old <=760px rendering: the 760 block keeps its
  // non-header rules, so only the header trigger widened.
  const small = [...css.matchAll(/@media[^{]*max-width\s*:\s*([\d.]+)px[^{]*{([\s\S]*?)(?=@media|$)/g)]
    .filter((m) => Number(m[1]) === 760);
  assert.ok(small.length > 0, 'the 760px block must still exist');
  for (const selector of ['.wrap', '.sponsors-line', '.app-card']) {
    assert.ok(small.some((m) => m[2].includes(selector)),
      `the 760px block must still contain ${selector} (pre-existing mobile rendering preserved)`);
  }
});
