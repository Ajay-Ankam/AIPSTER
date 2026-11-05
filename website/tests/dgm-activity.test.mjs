/* Built with Meta Muse. */
// DGM activity view-model tests: unknown/empty/failure/synthetic
// distinctions and escaping. Inputs use REAL shapes where they exist —
// evaluateFixture verdicts for gates/provenance and a real buildReport over
// a real runExperiment — so the tests prove the normalizer matches the
// actual endpoint/report schemas, not handcrafted fixtures. Run summaries
// keep the documented list shape (runId/fixture/status/envelopeLabel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_SCHEMA, OBJECTIVE, buildActivityView, escapeHtml,
} from '../src/dgm/activity.mjs';
import { evaluateFixture, RUN_STATUSES } from '../src/dgm/preview.mjs';
import { buildWorkload, WORKLOAD_VERSION, WORKLOAD_SEED } from '../../experiments/dgm-routing/workload.mjs';
import { runExperiment } from '../../experiments/dgm-routing/runner.mjs';
import { buildReport } from '../../experiments/dgm-routing/report.mjs';

const summaryOf = (over = {}) => ({
  runId: 'run_v1_abc', fixture: 'good', status: 'completed-preview',
  envelopeLabel: 'VALIDATED', createdAt: '2026-11-05T06:00:00.000Z', ...over,
});

// Real verdict shape (gates + provenance) with list-level identity overlaid,
// exactly as the router pairs a summary row with evaluateFixture output.
const detailOf = (verdict, over = {}) => ({
  runId: 'run_v1_abc',
  fixture: verdict.fixture,
  status: verdict.status,
  envelopeLabel: verdict.envelopeLabel,
  settlement: verdict.settlement,
  gates: verdict.gates,
  provenance: verdict.provenance,
  telemetry: { readStatus: 'ok', freshnessNote: 'fresh', outcomeCounts: {} },
  ...over,
});

function realLocalReport() {
  const workload = buildWorkload();
  const experiment = runExperiment({
    candidate: JSON.parse('{"weights":{"EXACT_TOKEN":60,"ONLINE":30,"FRESHNESS_MAX":20,"OWNED":10,"HEADROOM":5}}'),
    workload,
    proposalsUsed: 0,
  });
  assert.equal(experiment.refused, false);
  return buildReport({
    experiment, workloadVersion: WORKLOAD_VERSION, workloadSeed: WORKLOAD_SEED, sourceSha: 'test',
  }).report;
}

test('dgm activity: empty inputs render an honest empty state, never zeros', () => {
  const view = buildActivityView({});
  assert.equal(view.schema, ACTIVITY_SCHEMA);
  assert.equal(view.empty, true);
  assert.match(view.emptyNote, /No preview runs/);
  assert.deepEqual(view.experiments, []);
  assert.deepEqual(view.metrics, []);
  assert.ok(view.objective.length > 0);
  assert.ok(OBJECTIVE.includes('No production execution'));
});

test('dgm activity: fixture scores are labeled synthetic and hardcoded, not measured', () => {
  const verdict = evaluateFixture('good');
  assert.equal(verdict.status, 'completed-preview');
  const view = buildActivityView({ runs: [summaryOf()], runDetails: [detailOf(verdict)] });
  assert.equal(view.empty, false);
  assert.equal(view.experiments[0].state, 'inactive');
  const base = view.metrics.find((m) => m.side === 'baseline');
  const cand = view.metrics.find((m) => m.side === 'candidate');
  assert.deepEqual([base.value, base.unit, base.source, base.synthetic],
    [500000, 'ppm', 'fixture-table', true]);
  assert.match(base.note, /hardcoded/);
  assert.equal(cand.value, 700000);
  assert.equal(cand.synthetic, true);
  const promo = view.outcomes[0].promotion;
  assert.equal(promo.status, 'disabled');
  assert.equal(promo.approved, false);
});

test('dgm activity: rejected fixtures show unknown candidate, retained gates', () => {
  const verdict = evaluateFixture('bad-advice');
  assert.equal(verdict.status, 'validation-rejected');
  const view = buildActivityView({
    runs: [summaryOf({ status: 'validation-rejected', envelopeLabel: 'REJECTED' })],
    runDetails: [detailOf(verdict)],
  });
  const cand = view.metrics.find((m) => m.side === 'candidate');
  assert.equal(cand.known, false);
  assert.equal(cand.value, null);
  assert.match(cand.note, /rejected before/);
  assert.equal(view.failures.length, 2);
  assert.deepEqual(view.failures.map((f) => [f.kind, f.code]),
    [['gate', 'advice_shadow_only'], ['gate', 'archive_settled']]);
});

test('dgm activity: failed runs await review and surface as blockers, never running', () => {
  const verdict = evaluateFixture('corrupt-receipt');
  assert.equal(verdict.status, 'failed');
  const view = buildActivityView({
    runs: [summaryOf({ runId: 'r1', status: 'failed', envelopeLabel: 'VALIDATED' })],
    runDetails: [detailOf(verdict, { runId: 'r1', telemetry: { readStatus: 'degraded', unparsedRows: 2 } })],
  });
  assert.equal(view.experiments[0].state, 'awaiting-review');
  assert.ok(view.failures.some((f) => f.kind === 'telemetry' && f.code === 'degraded'));
  assert.ok(view.blockers.some((b) => b.includes('1 failed preview run')));
  assert.ok(!view.experiments.some((e) => e.state === 'running')), 'nothing executes here';
});

test('dgm activity: paused runs read paused, never running; unknown stays unknown', () => {
  const view = buildActivityView({
    runs: [summaryOf({ status: 'paused' }), summaryOf({ runId: 'rx', status: 'mystery' })],
    runDetails: [],
  });
  assert.equal(view.experiments[0].state, 'paused');
  assert.match(view.experiments[0].stateReason, /no execution in flight/);
  assert.equal(view.experiments[1].state, 'unknown');
  assert.match(view.experiments[1].stateReason, /not classified/);
});

test('dgm activity: every real run status maps without ever claiming running', () => {
  assert.deepEqual([...RUN_STATUSES].sort(),
    ['cancelled', 'completed-preview', 'failed', 'paused', 'validation-rejected']);
  const view = buildActivityView({
    runs: RUN_STATUSES.map((status, i) => summaryOf({ runId: `s${i}`, status })),
    runDetails: [],
  });
  const states = Object.fromEntries(view.experiments.map((e) => [e.id, e.state]));
  assert.deepEqual(states, {
    s0: 'inactive', s1: 'paused', s2: 'inactive', s3: 'awaiting-review', s4: 'inactive',
  });
  assert.ok(!view.experiments.some((e) => e.state === 'running'));
});

const museStatusOf = (over = {}) => ({
  schema: 'aipster.dgm.muse/v1',
  evaluation: 'fixture',
  provider: { model: 'muse-spark-1.3-contributor', configured: false },
  spendCapUsd: 1,
  spend: { scope: 'dgm-muse', window: 'all-time', capUsd: 1, status: 'uninitialised' },
  observedAt: '2026-11-05T06:15:00.000Z',
  ...over,
});

test('dgm activity: proposal ops use queued/fetching/stale-unknown, never active calls', () => {
  const view = buildActivityView({
    museStatus: museStatusOf(),
    museOps: [
      {
        opKey: 'op1', state: 'uncertain', unknownOutcome: 1,
        receipt: { model: 'muse-spark-1.3-contributor', modelVerified: true, responseId: 'resp_1', usage: { input_tokens: 120, output_tokens: 60 }, spendUsdReserved: 0.001, spendUsdUsed: null },
      },
      { opKey: 'op2', state: 'reserved' },
      { opKey: 'op3', state: 'fetching', unknownOutcome: 1 },
      { opKey: 'op4', state: 'fetching', unknownOutcome: 0 },
    ],
  });
  const byId = Object.fromEntries(view.experiments.map((e) => [e.id, e]));
  assert.equal(byId.op1.state, 'awaiting-review');
  assert.equal(byId.op1.modelVerified, true);
  assert.equal(byId.op2.state, 'queued');
  assert.equal(byId.op3.state, 'stale-unknown');
  assert.equal(byId.op4.state, 'fetching');
  assert.ok(!view.experiments.some((e) => e.state === 'running' || e.state === 'active'));
  const u = view.usage.find((x) => x.id === 'op1');
  assert.equal(u.usageKnown, true);
  assert.deepEqual([u.inputTokens, u.outputTokens], [120, 60]);
  assert.equal(u.spendUsedUsd, null);
  assert.equal(u.budgetKnown, false);
  assert.ok(view.failures.some((f) => f.kind === 'proposal'));
  assert.ok(view.blockers.some((b) => b.includes('fixture-only')));
  assert.ok(view.blockers.some((b) => b.includes('uncertain, failed, or quarantined')));
});

test('dgm activity: provider and budget follow the real muse status shape', () => {
  const off = buildActivityView({ museStatus: museStatusOf() });
  assert.deepEqual(off.provider, {
    known: true, configured: false, live: false,
    model: 'muse-spark-1.3-contributor', evaluation: 'fixture',
    observedAt: '2026-11-05T06:15:00.000Z',
  });
  assert.equal(off.budget.known, false);
  assert.equal(off.budget.ledgerStatus, 'uninitialised');
  const live = buildActivityView({
    museStatus: museStatusOf({
      evaluation: 'synthetic-live',
      provider: { model: 'muse-spark-1.3-contributor', configured: true },
      spend: {
        scope: 'dgm-muse', window: 'all-time', capUsd: 1,
        reservedUsd: 0.002, usedUsd: 0.0005, remainingUsd: 0.998,
        updatedAt: '2026-11-05T06:16:00.000Z',
      },
    }),
  });
  assert.equal(live.provider.live, true);
  assert.equal(live.budget.known, true);
  assert.deepEqual([live.budget.capUsd, live.budget.reservedUsd, live.budget.usedUsd, live.budget.remainingUsd],
    [1, 0.002, 0.0005, 0.998]);
  assert.match(live.budget.note, /not a bill/);
  const absent = buildActivityView({});
  assert.equal(absent.provider.known, false);
  assert.equal(absent.budget.ledgerStatus, 'unknown');
});

test('dgm activity: persisted op rows use unknown_outcome/receipt_json, quarantine on evidence', () => {
  // Persisted store shape (admissionBlockers columns), not the route shape.
  const view = buildActivityView({
    museOps: [
      { op_key: 'q1', state: 'cancelled', mode: 'live', unknown_outcome: 1, receipt_json: JSON.stringify({ note: 'sent then cancelled' }) },
      { op_key: 'q2', state: 'cancelled', mode: 'live', unknown_outcome: 0, receipt_json: JSON.stringify({ providerContact: 'sent', acceptance: 'unknown', billing: 'unknown' }) },
      { op_key: 'q3', state: 'cancelled', mode: 'fixture', unknown_outcome: 0, receipt_json: JSON.stringify({ cancelledFrom: 'fetching' }) },
      { op_key: 'q4', state: 'reconciled', mode: 'live', unknown_outcome: 1, receipt_json: JSON.stringify({ note: 'operator acknowledged' }) },
      { op_key: 'q5', state: 'cancelled', mode: 'live', unknown_outcome: 0, receipt_json: '{broken json' },
    ],
  });
  const byId = Object.fromEntries(view.experiments.map((e) => [e.id, e]));
  assert.equal(byId.q1.state, 'quarantined');
  assert.equal(byId.q2.state, 'quarantined');
  assert.equal(byId.q3.state, 'inactive');
  assert.equal(byId.q4.state, 'inactive');
  assert.match(byId.q4.stateReason, /operator-acknowledged/);
  assert.equal(byId.q5.state, 'inactive');
  const q2fail = view.failures.find((f) => f.experimentId === 'q2');
  assert.match(q2fail.detail, /sent\/unknown\/unknown/);
  const q1fail = view.failures.find((f) => f.experimentId === 'q1');
  assert.match(q1fail.detail, /sent then cancelled/);
  // Quarantined cancellations block admission exactly like uncertain ops.
  assert.ok(view.blockers.some((b) => b.includes('uncertain, failed, or quarantined')));
});

test('dgm activity: receipt error field becomes the failure code', () => {
  const view = buildActivityView({
    museOps: [{ op_key: 'e1', state: 'failed', receipt_json: JSON.stringify({ error: 'DGM_MUSE_UPSTREAM', billing: 'unknown' }) }],
  });
  assert.equal(view.failures[0].code, 'DGM_MUSE_UPSTREAM');
});

test('dgm activity: negative and non-integer counts render unknown, never asserted', () => {
  const view = buildActivityView({
    runs: [summaryOf()],
    runDetails: [detailOf(evaluateFixture('good'), {
      provenance: { fixture: 'good', baselineScorePpm: -5, candidateScorePpm: 1.5 },
    })],
    museOps: [{ opKey: 'op9', state: 'delivered', receipt: { usage: { input_tokens: -1, output_tokens: 2.5 } } }],
  });
  assert.equal(view.metrics.find((m) => m.side === 'baseline'), undefined);
  assert.equal(view.metrics.find((m) => m.side === 'candidate').known, false);
  assert.equal(view.usage[0].usageKnown, false);
});

test('dgm activity: real local report keeps guardrail failures on every outcome', () => {
  const report = realLocalReport();
  assert.ok(Array.isArray(report.guardrails));
  const failing = report.guardrails.filter((g) => g.passed === false).length;
  const view = buildActivityView({ localReports: [report] });
  const ms = view.metrics.filter((m) => m.source === 'synthetic-local');
  assert.equal(ms.length, 2);
  assert.ok(ms.every((m) => m.synthetic === true && m.unit === 'top1-hits' && m.n === 24));
  assert.match(ms[0].note, /not fabric quality/);
  assert.equal(view.failures.filter((f) => f.kind === 'guardrail').length, failing);
  const promo = view.outcomes[0].promotion;
  assert.equal(promo.approved, false);
  assert.ok(promo.status === 'ineligible' || promo.status === 'eligible-unapproved');
  assert.equal(view.experiments[0].sourceHash, 'test');
  assert.equal(view.experiments[0].title, 'local routing experiment (provenance unknown)');
  const live = buildActivityView({ localReports: [{ ...report, proposalProvenance: { evaluation: 'live', model: 'm' } }] });
  assert.equal(live.experiments[0].title, 'local routing experiment (live-proposed, synthetic evaluation)');
  const dry = buildActivityView({ localReports: [{ ...report, proposalProvenance: { evaluation: 'injected-offline' } }] });
  assert.equal(dry.experiments[0].title, 'local routing experiment (dry-run, offline)');
  // Guardrail failures survive on every outcome, including regressions.
  const failed = {
    ...report,
    outcome: 'regression',
    guardrails: report.guardrails.map((g, i) => (i === 0 ? { ...g, passed: false, evidence: 'synthetic-fail' } : g)),
  };
  const bad = buildActivityView({ localReports: [failed] });
  const kept = bad.failures.filter((f) => f.kind === 'guardrail');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].detail, 'synthetic-fail');
});

test('dgm activity: long untrusted strings are bounded', () => {
  const big = 'x'.repeat(5000);
  const view = buildActivityView({
    runs: [summaryOf({ runId: big, fixture: big })],
    runDetails: [detailOf(evaluateFixture('good'), { runId: big })],
  });
  assert.ok(view.experiments[0].id.length <= 256);
  assert.ok(view.experiments[0].title.length <= 256 + 'fixture '.length);
});

test('dgm activity: escaping neutralizes untrusted display strings', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('"quoted" & \'rest\''), '&quot;quoted&quot; &amp; &#39;rest&#39;');
  const view = buildActivityView({
    runs: [summaryOf({ fixture: '<img src=x>' })], runDetails: [],
  });
  assert.equal(escapeHtml(view.experiments[0].title), 'fixture &lt;img src=x&gt;');
});
