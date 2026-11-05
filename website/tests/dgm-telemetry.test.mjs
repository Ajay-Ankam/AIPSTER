// Live routing telemetry aggregation for the daily DGM self-test: reduces
// the sanitized per-decision metrics in routing_ops to counts, rates and
// percentiles over one window. Offline, real migrations, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-shim.mjs';
import { aggregateRoutingTelemetry, ROUTING_TELEMETRY_SCHEMA, TELEMETRY_ROW_CAP } from '../src/dgm/telemetry.mjs';

const T0 = Date.parse('2026-11-05T03:15:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function metrics(over = {}) {
  return {
    schema: 'aipster.routing.decision-metrics/v1', policyVersion: 'route/v1', clock: 'live', decisionMs: 12,
    candidates: { eligible: 4, rejected: 1, scored: 4, truncated: false }, cache: 'miss',
    deterministicTop1: 'r1', servedTop1: 'r1', top1AgreesWithDeterministic: true, orderAgreesWithDeterministic: true,
    selection: { propensity: null, basis: 'model-advice-unknown' },
    advice: { outcome: 'advice', attempted: true, completed: true, failureCode: null, latencyMs: 100, mode: 'standard', model: 'muse-spark-1.3',
      usage: { inputTokens: 100, outputTokens: 30, source: 'reported' }, spendUsdEst: 0.00025, priceVersion: 'meta-2026-11-01' },
    ...over,
  };
}

let seq = 0;
async function row(t, { atMs, source = 'advice', state = 'admitted', failure = null, m = metrics(), tenant = 'u_alice' }) {
  seq += 1;
  const body = JSON.stringify({ ranking: ['r1'], source, failure, outcome: null, metrics: m });
  await t.DB.prepare('INSERT INTO routing_ops (id, tenant_id, request_id, state, source, ranking_json, failure_code, feature_digest, candidate_digest, policy_version, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(`op_${seq}`, tenant, `req_${seq}`, state, source, body, failure ? failure.code : null, 'f', 'c', 'route/v1', iso(atMs), iso(atMs), iso(atMs + 3600e3)).run();
}

test('telemetry: aggregates one window with sources, agreement, advice, cache, latency and codes', async () => {
  const t = await createTestEnv({});
  const inWin = T0 - 3600e3;
  await row(t, { atMs: inWin, m: metrics({ decisionMs: 10, advice: { ...metrics().advice, latencyMs: 100 } }) });
  await row(t, { atMs: inWin + 1, m: metrics({ decisionMs: 20, top1AgreesWithDeterministic: false, orderAgreesWithDeterministic: false, advice: { ...metrics().advice, latencyMs: 300, spendUsdEst: 0.001 } }) });
  await row(t, { atMs: inWin + 2, source: 'cached', m: metrics({ decisionMs: 5, cache: 'hit', advice: null }) });
  await row(t, { atMs: inWin + 3, source: 'fallback', failure: { code: 'ADVICE_UPSTREAM', status: 502 },
    m: metrics({ clock: 'injected', decisionMs: 0, selection: { propensity: null, basis: 'fallback-after-advice-attempt' },
      advice: { ...metrics().advice, outcome: 'fallback', completed: false, failureCode: 'ADVICE_UPSTREAM', latencyMs: 50, usage: { inputTokens: 100, outputTokens: 512, source: 'estimated' } } }) });
  await row(t, { atMs: inWin + 4, source: 'fallback', m: metrics({ decisionMs: 8, selection: { propensity: 1, basis: 'deterministic-route/v1' },
    advice: { outcome: 'fallback', attempted: false, completed: false, failureCode: 'ADVICE_DISALLOWED', latencyMs: 0, mode: 'standard', model: 'm', usage: null, spendUsdEst: 0, priceVersion: 'v' } }) });
  await row(t, { atMs: inWin + 5, source: 'none', state: 'rejected', failure: { code: 'NO_CANDIDATES', status: 200 }, m: metrics({ decisionMs: 3, deterministicTop1: null, servedTop1: null, top1AgreesWithDeterministic: null, orderAgreesWithDeterministic: null, selection: { propensity: null, basis: 'no-selection' }, advice: null }) });
  // In flight (no metrics yet) and outside the window: counted / excluded respectively.
  await row(t, { atMs: inWin + 6, source: 'none', state: 'proposed', m: undefined });
  await t.DB.prepare("UPDATE routing_ops SET ranking_json = ? WHERE id = ?").bind(JSON.stringify({ ranking: [], source: 'none', failure: null, outcome: null }), `op_${seq}`).run();
  await row(t, { atMs: T0 - 25 * 3600e3, m: metrics() });
  await row(t, { atMs: T0 + 1, m: metrics() });

  const a = await aggregateRoutingTelemetry(t.DB, { untilMs: T0 });
  assert.equal(a.schema, ROUTING_TELEMETRY_SCHEMA);
  assert.equal(a.state, 'computed');
  assert.equal(a.store, 'ready');
  assert.deepEqual(a.window, { from: iso(T0 - 24 * 3600e3), to: iso(T0), hours: 24 });
  assert.equal(a.decisions, 7);
  assert.equal(a.withMetrics, 6);
  assert.equal(a.truncated, false);
  assert.deepEqual(a.bySource, { advice: 2, cached: 1, fallback: 2, 'degraded-stale': 0, none: 2, other: 0 });
  assert.deepEqual(a.byState, { admitted: 5, rejected: 1, proposed: 1, expired: 0, other: 0 });
  assert.deepEqual(a.failureCodes, { ADVICE_UPSTREAM: 1, NO_CANDIDATES: 1 });
  assert.equal(a.advice.attempted, 3);
  assert.equal(a.advice.completed, 2);
  assert.equal(a.advice.failed, 1);
  assert.deepEqual(a.advice.codes, { ADVICE_UPSTREAM: 1, ADVICE_DISALLOWED: 1 });
  assert.deepEqual(a.advice.latencyMs, { n: 3, p50: 100, p95: 300 });
  assert.equal(a.advice.inputTokens, 300);
  assert.equal(a.advice.outputTokens, 572);
  assert.equal(a.advice.spendUsdEst, 0.0015, 'a failed attempt still carries its worst-case spend estimate');
  assert.deepEqual(a.agreement, { known: 5, top1Agree: 4, top1AgreeRate: 80, orderKnown: 5, orderAgree: 4, orderAgreeRate: 80 });
  assert.deepEqual(a.cache, { hit: 1, staleHit: 0, miss: 5, unservable: 0, notChecked: 0, hitRate: 16.7 });
  assert.deepEqual(a.selection, { deterministic: 1, modelUnknown: 3, fallbackAfterAttempt: 1, noSelection: 1 });
  assert.deepEqual(a.decisionMs, { n: 5, p50: 8, p95: 20 }, 'injected clocks are excluded');
  assert.deepEqual(a.candidates, { eligibleMean: 4, scoredMean: 4 });
  assert.deepEqual(a.rates, { advicePct: 28.6, cachedPct: 14.3, fallbackPct: 28.6, nonePct: 28.6 });
  // Sanitized: no tenant, request, resource or alias material in the aggregate.
  const blob = JSON.stringify(a);
  for (const leak of ['u_alice', 'req_', 'op_', '"r1"', 'resourceId', 'ownerId']) assert.ok(!blob.includes(leak), leak);
});

test('telemetry: empty window says zero decisions, never invents rates', async () => {
  const t = await createTestEnv({});
  const a = await aggregateRoutingTelemetry(t.DB, { untilMs: T0 });
  assert.equal(a.decisions, 0);
  assert.equal(a.withMetrics, 0);
  assert.equal(a.agreement.top1AgreeRate, null);
  assert.equal(a.cache.hitRate, null);
  assert.deepEqual(a.decisionMs, { n: 0, p50: null, p95: null });
  assert.equal(a.rates.advicePct, null);
});

test('telemetry: row cap truncates honestly and codes stay bounded', async () => {
  const t = await createTestEnv({});
  for (let i = 0; i < 5; i++) await row(t, { atMs: T0 - 1000 - i, failure: { code: 'CODE_' + i, status: 500 } });
  for (let i = 0; i < 12; i++) await row(t, { atMs: T0 - 5000 - i, failure: { code: 'X' + i, status: 500 } });
  const a = await aggregateRoutingTelemetry(t.DB, { untilMs: T0, rowCap: 3 });
  assert.equal(a.decisions, 3);
  assert.equal(a.truncated, true);
  assert.equal(a.rowCap, 3);
  const full = await aggregateRoutingTelemetry(t.DB, { untilMs: T0 });
  assert.equal(full.decisions, 17);
  assert.ok(Object.keys(full.failureCodes).length <= 11, 'at most 10 codes plus OTHER');
  assert.ok(full.failureCodes.OTHER >= 1);
  assert.equal(TELEMETRY_ROW_CAP, 2000);
});

test('telemetry: missing routing ledger reports not-migrated without throwing', async () => {
  const t = await createTestEnv({});
  await t.DB.prepare('DROP TABLE routing_ops').run();
  const a = await aggregateRoutingTelemetry(t.DB, { untilMs: T0 });
  assert.equal(a.state, 'computed');
  assert.equal(a.store, 'not-migrated');
  assert.equal(a.decisions, null);
});
