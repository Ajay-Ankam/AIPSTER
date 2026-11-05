/* Built with Meta Muse. Meta-qual lane: Overview qualification panel tests. */
/* Exercises the real public/app/app.js in a stub DOM (mirrors advisor-ui):
   three labeled lanes, fixture pill, request flow with CSRF, disabled and
   error states, escaping, and stale-generation fencing. Fixtures only. */
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';

const source = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');

function makeEl(tag, id) {
  const children = [];
  return {
    tag, id: id || null, children, dataset: {},
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    listeners: {}, attrs: {}, selects: [],
    addEventListener(k, v) { this.listeners[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll(sel) { return this.selects.filter((s) => s.sel === sel).flatMap((s) => s.els); },
    get firstChild() { return children.length ? children[0] : null; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
    appendChild(c) { children.push(c); return c; },
    focus() {},
  };
}

function harness(routes) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const selects = [];
  const calls = [];
  const fetcher = async (path, init) => {
    calls.push({ path, init: init || {} });
    const route = routes[typeof path === 'string' ? path.split('?')[0] : ''];
    return route ? route(calls.length, init || {}) : Response.json({ error: 'No route', code: 'UNKNOWN' }, { status: 404 });
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll(sel) { return selects.filter((s) => s.sel === sel).flatMap((s) => s.els); },
      createElement(tag) { return makeEl(tag, null); },
    },
    fetch: fetcher,
    crypto: { randomUUID: () => 'uuid-qual-01' },
    AbortController: globalThis.AbortController,
    setTimeout: () => 0,
    encodeURIComponent: globalThis.encodeURIComponent,
    console,
  });
  vm.runInContext(source, context);
  return { el, context, calls, registerSelect: (sel, els) => selects.push({ sel, els }) };
}

function inventory(items = [{ id: 'res1', name: 'Node 1' }]) {
  return { items, total: items.length, limit: 50, offset: 0 };
}

function qualUi(routes) {
  return harness({
    '/api/qualifications': () => Response.json(routes.report !== undefined ? routes.report : { recommendations: [], runs: [] }),
    '/api/inventory': () => Response.json(routes.inventory !== undefined ? routes.inventory : inventory()),
    ...(routes.extra || {}),
  });
}

const prof = (digest = 'd') => ({ node_id: 'res1', profile_digest: digest, profile_digest_live: `live-${digest}`, has_snapshot: true });

const cachedRow = (over = {}) => ({
  node_id: 'res1', profile_digest: 'd', catalog_version: 'qual-catalog-v1',
  prompt_version: 'qual-prompt-v1', mode: 'fixture',
  advice_json: JSON.stringify({
    summary: 'CPU smoke looks supportable.',
    suggestions: [{ label: 'completion-smoke-v1', detail: 'Run the fixed smoke.' }],
    rationale: '', unknowns: ['Throughput unknown until measured.'],
    benchmarkCatalogId: 'completion-smoke-v1',
  }),
  receipt_json: JSON.stringify({ opKey: 'k', mode: 'fixture', model: 'fixture', responseId: null, usage: null, spendUsdEst: 0, elapsedMs: 1, schemaVersion: 'qualification/v1', validation: 'pass', replay: true, deliveredAt: '2026-11-05T00:00:00.000Z', sourceSha: 'unknown' }),
  updated_at: '2026-11-05T00:00:00.000Z',
  ...over,
});

const rec = (over = {}) => ({
  node_id: 'res1', profile_digest: 'd', catalog_version: 'qual-catalog-v1',
  mode: 'fixture', state: 'delivered',
  advice_json: JSON.stringify({
    summary: 'CPU smoke looks supportable.',
    suggestions: [{ label: 'completion-smoke-v1', detail: 'Run the fixed smoke.' }],
    rationale: '', unknowns: ['Throughput unknown until measured.'],
    benchmarkCatalogId: 'completion-smoke-v1',
  }),
  receipt_json: JSON.stringify({ opKey: 'k', mode: 'fixture', model: 'fixture', responseId: null, usage: null, spendUsdEst: 0, elapsedMs: 1, schemaVersion: 'qualification/v1', validation: 'pass', replay: false, deliveredAt: '2026-11-05T00:00:00.000Z', sourceSha: 'unknown' }),
  created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z',
  ...over,
});

test('qual ui: three labeled lanes with empty states and request button', async () => {
  const ui = qualUi({
    report: { recommendations: [], runs: [], cached: [], profiles: [prof()] },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, fresh: true,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /Detected \(worker-reported inventory, not independently attested\)/);
  assert.match(html, /Advisory \(Meta recommendation\)/);
  assert.match(html, /Measured \(benchmark result\)/);
  assert.match(html, /Node 1/);
  assert.match(html, /linux \/ x86_64/);
  assert.match(html, /Advisory \(Meta recommendation\): none yet/);
  assert.match(html, /no benchmark has run for this node/);
  assert.match(html, /data-qual-request="res1"/);
});

test('qual ui: profile-only node shows its snapshot, never a false no-snapshot state', async () => {
  const ui = qualUi({
    report: { recommendations: [], runs: [], cached: [], profiles: [prof()] },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, fresh: true,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.ok(!html.includes('no capability snapshot yet'), `false no-snapshot state: ${html}`);
  assert.match(html, /not independently attested/);
});

test('qual ui: no snapshot means snapshot-first copy and no request button', async () => {
  const ui = qualUi({ report: { recommendations: [], runs: [], cached: [], profiles: [] } });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /no capability snapshot yet/);
  assert.ok(!html.includes('data-qual-request'), 'request needs a snapshot first');
});

test('qual ui: stale runs and snapshots are labeled, never current', async () => {
  const ui = qualUi({
    report: {
      recommendations: [rec({ profile_digest: 'new' })],
      runs: [{
        run_id: 'qrun_1', node_id: 'res1', profile_digest: 'old', catalog_version: 'qual-catalog-v1',
        catalog_id: 'completion-smoke-v1', state: 'succeeded',
        result_json: JSON.stringify({ runtimeId: 'llama-server', modelId: 'm', elapsedMs: 5 }),
        created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z',
      }],
      cached: [],
      profiles: [prof('cur')],
    },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 99999, fresh: false,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /not independently attested/);
  assert.match(html, /stale snapshot/);
  assert.match(html, /none for the current profile — it changed since the last assessment/);
  assert.match(html, /no benchmark for the current profile/);
  assert.match(html, /1 earlier run\(s\) kept for history under changed profiles/);
  assert.ok(!html.includes('32.0 tokens'), 'stale numbers must not render as current');
});

test('qual ui: recommendation renders advisory labels, run renders measured TPS', async () => {
  const ui = qualUi({
    report: {
      recommendations: [rec()],
      runs: [{
        run_id: 'qrun_1', node_id: 'res1', profile_digest: 'd', catalog_version: 'qual-catalog-v1',
        catalog_id: 'completion-smoke-v1', state: 'succeeded',
        result_json: JSON.stringify({ runtimeId: 'llama-server', modelId: 'm', elapsedMs: 1200, completionTokens: 32, nativeTimings: { promptN: 10, promptMs: 500, predictedN: 32, predictedMs: 1000 } }),
        created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z',
      }],
      cached: [],
      profiles: [prof()],
    },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, fresh: true,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /linux \/ x86_64/);
  assert.match(html, /fixture — not live evidence/);
  assert.match(html, /catalog:.*completion-smoke-v1/);
  assert.match(html, /32\.0 tokens\/s generation/);
  assert.match(html, /20\.0 tokens\/s prefill/);
  assert.match(html, /certifies no placement and no GPU/);
});

test('qual ui: pruned assessment still shows from the saved cache', async () => {
  const ui = qualUi({
    report: { recommendations: [], runs: [], cached: [cachedRow()], profiles: [prof()] },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, fresh: true,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /CPU smoke looks supportable/);
  assert.match(html, /From the saved cache/);
  assert.ok(!html.includes('none yet'), 'cache must not read as no recommendation');
});

test('qual ui: served identity and unknown placement render honestly', async () => {
  const ui = qualUi({
    report: {
      recommendations: [rec()],
      runs: [{
        run_id: 'qrun_1', node_id: 'res1', profile_digest: 'd', catalog_version: 'qual-catalog-v1',
        catalog_id: 'completion-smoke-v1', state: 'succeeded',
        result_json: JSON.stringify({ runtimeId: 'ganglion', modelId: 'qwen3', servedModelId: 'qwen3-up', placementProvenance: 'unknown', elapsedMs: 1200 }),
        created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z',
      }],
      cached: [],
      profiles: [prof()],
    },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, fresh: true,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /served as qwen3-up/);
  assert.match(html, /Placement: unknown/);
  assert.match(html, /certifies no placement and no GPU/);
  assert.ok(!html.includes('placement') || html.includes('Placement: unknown'), 'no CPU certificate anywhere');
});

test('qual ui: failed assessment offers an explicit retry', async () => {
  const ui = qualUi({
    report: {
      recommendations: [rec({ state: 'failed', advice_json: null })],
      runs: [], cached: [], profiles: [prof()],
    },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, fresh: true,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /retained, no automatic retry/);
  assert.match(html, /data-qual-request="res1"/);
  assert.match(html, /Retry assessment/);
});

test('qual ui: live deployment offers a live fetch over fixture advice', async () => {
  const ui = qualUi({
    report: { recommendations: [rec()], runs: [], cached: [], profiles: [prof()], live: true },
    extra: {
      '/api/resources/res1/capabilities': () => Response.json({
        nodeId: 'res1',
        snapshot: { schema_version: 1, os: 'linux', arch: 'x86_64', runtimes: [{ name: 'llama-server', mode: 'managed' }], mem: { ramTotalBytes: 8 * 1024 ** 3 }, disk: {}, workload: {} },
        reportedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, fresh: true,
      }),
    },
  });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.match(html, /fixture — not live evidence/);
  assert.match(html, /fetches a live recommendation/);
  assert.match(html, /data-qual-request="res1"/);
});

test('qual ui: disabled deployment shows the honest off state', async () => {
  const ui = harness({ '/api/qualifications': () => Response.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404 }) });
  await vm.runInContext('loadQualification()', ui.context);
  assert.match(ui.el('qual-body').innerHTML, /disabled on this deployment/);
});

test('qual ui: request posts fenced call with CSRF and fresh op key', async () => {
  const ui = qualUi({});
  await vm.runInContext('loadQualification()', ui.context);
  const btn = makeEl('button', null);
  btn.dataset.qualRequest = 'res1';
  ui.el('qual-body').selects.push({ sel: '[data-qual-request]', els: [btn] });
  await vm.runInContext('loadQualification()', ui.context);
  btn.listeners.click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const post = ui.calls.find((c) => c.init.method === 'POST');
  assert.ok(post, 'expected a POST after clicking Request assessment');
  assert.equal(post.path, '/api/resources/res1/qualification');
  assert.equal(post.init.headers['X-Aipster-CSRF'], '1');
  assert.deepEqual(JSON.parse(post.init.body), { opKey: 'uuid-qual-01' });
});

test('qual ui: untrusted advice renders escaped, never markup', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const ui = qualUi({ report: { recommendations: [rec({ advice_json: JSON.stringify({ summary: payload, suggestions: [], rationale: '', unknowns: [payload], benchmarkCatalogId: 'unsupported' }) })], runs: [], cached: [], profiles: [prof()] } });
  await vm.runInContext('loadQualification()', ui.context);
  const html = ui.el('qual-body').innerHTML;
  assert.ok(!html.includes('<img src=x'), html);
  const doc = parseFragment(html);
  const hasImg = (n) => (n.tagName === 'img') || (n.childNodes || []).some(hasImg);
  assert.ok(!hasImg(doc), `BUG: advice became markup: ${html}`);
});

test('qual ui: stale generation never renders', async () => {
  const ui = qualUi({});
  const pending = vm.runInContext('loadQualification()', ui.context);
  await vm.runInContext('generation++', ui.context);
  await pending;
  assert.match(ui.el('qual-body').innerHTML, /Loading/);
  assert.ok(!ui.el('qual-body').innerHTML.includes('Node 1'), 'stale response must never render');
});
