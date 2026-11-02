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
  museLiveEnabled, museProviderStatus, buildProposeRequest, proposeLive, runFixtureProposal,
} from './muse-provider.mjs';

// Read permission reuses the preview grant: no new grant shape, no new
// issuance path. Write authority is the EXISTING engineering-assignment
// permission (held by engineering_reviewer, not by read-only
// operations_observer): commissioning a bounded billable proposal is
// engineering evaluation work, and the observer role must never authorize
// model generation or cancellation alone. No ROLE_PERMISSIONS change.
export const DGM_MUSE_PERMISSION = 'admin.dgm.preview';
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

async function claimOp(db, tenant, opKey, digest) {
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
      const blockers = await all(db,
        "SELECT op_key, state FROM dgm_muse_ops WHERE tenant_id = ? AND state IN ('reserved','fetching','uncertain') ORDER BY updated_at ASC LIMIT 5",
        tenant);
      const uncertain = (blockers || []).filter((r) => r && r.state === 'uncertain');
      if (uncertain.length) {
        const names = uncertain.map((r) => r.op_key).join(', ');
        throw httpError(409, `Tenant has unresolved quarantined DGM proposal(s) (${names}): outcome unknown, no duplicate was sent. Reconcile each listed op from its stored evidence (GET ops/{key}), then cancel to close it out; a new key does not reconcile them.`, 'DGM_MUSE_UNCERTAIN');
      }
      if (blockers && blockers.length) {
        throw httpError(429, 'Another DGM proposal is already in flight for this tenant. Wait for it to settle or cancel it, then retry.', 'DGM_MUSE_IN_FLIGHT');
      }
      const now = new Date().toISOString();
      const res = await run(db,
        `INSERT INTO dgm_muse_ops (tenant_id, op_key, input_digest, state, receipt_json, created_at, updated_at)
         SELECT ?, ?, ?, 'reserved', NULL, ?, ? WHERE NOT EXISTS
         (SELECT 1 FROM dgm_muse_ops WHERE tenant_id = ? AND state IN ('reserved','fetching','uncertain'))`,
        tenant, opKey, digest, now, now, tenant);
      if (Number(res.meta.changes) === 1) return { outcome: 'claimed' };
      const raced = await first(db, 'SELECT op_key, input_digest, state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', tenant, opKey);
      if (raced) return claimOp(db, tenant, opKey, digest);
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

function receiptFor({ key, live, out, elapsedMs, replay }) {
  return {
    opKey: key,
    mode: live ? 'live' : 'fixture',
    evaluation: live ? 'synthetic-live' : 'fixture',
    model: live ? out.model : 'fixture',
    responseId: live ? out.responseId : null,
    usage: live ? out.usage : null,
    elapsedMs,
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
  const claim = await claimOp(db, tenant, key, digest);
  if (claim.outcome === 'replay') {
    if (!live || claim.state !== 'delivered') {
      if (claim.state === 'delivered' && !live) {
        return { status: 200, body: { proposal: runFixtureProposal(prompt), receipt: { ...claim.receipt, replay: true }, replay: true } };
      }
      return { status: 200, body: { proposal: null, receipt: { ...claim.receipt, replay: true }, replay: true, note: 'Proposal text is not stored; this replay returns the original receipt only.' } };
    }
    return { status: 200, body: { proposal: null, receipt: { ...claim.receipt, replay: true }, replay: true, note: 'Proposal text is not stored; this replay returns the original receipt only.' } };
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
    const receipt = receiptFor({ key, live, out, elapsedMs: Date.now() - t0, replay: false });
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
    const uncertain = e && (e.code === 'DGM_MUSE_TIMEOUT' || e.code === 'DGM_MUSE_UNREACHABLE');
    await markOp(db, tenant, key, ['fetching'], uncertain ? 'uncertain' : 'failed', {
      opKey: key, mode: 'live', evaluation: 'synthetic-live',
      error: e && e.code ? e.code : 'DGM_MUSE_ERROR',
      status: e && Number.isSafeInteger(e.status) ? e.status : 502, at: new Date().toISOString(),
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
  let marked;
  try {
    // Uncertain ops cancel too: operator-reviewed quarantine close-out.
    marked = await markOp(ctx.db, ctx.actor.user.id, opKey, ['reserved', 'fetching', 'uncertain'], 'cancelled', {
      opKey, mode: museLiveEnabled(ctx.env) ? 'live' : 'fixture', evaluation: museLiveEnabled(ctx.env) ? 'synthetic-live' : 'fixture',
      error: 'DGM_MUSE_CANCELLED', status: 200, at: new Date().toISOString(),
    });
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
