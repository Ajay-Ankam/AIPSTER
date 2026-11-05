/* Built with Meta Muse. */
// DGM activity UI tests: the read-only section renders existing receipts
// honestly over the real admin shell — objective, source-labeled metrics,
// blockers, and budget facts — with escaped untrusted strings and GET-only
// traffic (no mutations, no new endpoints).
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';

const source = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');

function makeEl(tag, id) {
  const children = [];
  return {
    tag, id: id || null, children,
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    listeners: {}, attrs: {},
    addEventListener(k, v) { this.listeners[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    get firstChild() { return children.length ? children[0] : null; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
    appendChild(c) { children.push(c); return c; }
  };
}

function harness(routes, { hostname = null } = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const calls = [];
  const fetcher = async (path, init) => {
    calls.push({ path, init: init || {} });
    const route = routes[path];
    if (route) return route(calls.length);
    return Response.json({ error: 'No route', code: 'UNKNOWN' }, { status: 404 });
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll() { return []; },
      createElement(tag) { return makeEl(tag, null); }
    },
    fetch: fetcher,
    encodeURIComponent: globalThis.encodeURIComponent,
    console,
    ...(hostname === null ? {} : { window: { location: { hostname } } }),
  });
  vm.runInContext(source, context);
  return { el, context, calls };
}

function collectIds(node, out = []) {
  if (!node) return out;
  if (node.attrs) {
    for (const attr of node.attrs) {
      if (attr.name === 'id') out.push(attr.value);
      if (attr.name === 'href' && attr.value.startsWith('#')) out.push(attr.value);
    }
  }
  for (const child of node.childNodes || []) collectIds(child, out);
  return out;
}

test('dgm activity ui: shell carries nav, section, and load control', () => {
  const ids = collectIds(parseFragment(shell));
  assert.ok(ids.includes('dgm-activity'), 'section present');
  assert.ok(ids.includes('dgm-activity-load'), 'load button present');
  assert.ok(ids.includes('dgm-activity-state'), 'state line present');
  assert.ok(ids.includes('dgm-activity-result'), 'result region present');
  assert.ok(ids.includes('#dgm-activity'), 'nav link present');
});

const detailOf = (over = {}) => ({
  runId: 'run_v1_ab12cd34', fixture: 'good', status: 'completed-preview',
  envelopeLabel: 'VALIDATED', settlement: 'success', label: '',
  adviceReason: 'shadow_only', evaluation: 'fixture',
  gates: [{ name: 'target_bound', passed: true, evidence: 'bound' }],
  provenance: { fixture: 'good', baselineScorePpm: 500000, candidateScorePpm: 700000, archive: [] },
  events: [],
  telemetry: { readStatus: 'ok', freshnessNote: 'fresh', outcomeCounts: {}, latencySummary: {}, tokensSummary: {} },
  ...over,
});

function activityRoutes(over = {}) {
  return {
    '/api/admin/v1/dgm/preview/status': () => Response.json({
      schema: 'aipster.dgm.preview/v1', evaluation: 'fixture',
      binding: { state: 'active' }, fixtures: ['good'], runs: 1,
    }),
    '/api/admin/v1/dgm/preview/runs': () => Response.json({
      evaluation: 'fixture',
      items: [{ runId: 'run_v1_ab12cd34', fixture: 'good', status: 'completed-preview', envelopeLabel: 'VALIDATED', createdAt: '2026-11-05T06:00:00.000Z' }],
      total: 1,
    }),
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(detailOf(over.detail)),
    '/api/admin/v1/dgm/preview/muse/status': () => Response.json({
      schema: 'aipster.dgm.muse/v1', evaluation: 'fixture',
      provider: { model: 'muse-spark-1.3-contributor', configured: false },
      spendCapUsd: 1,
      spend: { scope: 'dgm-muse', window: 'all-time', capUsd: 1, status: 'uninitialised' },
      observedAt: '2026-11-05T06:15:00.000Z',
    }),
    ...over.routes,
  };
}

test('dgm activity ui: load renders objective, labeled metrics, blockers; GET only', async () => {
  const ui = harness(activityRoutes());
  await vm.runInContext('loadDgmActivity()', ui.context);
  assert.ok(ui.calls.length >= 3);
  assert.ok(ui.calls.every((c) => !c.init.method || c.init.method === 'GET'), 'read-only traffic');
  assert.ok(ui.calls.some((c) => c.path === '/api/admin/v1/dgm/preview/status'));
  assert.ok(ui.calls.some((c) => c.path === '/api/admin/v1/dgm/preview/muse/status'));
  const html = ui.el('dgm-activity-result').innerHTML;
  for (const needle of ['Objective', 'Current state', 'History', 'Blockers', 'Budget',
    '500000', '700000', 'NOT MEASURED', 'fixture-only', '501', 'run_v1_ab12cd34',
    'muse-spark-1.3-contributor', 'no admission recorded yet', '2026-11-05T06:15:00.000Z',
    '1 total (showing first 1)', 'not listed by this API', 'inspect keys individually']) {
    assert.ok(html.includes(needle), needle);
  }
  assert.ok(!html.includes('No blockers recorded.'), 'no bare no-blockers claim');
  assert.match(ui.el('dgm-activity-state').textContent, /Loaded 1 run/);
});

test('dgm activity ui: empty stays empty and never looks running', async () => {
  const ui = harness({
    '/api/admin/v1/dgm/preview/status': () => Response.json({ binding: { state: 'active' } }),
    '/api/admin/v1/dgm/preview/runs': () => Response.json({ items: [], total: 0 }),
    '/api/admin/v1/dgm/preview/muse/status': () => Response.json({ configured: true, model: 'm' }),
  });
  await vm.runInContext('loadDgmActivity()', ui.context);
  const html = ui.el('dgm-activity-result').innerHTML;
  assert.ok(html.includes('No preview runs yet (empty'));
  assert.ok(!html.includes('Loading'));
  assert.match(ui.el('dgm-activity-state').textContent, /empty/);
});

test('dgm activity ui: loopback hook renders measured local numbers when present', async () => {
  const ui = harness({
    ...activityRoutes(),
    '/_local/dgm-activity': () => Response.json({
      schema: 'aipster.dgm.local-activity/v1',
      reports: [{
        generatedAt: '2026-11-05T06:20:00.000Z',
        outcome: 'tie-archived',
        baseline: { policyVersion: 'route/v1', heldout: { n: 24, top1Hits: 20 } },
        candidate: { heldout: { n: 24, top1Hits: 20 } },
        guardrails: [{ name: 'g1', passed: true }, { name: 'g2', passed: false }],
        promotionEligible: false,
      }],
      failures: [{ kind: 'local-report', code: 'DIGEST_MISMATCH', detail: 'dropped' }],
    }),
  });
  await vm.runInContext('loadDgmActivity()', ui.context);
  assert.ok(ui.calls.some((c) => c.path === '/_local/dgm-activity'), 'loopback attempted');
  const html = ui.el('dgm-activity-result').innerHTML;
  for (const needle of ['Local dry-run reports (this host only)', '20/24 → 20/24 top-1 (measured-synthetic',
    'tie-archived; guardrails 1/2', 'ineligible; human approval required', 'DIGEST_MISMATCH']) {
    assert.ok(html.includes(needle), needle);
  }
});

test('dgm activity ui: local hook ceiling renders verdict and per-weight movement, escaped', async () => {
  const ui = harness({
    ...activityRoutes(),
    '/_local/dgm-activity': () => Response.json({
      schema: 'aipster.dgm.local-activity/v1', reports: [], failures: [],
      ceiling: {
        state: 'computed', synthetic: true, ceiling: 'tie-archived', proposalCanImprove: false, evaluated: 161,
        counts: { improvement: 0, 'tie-archived': 54, regression: 107 }, baselineHeldoutTop1: 20, heldoutN: 24,
        best: { outcome: 'tie-archived', heldoutTop1: 20, variables: [
          { name: 'EXACT_TOKEN', baseline: 50, best: 60, direction: 'up' },
          { name: '<b>X</b>', baseline: 20, best: 10, direction: 'down' },
          { name: 'OWNED', baseline: 10, best: 10, direction: 'same' },
        ] },
      },
    }),
  });
  await vm.runInContext('loadDgmActivity()', ui.context);
  const html = ui.el('dgm-activity-result').innerHTML;
  for (const needle of ['Routing weights: current vs best alternative tried',
    'None of the 161 alternative settings beats the current weights', 'ties at 20/24 against 20/24', 'Nothing to change',
    '0 better, 54 tie, 107 worse', 'not a fabric-quality measurement', 'EXACT_TOKEN', '+10', '-10', 'no change',
    'The live weights are not changed by this test', '&lt;b&gt;X&lt;/b&gt;']) {
    assert.ok(html.includes(needle), needle);
  }
  assert.ok(!html.includes('<b>X</b>'), 'escaped');
  assert.ok(!html.includes('tie-archived'), 'no internal outcome labels in the operator view');
});

test('dgm activity ui: unavailable ceiling says so and invents nothing', async () => {
  const ui = harness({
    ...activityRoutes(),
    '/_local/dgm-activity': () => Response.json({ reports: [], failures: [], ceiling: { state: 'unavailable', code: 'DGM_BASELINE_DRIFT' } }),
  });
  await vm.runInContext('loadDgmActivity()', ui.context);
  const html = ui.el('dgm-activity-result').innerHTML;
  assert.ok(html.includes('Not available (DGM_BASELINE_DRIFT)'));
  assert.ok(!html.includes('alternative settings'));
});

test('dgm activity ui: missing hook labels not-connected without inventing data', async () => {
  const ui = harness(activityRoutes());
  await vm.runInContext('loadDgmActivity()', ui.context);
  assert.ok(ui.calls.some((c) => c.path === '/_local/dgm-activity'), 'hook attempted as relative URL');
  assert.ok(ui.el('dgm-activity-result').innerHTML.includes('Not connected'));
});

test('dgm activity ui: failed runs await review with retained gates; strings escaped', async () => {
  const ui = harness(activityRoutes({
    detail: {
      status: 'failed', settlement: 'stale_receipt',
      gates: [{ name: 'archive_settled', passed: false, evidence: 'stale_receipt' }],
      provenance: { fixture: 'corrupt-receipt', baselineScorePpm: 500000, candidateScorePpm: null },
    },
    routes: {
      '/api/admin/v1/dgm/preview/runs': () => Response.json({
        items: [{ runId: 'run_v1_x<script>', fixture: 'corrupt-<receipt>', status: 'failed', envelopeLabel: 'VALIDATED' }],
        total: 1,
      }),
      '/api/admin/v1/dgm/preview/runs/run_v1_x%3Cscript%3E': () => Response.json(detailOf({
        runId: 'run_v1_x<script>', status: 'failed',
      })),
    },
  }));
  await vm.runInContext('loadDgmActivity()', ui.context);
  const html = ui.el('dgm-activity-result').innerHTML;
  assert.ok(!html.includes('<script>'), 'untrusted runId escaped');
  assert.ok(html.includes('run_v1_x&lt;script&gt;'), 'escaped runId rendered');
  assert.ok(html.includes('corrupt-&lt;receipt&gt;'), 'escaped fixture rendered');
  assert.ok(html.includes('awaiting-review'), 'failed run awaits review, never running');
  assert.ok(!html.includes('>running<'), 'no running state anywhere');
  assert.ok(html.includes('1 failed preview run'), 'blocker retained');
});
