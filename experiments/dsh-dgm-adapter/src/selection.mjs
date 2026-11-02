// Bounded selection and explicit rollback.
//
// Selection here is a *recommendation with a receipt*, not a promotion. Every
// record carries `applied: false` and a rollback plan that names the exact
// revision it would restore. There is no code path in this module that writes
// to a repository, a configuration store or an upstream ticket.

import { digestOf, idFromDigest, seal, verifySeal } from './canonical.mjs';
import { AUTHORITY, SELECTED, SELECTION_SCHEMA, refusal } from './contract.mjs';

export const MAX_CANDIDATES = 8;

/**
 * Select at most one candidate from a bounded set of verdicts.
 *
 * Ordering is deterministic and total: highest candidate score, then lowest
 * work units, then lexicographic verdict digest. The digest tie-break exists so
 * that two equal-scoring candidates cannot produce an order-dependent result.
 */
export async function select(verdicts, {
  baselineRevision = 'rev-2026-11-02-a',
  maxCandidates = MAX_CANDIDATES
} = {}) {
  if (!Array.isArray(verdicts)) {
    return refusal('DGM_BAD_INPUT', 'verdicts must be an array');
  }
  if (verdicts.length === 0) {
    return refusal('DGM_NO_CANDIDATES', 'no verdicts were supplied');
  }
  if (verdicts.length > maxCandidates) {
    return refusal('DGM_SELECTION_UNBOUNDED', `${verdicts.length} candidates exceed the bound of ${maxCandidates}`);
  }

  for (const verdict of verdicts) {
    const checked = await verifySeal(verdict, 'verdict_sha256');
    if (!checked.ok) {
      return refusal('DGM_VERDICT_TAMPERED', `a verdict digest ${checked.reason}`);
    }
    if (verdict.applied !== false || verdict.authority !== AUTHORITY) {
      return refusal('DGM_AUTHORITY_VIOLATION', 'a verdict claims authority this adapter does not have');
    }
    if (!verdict.receipt) {
      return refusal('DGM_NO_RECEIPT', 'a verdict has no archive receipt');
    }
    const receipt = await verifySeal(verdict.receipt, 'receipt_sha256');
    if (!receipt.ok) {
      return refusal('DGM_RECEIPT_TAMPERED', `a receipt digest ${receipt.reason}`);
    }
  }

  const eligible = verdicts.filter((verdict) => verdict.status === SELECTED);
  const rejected = verdicts.filter((verdict) => verdict.status !== SELECTED);

  const ranked = [...eligible].sort((a, b) => {
    const scoreDiff = (b.scores.subject_ppm ?? -1) - (a.scores.subject_ppm ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    const workDiff = a.work_units - b.work_units;
    if (workDiff !== 0) return workDiff;
    return a.verdict_sha256 < b.verdict_sha256 ? -1 : a.verdict_sha256 > b.verdict_sha256 ? 1 : 0;
  });

  const winner = ranked[0] || null;
  const rollback = {
    action: 'restore-previous-revision',
    revision: baselineRevision,
    from: winner ? winner.provenance.subject_sha256 : null,
    to: winner ? winner.provenance.reference_sha256 : null,
    trigger: 'operator request, failed verification, or withdrawn mandate',
    applied: false
  };

  const body = {
    schema: SELECTION_SCHEMA,
    selection_id: null,
    authority: AUTHORITY,
    applied: false,
    bound: { candidates: verdicts.length, max_candidates: maxCandidates, within_bound: true },
    considered: verdicts.map((verdict) => ({
      run_id: verdict.run_id,
      verdict_sha256: verdict.verdict_sha256,
      status: verdict.status,
      subject: verdict.subject,
      subject_ppm: verdict.scores.subject_ppm,
      work_units: verdict.work_units,
      repair_items: verdict.repair_brief.length
    })),
    ranked: ranked.map((verdict) => verdict.verdict_sha256),
    tie_break: 'highest subject score, then fewest work units, then verdict digest',
    ties: winner
      ? eligible.filter((verdict) => verdict.scores.subject_ppm === winner.scores.subject_ppm
        && verdict.work_units === winner.work_units).length
      : 0,
    selected: winner
      ? {
          run_id: winner.run_id,
          verdict_sha256: winner.verdict_sha256,
          fixture_id: winner.provenance.fixture_id,
          subject: winner.subject,
          subject_sha256: winner.provenance.subject_sha256,
          subject_ppm: winner.scores.subject_ppm
        }
      : null,
    rejected: rejected.map((verdict) => ({
      run_id: verdict.run_id,
      status: verdict.status,
      code: verdict.code
    })),
    rollback,
    note: winner
      ? 'recommendation only: nothing was applied, promoted, merged or executed'
      : 'no candidate passed every gate; nothing was applied'
  };

  const selectionId = idFromDigest('sel', await digestOf({ ...body, selection_id: null }), 32);
  const sealed = await seal({ ...body, selection_id: selectionId }, 'selection_sha256');
  return { ok: true, selection: sealed };
}

/** Verify a stored selection record. */
export async function verifySelection(selection) {
  const checked = await verifySeal(selection, 'selection_sha256');
  if (!checked.ok) return { ok: false, reason: `selection digest ${checked.reason}` };
  if (selection.applied !== false) return { ok: false, reason: 'selection claims to have been applied' };
  if (selection.authority !== AUTHORITY) return { ok: false, reason: 'selection claims foreign authority' };
  if (!selection.rollback || selection.rollback.applied !== false) {
    return { ok: false, reason: 'selection has no unapplied rollback plan' };
  }
  return { ok: true, selection_id: selection.selection_id };
}

/**
 * Build a rollback *request*. Returns a refusal if asked to perform it: this
 * adapter never restores revisions, it only names the restoration.
 */
export function requestRollback(selection, { reason = 'operator request' } = {}) {
  if (!selection || selection.applied !== false) {
    return refusal('DGM_BAD_SELECTION', 'a verified, unapplied selection is required');
  }
  return {
    ok: true,
    applied: false,
    record: {
      kind: 'aipster.dsh-dgm.rollback-request/v1',
      selection_id: selection.selection_id,
      selection_sha256: selection.selection_sha256,
      action: selection.rollback.action,
      revision: selection.rollback.revision,
      from: selection.rollback.from,
      to: selection.rollback.to,
      reason: String(reason).slice(0, 512),
      executed: false,
      note: 'a human or the owning system performs this restoration; this adapter does not'
    }
  };
}
