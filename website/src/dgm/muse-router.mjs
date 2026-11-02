/* Built with Meta Muse. */
// DGM Muse proposal routes (flag-gated slice, dark by default). Mounts under
// /api/admin/v1/dgm/muse/* from ./router.mjs, so the canonical-host guard,
// uniform denial, and existence-gated routing apply unchanged. Authorization
// is the site's session/grant pattern only (permission `admin.dgm.preview`,
// shared with the fixture preview: no new grant shape, no operator tokens,
// no `?token=` URLs) and persistence is the existing D1 DB.
//
// A proposal is bounded advisory text for DGM test inputs: it never
// executes, never promotes, and never relabels anything as production.
// promote/execute stay refused 501 with no code path enabling them, exactly
// like the preview slice. Live output carries evaluation 'synthetic-live';
// unconfigured callers get the deterministic fixture proposal labeled
// evaluation 'fixture'. Raw prompts, proposal text and provider bodies are
// never persisted: only sanitized receipts are stored (usage counts,
// response/model identity, timing).
import { all, first, run, rid, nowIso } from '../lib/store.js';
import { readJson, httpError } from '../lib/validate.js';
import { checkWriteBudget } from '../lib/quotas.js';
import {
  DGM_MUSE_SCHEMA, DGM_MUSE_MODEL, DGM_MUSE_PROMPT_MAX_BYTES, DGM_MUSE_RESPONSE_MAX,
  DGM_MUSE_PRICE_REF, DGM_MUSE_PRICE_VERSION, DGM_MUSE_PRICE_SOURCE,
  museLiveEnabled, museProviderStatus, buildProposeRequest, proposeLive, runFixtureProposal,
  museSpendCapUsd, museWorstCaseSpendUsd, museUsageSpendUsd,
} from './muse-provider.mjs';

// Read permission reuses the preview grant: no new grant shape, no new
// issuance path. Write authority is the EXISTING engineering-assignment
// permission (held by engineering_reviewer, not by read-only
// operations_observer): commissioning a bounded billable proposal is
// engineering evaluation work, and the observer role must never authorize
// model generation or cancellation alone. No ROLE_PERMISSIONS change.
export const DGM_MUSE_PERMISSION = 'admin.dgm.preview';
// A stranded reservation (no provider contact yet) or in-flight fetch older
// than this is settled by the admission sweep: `reserved` proves no call
// was sent (the only path to a call passes through `fetching`), `fetching`
// may have sent one, so it becomes `uncertain`, never silently dropped.
export const DGM_MUSE_STALE_MS = 10 * 60 * 1000;
export const DGM_MUSE_WRITE_PERMISSION = 'admin.engineering.assign';

async function requireMuseWrite(ctx) {
  const read = await ctx.requireAdmin(DGM_MUSE_PERMISSION);
  if (read.status) return read;
  return ctx.requireAdmin(DGM_MUSE_WRITE_PERMISSION);
}

const PREFIX = '/api/admin/v1/dgm/preview/muse';
const OP_TTL_MS = 24 * 3600 * 1000;
const RECEIPT_MAX = 4096;

function send(ctx, status, body) {
  return ctx.json(status, body);
}

async function shaHex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dgm-muse-proposal/v1:${text}`));
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}

function isId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v);
}

function checkProposeBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw httpError(400, 'DGM proposal body must be an object.', 'DGM_MUSE_BAD_BODY');
  }
  for (const k of Object.keys(raw)) {
    if (k !== 'prompt' && k !== 'opKey' && k !== 'mode') throw httpError(400, `Unknown DGM proposal field: ${JSON.stringify(k)}.`, 'DGM_MUSE_BAD_BODY');
  }
  // Explicit mode only: a requested real test is never silently answered
  // with a fixture. Omitted mode means fixture (labelled), never live.
  const mode = raw.mode === undefined ? 'fixture' : raw.mode;
  if (mode !== 'live' && mode !== 'fixture') {
    throw httpError(400, 'mode must be "live" or "fixture".', 'DGM_MUSE_BAD_BODY');
  }
  // UTF-8 bytes via TextEncoder (Worker-safe, no node:buffer import).
  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0 ||
      new TextEncoder().encode(raw.prompt).length > DGM_MUSE_PROMPT_MAX_BYTES) {
    throw httpError(400, `prompt must be 1..${DGM_MUSE_PROMPT_MAX_BYTES} bytes.`, 'DGM_MUSE_BAD_PROMPT');
  }
  let opKey = null;
  if (raw.opKey !== undefined) {
    if (!isId(raw.opKey)) throw httpError(400, 'opKey must be 1..64 id chars.', 'DGM_MUSE_BAD_KEY');
    opKey = raw.opKey;
  }
  return { prompt: raw.prompt, opKey, mode };
}

function storageMissing(e) {
  const msg = String((e && e.message) || e || '');
  return /no such table/i.test(msg);
}

function opAge(createdAt) {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return '';
  return `, ${Math.max(0, Math.round((Date.now() - ms) / 1000))}s old`;
}

function evaluationForMode(mode, fallback) {
  if (mode === 'live') return 'synthetic-live';
  if (mode === 'fixture') return 'fixture';
  return fallback || 'unknown';
}

async function sweepStrandedOps(db, tenant) {
  // Bounded-deadline recovery: reservations prove no provider contact (the
  // only path to a call passes through `fetching`), so they fail closed;
  // fetches may have sent a call, so they quarantine as uncertain. Either
  // way the tenant wedge clears without operator key knowledge.
  const cutoff = new Date(Date.now() - DGM_MUSE_STALE_MS).toISOString();
  let stranded = null;
  try {
    stranded = await all(db,
      "SELECT op_key, state, mode FROM dgm_muse_ops WHERE tenant_id = ? AND state IN ('reserved','fetching') AND created_at < ?",
      tenant, cutoff);
  } catch (e) {
    if (storageMissing(e)) throw httpError(503, 'DGM Muse proposal store is not migrated.', 'DGM_MUSE_UNAVAILABLE');
    throw e;
  }
  if (!stranded || !stranded.length) return 0;
  const now = nowIso();
  const stmts = stranded.map((r) => {
    const toFailed = r.state === 'reserved';
    const receipt = {
      opKey: r.op_key,
      mode: r.mode || null,
      evaluation: evaluationForMode(r.mode, null),
      error: 'DGM_MUSE_EXPIRED',
      status: 502,
      at: now,
      ...(toFailed
        ? { note: 'Reservation expired before provider contact; no provider call was sent.' }
        : { accepted: true, note: 'Expired while fetching; outcome unknown. Reconcile from stored evidence, then cancel.' }),
    };
    return db.prepare(
      `UPDATE dgm_muse_ops SET state = ?, receipt_json = ?, updated_at = ?
       WHERE tenant_id = ? AND op_key = ? AND state = ?`
    ).bind(toFailed ? 'failed' : 'uncertain', JSON.stringify(receipt), now, tenant, r.op_key, r.state);
  });
  await db.batch(stmts);
  return stranded.length;
}

async function claimOp(db, tenant, opKey, digest, mode) {
  let found;
  try {
    found = await first(db, 'SELECT op_key, input_digest, state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', tenant, opKey);
  } catch (e) {
    if (storageMissing(e)) throw httpError(503, 'DGM Muse proposal store is not migrated.', 'DGM_MUSE_UNAVAILABLE');
    throw e;
  }
  if (found) {
    if (found.input_digest !== digest) {
      throw httpError(409, 'Idempotency key was already used with a different prompt.', 'CHANGED_REPLAY');
    }
    if (found.state === 'delivered' || found.state === 'failed' || found.state === 'cancelled') {
      let receipt = null;
      try { receipt = found.receipt_json ? JSON.parse(found.receipt_json) : null; } catch { receipt = null; }
      return { outcome: 'replay', state: found.state, receipt };
    }
    if (found.state === 'uncertain') {
      let receipt = null;
      try { receipt = found.receipt_json ? JSON.parse(found.receipt_json) : null; } catch { receipt = null; }
      return { outcome: 'uncertain', receipt };
    }
    return { outcome: 'in-progress' };
  }
  // Unresolved outcomes block admission: an uncertain op quarantines the
  // tenant until it is reconciled (read evidence, then cancel). A different
  // opKey never bypasses this; cancellation closes quarantine explicitly.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await run(db, "DELETE FROM dgm_muse_ops WHERE tenant_id = ? AND state IN ('delivered','failed','cancelled') AND created_at < ?",
        tenant, new Date(Date.now() - OP_TTL_MS).toISOString());
      // Bounded-deadline recovery first: stranded rows settle to failed
      // (provably unsent) or uncertain (maybe sent) so no silent wedge
      // survives a lost key or a dead Worker.
      await sweepStrandedOps(db, tenant);
      const blockers = await all(db,
        "SELECT op_key, state, created_at FROM dgm_muse_ops WHERE tenant_id = ? AND state IN ('reserved','fetching','uncertain') ORDER BY updated_at ASC LIMIT 5",
        tenant);
      const uncertain = (blockers || []).filter((r) => r && r.state === 'uncertain');
      if (uncertain.length) {
        const names = uncertain.map((r) => r.op_key).join(', ');
        throw httpError(409, `Tenant has unresolved quarantined DGM proposal(s) (${names}): outcome unknown, no duplicate was sent. Reconcile each listed op from its stored evidence (GET ops/{key}), then cancel to close it out; a new key does not reconcile them.`, 'DGM_MUSE_UNCERTAIN');
      }
      if (blockers && blockers.length) {
        const named = blockers.slice(0, 3).map((r) => `${r.op_key} (${r.state}${opAge(r.created_at)})`).join(', ');
        throw httpError(429, `Another DGM proposal is already in flight for this tenant (${named}). Wait for it to settle or cancel it by key, then retry.`, 'DGM_MUSE_IN_FLIGHT');
      }
      const now = new Date().toISOString();
      const res = await run(db,
        `INSERT INTO dgm_muse_ops (tenant_id, op_key, input_digest, mode, state, receipt_json, created_at, updated_at)
         SELECT ?, ?, ?, ?, 'reserved', NULL, ?, ? WHERE NOT EXISTS
         (SELECT 1 FROM dgm_muse_ops WHERE tenant_id = ? AND state IN ('reserved','fetching','uncertain'))`,
        tenant, opKey, digest, mode, now, now, tenant);
      if (Number(res.meta.changes) === 1) return { outcome: 'claimed' };
      const raced = await first(db, 'SELECT op_key, input_digest, state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', tenant, opKey);
      if (raced) return claimOp(db, tenant, opKey, digest, mode);
      // A concurrent cancel may have cleared the blocker between the check
      // and the insert; retry rather than misreporting a settled race.
    } catch (e) {
      if (e && (e.status === 409 || e.status === 429)) throw e;
      if (storageMissing(e)) throw httpError(503, 'DGM Muse proposal store is not migrated.', 'DGM_MUSE_UNAVAILABLE');
      throw e;
    }
  }
  throw httpError(500, 'Proposal operation changed state unexpectedly.', 'DGM_MUSE_STATE');
}

async function markOp(db, tenant, opKey, fromStates, to, receipt = null) {
  const blob = receipt === null || receipt === undefined ? null : JSON.stringify(receipt);
  if (blob !== null && blob.length > RECEIPT_MAX) throw httpError(500, 'Receipt exceeds storage bound.', 'RECEIPT_TOO_LARGE');
  const res = await run(db,
    `UPDATE dgm_muse_ops SET state = ?, receipt_json = COALESCE(?, receipt_json), updated_at = ?
     WHERE tenant_id = ? AND op_key = ? AND state IN (${fromStates.map(() => '?').join(',')})`,
    to, blob, nowIso(), tenant, opKey, ...fromStates);
  return { ok: Number(res.meta.changes) === 1 };
}

function receiptFor({ key, live, out, elapsedMs, replay, spendReserved = 0, spendUsed = null }) {
  return {
    opKey: key,
    mode: live ? 'live' : 'fixture',
    evaluation: live ? 'synthetic-live' : 'fixture',
    model: live ? out.model : 'fixture',
    responseId: live ? out.responseId : null,
    usage: live ? out.usage : null,
    elapsedMs,
    spendUsdReserved: spendReserved,
    spendUsdUsed: spendUsed,
    schemaVersion: DGM_MUSE_SCHEMA,
    validation: 'pass',
    replay: !!replay,
    deliveredAt: new Date().toISOString(),
  };
}

async function proposeOnce({ db, env, actor, prompt, opKey, mode = 'fixture', fetchImpl }) {
  const tenant = actor.user.id;
  const key = opKey || rid('op_');
  // The digest binds mode and prompt: reusing a key across modes is a
  // changed replay, never a silent substitution of fixture for live.
  const digest = await shaHex(`${mode}:${prompt}`);
  if (mode === 'live' && !museLiveEnabled(env)) {
    throw httpError(503, 'Live DGM proposals are not configured; no fixture was substituted. Request mode "fixture" for a labelled dry run.', 'DGM_MUSE_UNAVAILABLE');
  }
  const live = mode === 'live';
  // Finite server-controlled spend admission (advisor pattern): the
  // worst-case bounded cost must fit an explicit operator-set cap, or the
  // call is refused before any budget is touched or row written. No user
  // budget is accepted; the production default is unset (fail closed).
  let spendReserved = 0;
  if (live) {
    const cap = museSpendCapUsd(env);
    spendReserved = museWorstCaseSpendUsd(prompt);
    if (!(cap > 0) || spendReserved > cap) {
      throw httpError(402, 'Live DGM proposal spend cap does not cover the worst-case bounded cost. No provider call was sent and nothing was charged.', 'DGM_MUSE_SPEND_EXCEEDED');
    }
  }
  const claim = await claimOp(db, tenant, key, digest, mode);
  if (claim.outcome === 'replay') {
    const stored = claim.receipt || {};
    // Truthful replays: delivered succeeds; failed replays its recorded
    // failure status/code; cancelled answers 409. Every replay names its
    // state — a failure is never reported as success.
    if (claim.state === 'delivered' && !live) {
      return { status: 200, body: { proposal: runFixtureProposal(prompt), receipt: { ...stored, replay: true }, state: 'delivered', replay: true } };
    }
    if (claim.state === 'delivered') {
      return { status: 200, body: { proposal: null, receipt: { ...stored, replay: true }, state: 'delivered', replay: true, note: 'Proposal text is not stored; this replay returns the original receipt only.' } };
    }
    if (claim.state === 'failed') {
      const code = typeof stored.error === 'string' && stored.error ? stored.error : 'DGM_MUSE_ERROR';
      const status = Number.isSafeInteger(stored.status) && stored.status >= 400 && stored.status <= 599 ? stored.status : 502;
      return { status, body: { proposal: null, receipt: { ...stored, replay: true }, state: 'failed', replay: true } };
    }
    if (claim.state === 'cancelled') {
      return { status: 409, body: { proposal: null, receipt: { ...stored, replay: true }, state: 'cancelled', replay: true, note: 'This operation was cancelled by operator review; its stored receipt is returned unchanged apart from the replay marker.' } };
    }
  }
  if (claim.outcome === 'in-progress') {
    throw httpError(409, 'This proposal is already running. Retry shortly with the same key.', 'DGM_MUSE_IN_PROGRESS');
  }
  if (claim.outcome === 'uncertain') {
    // Quarantined: a new key alone does not reconcile this op. The operator
    // reconciles via GET ops/{key} evidence, then cancels to close it out.
    throw httpError(409, `Proposal ${key} is quarantined: the provider response was lost, no duplicate was sent, and the outcome is unknown. Reconcile from the stored evidence (GET ops/${key}) before any new attempt; a new key does not reconcile this op.`, 'DGM_MUSE_UNCERTAIN');
  }
  const t0 = Date.now();
  const marked = await markOp(db, tenant, key, ['reserved'], 'fetching');
  if (!marked.ok) {
    // A concurrent operator cancel wins before any provider contact: no
    // provider call was sent on this attempt.
    const current = await first(db, 'SELECT state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', tenant, key);
    if (current && current.state === 'cancelled') {
      let receipt = null;
      try { receipt = current.receipt_json ? JSON.parse(current.receipt_json) : null; } catch { receipt = null; }
      throw httpError(409, 'Proposal was cancelled during admission; no provider call was sent.', 'DGM_MUSE_CANCELLED');
    }
    throw httpError(500, 'Proposal operation changed state unexpectedly.', 'DGM_MUSE_STATE');
  }
  if (!live) {
    const proposal = runFixtureProposal(prompt);
    const receipt = receiptFor({ key, live, out: {}, elapsedMs: Date.now() - t0, replay: false });
    const settled = await markOp(db, tenant, key, ['fetching'], 'delivered', receipt);
    if (!settled.ok) {
      const current = await first(db, 'SELECT state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', tenant, key);
      let cancelled = null;
      try { cancelled = current && current.receipt_json ? JSON.parse(current.receipt_json) : null; } catch { cancelled = null; }
      throw httpError(409, 'Proposal was cancelled before delivery; nothing was delivered.', 'DGM_MUSE_CANCELLED');
    }
    return { status: 200, body: { proposal, receipt, replay: false } };
  }
  try {
    const out = await proposeLive({ fetchImpl, apiKey: env.DGM_MUSE_API_KEY, prompt });
    const receipt = receiptFor({ key, live, out, elapsedMs: Date.now() - t0, replay: false, spendReserved, spendUsed: museUsageSpendUsd(out.usage) });
    const settled = await markOp(db, tenant, key, ['fetching'], 'delivered', receipt);
    if (!settled.ok) {
      // Local cancellation cannot recall an already-sent provider call: the
      // call counts as accepted, the response is discarded, and the ledger
      // keeps the operator's cancellation. Never overwritten as delivered.
      const current = await first(db, 'SELECT state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', tenant, key);
      let cancelled = null;
      try { cancelled = current && current.receipt_json ? JSON.parse(current.receipt_json) : null; } catch { cancelled = null; }
      return { status: 409, body: { proposal: null, receipt: cancelled, replay: false, note: 'Cancelled during provider flight. The provider call was already sent and counts as accepted, but no proposal was delivered; the cancellation stands.' } };
    }
    return { status: 200, body: { proposal: out.proposal, receipt, replay: false } };
  } catch (e) {
    // Unknown outcomes quarantine: lost responses AND accepted-but-unusable
    // provider output (the call was sent, so a new key must not duplicate
    // it). The worst-case reservation is retained on the receipt — charges
    // are never silently refunded; reconciliation is explicit cancel.
    const uncertain = e && (e.code === 'DGM_MUSE_TIMEOUT' || e.code === 'DGM_MUSE_UNREACHABLE' || e.accepted === true);
    await markOp(db, tenant, key, ['fetching'], uncertain ? 'uncertain' : 'failed', {
      opKey: key, mode: 'live', evaluation: 'synthetic-live',
      error: e && e.code ? e.code : 'DGM_MUSE_ERROR',
      status: e && Number.isSafeInteger(e.status) ? e.status : 502, at: new Date().toISOString(),
      spendUsdReserved: spendReserved,
      spendUsdUsed: null,
      chargeNote: 'Worst-case reservation retained; no automatic refund. Reconcile by cancelling.',
      ...(e && e.accepted === true ? { accepted: true } : {}),
      ...(e && Number.isSafeInteger(e.httpStatus) ? { httpStatus: e.httpStatus } : {}),
    });
    throw e;
  }
}

/**
 * Testable proposal core (no auth/CSRF/budget): validates the body, claims
 * the op, and runs fixture or one bounded live call. Route-tested through
 * the worker; live-tested here with an injected fetchImpl and zero network.
 */
export async function handleMusePropose({ db, env, actor, body, fetchImpl } = {}) {
  const { prompt, opKey, mode } = checkProposeBody(body);
  // UTF-8 byte length via TextEncoder: no node:buffer import, so the module
  // runs under the existing Worker compatibility (nodejs_als only).
  if (new TextEncoder().encode(JSON.stringify(buildProposeRequest(prompt))).length > 64 * 1024) {
    throw httpError(400, 'Proposal prompt exceeds the request envelope bound.', 'DGM_MUSE_BAD_PROMPT');
  }
  return proposeOnce({ db, env, actor, prompt, opKey, mode, fetchImpl });
}

async function statusRoute(ctx) {
  const gate = await ctx.requireAdmin(DGM_MUSE_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const live = museLiveEnabled(ctx.env);
  return send(ctx, 200, {
    schema: DGM_MUSE_SCHEMA,
    evaluation: live ? 'synthetic-live' : 'fixture',
    provider: museProviderStatus(ctx.env),
    authorization: { read: DGM_MUSE_PERMISSION, write: DGM_MUSE_WRITE_PERMISSION },
    modes: ['fixture', 'live'],
    spendCapUsd: museSpendCapUsd(ctx.env),
    priceRef: { version: DGM_MUSE_PRICE_VERSION, source: DGM_MUSE_PRICE_SOURCE, model: DGM_MUSE_PRICE_REF.model, limitsProvisional: true, liveVerificationRequired: true },
    constraints: {
      defaultState: 'off',
      contributorTrainingUse: 'Contributor mode permits training use of submitted content: operators must submit synthetic qualification input only.',
      inputMustBeSynthetic: 'Labelling the output synthetic does not make arbitrary input synthetic. Tenant, credential, personal, or production data must never be submitted.',
      liveRequires: ['DGM_MUSE_LIVE=1', 'server-side DGM_MUSE_API_KEY binding', 'DGM_MUSE_SPEND_CAP_USD covering the worst-case bounded cost', 'admin.engineering.assign grant'],
      spendAccounting: 'Worst-case cost is reserved per live call and retained on uncertain/failed receipts; no automatic refund. Reconciliation is explicit cancel.',
    },
    promotion: { promote: 'disabled', execute: 'disabled', detail: 'promotion is disabled; no code path enables it', code: 'ADMIN_NOT_IMPLEMENTED' },
    responseCapBytes: DGM_MUSE_RESPONSE_MAX,
    expectedModel: DGM_MUSE_MODEL,
    observedAt: nowIso(),
  });
}

async function proposeRoute(ctx, fetchImpl) {
  // Billable generation: read permission alone never suffices.
  const gate = await requireMuseWrite(ctx);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  let raw;
  try {
    raw = await readJson(ctx.request);
  } catch (error) {
    if (error && error.status) return send(ctx, error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
    throw error;
  }
  // Synchronous validation first: refused bodies charge nothing and write
  // nothing. The shared core re-validates as defense in depth.
  let body;
  try {
    body = checkProposeBody(raw);
  } catch (error) {
    if (error && error.status) return send(ctx, error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
    throw error;
  }
  // Live preflight before the budget charge (advisor pattern): unconfigured
  // or uncapped live requests are refused before any budget is touched or
  // row written. proposeOnce re-checks as defense in depth.
  if (body.mode === 'live') {
    if (!museLiveEnabled(ctx.env)) {
      return send(ctx, 503, { error: 'Live DGM proposals are not configured; no fixture was substituted. Request mode "fixture" for a labelled dry run.', code: 'DGM_MUSE_UNAVAILABLE' });
    }
    const cap = museSpendCapUsd(ctx.env);
    if (!(cap > 0) || museWorstCaseSpendUsd(body.prompt) > cap) {
      return send(ctx, 402, { error: 'Live DGM proposal spend cap does not cover the worst-case bounded cost. No provider call was sent and nothing was charged.', code: 'DGM_MUSE_SPEND_EXCEEDED' });
    }
  }
  await checkWriteBudget(ctx.db, ctx.actor.user.id);
  try {
    const out = await proposeOnce({ db: ctx.db, env: ctx.env, actor: ctx.actor, prompt: body.prompt, opKey: body.opKey, mode: body.mode, fetchImpl });
    return send(ctx, out.status, out.body);
  } catch (error) {
    if (error && error.status) return send(ctx, error.status, { error: error.message, code: error.code || 'DGM_MUSE_ERROR' });
    throw error;
  }
}

async function opRoute(ctx, opKey) {
  const gate = await ctx.requireAdmin(DGM_MUSE_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  let row;
  try {
    row = await first(ctx.db, 'SELECT state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', ctx.actor.user.id, opKey);
  } catch (e) {
    if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
    throw e;
  }
  if (!row) return send(ctx, 404, { error: 'DGM proposal operation not found.', code: 'DGM_MUSE_UNKNOWN_OP' });
  let receipt = null;
  try { receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null; } catch { receipt = null; }
  return send(ctx, 200, { opKey, state: row.state, receipt, evaluation: receipt && receipt.evaluation ? receipt.evaluation : 'fixture' });
}

async function cancelRoute(ctx, opKey) {
  // State-changing reconciliation: read permission alone never suffices.
  const gate = await requireMuseWrite(ctx);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  // Cancellation preserves: the prior receipt is merged, never replaced —
  // prior error/status/acceptance/evaluation survive, and the op's own
  // claim-time mode is recorded, never the current flag/key environment.
  // Unknown acceptance is therefore never erased or quashed, and a cancelled
  // quarantine still blocks nothing silently: the receipt says so.
  let current = null;
  try {
    current = await first(ctx.db, 'SELECT state, receipt_json, mode FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', ctx.actor.user.id, opKey);
  } catch (e) {
    if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
    throw e;
  }
  if (!current) return send(ctx, 404, { error: 'DGM proposal operation not found.', code: 'DGM_MUSE_UNKNOWN_OP' });
  if (current.state !== 'reserved' && current.state !== 'fetching' && current.state !== 'uncertain') {
    return send(ctx, 409, { error: `Proposal already settled as ${JSON.stringify(current.state)}; cancellation is a no-op.`, code: 'DGM_MUSE_STATE' });
  }
  let prior = null;
  try { prior = current.receipt_json ? JSON.parse(current.receipt_json) : null; } catch { prior = null; }
  const now = nowIso();
  const merged = {
    ...(prior || {}),
    opKey,
    state: 'cancelled',
    cancelledFrom: current.state,
    cancelledAt: now,
    error: (prior && prior.error) || 'DGM_MUSE_CANCELLED',
    status: (prior && Number.isSafeInteger(prior.status)) ? prior.status : 200,
    mode: current.mode || (prior && prior.mode) || null,
    evaluation: evaluationForMode(current.mode || (prior && prior.mode), (prior && prior.evaluation) || 'unknown'),
  };
  let marked;
  try {
    marked = await markOp(ctx.db, ctx.actor.user.id, opKey, ['reserved', 'fetching', 'uncertain'], 'cancelled', merged);
  } catch (e) {
    if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
    throw e;
  }
  if (!marked.ok) {
    let row = null;
    try {
      row = await first(ctx.db, 'SELECT state FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', ctx.actor.user.id, opKey);
    } catch (e) {
      if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
      throw e;
    }
    if (!row) return send(ctx, 404, { error: 'DGM proposal operation not found.', code: 'DGM_MUSE_UNKNOWN_OP' });
    return send(ctx, 409, { error: `Proposal already settled as ${JSON.stringify(row.state)}; cancellation is a no-op.`, code: 'DGM_MUSE_STATE' });
  }
  return opRoute(ctx, opKey);
}

async function disabledAction(ctx) {
  // Always refused before any op lookup: unknown ids answer identically.
  // No budget charge, no audit row, no state change of any kind.
  const gate = await ctx.requireAdmin(DGM_MUSE_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  return send(ctx, 501, {
    error: 'DGM promotion is disabled; no code path enables it.',
    code: 'ADMIN_NOT_IMPLEMENTED',
  });
}

const ID = '([A-Za-z0-9][A-Za-z0-9._:-]{0,63})';

export async function handleDgmMuse(ctx, { fetchImpl } = {}) {
  const { request, url } = ctx;
  const path = url.pathname;
  const method = request.method;

  if (path === `${PREFIX}/status` && method === 'GET') return statusRoute(ctx);
  if (path === `${PREFIX}/proposals` && method === 'POST') return proposeRoute(ctx, fetchImpl);
  {
    const m = new RegExp(`^${PREFIX}/ops/${ID}$`).exec(path);
    if (m && method === 'GET') return opRoute(ctx, m[1]);
  }
  {
    const m = new RegExp(`^${PREFIX}/ops/${ID}/cancel$`).exec(path);
    if (m && method === 'POST') return cancelRoute(ctx, m[1]);
  }
  {
    const m = new RegExp(`^${PREFIX}/ops/${ID}/(promote|execute)$`).exec(path);
    if (m && method === 'POST') return disabledAction(ctx);
  }
  // Unknown muse paths deny before revealing routing, like the preview 404.
  const gate = await ctx.requireAdmin(DGM_MUSE_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  return send(ctx, 404, { error: 'Unknown DGM Muse route.', code: 'NOT_FOUND' });
}
