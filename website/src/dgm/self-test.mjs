/* Built with Meta Muse. */
// Worker-cron DGM self-test runner (Worker-safe: no node: imports).
//
// One run stores exactly one row in dgm_self_tests with two independent
// parts:
// - snapshot_json: the deterministic policy check from ./eval-core.mjs (the
//   frozen baseline against every allowlisted weight candidate). It is a pure
//   function of the source code, so it changes only when the routing policy
//   or the workload changes: a regression detector, not a trend.
// - routing_json: the aggregate of real routing decisions in the 24 hours
//   before the run (./telemetry.mjs). This is the part that moves day to day.
// No network, no model calls, no keys, no credentials.
//
// Opt-in like every other capability on this site: runs only when
// env.DGM_SELF_TEST_ENABLED === '1'. Skips (never throws, never writes) when
// not enabled or when the table is absent (store-not-migrated). A throwing
// evaluator records state:'failed' with its code; a failing telemetry read
// records routing_json {state:'failed', code} beside a completed evaluation.
// Nothing is ever guessed. Retention keeps the newest SELF_TEST_RETENTION rows.
import { computeSelfTestSnapshot } from './eval-core.mjs';
import { aggregateRoutingTelemetry, ROUTING_TELEMETRY_SCHEMA } from './telemetry.mjs';

export const SELF_TEST_TRIGGER_CRON = 'cron';
export const SELF_TEST_TRIGGER_MANUAL = 'manual';
export const SELF_TEST_TRIGGERS = Object.freeze([SELF_TEST_TRIGGER_CRON, SELF_TEST_TRIGGER_MANUAL]);
export const SELF_TEST_RETENTION = 400;
export const SELF_TEST_LIST_LIMIT = 30;
// Mirrors wrangler.jsonc triggers.crons: 03:15 UTC daily.
export const SELF_TEST_CRON = '15 3 * * *';
export const SELF_TEST_CRON_HOUR_UTC = 3;
export const SELF_TEST_CRON_MINUTE_UTC = 15;

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `st_${c.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return `st_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

function isoOf(value) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  if (Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

/** Opt-in flag: exactly '1' enables the cron (house rule: dark by default). */
export function selfTestEnabled(env) {
  return !!env && env.DGM_SELF_TEST_ENABLED === '1';
}

/** The most recent scheduled fire at or before nowMs, as an ISO instant. */
export function lastScheduledRunAt(nowMs = Date.now()) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const d = new Date(now);
  let fire = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SELF_TEST_CRON_HOUR_UTC, SELF_TEST_CRON_MINUTE_UTC, 0, 0);
  if (fire > now) fire -= 24 * 3600 * 1000;
  return new Date(fire).toISOString();
}

export async function storePresent(db) {
  try {
    await db.prepare('SELECT 1 FROM dgm_self_tests LIMIT 0').all();
    return true;
  } catch (e) {
    if (e && typeof e.message === 'string' && e.message.includes('no such table')) return false;
    throw e;
  }
}

/**
 * Run one self-test and store exactly one row.
 * @param {object} opts {db, env, trigger ('cron'|'manual'), cron, nowMs,
 *   scheduledAt (ms or ISO from the cron controller), compute (injected
 *   snapshot fn for tests), telemetry (injected aggregate fn for tests)}
 */
export async function runDgmSelfTest({
  db, env = {}, trigger = SELF_TEST_TRIGGER_MANUAL, cron = null, nowMs = null, scheduledAt = null, compute = null, telemetry = null,
} = {}) {
  if (!db) throw Object.assign(new Error('self-test needs a database'), { code: 'DGM_SELF_TEST_NO_DB' });
  if (!SELF_TEST_TRIGGERS.includes(trigger)) {
    throw Object.assign(new Error(`unknown self-test trigger: ${String(trigger)}`), { code: 'DGM_SELF_TEST_BAD_TRIGGER' });
  }
  if (!selfTestEnabled(env)) {
    return { skipped: true, reason: 'disabled' };
  }
  if (!(await storePresent(db))) {
    return { skipped: true, reason: 'store-not-migrated' };
  }
  const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
  const at = new Date(now).toISOString();
  const scheduledIso = isoOf(scheduledAt);
  const t0 = Date.now();
  const computer = typeof compute === 'function' ? compute : computeSelfTestSnapshot;
  let snapshot = null;
  let state = 'completed';
  let code = null;
  try {
    snapshot = await computer();
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw Object.assign(new Error('snapshot computer returned no usable snapshot'), { code: 'DGM_EVAL_BAD_SNAPSHOT' });
    }
    // A snapshot that fails its own guardrails is not a result: its counts
    // and ceiling are meaningless. Record failed, keeping only the guardrail
    // verdicts as evidence (no ceiling, no weights, nothing to render).
    const guards = Array.isArray(snapshot.guardrails) ? snapshot.guardrails : null;
    if (!guards || guards.length === 0 || !guards.every((g) => g && g.passed === true)) {
      const kept = (guards || []).slice(0, 10).map((g) => ({ name: String((g && g.name) || 'unknown').slice(0, 64), passed: !!(g && g.passed === true) }));
      throw Object.assign(new Error('self-test guardrail failed'), { code: 'DGM_GUARDRAIL_FAILED', evidence: { guardrails: kept } });
    }
  } catch (e) {
    state = 'failed';
    code = (e && e.code) || 'DGM_EVAL_FAILED';
    snapshot = e && e.code === 'DGM_GUARDRAIL_FAILED' && e.evidence ? e.evidence : null;
  }
  // Live routing aggregate for the 24 h before this run. Independent of the
  // evaluation: a telemetry failure is recorded as such, never as zeros.
  let routing;
  try {
    const aggregate = typeof telemetry === 'function' ? telemetry : aggregateRoutingTelemetry;
    routing = await aggregate(db, { untilMs: now });
    if (!routing || typeof routing !== 'object') throw Object.assign(new Error('telemetry returned nothing'), { code: 'DGM_TELEMETRY_BAD_RESULT' });
  } catch (e) {
    routing = { schema: ROUTING_TELEMETRY_SCHEMA, state: 'failed', code: String((e && e.code) || 'DGM_TELEMETRY_FAILED').slice(0, 64) };
  }
  // Workers advance Date.now() only across I/O, so a pure CPU evaluation
  // usually records 0 here; Node records real elapsed time. Not a benchmark.
  const durationMs = Date.now() - t0;
  const id = newId();
  await db.prepare(
    'INSERT INTO dgm_self_tests (id, ran_at, scheduled_at, trigger_kind, state, code, cron, duration_ms, snapshot_json, routing_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, at, scheduledIso, trigger, state, code, cron, durationMs, snapshot === null ? null : JSON.stringify(snapshot), JSON.stringify(routing), at).run();
  await db.prepare(
    'DELETE FROM dgm_self_tests WHERE id NOT IN (SELECT id FROM dgm_self_tests ORDER BY ran_at DESC, rowid DESC LIMIT ?)',
  ).bind(SELF_TEST_RETENTION).run();
  return { completed: state === 'completed', id, state, code, durationMs, routingState: routing.state };
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text.length) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function projectRow(r) {
  return {
    id: typeof r.id === 'string' ? r.id : null,
    ranAt: typeof r.ran_at === 'string' ? r.ran_at : null,
    scheduledAt: typeof r.scheduled_at === 'string' ? r.scheduled_at : null,
    trigger: typeof r.trigger_kind === 'string' ? r.trigger_kind : null,
    state: typeof r.state === 'string' ? r.state : null,
    code: typeof r.code === 'string' ? r.code : null,
    cron: typeof r.cron === 'string' ? r.cron : null,
    durationMs: Number.isSafeInteger(r.duration_ms) ? r.duration_ms : null,
    snapshot: parseJsonObject(r.snapshot_json),
    routing: parseJsonObject(r.routing_json),
    createdAt: typeof r.created_at === 'string' ? r.created_at : null,
  };
}

/** Newest-first allowlisted rows (limit clamped to 1..SELF_TEST_LIST_LIMIT). */
export async function listSelfTests(db, { limit = SELF_TEST_LIST_LIMIT } = {}) {
  if (!db) throw Object.assign(new Error('self-test needs a database'), { code: 'DGM_SELF_TEST_NO_DB' });
  if (!(await storePresent(db))) return [];
  const n = Math.min(SELF_TEST_LIST_LIMIT, Math.max(1, Number.isSafeInteger(limit) ? limit : SELF_TEST_LIST_LIMIT));
  const out = await db.prepare(
    'SELECT id, ran_at, scheduled_at, trigger_kind, state, code, cron, duration_ms, snapshot_json, routing_json, created_at FROM dgm_self_tests ORDER BY ran_at DESC, rowid DESC LIMIT ?',
  ).bind(n).all();
  const rows = out && Array.isArray(out.results) ? out.results : [];
  return rows.map(projectRow);
}
