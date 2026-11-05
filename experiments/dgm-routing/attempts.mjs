/* DGM lane: durable live-attempt claims and immutable receipts (local only).
 *
 * A live CLI rerun with an unchanged request must NOT spend again, and an
 * uncertain outcome must be persisted — not lost. Before any network contact,
 * the caller atomically claims an experiment identity derived from the full
 * request context (baseline, workload, model, prompt hash, per-call budget,
 * label). The claim file is created exclusively ('wx'): a second claimant
 * replays the existing record instead of spending. After the single bounded
 * call, exactly one immutable receipt is written (exclusive create):
 * 'succeeded', 'uncertain', or 'invalid-candidate'. No automatic retry — a
 * deliberate fresh experiment requires an explicit new label.
 *
 * Receipts are sanitized: the caller key is never an input to these
 * functions' persisted structures, and writeReceipt refuses any payload
 * containing caller-supplied secrets. Budgets here are PER CALL only; this
 * slice keeps no aggregate/global ledger, and receipts say so.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify } from './report.mjs';

export const ATTEMPT_SCHEMA = 'aipster.dgm.routing-attempt/v1';
export const RECEIPT_SCHEMA = 'aipster.dgm.routing-attempt-receipt/v1';

export function attemptIdFor({ baselinePolicy, baselineSourceHash, workloadVersion, workloadSeed, model, promptHash, maxSpendUsd, label = 'default' }) {
  const canonical = stableStringify({
    baselinePolicy, baselineSourceHash, workloadVersion, workloadSeed, model, promptHash, maxSpendUsd, label,
  });
  return `att_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)}`;
}

const attemptPath = (storeDir, id) => join(storeDir, `attempt-${id}.json`);
const receiptPath = (storeDir, id) => join(storeDir, `attempt-${id}.receipt.json`);

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Atomically claim an experiment identity BEFORE any network contact.
 * Returns { fresh: true, attempt } on first claim; { fresh: false, attempt }
 * when the identity already exists (caller must replay, never re-spend).
 * `fields` must be key-free display context only.
 */
export function claimAttempt(storeDir, fields) {
  const {
    baselinePolicy, baselineSourceHash, workloadVersion, workloadSeed,
    model, promptHash, maxSpendUsd, label = 'default',
  } = fields || {};
  if (!baselinePolicy || !baselineSourceHash || !workloadVersion || !Number.isSafeInteger(workloadSeed)
      || !model || !promptHash || !Number.isFinite(maxSpendUsd)) {
    throw refusal('DGM_ATTEMPT_BAD_CONTEXT', 'attempt claim needs full request context (baseline, workload, model, prompt hash, budget)');
  }
  const id = attemptIdFor({ baselinePolicy, baselineSourceHash, workloadVersion, workloadSeed, model, promptHash, maxSpendUsd, label });
  mkdirSync(storeDir, { recursive: true });
  const attempt = {
    schema: ATTEMPT_SCHEMA,
    attemptId: id,
    state: 'reserved',
    baselinePolicy,
    baselineSourceHash,
    workloadVersion,
    workloadSeed,
    model,
    promptHash,
    perCallBudgetUsd: maxSpendUsd,
    aggregateLedger: 'none — per-call budget only in this slice',
    label,
    claimedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(attemptPath(storeDir, id), `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'wx' });
    return { fresh: true, attempt };
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      return { fresh: false, attempt: readAttempt(storeDir, id) };
    }
    throw e;
  }
}

/**
 * Release a claim that provably sent nothing: only an attempt with no
 * receipt may be released, and only by the caller that just created it
 * before any network contact (the ceiling-gate race in live-run.mjs).
 */
export function releaseUnsentClaim(storeDir, id) {
  if (existsSync(receiptPath(storeDir, id))) {
    throw refusal('DGM_ATTEMPT_HAS_RECEIPT', 'an attempt with a receipt is never released');
  }
  rmSync(attemptPath(storeDir, id), { force: true });
}

/** Read-only existence probe: never claims, never creates the store. */
export function attemptExists(storeDir, id) {
  return existsSync(attemptPath(storeDir, id));
}

export function readAttempt(storeDir, id) {
  return JSON.parse(readFileSync(attemptPath(storeDir, id), 'utf8'));
}

export function readReceipt(storeDir, id) {
  const path = receiptPath(storeDir, id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Write the single immutable receipt for a claimed attempt (exclusive
 * create — a second write refuses). `secrets` lists caller key material that
 * must not appear anywhere in the receipt; a match refuses the write.
 */
export function writeReceipt(storeDir, id, receipt, secrets = []) {
  const full = {
    schema: RECEIPT_SCHEMA,
    attemptId: id,
    recordedAt: new Date().toISOString(),
    ...receipt,
  };
  const text = JSON.stringify(full);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length > 0 && text.includes(s)) {
      throw refusal('DGM_RECEIPT_LEAKS_SECRET', 'receipt refuses caller key material');
    }
  }
  try {
    writeFileSync(receiptPath(storeDir, id), `${JSON.stringify(full, null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      throw refusal('DGM_RECEIPT_IMMUTABLE', 'a receipt already exists for this attempt; replay it instead');
    }
    throw e;
  }
  return full;
}
