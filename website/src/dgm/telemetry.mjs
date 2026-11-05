// Live routing telemetry aggregation for the daily DGM self-test.
//
// Reads the sanitized per-decision `metrics` that decide.mjs persists inside
// routing_ops.ranking_json and reduces one time window to counts, rates and
// percentiles. This is the part of the self-test that can actually move from
// day to day: the deterministic policy check in eval-core.mjs is a pure
// function of the source code, while these figures follow real traffic.
//
// Sanitized by construction: the aggregate carries counts, rates, internal
// failure codes (bounded), token totals and estimated spend. No tenant ids,
// request ids, resource/owner/grant ids, aliases or provider text leave this
// module. Worker-safe: no node:* imports, no network, no model calls.
export const ROUTING_TELEMETRY_SCHEMA = 'aipster.dgm.routing-telemetry/v1';
export const TELEMETRY_WINDOW_MS = 24 * 3600 * 1000;
export const TELEMETRY_ROW_CAP = 2000;
const CODE_CAP = 10;
const CODE_MAX_CHARS = 64;

const int = (v) => (Number.isSafeInteger(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d) => (num(v) === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (n, d) => (Number.isSafeInteger(n) && Number.isSafeInteger(d) && d > 0 ? round((n / d) * 100, 1) : null);

// Nearest-rank percentile: for small samples p95 is the maximum, never an
// interpolated value that no decision actually took.
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function bump(map, code) {
  const key = typeof code === 'string' && code.length ? code.slice(0, CODE_MAX_CHARS) : 'UNKNOWN';
  if (map[key] === undefined && Object.keys(map).length >= CODE_CAP) { map.OTHER = (map.OTHER || 0) + 1; return; }
  map[key] = (map[key] || 0) + 1;
}

function parseMetrics(rankingJson) {
  if (typeof rankingJson !== 'string' || !rankingJson.length) return null;
  try {
    const body = JSON.parse(rankingJson);
    const m = body && typeof body === 'object' ? body.metrics : null;
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

function emptyWindow(from, to, windowMs) {
  return { from, to, hours: round(windowMs / 3600000, 2) };
}

/**
 * Aggregate routing decisions created in [untilMs - windowMs, untilMs).
 * Reads at most rowCap rows (newest first) and says so when truncated.
 * Returns {state:'computed'} with the aggregate, or {state:'computed',
 * store:'not-migrated'} when routing_ops is absent. Throws on other DB errors
 * (the caller records the failure, never a guessed aggregate).
 */
export async function aggregateRoutingTelemetry(db, { untilMs = Date.now(), windowMs = TELEMETRY_WINDOW_MS, rowCap = TELEMETRY_ROW_CAP } = {}) {
  if (!db) throw Object.assign(new Error('telemetry needs a database'), { code: 'DGM_TELEMETRY_NO_DB' });
  const until = Number.isFinite(untilMs) ? untilMs : Date.now();
  const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : TELEMETRY_WINDOW_MS;
  const cap = Number.isSafeInteger(rowCap) && rowCap > 0 ? rowCap : TELEMETRY_ROW_CAP;
  const to = new Date(until).toISOString();
  const from = new Date(until - span).toISOString();
  const base = { schema: ROUTING_TELEMETRY_SCHEMA, state: 'computed', window: emptyWindow(from, to, span) };
  let out;
  try {
    out = await db.prepare(
      'SELECT source, state, failure_code, ranking_json FROM routing_ops WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).bind(from, to, cap + 1).all();
  } catch (e) {
    if (e && typeof e.message === 'string' && e.message.includes('no such table')) {
      return { ...base, store: 'not-migrated', decisions: null };
    }
    throw e;
  }
  const rows = out && Array.isArray(out.results) ? out.results : [];
  const truncated = rows.length > cap;
  const use = truncated ? rows.slice(0, cap) : rows;

  const bySource = { advice: 0, cached: 0, fallback: 0, 'degraded-stale': 0, none: 0, other: 0 };
  const byState = { admitted: 0, rejected: 0, proposed: 0, expired: 0, other: 0 };
  const failureCodes = {};
  const adviceCodes = {};
  const advice = { attempted: 0, completed: 0, failed: 0, inputTokens: 0, outputTokens: 0, spendUsdEst: 0 };
  const adviceLatency = [];
  const decisionLatency = [];
  const agreement = { known: 0, top1Agree: 0, orderKnown: 0, orderAgree: 0 };
  const cache = { hit: 0, staleHit: 0, miss: 0, unservable: 0, notChecked: 0 };
  const selection = { deterministic: 0, modelUnknown: 0, fallbackAfterAttempt: 0, noSelection: 0 };
  let eligibleSum = 0; let eligibleN = 0; let scoredSum = 0; let scoredN = 0;
  let withMetrics = 0;

  for (const r of use) {
    const src = typeof r.source === 'string' && bySource[r.source] !== undefined ? r.source : 'other';
    bySource[src] += 1;
    const st = typeof r.state === 'string' && byState[r.state] !== undefined ? r.state : 'other';
    byState[st] += 1;
    if (typeof r.failure_code === 'string' && r.failure_code) bump(failureCodes, r.failure_code);
    const m = parseMetrics(r.ranking_json);
    if (!m) continue;
    withMetrics += 1;
    if (m.clock === 'live' && num(m.decisionMs) !== null) decisionLatency.push(m.decisionMs);
    const c = m.candidates && typeof m.candidates === 'object' ? m.candidates : {};
    if (int(c.eligible) !== null) { eligibleSum += c.eligible; eligibleN += 1; }
    if (int(c.scored) !== null) { scoredSum += c.scored; scoredN += 1; }
    if (m.cache === 'hit') cache.hit += 1;
    else if (m.cache === 'stale-hit') cache.staleHit += 1;
    else if (m.cache === 'miss') cache.miss += 1;
    else if (m.cache === 'unservable') cache.unservable += 1;
    else cache.notChecked += 1;
    if (typeof m.top1AgreesWithDeterministic === 'boolean') { agreement.known += 1; if (m.top1AgreesWithDeterministic) agreement.top1Agree += 1; }
    if (typeof m.orderAgreesWithDeterministic === 'boolean') { agreement.orderKnown += 1; if (m.orderAgreesWithDeterministic) agreement.orderAgree += 1; }
    const basis = m.selection && typeof m.selection === 'object' ? m.selection.basis : null;
    if (basis === 'deterministic-route/v1') selection.deterministic += 1;
    else if (basis === 'fallback-after-advice-attempt') selection.fallbackAfterAttempt += 1;
    else if (basis === 'no-selection') selection.noSelection += 1;
    else selection.modelUnknown += 1;
    const a = m.advice && typeof m.advice === 'object' ? m.advice : null;
    if (a && a.attempted === true) {
      advice.attempted += 1;
      if (a.outcome === 'advice') advice.completed += 1; else { advice.failed += 1; bump(adviceCodes, a.failureCode); }
      if (num(a.latencyMs) !== null) adviceLatency.push(a.latencyMs);
      const u = a.usage && typeof a.usage === 'object' ? a.usage : {};
      if (int(u.inputTokens) !== null) advice.inputTokens += u.inputTokens;
      if (int(u.outputTokens) !== null) advice.outputTokens += u.outputTokens;
      if (num(a.spendUsdEst) !== null) advice.spendUsdEst += a.spendUsdEst;
    } else if (a && a.failureCode) {
      // Not attempted (disabled, skipped, unconfigured, budget): keep the reason.
      bump(adviceCodes, a.failureCode);
    }
  }
  const decisions = use.length;
  return {
    ...base,
    store: 'ready',
    decisions,
    truncated,
    rowCap: cap,
    withMetrics,
    bySource,
    byState,
    failureCodes,
    advice: {
      attempted: advice.attempted,
      completed: advice.completed,
      failed: advice.failed,
      codes: adviceCodes,
      latencyMs: { n: adviceLatency.length, p50: percentile(adviceLatency, 0.5), p95: percentile(adviceLatency, 0.95) },
      inputTokens: advice.inputTokens,
      outputTokens: advice.outputTokens,
      spendUsdEst: round(advice.spendUsdEst, 6),
    },
    agreement: {
      known: agreement.known,
      top1Agree: agreement.top1Agree,
      top1AgreeRate: pct(agreement.top1Agree, agreement.known),
      orderKnown: agreement.orderKnown,
      orderAgree: agreement.orderAgree,
      orderAgreeRate: pct(agreement.orderAgree, agreement.orderKnown),
    },
    cache: { ...cache, hitRate: pct(cache.hit + cache.staleHit, cache.hit + cache.staleHit + cache.miss + cache.unservable) },
    selection,
    decisionMs: { n: decisionLatency.length, p50: percentile(decisionLatency, 0.5), p95: percentile(decisionLatency, 0.95) },
    candidates: { eligibleMean: eligibleN ? round(eligibleSum / eligibleN, 2) : null, scoredMean: scoredN ? round(scoredSum / scoredN, 2) : null },
    rates: {
      advicePct: pct(bySource.advice, decisions),
      cachedPct: pct(bySource.cached + bySource['degraded-stale'], decisions),
      fallbackPct: pct(bySource.fallback, decisions),
      nonePct: pct(bySource.none, decisions),
    },
  };
}
