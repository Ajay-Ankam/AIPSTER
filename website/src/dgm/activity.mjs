/* Built with Meta Muse. */
// DGM activity view model: a pure, dependency-free normalizer over
// already-fetched, already-authorized endpoint payloads (preview status,
// runs, run details, Muse proposal ops, Muse provider status) plus optional
// local routing-report artifacts. It performs no fetch, holds no credentials,
// and aggregates nothing across owners: every input is already scoped to one
// operator by the endpoints that served it.
//
// Every number carries its source, unit, and a synthetic flag. Fixture-table
// scores are labeled hardcoded, never measured. The synthetic top-1 proxy is
// labeled a proxy, never fabric quality. Promotion history is derived from
// records only: the website promote path is disabled (501), so preview runs
// honestly report no promotion history instead of inventing one.
export const ACTIVITY_SCHEMA = 'aipster.dgm.activity/v1';

export const OBJECTIVE = 'Bounded routing-improvement experiments: one frozen baseline routing policy versus one restricted declarative candidate, evaluated on synthetic routing decisions with human-only promotion. No production execution, no autonomous loop.';
export const HARNESS_PURSUIT = 'The harness pursues a single declared comparison per experiment — baseline routing decisions against candidate routing decisions over a fixed synthetic workload — and stops at a persisted comparison receipt. It does not search continuously, merge, deploy, or promote by itself.';

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Counts (tokens, scores, hits) must be finite and non-negative; anything
// else is unknown, never a rendered zero or a negative claim.
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
// Untrusted API strings are display-bounded; absence is never asserted.
const bound = (v, max = 256) => {
  const s = str(v);
  return s === null ? null : s.slice(0, max);
};
const MAX_FAILURES = 50;

/** Minimal HTML escaping for untrusted display strings (ids, labels, evidence). */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function metric({ experimentId, side, value, unit, n = null, source, synthetic, note = null }) {
  return {
    experimentId, side,
    known: typeof value === 'number' && Number.isFinite(value),
    value: typeof value === 'number' && Number.isFinite(value) ? value : null,
    unit, n, source, synthetic: synthetic === true, note,
  };
}

function usageEntry({ id, usage, spendReservedUsd, spendUsedUsd, budgetNote = null }) {
  const u = usage && typeof usage === 'object' ? usage : null;
  const input = u ? count(u.input_tokens) : null;
  const output = u ? count(u.output_tokens) : null;
  const reserved = num(spendReservedUsd) !== null && spendReservedUsd >= 0 ? spendReservedUsd : null;
  const used = num(spendUsedUsd) !== null && spendUsedUsd >= 0 ? spendUsedUsd : null;
  return {
    id,
    usageKnown: input !== null && output !== null,
    inputTokens: input, outputTokens: output,
    spendKnown: reserved !== null || used !== null,
    spendReservedUsd: reserved,
    spendUsedUsd: used,
    budgetKnown: budgetNote !== null,
    budgetNote,
  };
}

function previewState(status) {
  // Nothing here executes: `paused` is a held preview awaiting inspection,
  // never a running execution. Unrecognized statuses are `unknown`, never
  // asserted terminal as fact.
  if (status === 'paused') return { state: 'paused', reason: 'held for inspection; no execution in flight' };
  if (status === 'failed') return { state: 'awaiting-review', reason: 'evaluation failed; retained for operator review' };
  if (status === 'completed-preview' || status === 'cancelled' || status === 'validation-rejected') {
    return { state: 'inactive', reason: `terminal state ${status}` };
  }
  return { state: 'unknown', reason: `unrecognized status ${status || 'missing'}; not classified` };
}

function parseStoredReceipt(value) {
  // Persisted rows carry `receipt_json` (string); route responses carry a
  // parsed `receipt` object. Both are untrusted: parse defensively, bound
  // the input, never throw.
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 64 * 1024) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function unknownFlagOf(o) {
  return Number(o?.unknown_outcome) === 1 || Number(o?.unknownOutcome) === 1;
}

// Mirrors the server's rowMayHaveBeenSent predicate (flag plus retained
// receipt evidence, not the flag alone): a cancelled op that may have been
// sent stays quarantined until explicit operator reconciliation.
function mayHaveBeenSent(o, receipt) {
  if (unknownFlagOf(o)) return true;
  const r = receipt;
  if (r && typeof r === 'object') {
    if (r.providerContact === 'sent' || r.providerContact === 'unknown'
      || r.acceptance === 'accepted' || r.acceptance === 'unknown'
      || r.billing === 'possibly-chargeable' || r.accepted === true) return true;
    if (r.cancelledFrom === 'fetching' && o?.mode !== 'fixture') return true;
  }
  return false;
}

function opStateOf(o, receipt) {
  const state = str(o?.state);
  // `reserved` is queued: no call proven active. `fetching` may be active or
  // stale-unknown; the durable unknown-outcome flag decides.
  if (state === 'reserved') return { state: 'queued', reason: 'admitted, no call proven active' };
  if (state === 'fetching') {
    return unknownFlagOf(o)
      ? { state: 'stale-unknown', reason: 'fetching with unknown outcome; may be stale' }
      : { state: 'fetching', reason: 'in flight; provider contact unproven' };
  }
  if (state === 'uncertain' || state === 'failed') {
    return { state: 'awaiting-review', reason: `proposal ${state}; retained, no silent retry` };
  }
  if (state === 'cancelled') {
    return mayHaveBeenSent(o, receipt)
      ? { state: 'quarantined', reason: 'cancelled but may have been sent; operator reconcile required' }
      : { state: 'inactive', reason: 'cancelled, provably unsent' };
  }
  // `reconciled` is a real terminal state: the operator acknowledged the
  // unknown outcome explicitly; the evidence stays, the op rests.
  if (state === 'reconciled') {
    return { state: 'inactive', reason: 'terminal state reconciled (operator-acknowledged unknown outcome)' };
  }
  if (state === 'delivered') {
    return { state: 'inactive', reason: 'terminal state delivered' };
  }
  return { state: 'unknown', reason: `unrecognized state ${state || 'missing'}; not classified` };
}

function normalizeRun(summary, detail) {
  const runId = bound(summary?.runId) || bound(detail?.runId) || 'unknown';
  const status = str(summary?.status) || str(detail?.status) || 'unknown';
  const mapped = previewState(status);
  const d = detail && typeof detail === 'object' ? detail : {};
  const prov = d.provenance && typeof d.provenance === 'object' ? d.provenance : {};
  const experiments = [{
    id: runId,
    kind: 'preview-run',
    title: `fixture ${bound(summary?.fixture) || bound(d.fixture) || 'unknown'}`,
    state: mapped.state,
    stateReason: mapped.reason,
    status,
    createdAt: str(summary?.createdAt) || str(d.createdAt),
    model: null,
    modelVerified: false,
    sourceHash: null,
  }];
  const metrics = [];
  const base = count(prov.baselineScorePpm);
  if (base !== null) {
    metrics.push(metric({
      experimentId: runId, side: 'baseline', value: base, unit: 'ppm',
      source: 'fixture-table', synthetic: true,
      note: 'hardcoded fixture score, not measured',
    }));
  }
  const cand = count(prov.candidateScorePpm);
  metrics.push(cand !== null
    ? metric({
      experimentId: runId, side: 'candidate', value: cand, unit: 'ppm',
      source: 'fixture-table', synthetic: true,
      note: 'hardcoded fixture score, not measured',
    })
    : metric({
      experimentId: runId, side: 'candidate', value: NaN, unit: 'ppm',
      source: 'fixture-table', synthetic: true,
      note: 'no candidate score: rejected before any runner activity',
    }));
  const failures = [];
  for (const g of arr(d.gates)) {
    if (g && typeof g === 'object' && g.passed === false) {
      failures.push({ experimentId: runId, kind: 'gate', code: str(g.name) || 'unknown-gate', detail: str(g.evidence) || 'no evidence recorded' });
    }
  }
  const tele = d.telemetry && typeof d.telemetry === 'object' ? d.telemetry : null;
  if (tele && (tele.readStatus === 'degraded' || tele.readStatus === 'unavailable' || tele.readStatus === 'stale')) {
    failures.push({ experimentId: runId, kind: 'telemetry', code: tele.readStatus, detail: `unparsedRows=${num(tele.unparsedRows) ?? 'unknown'}` });
  }
  const outcomes = [{
    experimentId: runId,
    outcome: str(d.envelopeLabel) || 'unknown',
    promotion: { status: 'disabled', approved: false, detail: 'website promote/execute answer 501; no promotion history exists for preview runs' },
  }];
  return { experiments, metrics, outcomes, failures };
}

function normalizeOp(op) {
  const o = op && typeof op === 'object' ? op : {};
  const key = bound(o.opKey) || bound(o.op_key) || 'unknown';
  const receipt = parseStoredReceipt(o.receipt_json ?? o.receipt) || {};
  const mapped = opStateOf(o, receipt);
  const experiments = [{
    id: key,
    kind: 'muse-proposal',
    title: `proposal ${bound(o.mode) || 'unknown-mode'}`,
    state: mapped.state,
    stateReason: mapped.reason,
    status: str(o.state) || 'unknown',
    createdAt: str(o.createdAt) || str(o.created_at),
    model: str(receipt.model) || str(o.model),
    modelVerified: receipt.modelVerified === true && str(receipt.model) !== null,
    sourceHash: null,
  }];
  const failures = [];
  if (mapped.state === 'awaiting-review' || mapped.state === 'stale-unknown' || mapped.state === 'quarantined') {
    // Real receipt fields (error/note plus the contact/acceptance/billing
    // labels); anything absent falls back to generic retained text.
    const labels = [receipt.providerContact, receipt.acceptance, receipt.billing]
      .filter((v) => typeof v === 'string' && v.length > 0).join('/');
    failures.push({
      experimentId: key, kind: 'proposal',
      code: bound(receipt.error) || bound(o.state) || 'unknown',
      detail: bound(receipt.note)
        || (labels.length ? `contact/acceptance/billing: ${labels}; retained without automatic retry` : 'retained without automatic retry'),
    });
  }
  return {
    experiments,
    usage: [usageEntry({
      id: key,
      usage: receipt.usage || o.usage,
      spendReservedUsd: num(receipt.spendUsdReserved),
      spendUsedUsd: num(receipt.spendUsdUsed),
    })],
    failures,
  };
}

function normalizeLocalReport(report) {
  const r = report && typeof report === 'object' ? report : {};
  const id = `local-${str(r.evalVersion) || 'report'}-${str(r.generatedAt) || 'undated'}`;
  const outcome = str(r.outcome) || 'unknown';
  const heldBase = r.baseline?.heldout && typeof r.baseline.heldout === 'object' ? r.baseline.heldout : null;
  const heldCand = r.candidate?.heldout && typeof r.candidate.heldout === 'object' ? r.candidate.heldout : null;
  const metrics = [];
  if (heldBase && Number.isSafeInteger(heldBase.top1Hits)) {
    metrics.push(metric({
      experimentId: id, side: 'baseline', value: heldBase.top1Hits, unit: 'top1-hits',
      n: Number.isSafeInteger(heldBase.n) ? heldBase.n : null,
      source: 'synthetic-local', synthetic: true,
      note: 'measured on the synthetic held-out split; not fabric quality',
    }));
  }
  if (heldCand && Number.isSafeInteger(heldCand.top1Hits)) {
    metrics.push(metric({
      experimentId: id, side: 'candidate', value: heldCand.top1Hits, unit: 'top1-hits',
      n: Number.isSafeInteger(heldCand.n) ? heldCand.n : null,
      source: 'synthetic-local', synthetic: true,
      note: 'measured on the synthetic held-out split; not fabric quality',
    }));
  }
  // Guardrail failures are retained on every outcome — including
  // regressions — never dropped.
  const failures = [];
  for (const g of arr(r.guardrails)) {
    if (g && typeof g === 'object' && g.passed === false) {
      failures.push({
        experimentId: id, kind: 'guardrail',
        code: bound(g.name) || 'unknown-gate',
        detail: bound(g.evidence) || 'no evidence recorded',
      });
    }
  }
  // Title derives from the recorded provenance, never a fixed dry-run
  // claim: a future live-Meta-proposed synthetic evaluation must not be
  // mislabeled, and an unrecorded provenance stays unknown.
  const provEval = r.proposalProvenance && typeof r.proposalProvenance === 'object'
    ? r.proposalProvenance.evaluation : null;
  const title = provEval === 'live'
    ? 'local routing experiment (live-proposed, synthetic evaluation)'
    : provEval === 'injected-offline'
      ? 'local routing experiment (dry-run, offline)'
      : 'local routing experiment (provenance unknown)';
  return {
    experiments: [{
      id,
      kind: 'local-report',
      title,
      state: 'inactive',
      stateReason: `historical ${outcome}`,
      status: outcome,
      createdAt: str(r.generatedAt),
      model: r.proposalProvenance && typeof r.proposalProvenance === 'object' ? str(r.proposalProvenance.model) : null,
      modelVerified: false,
      sourceHash: str(r.sourceSha),
    }],
    metrics,
    outcomes: [{
      experimentId: id,
      outcome,
      promotion: {
        status: r.promotionEligible === true ? 'eligible-unapproved' : 'ineligible',
        approved: false,
        detail: bound(r.outcomeDetail) || 'no eligible local candidate applies itself',
      },
    }],
    failures,
  };
}

/**
 * Build the activity view. All inputs optional; anything absent renders as
 * an explicit unknown or an honest empty state — never as zeros, and never
 * as invented history.
 */
export function buildActivityView(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const summaries = arr(src.runs);
  const details = arr(src.runDetails);
  const detailById = new Map();
  for (const d of details) {
    const id = d && typeof d === 'object' ? (str(d.runId)) : null;
    if (id) detailById.set(id, d);
  }
  const experiments = [];
  const metrics = [];
  const outcomes = [];
  const failures = [];
  const usage = [];
  for (const s of summaries) {
    const id = s && typeof s === 'object' ? str(s.runId) : null;
    const part = normalizeRun(s, id ? detailById.get(id) : null);
    experiments.push(...part.experiments);
    metrics.push(...part.metrics);
    outcomes.push(...part.outcomes);
    failures.push(...part.failures);
  }
  const ops = arr(src.museOps);
  const blockers = [];
  for (const op of ops.slice(0, MAX_FAILURES)) {
    const part = normalizeOp(op);
    experiments.push(...part.experiments);
    usage.push(...part.usage);
    failures.push(...part.failures);
  }
  if (ops.length > MAX_FAILURES) {
    blockers.push(`${ops.length - MAX_FAILURES} additional proposal op(s) not shown; inspect individually`);
  }
  for (const rep of arr(src.localReports)) {
    const part = normalizeLocalReport(rep);
    experiments.push(...part.experiments);
    metrics.push(...part.metrics);
    outcomes.push(...part.outcomes);
    failures.push(...part.failures);
  }
  // Provider + budget from the ACTUAL muse status shape: top-level
  // provider/spend objects, never top-level configured/model.
  const muse = src.museStatus && typeof src.museStatus === 'object' ? src.museStatus : null;
  const provider = muse && typeof muse.provider === 'object' ? muse.provider : null;
  const providerConfigured = provider?.configured === true;
  const spend = muse && typeof muse.spend === 'object' ? muse.spend : null;
  const binding = src.status && typeof src.status === 'object' ? src.status.binding : null;
  if (binding && binding.state !== 'active') blockers.push('preview binding is not active; runs cannot start');
  if (muse && !providerConfigured) {
    blockers.push('Meta provider not configured: proposals answer fixture-only, never live');
  }
  const failedRuns = summaries.filter((s) => s && s.status === 'failed').length;
  if (failedRuns > 0) blockers.push(`${failedRuns} failed preview run(s) retained above`);
  const stuckOps = arr(src.museOps).filter((o) => {
    if (!o || typeof o !== 'object') return false;
    if (o.state === 'uncertain' || o.state === 'failed') return true;
    // A quarantined cancellation blocks admission exactly like an uncertain
    // op; recompute the predicate rather than trusting any caller label.
    if (o.state !== 'cancelled') return false;
    return mayHaveBeenSent(o, parseStoredReceipt(o.receipt_json ?? o.receipt));
  }).length;
  if (stuckOps > 0) blockers.push(`${stuckOps} proposal op(s) uncertain, failed, or quarantined; no silent retry`);
  const cappedFailures = failures.slice(0, MAX_FAILURES);
  if (failures.length > MAX_FAILURES) {
    cappedFailures.push({ experimentId: 'view', kind: 'truncated', code: 'FAILURE_CAP', detail: `${failures.length - MAX_FAILURES} further failure row(s) not shown` });
  }
  const empty = experiments.length === 0;
  // Budget from the persisted aggregate ledger (actual spend.* shape):
  // reserved is the admission bound, not a bill; used covers delivered
  // calls only and is a lower bound on known usage. Anything absent is
  // unknown — including the uninitialised and store-not-migrated states.
  const spendKnown = spend !== null && spend.status !== 'store-not-migrated' && spend.status !== 'uninitialised';
  const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const cap = money(spend?.capUsd);
  const reserved = money(spend?.reservedUsd);
  const used = money(spend?.usedUsd);
  const remaining = money(spend?.remainingUsd);
  const budget = {
    known: spendKnown && cap !== null && reserved !== null && used !== null && remaining !== null,
    capUsd: cap, reservedUsd: reserved, usedUsd: used, remainingUsd: remaining,
    updatedAt: str(spend?.updatedAt) || null,
    ledgerStatus: str(spend?.status) || (spendKnown ? 'active' : 'unknown'),
    note: 'reservedUsd is the admission bound, not a bill; usedUsd is reported usage from delivered calls only (lower bound on known usage), never a bill',
  };
  return {
    schema: ACTIVITY_SCHEMA,
    objective: OBJECTIVE,
    harness: HARNESS_PURSUIT,
    experiments,
    metrics,
    outcomes,
    usage,
    provider: {
      known: provider !== null,
      configured: providerConfigured,
      live: providerConfigured && str(muse?.evaluation) === 'synthetic-live',
      model: str(provider?.model),
      evaluation: str(muse?.evaluation),
      observedAt: str(muse?.observedAt),
    },
    budget,
    failures: cappedFailures,
    blockers,
    empty,
    emptyNote: empty ? 'No preview runs, proposal ops, or local reports on record. Start a preview run or a local dry-run experiment to populate this view.' : null,
  };
}
