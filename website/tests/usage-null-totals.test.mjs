/* Null usage totals stay unknown, never null or zero.
 * Exact-client probe: loads the checked-in public/app/app.js in a stub DOM
 * (same pattern as ui-heartbeat.test.mjs) and asserts loadUsage + the
 * loadOverview usage tile hatch absent totals instead of rendering literal
 * "null" or a zero-filled token sum (null + null === 0 in JS). */
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app', 'app.js');

async function loadClient(router) {
  const source = await readFile(APP_JS, 'utf8');
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: false, textContent: '', innerHTML: '', value: '', attrs: {}, listeners: {}, dataset: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: el, querySelectorAll() { return []; } },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search: '', assign() {} },
    fetch: router,
    setTimeout() { return 0; }, console, URLSearchParams,
    history: { replaceState() {} },
  });
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  await new Promise(setImmediate);
  assert.equal(typeof context.loadUsage, 'function', 'client exposes loadUsage');
  assert.equal(typeof context.loadOverview, 'function', 'client exposes loadOverview');
  return { context, el };
}

const nullTotals = (limit) => ({
  items: [], total: 0, limit, offset: 0,
  totals: { requests: null, tokensIn: null, tokensOut: null, modelCostUsd: null, executionCostUsd: null },
});
const emptyStatus = () => ({
  schema: 'aipster.status/1', generatedAt: new Date().toISOString(), demo: false,
  source: 'declared-resources', telemetry: 'unavailable',
  summary: { total: 0, online: 0, stale: 0, offline: 0, unknown: 0 },
  total: 0, itemsTruncated: false, sharedWithMe: 0, items: [],
});

test('loadUsage hatches null request/token totals instead of rendering null', async () => {
  const router = async (p) => {
    if (String(p).startsWith('/api/usage')) return Response.json(nullTotals(50));
    return Response.json({ items: [], total: 0 });
  };
  const { context, el } = await loadClient(router);
  await context.loadUsage();
  const html = el('usage-totals').innerHTML;
  assert.ok(!html.includes('>null<') && !html.includes('null requests'), `literal null leaked: ${html}`);
  assert.ok(html.includes('hatch') && html.includes('unknown'), `expected hatched unknown: ${html}`);
  assert.ok(!html.includes('$0'), 'no zero-filled costs');
});

test('loadOverview hatches null usage totals and the tile reads unknown', async () => {
  const router = async (p) => {
    p = String(p);
    if (p === '/api/status') return Response.json(emptyStatus());
    if (p === '/api/usage?limit=1') return Response.json(nullTotals(1));
    if (p === '/api/usage?limit=50') return Response.json(nullTotals(50));
    if (p === '/api/inventory?limit=50') return Response.json({ items: [], total: 0 });
    if (p === '/api/shared-with-me?limit=50') return Response.json({ items: [], total: 0 });
    if (p === '/api/catalog/summary') return Response.json({ privateAssets: 0, activeDeployments: 0 });
    return Response.json({ items: [], total: 0 });
  };
  const { context, el } = await loadClient(router);
  await context.loadOverview();
  await new Promise((r) => setTimeout(r, 20));
  const kpis = el('ov-kpis').innerHTML;
  const cards = el('ov-cards').innerHTML;
  assert.ok(!kpis.includes('>null<'), `KPI strip leaked null: ${kpis}`);
  assert.ok(kpis.includes('hatch'), `KPI strip should hatch null totals: ${kpis}`);
  assert.ok(!cards.includes('null requests'), `tile leaked null: ${cards}`);
  assert.ok(cards.includes('unknown requests') && cards.includes('unknown tokens'), `tile should read unknown: ${cards}`);
  assert.ok(!cards.includes('0 tokens') || cards.includes('unknown tokens'), 'unmeasured tokens never read as zero');
});
