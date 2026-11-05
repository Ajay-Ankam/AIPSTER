/* Built with Meta Muse. */
// Worker-cron DGM self-test: store insert/retention/failure/disabled and
// store-not-migrated paths, scheduled() delegation, the admin read API
// (permission + GET-only), and the admin trend renderer (previous-run
// deltas, stale label, empty state, escaping). Snapshots are injected
// synthetics; only the scheduled() test exercises the real eval-core
// default path, and it performs no model or network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { runDgmSelfTest, listSelfTests, lastScheduledRunAt } from '../src/dgm/self-test.mjs';

const FLAG = { DGM_PREVIEW_ENABLED: '1', DGM_SELF_TEST_ENABLED: '1' };
const PATH = '/api/admin/v1/dgm/self-test';

const WEIGHTS = { EXACT_TOKEN: 3, ONLINE: 2, FRESHNESS_MAX: 1, OWNED: 0, HEADROOM: 1 };

// Minimal snapshot following the eval-core contract.
function fakeSnapshot(over = {}) {
  return {
    schema: 'aipster.dgm.self-test/v1',
    evalVersion: 'dgm-routing-eval/v1',
    policyVersion: 'route/v1',
    workload: { version: 'w/v1', seed: 7, trainN: 24, heldoutN: 24 },
    guardrails: [{ name: 'g', passed: true }],
    baseline: { weights: { ...WEIGHTS }, heldoutTop1: 20, trainTop1: 21, heldoutMeanRank: 1.2 },
    ceiling: 'tie-archived',
    proposalCanImprove: false,
    evaluated: 162,
    counts: { improvement: 0, 'tie-archived': 54, regression: 108 },
    best: {
      outcome: 'tie-archived', weights: { ...WEIGHTS }, weightsKey: 'k',
      heldoutTop1: 20, trainTop1: 21, heldoutMeanRank: 1.2,
    },
    variables: [],
    ...over,
  };
}

async function grant(t, userId, role) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(`g_st${Math.random().toString(36).slice(2, 8)}`, userId, role, 'platform', null, now, 'operator', null).run();
}

test('self-test run inserts one completed row', async () => {
  const t = await createTestEnv(FLAG);
  const out = await runDgmSelfTest({
    db: t.DB, env: t.env, trigger: 'cron', cron: '15 3 * * *',
    nowMs: Date.parse('2026-11-05T03:15:00.000Z'), compute: () => fakeSnapshot(),
  });
  assert.equal(out.state, 'completed');
  assert.ok(out.id, 'returns the row id');
  const row = await t.DB.prepare('SELECT * FROM dgm_self_tests').all();
  assert.equal(row.results.length, 1);
  assert.equal(row.results[0].id, out.id);
  assert.equal(row.results[0].state, 'completed');
  assert.equal(row.results[0].trigger_kind, 'cron');
  assert.equal(row.results[0].cron, '15 3 * * *');
  assert.equal(typeof row.results[0].duration_ms, 'number');
  const snap = JSON.parse(row.results[0].snapshot_json);
  assert.equal(snap.schema, 'aipster.dgm.self-test/v1');
  assert.equal(snap.ceiling, 'tie-archived');
});

test('self-test run retains only the newest 400 rows', async () => {
  const t = await createTestEnv(FLAG);
  const base = Date.parse('2026-11-05T03:15:00.000Z');
  for (let i = 0; i < 405; i++) {
    await runDgmSelfTest({
      db: t.DB, env: t.env, trigger: 'cron', cron: '15 3 * * *',
      nowMs: base + i * 1000, compute: () => fakeSnapshot(),
    });
  }
  const n = await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_self_tests').bind().all();
  assert.equal(n.results[0].n, 400);
  const oldest = await t.DB.prepare('SELECT ran_at FROM dgm_self_tests ORDER BY ran_at ASC LIMIT 1').bind().all();
  assert.equal(oldest.results[0].ran_at, new Date(base + 5 * 1000).toISOString());
});

test('self-test compute throw records failed with code, never a guess', async () => {
  const t = await createTestEnv(FLAG);
  const coded = new Error('boom');
  coded.code = 'DGM_EVAL_FAILED';
  const out = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', compute: () => { throw coded; } });
  assert.equal(out.state, 'failed');
  const row = await t.DB.prepare('SELECT state, code, snapshot_json FROM dgm_self_tests').all();
  assert.equal(row.results.length, 1);
  assert.equal(row.results[0].state, 'failed');
  assert.equal(row.results[0].code, 'DGM_EVAL_FAILED');
  assert.equal(row.results[0].snapshot_json, null);
  const plain = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', compute: () => { throw new Error('x'); } });
  assert.equal(plain.state, 'failed');
  const rows = await t.DB.prepare('SELECT code FROM dgm_self_tests ORDER BY ran_at DESC LIMIT 1').all();
  assert.equal(rows.results[0].code, 'DGM_EVAL_FAILED');
});

test('self-test records an unusable snapshot as failed, never a guess', async () => {
  const t = await createTestEnv(FLAG);
  const out = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', compute: () => null });
  assert.equal(out.state, 'failed');
  assert.equal(out.code, 'DGM_EVAL_BAD_SNAPSHOT');
  const row = await t.DB.prepare('SELECT state, code, snapshot_json FROM dgm_self_tests').all();
  assert.equal(row.results.length, 1);
  assert.equal(row.results[0].state, 'failed');
  assert.equal(row.results[0].code, 'DGM_EVAL_BAD_SNAPSHOT');
  assert.equal(row.results[0].snapshot_json, null);
});

test('self-test disabled flag skips without writing', async () => {
  const t = await createTestEnv({ ...FLAG, DGM_SELF_TEST_ENABLED: '0' });
  const out = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', compute: () => fakeSnapshot() });
  assert.deepEqual(out, { skipped: true, reason: 'disabled' });
  const n = await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_self_tests').all();
  assert.equal(n.results[0].n, 0);
});

test('self-test without the migrated store skips without throwing', async () => {
  const t = await createTestEnv({ ...FLAG, skipMigrations: true });
  const out = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', compute: () => fakeSnapshot() });
  assert.deepEqual(out, { skipped: true, reason: 'store-not-migrated' });
});

test('listSelfTests returns newest-first allowlisted rows capped at 30', async () => {
  const t = await createTestEnv(FLAG);
  const base = Date.parse('2026-11-05T03:15:00.000Z');
  for (let i = 0; i < 35; i++) {
    const at = new Date(base + i * 1000).toISOString();
    await t.DB.prepare(
      'INSERT INTO dgm_self_tests (id, ran_at, trigger_kind, state, code, cron, duration_ms, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`r${i}`, at, 'cron', 'completed', null, '15 3 * * *', 1, JSON.stringify(fakeSnapshot()), at).run();
  }
  const rows = await listSelfTests(t.DB, { limit: 50 });
  assert.equal(rows.length, 30);
  assert.equal(rows[0].id, 'r34');
  assert.equal(rows[29].id, 'r5');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['code', 'createdAt', 'cron', 'durationMs', 'id', 'ranAt', 'routing', 'scheduledAt', 'snapshot', 'state', 'trigger']);
  assert.equal(rows[0].snapshot.ceiling, 'tie-archived');
});

test('worker scheduled() delegates to the self-test run', async () => {
  const t = await createTestEnv({ DGM_SELF_TEST_ENABLED: '1' });
  const worker = (await import('../src/worker.js')).default;
  assert.equal(typeof worker.scheduled, 'function');
  const waited = [];
  const ctx = { waitUntil(p) { waited.push(p); } };
  await worker.scheduled({ cron: '15 3 * * *' }, t.env, ctx);
  assert.equal(waited.length, 1);
  const out = await waited[0];
  assert.equal(out.state, 'completed');
  const n = await t.DB.prepare("SELECT COUNT(*) AS n FROM dgm_self_tests WHERE trigger_kind = 'cron'").all();
  assert.equal(n.results[0].n, 1);
});

test('self-test api: readable without the preview flag, rows with it, denied without grant', async () => {
  // Deliberate contract (see handleDgmSelfTest): synthetic self-test history
  // is not behind the dark preview flag; permission still gates every read.
  const dark = await createTestEnv();
  await grant(dark, 'u_alice', 'operations_observer');
  const open = await readJson(await dark.call(PATH, { headers: dark.as(dark.alice) }));
  assert.equal(open.status, 200);
  assert.equal(open.json.schema, 'aipster.dgm.self-test-list/v1');
  assert.equal(open.json.synthetic, true);
  assert.equal(open.json.enabled, false, 'opt-in: no flag means not enabled');
  assert.equal(open.json.store, 'ready');
  assert.deepEqual(open.json.runs, []);

  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const empty = await readJson(await t.call(PATH, { headers: t.as(t.alice) }));
  assert.equal(empty.status, 200);
  assert.equal(empty.json.schema, 'aipster.dgm.self-test-list/v1');
  assert.equal(empty.json.enabled, true);
  assert.equal(empty.json.schedule, '15 3 * * * UTC');
  assert.deepEqual(empty.json.runs, []);
  assert.equal(empty.json.latest, null);

  await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'manual', cron: null, compute: () => fakeSnapshot() });
  const full = await readJson(await t.call(PATH, { headers: t.as(t.alice) }));
  assert.equal(full.status, 200);
  assert.equal(full.json.runs.length, 1);
  assert.equal(full.json.runs[0].trigger, 'manual');
  assert.equal(full.json.runs[0].snapshot.baseline.heldoutTop1, 20);
  assert.equal(full.json.latest.id, full.json.runs[0].id);

  const denied = await readJson(await t.call(PATH, { headers: t.as(t.bob) }));
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'ADMIN_FORBIDDEN');
  const anon = await readJson(await t.call(PATH));
  assert.equal(anon.status, 401);
});

test('self-test api: non-GET is 405', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const out = await readJson(await t.call(PATH, { method, headers: { ...t.as(t.alice), ...t.csrf }, body: {} }));
    assert.equal(out.status, 405, method);
    assert.equal(out.json.code, 'METHOD_NOT_ALLOWED');
  }
});

// Admin panel renderer: load the real admin.js in a minimal DOM stub and
// exercise the self-test renderers against API-shaped payloads.
const adminSource = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');

function stubEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    addEventListener() {}, setAttribute() {}, appendChild() {}, removeChild() {},
  };
}

function render(expr, api) {
  const context = vm.createContext({
    API: api,
    document: { getElementById: () => stubEl(), querySelectorAll() { return []; }, createElement: () => stubEl() },
    fetch: async () => new Response('{}'),
    encodeURIComponent: globalThis.encodeURIComponent,
    console,
  });
  vm.runInContext(adminSource, context);
  return vm.runInContext(expr, context);
}
const renderPanel = (api) => render('dgmSelfTestPanelHtml(API)', api);
const renderHistory = (api) => render('dgmSelfTestHtml(API)', api);

const NOW = '2026-11-05T08:00:00.000Z';

function routingFixture(over = {}) {
  return {
    schema: 'aipster.dgm.routing-telemetry/v1', state: 'computed', store: 'ready',
    window: { from: '2026-11-04T03:15:00.000Z', to: '2026-11-05T03:15:00.000Z', hours: 24 },
    decisions: 40, truncated: false, rowCap: 2000, withMetrics: 40,
    bySource: { advice: 20, cached: 10, fallback: 8, 'degraded-stale': 0, none: 2, other: 0 },
    byState: { admitted: 38, rejected: 2, proposed: 0, expired: 0, other: 0 },
    failureCodes: { NO_CANDIDATES: 2 },
    advice: { attempted: 24, completed: 20, failed: 4, codes: { ADVICE_UPSTREAM: 4 }, latencyMs: { n: 24, p50: 180, p95: 900 }, inputTokens: 2400, outputTokens: 600, spendUsdEst: 0.0055 },
    agreement: { known: 38, top1Agree: 30, top1AgreeRate: 78.9, orderKnown: 38, orderAgree: 25, orderAgreeRate: 65.8 },
    cache: { hit: 10, staleHit: 0, miss: 28, unservable: 0, notChecked: 2, hitRate: 26.3 },
    selection: { deterministic: 4, modelUnknown: 30, fallbackAfterAttempt: 4, noSelection: 2 },
    decisionMs: { n: 40, p50: 14, p95: 60 }, candidates: { eligibleMean: 3.5, scoredMean: 3.5 },
    rates: { advicePct: 50, cachedPct: 25, fallbackPct: 20, nonePct: 5 },
    ...over,
  };
}

function apiRow(over = {}) {
  const at = over.ranAt || '2026-11-05T03:15:00.000Z';
  return {
    id: 'run1', ranAt: at, scheduledAt: at, trigger: 'cron', state: 'completed', code: null,
    cron: '15 3 * * *', durationMs: 12, createdAt: at, snapshot: fakeSnapshot(), routing: routingFixture(), ...over,
  };
}

function api(over = {}) {
  return {
    schema: 'aipster.dgm.self-test-list/v1', enabled: true, store: 'ready', schedule: '15 3 * * * UTC',
    observedAt: NOW, expectedRunAt: '2026-11-05T03:15:00.000Z', telemetryWindowHours: 24, synthetic: true,
    runs: [], latest: null, ...over,
  };
}

test('self-test ui: healthy headline in plain language, no internal labels', () => {
  const html = renderPanel(api({ runs: [apiRow()] }));
  for (const needle of [
    'pill-ok">healthy',
    'Checked 2026-11-05 03:15 UTC: the current routing weights scored 20/24 on the synthetic routing test; the best of 162 alternative settings also scored 20/24, so there is nothing to change.',
    'Routing weights: current vs best alternative tried', 'ties at 20/24 against 20/24', 'Nothing to change',
    'The live weights are not changed by this test', 'Schedule: daily at 03:15 UTC.', 'Run history (newest first)',
  ]) assert.ok(html.includes(needle), needle);
  for (const banned of ['tie-archived', 'held-out', 'measured-synthetic', 'T03:15:00.000Z', 'expected at']) assert.ok(!html.includes(banned), 'absent: ' + banned);
});

test('self-test ui: live routing tiles come from the stored aggregate', () => {
  const html = renderPanel(api({ runs: [apiRow()] }));
  for (const needle of [
    'Live routing in the 24 hours before the latest run', 'routing decisions', '<b>40</b>',
    'served by model advice 50%, cache 25%, deterministic fallback 20%', '<b>78.9%</b>', '30 of 38 served first choices matched route/v1',
    '<b>24</b>', '20 completed, 4 failed; median 180 ms', '<b>$0.0055</b>', '2400 in / 600 out tokens',
    '<b>26.3%</b>', '<b>14 ms median</b>', 'p95 60 ms over 40 live-clock decisions',
    'Decision failure codes: NO_CANDIDATES 2.', 'Window: 2026-11-04 03:15 UTC to 2026-11-05 03:15 UTC.',
  ]) assert.ok(html.includes(needle), needle);
});

test('self-test ui: zero traffic and telemetry failures are said plainly, never shown as zeros', () => {
  const none = renderPanel(api({ runs: [apiRow({ routing: routingFixture({ decisions: 0, withMetrics: 0 }) })] }));
  assert.ok(none.includes('No routing decisions were made in that window, so there are no live statistics yet'));
  assert.ok(!none.includes('class="tile"'));
  const failed = renderPanel(api({ runs: [apiRow({ routing: { schema: 'aipster.dgm.routing-telemetry/v1', state: 'failed', code: 'DGM_TELEMETRY_FAILED' } })] }));
  assert.ok(failed.includes('reading routing telemetry failed (DGM_TELEMETRY_FAILED)'));
  assert.ok(failed.includes('pill-ok">healthy'), 'a telemetry failure does not fail the policy verdict');
  const missing = renderPanel(api({ runs: [apiRow({ routing: null })] }));
  assert.ok(missing.includes('No routing statistics were recorded with this run.'));
  const notMigrated = renderPanel(api({ runs: [apiRow({ routing: routingFixture({ store: 'not-migrated', decisions: null }) })] }));
  assert.ok(notMigrated.includes('the routing ledger is not migrated'));
});

test('self-test ui: regression, improvement and better-weights verdicts compare with the previous completed run', () => {
  const older = apiRow({ id: 'a', ranAt: '2026-11-04T03:15:00.000Z' });
  const regressed = apiRow({ id: 'b', snapshot: fakeSnapshot({ baseline: { ...fakeSnapshot().baseline, heldoutTop1: 19 }, best: { ...fakeSnapshot().best, heldoutTop1: 19 } }) });
  const r = renderPanel(api({ runs: [regressed, older] }));
  assert.ok(r.includes('pill-bad">policy regressed'));
  assert.ok(r.includes('scored 19/24 on the synthetic routing test, down from 20/24 at the previous run. The routing policy regressed'));

  const improved = apiRow({ id: 'c', snapshot: fakeSnapshot({ baseline: { ...fakeSnapshot().baseline, heldoutTop1: 21 }, best: { ...fakeSnapshot().best, heldoutTop1: 21 } }) });
  const i = renderPanel(api({ runs: [improved, older] }));
  assert.ok(i.includes('pill-ok">policy improved'));
  assert.ok(i.includes('scored 21/24 on the synthetic routing test, up from 20/24 at the previous run.'));

  const better = apiRow({ id: 'd', snapshot: fakeSnapshot({ proposalCanImprove: true, counts: { improvement: 3, 'tie-archived': 50, regression: 109 }, best: { ...fakeSnapshot().best, outcome: 'improvement', heldoutTop1: 21 } }) });
  const b = renderPanel(api({ runs: [better, older] }));
  assert.ok(b.includes('pill-muted">better weights available'));
  assert.ok(b.includes('3 of 162 alternative settings scored higher (best 21/24). Review before any change; nothing is applied automatically.'));
  assert.ok(b.includes('3 of 162 alternative settings would beat the current weights (best scores 21/24 against 20/24)'));
});

test('self-test ui: history compares with the previous completed run, skipping failed rows; dates are readable', () => {
  const day1 = apiRow({ id: 'a', ranAt: '2026-11-03T03:15:00.000Z', snapshot: fakeSnapshot({ best: { ...fakeSnapshot().best, weights: { ...WEIGHTS, ONLINE: 2 } } }) });
  const day2 = apiRow({ id: 'b', ranAt: '2026-11-04T03:15:00.000Z', state: 'failed', code: 'DGM_EVAL_FAILED', snapshot: null, routing: routingFixture() });
  const day3 = apiRow({ id: 'c', ranAt: '2026-11-05T03:15:00.000Z', snapshot: fakeSnapshot({ best: { ...fakeSnapshot().best, weights: { ...WEIGHTS, ONLINE: 3, HEADROOM: 0 } } }) });
  const html = renderHistory(api({ runs: [day3, day2, day1] }));
  const rows = html.split('<tr>').slice(2);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes('2026-11-05 03:15 UTC'));
  assert.ok(rows[0].includes('ONLINE 2→3; HEADROOM 1→0'), 'delta against the earlier COMPLETED run, not the failed one');
  assert.ok(!rows[0].includes('no earlier completed run'));
  assert.ok(rows[1].includes('pill-bad">failed: DGM_EVAL_FAILED'));
  assert.ok(rows[1].includes('<td class="num">unknown</td>'));
  assert.ok(rows[2].includes('no earlier completed run'));
  assert.ok(rows[0].includes('<td class="num">40</td>') && rows[0].includes('78.9%') && rows[0].includes('20%'));
  for (const col of ['run (UTC)', 'result', 'current weights score', 'best alternative score', 'best alternative changed since previous run', 'decisions, prior 24 h', 'agree with deterministic choice', 'fallback share']) {
    assert.ok(html.includes('<th>' + col + '</th>'), col);
  }
  assert.ok(html.includes('class="tbl-wrap"'));
  assert.ok(!html.includes('T03:15:00.000Z'), 'no raw ISO timestamps');
});

test('self-test ui: a failed newest run is called out and never renders a verdict of its own', () => {
  const ok = apiRow({ id: 'ok', ranAt: '2026-11-04T03:15:00.000Z' });
  const bad = apiRow({ id: 'bad', state: 'failed', code: 'DGM_EVAL_FAILED', snapshot: null });
  const html = renderPanel(api({ runs: [bad, ok] }));
  assert.ok(html.includes('The newest run (2026-11-05 03:15 UTC) failed (DGM_EVAL_FAILED); the figures below are from the last completed run (2026-11-04 03:15 UTC).'));
  assert.ok(html.includes('pill-ok">healthy'), 'verdict comes from the last completed run');
  const only = renderPanel(api({ runs: [apiRow({ state: 'failed', code: 'DGM_GUARDRAIL_FAILED', snapshot: { guardrails: [{ name: 'mirror_fidelity', passed: false }] } })] }));
  assert.ok(only.includes('pill-bad">failed: DGM_GUARDRAIL_FAILED'));
  assert.ok(only.includes('No completed run yet; the newest run failed (DGM_GUARDRAIL_FAILED).'));
  assert.ok(!only.includes('Routing weights: current vs best alternative tried'), 'no weights verdict from a failed run');
});

test('self-test ui: missed-run notice from the server clock, stale label, empty, disabled, not migrated, escaping', () => {
  const old = renderPanel(api({ runs: [apiRow({ ranAt: '2026-11-03T03:15:00.000Z' })] }));
  assert.ok(old.includes('A run was expected at 2026-11-05 03:15 UTC but none was recorded: the cron did not complete.'));
  assert.ok(old.includes('stale (&gt;26 h)'));
  const onTime = renderPanel(api({ runs: [apiRow()] }));
  assert.ok(!onTime.includes('expected at') && !onTime.includes('stale ('));
  const withinGrace = renderPanel(api({ runs: [apiRow({ ranAt: '2026-11-04T03:15:00.000Z' })], observedAt: '2026-11-05T04:00:00.000Z' }));
  assert.ok(!withinGrace.includes('expected at'), 'two-hour grace after the scheduled fire');
  const disabled = renderPanel(api({ runs: [], enabled: false, expectedRunAt: null }));
  assert.ok(disabled.includes('not enabled: the cron runs only when DGM_SELF_TEST_ENABLED=1'));
  assert.ok(disabled.includes('pill-muted">no runs yet') && disabled.includes('No self-test runs yet'));
  assert.ok(!disabled.includes('expected at'));
  assert.ok(renderPanel(api({ store: 'not-migrated' })).includes('not migrated on this deployment (migration 0031)'));
  assert.ok(renderPanel(null).includes('Unavailable: self-test history could not be read'));
  const evil = renderPanel(api({ runs: [apiRow({ trigger: '<script>alert(1)</script>', state: 'failed', code: '<b>', snapshot: null })] }));
  assert.ok(!evil.includes('<script>alert') && !evil.includes('(<b>)'));
  assert.ok(evil.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && evil.includes('&lt;b&gt;'));
});

test('self-test is opt-in: only DGM_SELF_TEST_ENABLED === "1" runs', async () => {
  for (const value of [undefined, '0', 'true', 'yes', '']) {
    const env = value === undefined ? {} : { DGM_SELF_TEST_ENABLED: value };
    const t = await createTestEnv(env);
    let called = 0;
    const out = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', compute: () => { called += 1; return fakeSnapshot(); } });
    assert.deepEqual(out, { skipped: true, reason: 'disabled' }, String(value));
    assert.equal(called, 0, 'nothing evaluated when not enabled');
    const n = await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_self_tests').first();
    assert.equal(Number(n.n), 0);
  }
});

test('self-test guardrail failure is recorded failed with evidence, never as a verdict', async () => {
  const t = await createTestEnv(FLAG);
  const out = await runDgmSelfTest({
    db: t.DB, env: t.env, trigger: 'cron',
    compute: () => fakeSnapshot({ guardrails: [{ name: 'mirror_fidelity', passed: false }, { name: 'split_independence', passed: true }] }),
  });
  assert.equal(out.state, 'failed');
  assert.equal(out.code, 'DGM_GUARDRAIL_FAILED');
  const [row] = await listSelfTests(t.DB);
  assert.equal(row.state, 'failed');
  assert.deepEqual(row.snapshot, { guardrails: [{ name: 'mirror_fidelity', passed: false }, { name: 'split_independence', passed: true }] });
  assert.equal(row.routing.state, 'computed', 'telemetry is still recorded beside a failed evaluation');
  for (const bad of [{ guardrails: [] }, { guardrails: undefined }]) {
    const r = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'manual', compute: () => fakeSnapshot(bad) });
    assert.equal(r.code, 'DGM_GUARDRAIL_FAILED', 'missing guardrails is a failure, not a pass');
  }
});

test('self-test stores scheduledAt and the routing aggregate; a telemetry failure never masks the evaluation', async () => {
  const t = await createTestEnv(FLAG);
  const out = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', cron: '15 3 * * *', scheduledAt: Date.parse('2026-11-05T03:15:00.000Z'), compute: () => fakeSnapshot() });
  assert.equal(out.state, 'completed');
  assert.equal(out.routingState, 'computed');
  const [row] = await listSelfTests(t.DB);
  assert.equal(row.scheduledAt, '2026-11-05T03:15:00.000Z');
  assert.equal(row.routing.decisions, 0);
  assert.equal(row.routing.window.hours, 24);
  const failing = await runDgmSelfTest({
    db: t.DB, env: t.env, trigger: 'manual', compute: () => fakeSnapshot(),
    telemetry: async () => { throw Object.assign(new Error('boom'), { code: 'DGM_TELEMETRY_FAILED' }); },
  });
  assert.equal(failing.state, 'completed');
  assert.equal(failing.routingState, 'failed');
  const [latest] = await listSelfTests(t.DB);
  assert.deepEqual(latest.routing, { schema: 'aipster.dgm.routing-telemetry/v1', state: 'failed', code: 'DGM_TELEMETRY_FAILED' });
  assert.equal(latest.scheduledAt, null, 'manual runs have no scheduled instant');
  await assert.rejects(runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'bogus', compute: () => fakeSnapshot() }), (e) => e.code === 'DGM_SELF_TEST_BAD_TRIGGER');
});

test('self-test end to end: real routing rows flow into the stored aggregate', async () => {
  const t = await createTestEnv(FLAG);
  const at = '2026-11-05T02:00:00.000Z';
  const body = JSON.stringify({ ranking: ['r1'], source: 'fallback', failure: null, outcome: null,
    metrics: { clock: 'live', decisionMs: 7, cache: 'miss', candidates: { eligible: 2, rejected: 0, scored: 2, truncated: false },
      top1AgreesWithDeterministic: true, orderAgreesWithDeterministic: true, selection: { propensity: 1, basis: 'deterministic-route/v1' },
      advice: { outcome: 'fallback', attempted: false, completed: false, failureCode: 'ADVICE_DISALLOWED', latencyMs: 0, mode: 'standard', model: 'm', usage: null, spendUsdEst: 0, priceVersion: 'v' } } });
  await t.DB.prepare('INSERT INTO routing_ops (id, tenant_id, request_id, state, source, ranking_json, failure_code, feature_digest, candidate_digest, policy_version, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('op_e2e', 'u_alice', 'req_e2e', 'admitted', 'fallback', body, null, 'f', 'c', 'route/v1', at, at, at).run();
  const out = await runDgmSelfTest({ db: t.DB, env: t.env, trigger: 'cron', nowMs: Date.parse('2026-11-05T03:15:00.000Z') });
  assert.equal(out.state, 'completed');
  const [row] = await listSelfTests(t.DB);
  assert.equal(row.routing.decisions, 1);
  assert.equal(row.routing.selection.deterministic, 1);
  assert.deepEqual(row.routing.advice.codes, { ADVICE_DISALLOWED: 1 });
  assert.equal(row.snapshot.ceiling, 'tie-archived');
  assert.deepEqual(row.snapshot.counts, { improvement: 0, 'tie-archived': 54, regression: 107 });
});

test('self-test api carries the server clock and the expected run; lastScheduledRunAt', async () => {
  assert.equal(lastScheduledRunAt(Date.parse('2026-11-05T08:00:00.000Z')), '2026-11-05T03:15:00.000Z');
  assert.equal(lastScheduledRunAt(Date.parse('2026-11-05T02:00:00.000Z')), '2026-11-04T03:15:00.000Z');
  assert.equal(lastScheduledRunAt(Date.parse('2026-11-05T03:15:00.000Z')), '2026-11-05T03:15:00.000Z');
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const out = await readJson(await t.call(PATH, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.ok(Number.isFinite(Date.parse(out.json.observedAt)));
  assert.equal(out.json.expectedRunAt, lastScheduledRunAt(Date.parse(out.json.observedAt)));
  assert.equal(out.json.telemetryWindowHours, 24);
  const dark = await createTestEnv({});
  await grant(dark, 'u_alice', 'operations_observer');
  const off = await readJson(await dark.call(PATH, { headers: dark.as(dark.alice) }));
  assert.equal(off.json.enabled, false);
  assert.equal(off.json.expectedRunAt, null);
});

test('self-test api and ui: store not migrated is explicit, not "no runs"', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  await t.DB.prepare('DROP TABLE dgm_self_tests').run();
  const out = await readJson(await t.call(PATH, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.store, 'not-migrated');
  assert.deepEqual(out.json.runs, []);
  const html = renderPanel(out.json);
  assert.ok(html.includes('not migrated on this deployment'));
  assert.ok(!html.includes('No self-test runs yet'));
});

test('admin shell: statistics panels come first and engineering controls are grouped', async () => {
  const shell = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');
  const order = ['id="dgm-self-test"', 'id="dgm-activity"', 'id="dgm-controls"', 'id="dgm-preview"', 'id="dgm-run"', 'id="dgm-states"', 'id="dgm-muse"'].map((k) => shell.indexOf(k));
  assert.ok(order.every((v) => v >= 0), 'all DGM sections present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'statistics, then the collapsed controls group');
  assert.ok(shell.includes('<details class="panel-group" id="dgm-controls"><summary>'));
  assert.ok(shell.indexOf('DGM statistics</p>') < shell.indexOf('DGM engineering controls</p>'));
  assert.ok(adminSource.includes("window.addEventListener('hashchange', dgmRevealHash)"), 'rail links into the collapsed group still open it');
});
