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
  DGM_MUSE_ID_MAX, DGM_MUSE_META_MAX,
  museLiveEnabled, museProviderStatus, buildProposeRequest, proposeLive, runFixtureProposal,
  museWorstCaseSpendUsd, museUsageSpendUsd,
  museSpendCapMicros, museWorstCaseSpendMicros, museUsdToMicros,
  boundProviderText, extractProposalFixtureInput,
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
// Aggregate spend admission: one explicit scope and one explicit window.
// 'global' means every tenant and every op key shares the operator cap —
// a new key or a new user cannot start a fresh budget. 'all-time' means the
// window never resets automatically; no TTL, cancellation, or missing usage
// releases a reservation.
const SPEND_SCOPE = 'global';
const SPEND_WINDOW = 'all-time';
// States whose outcome is unknown or still running. A cancelled op that may
// have been sent stays in the quarantine set until an explicit operator
// reconciliation; a local cancel is bookkeeping, not proof.
//
// The cancelled branch cannot rely on `unknown_outcome` alone: migration 0028
// gave every pre-existing row the column default 0, including round-1 rows
// that were already uncertain or in flight, and a row can be written by a
// future path that forgets the flag. The retained receipt is therefore part
// of the predicate, so evidence — not only a flag — keeps a possibly-sent
// cancellation quarantined. Every pattern only ever makes the predicate more
// conservative.
//
// The phase literal `cancelledFrom:"fetching"` is contact evidence only for a
// mode that can reach the provider. Fixture mode has no transport path, so a
// fixture cancellation during its durable fetching phase is provably unsent
// and must stay usable; NULL/unknown mode stays conservative. Actual contact
// fields remain mode-independent, so fabricated sent evidence still blocks.
const SENT_EVIDENCE_PATTERNS = [
  '"providerContact":"sent"',
  '"providerContact":"unknown"',
  '"acceptance":"accepted"',
  '"acceptance":"unknown"',
  '"billing":"possibly-chargeable"',
  '"accepted":true',
  '"accepted": true',
];
const CANCELLED_FROM_FETCHING = '"cancelledFrom":"fetching"';
const SENT_EVIDENCE_SQL = SENT_EVIDENCE_PATTERNS.map((p) => `receipt_json LIKE '%${p}%'`).join(' OR ');
const CANCELLED_FROM_FETCHING_SQL = `receipt_json LIKE '%${CANCELLED_FROM_FETCHING}%'`;
const CANCELLED_MAY_HAVE_BEEN_SENT = `(
      unknown_outcome = 1
      OR ${SENT_EVIDENCE_SQL}
      OR (${CANCELLED_FROM_FETCHING_SQL} AND (mode IS NULL OR mode <> 'fixture')))`;
const BLOCKING_WHERE = `(state IN ('reserved','fetching','uncertain') OR (state = 'cancelled' AND ${CANCELLED_MAY_HAVE_BEEN_SENT}))`;
const RECONCILE_STATES = ['fetching', 'uncertain', 'cancelled'];

/**
 * The same derivation as CANCELLED_MAY_HAVE_BEEN_SENT, in JS, for rows
 * already read. Both encodings apply the same pattern list to the stored
 * receipt text (and the same mode rule for the phase literal), so a legacy
 * cancelled row is treated exactly as the SQL predicate treats it.
 */
function rowMayHaveBeenSent(row) {
  if (Number(row && row.unknown_outcome) === 1) return true;
  const text = String((row && row.receipt_json) || '').toLowerCase();
  if (SENT_EVIDENCE_PATTERNS.some((p) => text.includes(p.toLowerCase()))) return true;
  const fromFetching = text.includes(CANCELLED_FROM_FETCHING);
  if (fromFetching && (!row || row.mode !== 'fixture')) return true;
  // Parsed fallback keeps equivalent hand-written shapes conservative even
  // when their whitespace does not appear literally in the pattern list.
  const r = parseReceipt(row && row.receipt_json, null);
  if (!r || typeof r !== 'object') return false;
  if (r.providerContact === 'sent' || r.providerContact === 'unknown'
    || r.acceptance === 'accepted' || r.acceptance === 'unknown'
    || r.billing === 'possibly-chargeable'
    || r.accepted === true) return true;
  return r.cancelledFrom === 'fetching' && (!row || row.mode !== 'fixture');
}

function send(ctx, status, body) {
  return ctx.json(status, body);
}

async function sha256Hex(domain, text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}:${text}`));
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}

async function shaHex(text) {
  return sha256Hex('dgm-muse-proposal/v1', text);
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
  // A missing table is the un-migrated store; a missing column is the same
  // state for a database that stopped one migration short (e.g. 0027 without
  // 0028). Both fail closed with the same named code rather than leaking the
  // raw SQLite message through the generic 500 path.
  return /no such (table|column)/i.test(msg);
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

function parseReceipt(text, fallback = null) {
  if (!text) return fallback;
  try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
}

/** Bounded, redacted operator-supplied or provider-supplied text. */
function boundedText(value, max) {
  if (typeof value !== 'string') return null;
  const b = boundProviderText(value, max);
  return b ? b.value : null;
}

/**
 * Safe provider metadata copied from a typed failure into the durable
 * receipt. Only the documented fields, each bounded and redacted; the
 * provider's own `truncated` names are carried so a cut value is visible
 * rather than silently shortened. Usage is counts, never raw text.
 */
function boundedProviderMeta(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const meta = {};
  const put = (key, max) => {
    const v = boundedText(detail[key], max);
    if (v !== null && v !== '') meta[key] = v;
  };
  put('status', 32);
  put('incompleteReason', DGM_MUSE_META_MAX);
  put('model', DGM_MUSE_META_MAX);
  put('observedModel', DGM_MUSE_META_MAX);
  put('responseId', DGM_MUSE_ID_MAX);
  if (detail.usage && Number.isSafeInteger(detail.usage.input_tokens) && Number.isSafeInteger(detail.usage.output_tokens)
      && detail.usage.input_tokens >= 0 && detail.usage.output_tokens >= 0) {
    meta.usage = { input_tokens: detail.usage.input_tokens, output_tokens: detail.usage.output_tokens };
  }
  if (Array.isArray(detail.truncated) && detail.truncated.length) {
    meta.truncated = detail.truncated.filter((n) => typeof n === 'string').slice(0, 6);
  }
  return Object.keys(meta).length ? meta : null;
}

/**
 * Transport acceptance, provider terminal outcome and billing certainty are
 * three different things. This mapping never claims a bill and never claims
 * a call was definitely not billed when the transport cannot prove it.
 */
function classifyError(e) {
  const httpStatus = e && Number.isSafeInteger(e.httpStatus) ? e.httpStatus : null;
  if (e && e.accepted === true) {
    const saw2xx = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    return saw2xx
      ? { providerContact: 'sent', acceptance: 'accepted', billing: 'possibly-chargeable' }
      : { providerContact: 'sent', acceptance: 'unknown', billing: 'unknown' };
  }
  if (e && (e.code === 'DGM_MUSE_TIMEOUT' || e.code === 'DGM_MUSE_UNREACHABLE')) {
    // No response was observed: the request may never have arrived, or it
    // may have run with the reply lost.
    return { providerContact: 'unknown', acceptance: 'unknown', billing: 'unknown' };
  }
  // Definitive rejection (400/401/403/429): the provider answered and
  // refused; no generation was accepted.
  return { providerContact: 'sent', acceptance: 'not-accepted', billing: 'not-chargeable' };
}

/** The durable record written at claim time, before any network contact. */
function claimReceiptFor({ key, mode, spendMicros, at }) {
  const live = mode === 'live';
  return {
    opKey: key,
    mode,
    evaluation: evaluationForMode(mode, null),
    state: 'reserved',
    schemaVersion: DGM_MUSE_SCHEMA,
    claimedAt: at,
    providerContact: 'none',
    acceptance: 'not-sent',
    billing: 'not-chargeable',
    spendUsdReserved: spendMicros / 1e6,
    spendUsdUsed: null,
    chargeNote: live
      ? 'Worst-case reservation recorded at admission, before any provider contact. Cancellation does not release it and no automatic refund exists.'
      : 'Fixture operation: no provider contact and no spend.',
  };
}

async function lookupOp(db, tenant, opKey) {
  try {
    return await first(db, 'SELECT * FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', tenant, opKey);
  } catch (e) {
    if (storageMissing(e)) throw httpError(503, 'DGM Muse proposal store is not migrated.', 'DGM_MUSE_UNAVAILABLE');
    throw e;
  }
}

/** Replay/refusal classification for an already-existing operation row. */
function resolveExisting(found, digest) {
  if (found.input_digest !== digest) {
    throw httpError(409, 'Idempotency key was already used with a different prompt.', 'CHANGED_REPLAY');
  }
  const receipt = parseReceipt(found.receipt_json);
  if (found.state === 'delivered' || found.state === 'failed' || found.state === 'cancelled' || found.state === 'reconciled') {
    return { outcome: 'replay', state: found.state, receipt };
  }
  if (found.state === 'uncertain') return { outcome: 'uncertain', receipt };
  return { outcome: 'in-progress' };
}

/**
 * Admission blockers. `uncertain` covers unknown-outcome ops, including a
 * cancelled op that may still have been sent: cancelling is a local record
 * and cannot prove the provider call did not run. Only an explicit operator
 * reconciliation closes that quarantine.
 */
async function admissionBlockers(db, tenant) {
  const rows = await all(db,
    `SELECT op_key, state, mode, unknown_outcome, receipt_json, created_at FROM dgm_muse_ops
     WHERE tenant_id = ? AND ${BLOCKING_WHERE} ORDER BY updated_at ASC LIMIT 5`,
    tenant);
  // Same evidence rule as the SQL predicate: a cancelled row blocks when its
  // flag says so OR its retained receipt shows a possibly-sent call. This is
  // what keeps migrated rows (flag defaulted to 0) quarantined.
  const uncertain = (rows || []).filter((r) => r.state === 'uncertain' || (r.state === 'cancelled' && rowMayHaveBeenSent(r)));
  const inFlight = (rows || []).filter((r) => r.state === 'reserved' || r.state === 'fetching');
  return { uncertain, inFlight };
}

async function sweepStrandedOps(db, tenant) {
  // Bounded-deadline recovery: a reservation proves no provider contact (the
  // only path to a call passes through `fetching`), so it fails closed; a
  // stale live fetch may have sent a call, so it quarantines as uncertain.
  // A stale FIXTURE fetch is proof of no provider contact (that mode never
  // calls out), so it also fails closed. Prior claim-time receipts are
  // merged, never replaced: the reservation and contact/acceptance
  // classification survive the sweep.
  const cutoff = new Date(Date.now() - DGM_MUSE_STALE_MS).toISOString();
  let stranded = null;
  try {
    stranded = await all(db,
      "SELECT op_key, state, mode, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND state IN ('reserved','fetching') AND created_at < ?",
      tenant, cutoff);
  } catch (e) {
    if (storageMissing(e)) throw httpError(503, 'DGM Muse proposal store is not migrated.', 'DGM_MUSE_UNAVAILABLE');
    throw e;
  }
  if (!stranded || !stranded.length) return 0;
  const now = nowIso();
  const stmts = stranded.map((r) => {
    const mayHaveBeenSent = r.state === 'fetching' && r.mode !== 'fixture';
    const prior = parseReceipt(r.receipt_json, {}) || {};
    const receipt = {
      ...prior,
      opKey: r.op_key,
      mode: r.mode || prior.mode || null,
      evaluation: evaluationForMode(r.mode || prior.mode, prior.evaluation || null),
      error: 'DGM_MUSE_EXPIRED',
      status: 502,
      at: now,
      ...(mayHaveBeenSent
        ? {
          accepted: true,
          providerContact: 'sent',
          acceptance: 'unknown',
          billing: 'unknown',
          note: 'Expired while fetching; the call may have been sent and its outcome is unknown. Reconcile with an explicit operator acknowledgement.',
        }
        : {
          providerContact: 'none',
          acceptance: 'not-sent',
          billing: 'not-chargeable',
          note: r.mode === 'fixture'
            ? 'Fixture operation expired before delivery; that mode never contacts the provider, so no provider call was sent and no spend occurred.'
            : 'Reservation expired before provider contact; no provider call was sent and no charge can have occurred.',
        }),
    };
    return db.prepare(
      `UPDATE dgm_muse_ops SET state = ?, receipt_json = ?, unknown_outcome = ?, updated_at = ?
       WHERE tenant_id = ? AND op_key = ? AND state = ?`
    ).bind(mayHaveBeenSent ? 'uncertain' : 'failed', JSON.stringify(receipt), mayHaveBeenSent ? 1 : 0, now, tenant, r.op_key, r.state);
  });
  await db.batch(stmts);
  return stranded.length;
}

function uncertainError(rows) {
  const names = rows.map((r) => r.op_key).join(', ');
  const cancelled = rows.filter((r) => r.state === 'cancelled').map((r) => r.op_key);
  return httpError(409,
    `Tenant has unresolved quarantined DGM proposal(s) (${names})${cancelled.length ? `; cancelled locally with an unknown provider outcome: ${cancelled.join(', ')}` : ''}. No duplicate was sent and none will be. Read the stored evidence (GET ops/{key}) and reconcile each op with an explicit acknowledgement (POST ops/{key}/reconcile). A new key does not reconcile them, and cancelling does not release the quarantine.`,
    'DGM_MUSE_UNCERTAIN');
}

function inFlightError(rows) {
  const named = rows.slice(0, 3).map((r) => `${r.op_key} (${r.state}${opAge(r.created_at)})`).join(', ');
  return httpError(429,
    `Another DGM proposal is already in flight for this tenant (${named}). Wait for it to settle, or cancel it by key; cancelling an in-flight call keeps its unknown outcome quarantined until an explicit reconciliation.`,
    'DGM_MUSE_IN_FLIGHT');
}

async function claimOp(db, tenant, opKey, digest, mode, { spendMicros = 0, capMicros = 0 } = {}) {
  // An existing key is resolved first: replay, changed-input refusal and
  // in-flight/quarantine answers never depend on current activation config.
  const existing = await lookupOp(db, tenant, opKey);
  if (existing) return resolveExisting(existing, digest);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // TTL cleanup never deletes a blocking row: an uncertain op, or a
      // cancelled op whose provider outcome is unknown, is evidence and
      // quarantine — expiry must not become an automatic replay escape.
      await run(db, `DELETE FROM dgm_muse_ops WHERE tenant_id = ? AND created_at < ? AND NOT ${BLOCKING_WHERE}`,
        tenant, new Date(Date.now() - OP_TTL_MS).toISOString());
      // Bounded-deadline recovery first: stranded rows settle to failed
      // (provably unsent) or uncertain (maybe sent) so no silent wedge
      // survives a lost key or a dead Worker.
      await sweepStrandedOps(db, tenant);
      const { uncertain, inFlight } = await admissionBlockers(db, tenant);
      if (uncertain.length) throw uncertainError(uncertain);
      if (inFlight.length) throw inFlightError(inFlight);
      const now = nowIso();
      const claimReceipt = claimReceiptFor({ key: opKey, mode, spendMicros, at: now });
      const blob = JSON.stringify(claimReceipt);
      if (blob.length > RECEIPT_MAX) throw httpError(500, 'Receipt exceeds storage bound.', 'RECEIPT_TOO_LARGE');
      const insertSql = (guard) => `INSERT INTO dgm_muse_ops
        (tenant_id, op_key, input_digest, mode, state, receipt_json, unknown_outcome, spend_micros, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'reserved', ?, 0, ?, ?, ? WHERE NOT EXISTS
        (SELECT 1 FROM dgm_muse_ops WHERE tenant_id = ? AND ${BLOCKING_WHERE})${guard ? ' AND changes() = 1' : ''}`;
      if (spendMicros > 0) {
        // ONE conditional UPDATE is the aggregate admission: the reservation
        // increments only while the whole-window total stays within the
        // operator cap, so concurrent and sequential claims serialize and
        // the cap bounds the SUM, not one call. The window row is created
        // lazily in the same batch, so a fresh deployment needs no seeded
        // data and the first admission still happens atomically.
        const seed = db.prepare(
          'INSERT OR IGNORE INTO dgm_muse_spend (scope, window_key, reserved_micros, used_micros, updated_at) VALUES (?, ?, 0, 0, ?)'
        ).bind(SPEND_SCOPE, SPEND_WINDOW, now);
        const reserve = db.prepare(
          `UPDATE dgm_muse_spend SET reserved_micros = reserved_micros + ?, updated_at = ?
           WHERE scope = ? AND window_key = ? AND reserved_micros + ? <= ?`
        ).bind(spendMicros, now, SPEND_SCOPE, SPEND_WINDOW, spendMicros, capMicros);
        const insert = db.prepare(insertSql(true))
          .bind(tenant, opKey, digest, mode, blob, spendMicros, now, now, tenant);
        const out = await db.batch([seed, reserve, insert]);
        if (Number(out[2].meta.changes) === 1) return { outcome: 'claimed', receipt: claimReceipt };
        if (Number(out[1].meta.changes) === 0) {
          throw httpError(402, 'Aggregate live DGM proposal spend for this deployment and window would exceed the operator cap. No provider call was sent, no operation was reserved, and nothing was charged.', 'DGM_MUSE_SPEND_EXCEEDED');
        }
        // The reservation applied but the op row lost a race: release
        // exactly this attempt's reservation (never more) and resolve again.
        await run(db,
          'UPDATE dgm_muse_spend SET reserved_micros = CASE WHEN reserved_micros >= ? THEN reserved_micros - ? ELSE 0 END, updated_at = ? WHERE scope = ? AND window_key = ?',
          spendMicros, spendMicros, nowIso(), SPEND_SCOPE, SPEND_WINDOW);
      } else {
        const res = await run(db, insertSql(false),
          tenant, opKey, digest, mode, blob, 0, now, now, tenant);
        if (Number(res.meta.changes) === 1) return { outcome: 'claimed', receipt: claimReceipt };
      }
      const raced = await lookupOp(db, tenant, opKey);
      if (raced) return resolveExisting(raced, digest);
      // A concurrent cancel/reconcile may have cleared a blocker between the
      // check and the insert; retry rather than misreporting a settled race.
    } catch (e) {
      if (e && (e.status === 402 || e.status === 409 || e.status === 429)) throw e;
      if (storageMissing(e)) throw httpError(503, 'DGM Muse proposal store is not migrated.', 'DGM_MUSE_UNAVAILABLE');
      throw e;
    }
  }
  throw httpError(500, 'Proposal operation changed state unexpectedly.', 'DGM_MUSE_STATE');
}

async function markOp(db, tenant, opKey, fromStates, to, receipt = null, { unknownOutcome = null } = {}) {
  const blob = receipt === null || receipt === undefined ? null : JSON.stringify(receipt);
  if (blob !== null && blob.length > RECEIPT_MAX) throw httpError(500, 'Receipt exceeds storage bound.', 'RECEIPT_TOO_LARGE');
  const res = await run(db,
    `UPDATE dgm_muse_ops SET state = ?, receipt_json = COALESCE(?, receipt_json),
       unknown_outcome = COALESCE(?, unknown_outcome), updated_at = ?
     WHERE tenant_id = ? AND op_key = ? AND state IN (${fromStates.map(() => '?').join(',')})`,
    to, blob, unknownOutcome, nowIso(), tenant, opKey, ...fromStates);
  return { ok: Number(res.meta.changes) === 1 };
}

/**
 * Delivered settlement + reported-usage accounting in one batch. The op
 * update is the fence (only a still-`fetching` row settles); the spend
 * update runs only when that fence applied, so a late result after a cancel
 * never books usage against the aggregate.
 */
async function settleDelivered(db, tenant, opKey, receipt, usedMicros) {
  const blob = JSON.stringify(receipt);
  if (blob.length > RECEIPT_MAX) throw httpError(500, 'Receipt exceeds storage bound.', 'RECEIPT_TOO_LARGE');
  const now = nowIso();
  const stmts = [
    db.prepare(
      `UPDATE dgm_muse_ops SET state = 'delivered', receipt_json = ?, unknown_outcome = 0, updated_at = ?
       WHERE tenant_id = ? AND op_key = ? AND state = 'fetching'`
    ).bind(blob, now, tenant, opKey),
  ];
  if (usedMicros > 0) {
    stmts.push(db.prepare(
      `UPDATE dgm_muse_spend SET used_micros = used_micros + ?, updated_at = ?
       WHERE scope = ? AND window_key = ? AND changes() = 1`
    ).bind(usedMicros, now, SPEND_SCOPE, SPEND_WINDOW));
  }
  const out = await db.batch(stmts);
  return { ok: Number(out[0].meta.changes) === 1 };
}

/**
 * A late success/error after an operator cancel (or a reconciliation) is
 * real evidence: the call left the process. Record it under `lateOutcome`
 * inside the existing receipt without changing the settled state — a
 * cancelled op is never rewritten as delivered, and the reservation and
 * unknown-outcome mark stay untouched.
 */
async function recordLateEvidence(db, tenant, opKey, patch) {
  const row = await lookupOp(db, tenant, opKey);
  if (!row || (row.state !== 'cancelled' && row.state !== 'reconciled')) return false;
  const prior = parseReceipt(row.receipt_json, {}) || {};
  const merged = { ...prior, lateOutcome: { ...patch, at: nowIso() } };
  const blob = JSON.stringify(merged);
  if (blob.length > RECEIPT_MAX) {
    // Fall back to a compact but still truthful record rather than dropping
    // the fact that a call completed late.
    const compact = {
      ...prior,
      lateOutcome: { at: nowIso(), kind: patch.kind, note: 'Late provider evidence existed but exceeded the receipt bound; core classification kept.' },
    };
    await run(db, "UPDATE dgm_muse_ops SET receipt_json = ?, updated_at = ? WHERE tenant_id = ? AND op_key = ? AND state IN ('cancelled','reconciled')",
      JSON.stringify(compact), nowIso(), tenant, opKey);
    return true;
  }
  await run(db, "UPDATE dgm_muse_ops SET receipt_json = ?, updated_at = ? WHERE tenant_id = ? AND op_key = ? AND state IN ('cancelled','reconciled')",
    blob, nowIso(), tenant, opKey);
  return true;
}

function receiptFor({
  key, live, out, elapsedMs, replay,
  spendReserved = 0, spendUsed = null,
  proposalHash = null, proposalChars = null, proposalInput = null,
}) {
  return {
    opKey: key,
    mode: live ? 'live' : 'fixture',
    evaluation: live ? 'synthetic-live' : 'fixture',
    model: live ? out.model : 'fixture',
    modelTruncated: live ? !!out.modelTruncated : false,
    responseId: live ? out.responseId : null,
    responseIdTruncated: live ? !!out.responseIdTruncated : false,
    usage: live ? out.usage : null,
    elapsedMs,
    spendUsdReserved: spendReserved,
    spendUsdUsed: spendUsed,
    // Three distinct facts: the request left the process, the provider
    // returned a terminal accepted result, and billing is not established
    // by any of this evidence.
    providerContact: live ? 'sent' : 'none',
    acceptance: live ? 'accepted' : 'not-sent',
    billing: live ? 'possibly-chargeable' : 'not-chargeable',
    // Content identity only: the proposal text itself is never stored. The
    // hash and the bounded allowlisted input bind a run to what was
    // delivered without persisting provider output.
    proposalHash,
    proposalChars,
    proposalInput: proposalInput ? { fixture: proposalInput } : null,
    schemaVersion: DGM_MUSE_SCHEMA,
    validation: 'pass',
    replay: !!replay,
    deliveredAt: new Date().toISOString(),
  };
}

/** Replay/refusal answer for an already-existing operation row. */
function replayOrThrow(claim, { prompt, live, key }) {
  if (claim.outcome === 'replay') {
    const stored = claim.receipt || {};
    // Truthful replays: delivered succeeds; failed replays its recorded
    // failure status/code; cancelled/reconciled answer 409. Every replay
    // names its state — a failure is never reported as success, and an
    // unknown outcome is never replayed as a clean one.
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
      return { status: 409, body: { proposal: null, receipt: { ...stored, replay: true }, state: 'cancelled', replay: true, note: 'This operation was cancelled by operator review; its stored receipt is returned unchanged apart from the replay marker. A cancellation is local bookkeeping and does not prove the call was not sent or billed.' } };
    }
    if (claim.state === 'reconciled') {
      return { status: 409, body: { proposal: null, receipt: { ...stored, replay: true }, state: 'reconciled', replay: true, note: 'This operation was reconciled by an operator with an explicit acknowledgement of its unknown provider outcome; its stored receipt is returned unchanged apart from the replay marker.' } };
    }
  }
  if (claim.outcome === 'in-progress') {
    throw httpError(409, 'This proposal is already running. Retry shortly with the same key.', 'DGM_MUSE_IN_PROGRESS');
  }
  if (claim.outcome === 'uncertain') {
    // Quarantined: a new key alone does not reconcile this op.
    throw httpError(409, `Proposal ${key} is quarantined: the outcome is unknown, no duplicate was sent, and none will be. Read the stored evidence (GET ops/${key}) and reconcile with an explicit operator acknowledgement (POST ops/${key}/reconcile); a new key does not reconcile this op and cancelling it does not release the quarantine.`, 'DGM_MUSE_UNCERTAIN');
  }
  throw httpError(500, 'Proposal operation changed state unexpectedly.', 'DGM_MUSE_STATE');
}

async function proposeOnce({ db, env, actor, prompt, opKey, mode = 'fixture', fetchImpl }) {
  const tenant = actor.user.id;
  const key = opKey || rid('op_');
  // The digest binds mode and prompt: reusing a key across modes is a
  // changed replay, never a silent substitution of fixture for live.
  const digest = await shaHex(`${mode}:${prompt}`);
  const live = mode === 'live';

  // Resolve an existing operation BEFORE checking current activation or
  // spend configuration: a settled receipt stays replayable during
  // shutdown, and a same-key changed input is still refused (N4).
  const existing = await lookupOp(db, tenant, key);
  if (existing) return replayOrThrow(resolveExisting(existing, digest), { prompt, live, key });

  if (live && !museLiveEnabled(env)) {
    throw httpError(503, 'Live DGM proposals are not configured; no fixture was substituted. Request mode "fixture" for a labelled dry run.', 'DGM_MUSE_UNAVAILABLE');
  }
  // Finite, aggregate server-controlled spend admission: the worst-case
  // bounded cost must fit both the operator cap for THIS call and the
  // deployment-wide window total, enforced atomically with the claim below.
  // No user budget is accepted; the production default is unset (fail closed).
  let spendReserved = 0;
  let spendMicros = 0;
  let capMicros = 0;
  if (live) {
    capMicros = museSpendCapMicros(env);
    spendReserved = museWorstCaseSpendUsd(prompt);
    spendMicros = museWorstCaseSpendMicros(prompt);
    if (!(capMicros > 0) || spendMicros > capMicros) {
      throw httpError(402, 'Live DGM proposal spend cap does not cover the worst-case bounded cost. No provider call was sent and nothing was charged.', 'DGM_MUSE_SPEND_EXCEEDED');
    }
  }
  const claim = await claimOp(db, tenant, key, digest, mode, { spendMicros, capMicros });
  if (claim.outcome !== 'claimed') return replayOrThrow(claim, { prompt, live, key });

  const t0 = Date.now();
  const at = nowIso();
  const baseReceipt = claim.receipt || claimReceiptFor({ key, mode, spendMicros, at });
  // The `fetching` transition is the durable sent boundary: from here on a
  // process loss leaves a record that the call may have left this Worker.
  const sentReceipt = {
    ...baseReceipt,
    state: 'fetching',
    providerContact: live ? 'sent' : 'none',
    acceptance: live ? 'unknown' : 'not-sent',
    billing: live ? 'possibly-chargeable' : 'not-chargeable',
    ...(live ? { sentAt: at } : {}),
  };
  const marked = await markOp(db, tenant, key, ['reserved'], 'fetching', sentReceipt, { unknownOutcome: live ? 1 : 0 });
  if (!marked.ok) {
    // A concurrent operator cancel wins before any provider contact: no
    // provider call was sent on this attempt, and the cancel receipt (with
    // its claim-time reservation) stands.
    const current = await lookupOp(db, tenant, key);
    if (current && (current.state === 'cancelled' || current.state === 'reconciled')) {
      throw httpError(409, 'Proposal was cancelled during admission; no provider call was sent.', 'DGM_MUSE_CANCELLED');
    }
    throw httpError(500, 'Proposal operation changed state unexpectedly.', 'DGM_MUSE_STATE');
  }
  if (!live) {
    const proposal = runFixtureProposal(prompt);
    const proposalHash = await sha256Hex('dgm-muse-delivery/v1', proposal);
    const receipt = receiptFor({
      key, live, out: {}, elapsedMs: Date.now() - t0, replay: false,
      proposalHash, proposalChars: proposal.length, proposalInput: extractProposalFixtureInput(proposal),
    });
    const settled = await settleDelivered(db, tenant, key, receipt, 0);
    if (!settled.ok) {
      const current = await lookupOp(db, tenant, key);
      throw httpError(409, 'Proposal was cancelled before delivery; nothing was delivered.', 'DGM_MUSE_CANCELLED');
    }
    return { status: 200, body: { proposal, receipt, replay: false } };
  }
  try {
    const out = await proposeLive({ fetchImpl, apiKey: env.DGM_MUSE_API_KEY, prompt });
    const spendUsed = museUsageSpendUsd(out.usage);
    const proposalHash = await sha256Hex('dgm-muse-delivery/v1', out.proposal);
    const receipt = receiptFor({
      key, live, out, elapsedMs: Date.now() - t0, replay: false,
      spendReserved, spendUsed, proposalHash, proposalChars: out.proposal.length,
      proposalInput: extractProposalFixtureInput(out.proposal),
    });
    const settled = await settleDelivered(db, tenant, key, receipt, museUsdToMicros(spendUsed || 0));
    if (!settled.ok) {
      // Local cancellation cannot recall an already-sent provider call: the
      // call counts as accepted, the response is discarded, and the ledger
      // keeps the operator's cancellation. Never overwritten as delivered —
      // but the late result is durable evidence, not a lost response.
      await recordLateEvidence(db, tenant, key, {
        kind: 'delivered-after-cancel',
        providerContact: 'sent',
        acceptance: 'accepted',
        billing: 'possibly-chargeable',
        responseId: out.responseId,
        model: out.model,
        usage: out.usage,
        spendUsdReserved: spendReserved,
        spendUsdUsed: spendUsed,
        proposalHash,
        proposalChars: out.proposal.length,
        elapsedMs: Date.now() - t0,
      });
      const current = await lookupOp(db, tenant, key);
      return {
        status: 409,
        body: {
          proposal: null,
          receipt: parseReceipt(current && current.receipt_json),
          replay: false,
          note: 'Cancelled or reconciled during provider flight. The provider call was already sent and its late result is recorded as evidence; no proposal was delivered and the settled cancellation stands.',
        },
      };
    }
    return { status: 200, body: { proposal: out.proposal, receipt, replay: false } };
  } catch (e) {
    // Unknown outcomes quarantine: lost responses AND accepted-but-unusable
    // provider output (the call was sent, so a new key must not duplicate
    // it). The worst-case reservation is retained — it is never silently
    // refunded, and reconciliation is an explicit operator act.
    const uncertain = e && (e.code === 'DGM_MUSE_TIMEOUT' || e.code === 'DGM_MUSE_UNREACHABLE' || e.accepted === true);
    const meta = boundedProviderMeta(e && e.detail);
    const classification = classifyError(e);
    const receipt = {
      opKey: key, mode: 'live', evaluation: 'synthetic-live',
      error: e && e.code ? e.code : 'DGM_MUSE_ERROR',
      status: e && Number.isSafeInteger(e.status) ? e.status : 502,
      at: nowIso(),
      spendUsdReserved: spendReserved,
      spendUsdUsed: meta && meta.usage ? museUsageSpendUsd(meta.usage) : null,
      ...classification,
      chargeNote: uncertain
        ? 'Worst-case reservation retained; no automatic refund. Reconciliation is an explicit operator acknowledgement, never automatic.'
        : 'The provider refused the request, so no generation was accepted; the admission reservation stays in the aggregate ledger (no automatic refund).',
      ...(e && e.accepted === true ? { accepted: true } : {}),
      ...(e && Number.isSafeInteger(e.httpStatus) ? { httpStatus: e.httpStatus } : {}),
      ...(meta ? { provider: meta } : {}),
    };
    const markedSettled = await markOp(db, tenant, key, ['fetching'], uncertain ? 'uncertain' : 'failed', receipt, { unknownOutcome: uncertain ? 1 : 0 });
    if (!markedSettled.ok) {
      // The row was cancelled or reconciled while the call was in flight.
      // Preserve the late classification durably instead of dropping it.
      await recordLateEvidence(db, tenant, key, {
        kind: uncertain ? 'unknown-after-cancel' : 'rejection-after-cancel',
        error: receipt.error,
        status: receipt.status,
        httpStatus: receipt.httpStatus,
        provider: meta,
        ...classification,
        uncertain: !!uncertain,
        spendUsdReserved: spendReserved,
        spendUsdUsed: receipt.spendUsdUsed,
      });
    }
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
  const capMicros = museSpendCapMicros(ctx.env);
  let spend;
  try {
    const row = await first(ctx.db, 'SELECT reserved_micros, used_micros, updated_at FROM dgm_muse_spend WHERE scope = ? AND window_key = ?', SPEND_SCOPE, SPEND_WINDOW);
    spend = row
      ? {
        scope: SPEND_SCOPE,
        window: SPEND_WINDOW,
        capUsd: capMicros / 1e6,
        reservedUsd: Number(row.reserved_micros) / 1e6,
        usedUsd: Number(row.used_micros) / 1e6,
        usedBasis: 'reported-usage-from-delivered-calls-only',
        remainingUsd: Math.max(0, (capMicros - Number(row.reserved_micros)) / 1e6),
        updatedAt: row.updated_at,
        note: 'Aggregate worst-case reservations across all tenants and every op key in this window. Cancellations, TTL cleanup, missing usage and new keys never release or reset a reservation. reservedUsd is the admission bound, not a bill. usedUsd is reported usage from delivered calls only: an accepted-but-unusable outcome records its reported usage on the op receipt but is not added here, so it is a lower bound on known usage and is not a bill.',
      }
      : { scope: SPEND_SCOPE, window: SPEND_WINDOW, capUsd: capMicros / 1e6, status: 'uninitialised' };
  } catch (e) {
    if (!storageMissing(e)) throw e;
    spend = { scope: SPEND_SCOPE, window: SPEND_WINDOW, capUsd: capMicros / 1e6, status: 'store-not-migrated' };
  }
  return send(ctx, 200, {
    schema: DGM_MUSE_SCHEMA,
    evaluation: live ? 'synthetic-live' : 'fixture',
    provider: museProviderStatus(ctx.env),
    authorization: { read: DGM_MUSE_PERMISSION, write: DGM_MUSE_WRITE_PERMISSION, reconcile: DGM_MUSE_WRITE_PERMISSION },
    modes: ['fixture', 'live'],
    spendCapUsd: capMicros / 1e6,
    spend,
    priceRef: { version: DGM_MUSE_PRICE_VERSION, source: DGM_MUSE_PRICE_SOURCE, model: DGM_MUSE_PRICE_REF.model, limitsProvisional: true, liveVerificationRequired: true },
    constraints: {
      defaultState: 'off',
      contributorTrainingUse: 'Contributor mode permits training use of submitted content: operators must submit synthetic qualification input only.',
      inputMustBeSynthetic: 'Labelling the output synthetic does not make arbitrary input synthetic. Tenant, credential, personal, or production data must never be submitted.',
      liveRequires: ['DGM_MUSE_LIVE=1', 'server-side DGM_MUSE_API_KEY binding', 'DGM_MUSE_SPEND_CAP_USD covering the aggregate worst-case reservation', 'admin.engineering.assign grant'],
      spendAccounting: 'Each live admission atomically reserves its worst-case cost in one deployment-wide, all-time aggregate ledger enforced against the operator cap. Cancellations, TTL cleanup, missing usage and new keys never release or reset a reservation; no automatic refund exists. The reservation is an admission bound, not a bill; reported usage is booked for delivered calls only, so the status usedUsd is a lower bound on known usage.',
      reconciliation: 'Cancelling an op keeps its durable reservation and unknown-outcome evidence. A cancelled op that may have been sent stays quarantined; POST ops/{key}/reconcile with acknowledge:true is the explicit operator act that closes it, and it never erases the evidence.',
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
  // An EXISTING operation is resolved inside the core before any current
  // activation or spend configuration is consulted, so a settled receipt
  // stays replayable during shutdown (N4). Only a new key gets this fast
  // fail-closed preflight, which keeps refusals from charging write budget.
  let existing = null;
  if (body.opKey) {
    try { existing = await lookupOp(ctx.db, ctx.actor.user.id, body.opKey); } catch { existing = null; }
  }
  if (body.mode === 'live' && !existing) {
    if (!museLiveEnabled(ctx.env)) {
      return send(ctx, 503, { error: 'Live DGM proposals are not configured; no fixture was substituted. Request mode "fixture" for a labelled dry run.', code: 'DGM_MUSE_UNAVAILABLE' });
    }
    const capMicros = museSpendCapMicros(ctx.env);
    if (!(capMicros > 0) || museWorstCaseSpendMicros(body.prompt) > capMicros) {
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
    row = await first(ctx.db, 'SELECT state, mode, receipt_json, unknown_outcome FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', ctx.actor.user.id, opKey);
  } catch (e) {
    if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
    throw e;
  }
  if (!row) return send(ctx, 404, { error: 'DGM proposal operation not found.', code: 'DGM_MUSE_UNKNOWN_OP' });
  let receipt = null;
  try { receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null; } catch { receipt = null; }
  // `unknownOutcome` is the durable, historical record that an outcome was
  // unknown; it stays true after reconciliation. `blocking` is the current
  // admission effect, derived from state and retained evidence, so an
  // operator reading only this projection cannot mistake the two.
  const unknownOutcome = Number(row.unknown_outcome) === 1;
  const blocking = row.state === 'reserved' || row.state === 'fetching' || row.state === 'uncertain'
    || (row.state === 'cancelled' && (unknownOutcome || rowMayHaveBeenSent(row)));
  return send(ctx, 200, {
    opKey,
    state: row.state,
    // Durable quarantine flag: true means the provider outcome is unknown
    // (the call may have been sent). A local cancel does not clear it.
    unknownOutcome,
    // Whether this op currently blocks a new admission for the tenant. Only
    // an explicit reconciliation clears a possibly-sent cancellation.
    blocking,
    receipt,
    evaluation: receipt && receipt.evaluation ? receipt.evaluation : 'fixture',
  });
}

async function cancelRoute(ctx, opKey) {
  // State-changing bookkeeping: read permission alone never suffices.
  const gate = await requireMuseWrite(ctx);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  // Cancellation preserves the prior receipt — merge, never replace. The
  // claim-time reservation, contact/acceptance classification and any
  // provider metadata survive, and the op's own claim-time mode is recorded,
  // never the current flag/key environment. Cancelling is NOT a remote
  // cancellation and NOT proof that no call ran or was billed, so an op that
  // may have been sent keeps its unknown-outcome quarantine until an
  // explicit operator reconciliation. The receipt never invents status 200.
  let current = null;
  try {
    current = await first(ctx.db, 'SELECT state, receipt_json, mode, unknown_outcome FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', ctx.actor.user.id, opKey);
  } catch (e) {
    if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
    throw e;
  }
  if (!current) return send(ctx, 404, { error: 'DGM proposal operation not found.', code: 'DGM_MUSE_UNKNOWN_OP' });
  if (current.state !== 'reserved' && current.state !== 'fetching' && current.state !== 'uncertain') {
    return send(ctx, 409, { error: `Proposal already settled as ${JSON.stringify(current.state)}; cancellation is a no-op.`, code: 'DGM_MUSE_STATE' });
  }
  const prior = parseReceipt(current.receipt_json, {}) || {};
  const now = nowIso();
  const mode = current.mode || prior.mode || null;
  // Evidence, not the column default, decides whether this cancellation may
  // have left a provider call in flight. A fixture op never contacts the
  // provider, so its cancellation is provably unsent even from `fetching`;
  // an unknown mode stays conservative. `rowMayHaveBeenSent` covers migrated
  // rows whose flag defaulted to 0 but whose receipt still records contact.
  const mayHaveBeenSent = rowMayHaveBeenSent(current)
    || current.state === 'uncertain'
    || (current.state === 'fetching' && mode !== 'fixture');
  const merged = {
    ...prior,
    opKey,
    state: 'cancelled',
    cancelledFrom: current.state,
    cancelledAt: now,
    error: prior.error || 'DGM_MUSE_CANCELLED',
    // Preserve a recorded failure status; otherwise a cancellation is a
    // conflict/abort shape, never a success-looking 200.
    status: Number.isSafeInteger(prior.status) && prior.status >= 400 && prior.status <= 599 ? prior.status : 409,
    mode,
    evaluation: evaluationForMode(mode, prior.evaluation || null),
    providerContact: prior.providerContact || (mayHaveBeenSent ? 'sent' : 'none'),
    acceptance: prior.acceptance || (mayHaveBeenSent ? 'unknown' : 'not-sent'),
    billing: prior.billing || (mayHaveBeenSent ? 'unknown' : 'not-chargeable'),
    spendUsdReserved: Number.isFinite(prior.spendUsdReserved) ? prior.spendUsdReserved : 0,
    spendUsdUsed: Number.isFinite(prior.spendUsdUsed) ? prior.spendUsdUsed : null,
    chargeNote: prior.chargeNote || (mayHaveBeenSent
      ? 'The call may have been sent; its cost is not established by cancellation and the reservation is retained.'
      : 'No provider call was sent; no charge can have occurred.'),
    cancelNote: mayHaveBeenSent
      ? 'Local cancellation only: it cannot recall a sent generation or prove that no billing occurred. The unknown outcome stays quarantined until an explicit operator reconciliation.'
      : 'Cancelled before provider contact; this op cannot have incurred a provider charge.',
  };
  let marked;
  try {
    // The durable flag is written from the evidence above, never left at the
    // migrated default. A provably-unsent cancellation stores 0 so it stays
    // usable; a possibly-sent one stores 1 so no new key is admitted.
    marked = await markOp(ctx.db, ctx.actor.user.id, opKey, ['reserved', 'fetching', 'uncertain'], 'cancelled', merged, {
      unknownOutcome: mayHaveBeenSent ? 1 : 0,
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

/**
 * Explicit operator reconciliation of an unknown provider outcome.
 *
 * This is the ONE action that clears quarantine for an op that may have
 * been sent. It uses the existing engineering-assignment write authority
 * (no new role, grant shape or credential), requires an explicit
 * acknowledgement, and records who reconciled, when, on what stored
 * evidence, and that a later attempt is an operator decision. It never
 * erases the reservation, the acceptance classification, or provider
 * metadata, and it never claims the unknown generation did not run.
 */
async function reconcileRoute(ctx, opKey) {
  const gate = await requireMuseWrite(ctx);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  let body;
  try {
    body = await readJson(ctx.request);
  } catch (error) {
    if (error && error.status) return send(ctx, error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
    throw error;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(ctx, 400, { error: 'Reconciliation body must be an object.', code: 'DGM_MUSE_BAD_BODY' });
  }
  for (const key of Object.keys(body)) {
    if (key !== 'acknowledge' && key !== 'note') {
      return send(ctx, 400, { error: `Unknown reconciliation field: ${JSON.stringify(key)}.`, code: 'DGM_MUSE_BAD_BODY' });
    }
  }
  if (body.acknowledge !== true) {
    return send(ctx, 400, {
      error: 'Reconciliation requires acknowledge:true — the operator accepts that the provider outcome is unknown and that a new attempt is an operator decision.',
      code: 'DGM_MUSE_ACK_REQUIRED',
    });
  }
  // Validate the operator's raw input, then redact for storage. Checking the
  // post-redaction value would make the bound unreachable (redaction/truncation
  // happens first) and silently cut an over-length note.
  let note = null;
  let noteTruncated = false;
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > 200) {
      return send(ctx, 400, { error: 'note must be a string of at most 200 chars.', code: 'DGM_MUSE_BAD_BODY' });
    }
    const bounded = boundProviderText(body.note, 200);
    note = bounded && bounded.value ? bounded.value : null;
    noteTruncated = !!(bounded && bounded.truncated);
  }
  let current = null;
  try {
    current = await first(ctx.db, 'SELECT state, receipt_json, mode FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', ctx.actor.user.id, opKey);
  } catch (e) {
    if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
    throw e;
  }
  if (!current) return send(ctx, 404, { error: 'DGM proposal operation not found.', code: 'DGM_MUSE_UNKNOWN_OP' });
  if (!RECONCILE_STATES.includes(current.state)) {
    return send(ctx, 409, {
      error: `Proposal is ${JSON.stringify(current.state)}; reconciliation applies only to an op whose provider outcome may be unknown (${RECONCILE_STATES.join(', ')}).`,
      code: 'DGM_MUSE_STATE',
    });
  }
  const prior = parseReceipt(current.receipt_json, {}) || {};
  const now = nowIso();
  const merged = {
    ...prior,
    opKey,
    state: 'reconciled',
    reconciledFrom: current.state,
    reconciledAt: now,
    reconciledBy: ctx.actor.user.id,
    acknowledged: true,
    ...(note ? { reconcileNote: note } : {}),
    ...(noteTruncated ? { reconcileNoteTruncated: true } : {}),
    mode: current.mode || prior.mode || null,
    evaluation: evaluationForMode(current.mode || prior.mode, prior.evaluation || null),
    // Snapshot of what the operator reconciled against; the top-level
    // evidence stays untouched so the record is additive, never rewritten.
    reconcileEvidence: {
      state: current.state,
      providerContact: prior.providerContact || null,
      acceptance: prior.acceptance || null,
      billing: prior.billing || null,
      accepted: prior.accepted === true,
      error: prior.error || null,
      status: Number.isSafeInteger(prior.status) ? prior.status : null,
      spendUsdReserved: Number.isFinite(prior.spendUsdReserved) ? prior.spendUsdReserved : null,
      spendUsdUsed: Number.isFinite(prior.spendUsdUsed) ? prior.spendUsdUsed : null,
    },
    reconcileNote: note || prior.reconcileNote || 'Unknown provider outcome acknowledged; a later attempt is an operator decision and the reservation is not refunded.',
  };
  let marked;
  try {
    marked = await markOp(ctx.db, ctx.actor.user.id, opKey, RECONCILE_STATES, 'reconciled', merged);
  } catch (e) {
    if (storageMissing(e)) return send(ctx, 503, { error: 'DGM Muse proposal store is not migrated.', code: 'DGM_MUSE_UNAVAILABLE' });
    throw e;
  }
  if (!marked.ok) {
    const row = await first(ctx.db, 'SELECT state FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?', ctx.actor.user.id, opKey).catch(() => null);
    if (!row) return send(ctx, 404, { error: 'DGM proposal operation not found.', code: 'DGM_MUSE_UNKNOWN_OP' });
    return send(ctx, 409, { error: `Proposal already settled as ${JSON.stringify(row.state)}; reconciliation is a no-op.`, code: 'DGM_MUSE_STATE' });
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
    const m = new RegExp(`^${PREFIX}/ops/${ID}/reconcile$`).exec(path);
    if (m && method === 'POST') return reconcileRoute(ctx, m[1]);
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
