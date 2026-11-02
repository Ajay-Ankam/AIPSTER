// Deterministic evaluation of a sealed upstream proposal.
//
// Pure of clock, randomness and network. The same request + fixture always
// produce the same verdict digest, which is what makes replay verification
// meaningful. Latency is measured outside this module and never enters a digest.
//
// A request names its `subject` — the artifact under decision (normally the
// candidate). The other artifact is scored as `reference`, so a verdict always
// shows both sides without pretending the reference was decided on.

import { digestOf, idFromDigest, seal, verifySeal } from './canonical.mjs';
import { evaluateCriteria } from './checks.mjs';
import { fixtureIdentity, eligibility, projectTicket } from './adapter.mjs';
import {
  AUTHORITY,
  EVALUATION_KIND,
  FAILED,
  GATES,
  LIMITATIONS,
  REJECTED,
  RECEIPT_SCHEMA,
  SELECTED,
  UNAVAILABLE,
  VERDICT_SCHEMA,
  gate
} from './contract.mjs';

const REQUIRED_BASELINE_FIELDS = ['kind', 'policy', 'budgets', 'public_identifiers', 'rollback'];

function ppm(passed, total) {
  if (!total) return null;
  return Math.round((passed / total) * 1_000_000);
}

function outcomeOf(checks) {
  return {
    passed: checks.filter((check) => check.passed).length,
    failed: checks.filter((check) => !check.passed).length,
    total: checks.length
  };
}

function wellFormed(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return false;
  if (artifact.kind !== 'agent-change-bundle/v1') return false;
  return REQUIRED_BASELINE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(artifact, field));
}

/**
 * Baseline policy: the upstream-shaped status quo. An artifact that parses and
 * declares its kind is admissible; a human then reviews it. This policy does
 * not run the acceptance contract, which is exactly the gap the DGM gate fills.
 */
export function baselinePolicy(artifact) {
  const parses = Boolean(artifact) && typeof artifact === 'object' && !Array.isArray(artifact)
    && typeof artifact.kind === 'string';
  return {
    status: parses ? SELECTED : FAILED,
    work_units: 1,
    reason: parses ? 'parse-ok' : 'DGM_BAD_ARTIFACT'
  };
}

async function refusalVerdict(request, code, detail) {
  const runId = idFromDigest('run', request.request_sha256);
  const body = {
    schema: VERDICT_SCHEMA,
    run_id: runId,
    request_sha256: request.request_sha256,
    status: UNAVAILABLE,
    code,
    detail,
    evaluation: EVALUATION_KIND,
    authority: AUTHORITY,
    applied: false,
    subject: request.subject || 'candidate',
    target: request.target,
    gates: GATES.map((name) => gate(name, false, code, 'not evaluated')),
    checks: { subject: [], reference: [] },
    scores: { subject_ppm: null, reference_ppm: null, kind: 'fixture-check-pass-rate' },
    work_units: 0,
    repair_brief: [],
    receipt: null,
    provenance: {
      fixture_id: request.snapshot.fixture_id,
      fixture_sha256: request.snapshot.fixture_sha256,
      criteria_sha256: request.snapshot.criteria_sha256,
      reference_sha256: request.baseline.sha256,
      subject_sha256: (request.subject === 'baseline' ? request.baseline : request.candidate).sha256,
      module: request.module,
      environment: EVALUATION_KIND
    },
    events: [
      { seq: 0, event: 'evaluation.request_received', detail: request.request_sha256.slice(0, 12) },
      { seq: 1, event: 'evaluation.unavailable', detail: code }
    ],
    limitations: [...LIMITATIONS]
  };
  return { ...body, verdict_sha256: await digestOf(body) };
}

/**
 * Evaluate a sealed request against its fixture.
 *
 * Status is honest by construction:
 * - `failed`      identity/parse failure; no score is produced,
 * - `unavailable` the fixture, mandate or budget cannot support an evaluation,
 * - `rejected`    the subject violates the acceptance contract (repair brief),
 * - `selected`    every gate passed; `applied` stays false.
 */
export async function evaluate(workItem, request) {
  if (!workItem || !request) {
    throw new TypeError('evaluate(workItem, request) requires both arguments');
  }

  const requestSeal = await verifySeal(request, 'request_sha256');
  if (!requestSeal.ok) {
    return refusalVerdict(request, 'DGM_REQUEST_TAMPERED', `request digest ${requestSeal.reason}`);
  }

  // Recompute every identity the request claims. A post-seal artifact mutation
  // changes the candidate digest and is refused before any scoring happens.
  const [fixtureSha, baselineSha, candidateSha, criteriaSha] = await Promise.all([
    fixtureIdentity(workItem),
    digestOf(workItem.artifact),
    digestOf(workItem.candidate),
    digestOf(workItem.criteria)
  ]);

  const identityChecks = [
    { name: 'fixture', claimed: request.snapshot.fixture_sha256, actual: fixtureSha },
    { name: 'baseline', claimed: request.baseline.sha256, actual: baselineSha },
    { name: 'candidate', claimed: request.candidate.sha256, actual: candidateSha },
    { name: 'criteria', claimed: request.snapshot.criteria_sha256, actual: criteriaSha }
  ];
  const identityFailure = identityChecks.find((check) => check.claimed !== check.actual);
  if (identityFailure) {
    return refusalVerdict(
      request,
      'DGM_IDENTITY_MISMATCH',
      `${identityFailure.name} digest does not match the sealed request`
    );
  }

  const projected = projectTicket(workItem.ticket);
  const eligible = eligibility(projected, { reportState: projected.report_state });
  if (!eligible.ok) {
    return refusalVerdict(request, eligible.code, eligible.detail);
  }

  if (!Array.isArray(workItem.criteria) || workItem.criteria.length === 0) {
    return refusalVerdict(request, 'DGM_NO_CRITERIA', 'the fixture has no acceptance criteria');
  }

  const subjectName = request.subject === 'baseline' ? 'baseline' : 'candidate';
  const subjectArtifact = subjectName === 'baseline' ? workItem.artifact : workItem.candidate;
  const subjectRun = evaluateCriteria(subjectArtifact, workItem.criteria);
  const referenceName = subjectName === 'baseline' ? 'candidate' : 'baseline';
  const referenceRun = evaluateCriteria(referenceName === 'baseline' ? workItem.artifact : workItem.candidate, workItem.criteria);
  const subjectOutcome = outcomeOf(subjectRun.checks);
  const referenceOutcome = outcomeOf(referenceRun.checks);
  // A count, not the failed checks themselves: the envelope compares numbers.
  const repairItems = subjectRun.failed.length;
  const workUnits = subjectRun.workUnits + referenceRun.workUnits + identityChecks.length;

  const targetBound = request.target.kind === 'dsh-ticket'
    && request.target.name === projected.ticket_id
    && Boolean(request.target.source)
    && request.target.source.repo === workItem.source.repo
    && request.target.issue_number === workItem.source.number;

  const mandateValid = projected.mandate.strength === 'explicit'
    || (projected.mandate.strength === 'inferred' && projected.accept_mode === 'auto');

  const artifactOk = wellFormed(subjectArtifact);

  const criteriaMet = subjectRun.passed && subjectOutcome.failed === 0;

  const workUnitConstraint = request.constraints.find((constraint) => constraint.name === 'work_units');
  const repairConstraint = request.constraints.find((constraint) => constraint.name === 'repair_items');
  const envelopeFits = workUnits <= (workUnitConstraint ? workUnitConstraint.threshold : 0)
    && repairItems <= (repairConstraint ? repairConstraint.threshold : 0);

  let status = SELECTED;
  let code = 'DGM_SELECTED';
  let detail = 'every gate passed; nothing was applied';
  if (!artifactOk) {
    status = FAILED;
    code = 'DGM_BAD_ARTIFACT';
    detail = 'the subject artifact is not a well-formed agent change bundle';
  } else if (!envelopeFits) {
    status = UNAVAILABLE;
    code = 'DGM_ENVELOPE_EXCEEDED';
    detail = `work units ${workUnits} or repair items ${repairItems} exceed the admitted envelope`;
  } else if (!criteriaMet) {
    status = REJECTED;
    code = 'DGM_CRITERIA_FAILED';
    detail = `${subjectOutcome.failed} of ${subjectOutcome.total} acceptance checks failed`;
  }

  const runId = idFromDigest('run', request.request_sha256);
  const scores = {
    subject_ppm: ppm(subjectOutcome.passed, subjectOutcome.total),
    reference_ppm: ppm(referenceOutcome.passed, referenceOutcome.total),
    kind: 'fixture-check-pass-rate'
  };

  const receipt = await seal({
    schema: RECEIPT_SCHEMA,
    run_id: runId,
    request_sha256: request.request_sha256,
    status,
    code,
    evaluation: EVALUATION_KIND,
    authority: AUTHORITY,
    applied: false,
    fixture_id: workItem.id,
    subject: subjectName,
    subject_sha256: subjectName === 'baseline' ? baselineSha : candidateSha,
    reference_sha256: subjectName === 'baseline' ? candidateSha : baselineSha,
    subject_ppm: scores.subject_ppm,
    reference_ppm: scores.reference_ppm,
    work_units: workUnits,
    repair_items: repairItems,
    outcome: subjectOutcome
  }, 'receipt_sha256');

  const receiptCheck = await verifySeal(receipt, 'receipt_sha256');
  const archiveSettled = receiptCheck.ok
    && receipt.request_sha256 === request.request_sha256
    && receipt.status === status;

  const gates = [
    gate('target_bound', targetBound, targetBound ? 'ticket and source match the fixture' : 'target binding differs from the fixture'),
    gate('mandate_valid', mandateValid, mandateValid ? `${projected.mandate.strength} mandate is live` : 'mandate strength or accept mode does not permit evaluation'),
    gate('artifact_well_formed', artifactOk, artifactOk ? 'subject is a well-formed change bundle' : 'subject artifact is malformed'),
    gate('criteria_met', criteriaMet, criteriaMet ? `${subjectOutcome.passed}/${subjectOutcome.total} checks passed` : `${subjectOutcome.failed}/${subjectOutcome.total} checks failed`),
    gate('envelope_fits', envelopeFits, envelopeFits ? `${workUnits} work units, ${repairItems} repair items` : 'envelope exceeded'),
    gate('archive_settled', archiveSettled, archiveSettled ? 'receipt verified' : 'receipt did not verify')
  ];

  const events = [
    { seq: 0, event: 'evaluation.request_verified', detail: request.request_sha256.slice(0, 12) },
    { seq: 1, event: 'evaluation.fixture_bound', detail: `${workItem.id}@${fixtureSha.slice(0, 12)}` },
    { seq: 2, event: 'evaluation.subject_scored', detail: `${subjectName}:${subjectOutcome.passed}/${subjectOutcome.total}` },
    { seq: 3, event: 'evaluation.reference_scored', detail: `${referenceName}:${referenceOutcome.passed}/${referenceOutcome.total}` },
    ...gates.map((entry, index) => ({
      seq: 4 + index,
      event: 'evaluation.gate_checked',
      detail: `${entry.name}:${entry.passed ? 'pass' : 'fail'}`
    })),
    { seq: 4 + gates.length, event: `evaluation.${status}`, detail: code }
  ];

  const body = {
    schema: VERDICT_SCHEMA,
    run_id: runId,
    request_sha256: request.request_sha256,
    status,
    code,
    detail,
    evaluation: EVALUATION_KIND,
    authority: AUTHORITY,
    applied: false,
    subject: subjectName,
    target: request.target,
    gates,
    checks: {
      subject: subjectRun.checks,
      reference: referenceRun.checks
    },
    scores,
    work_units: workUnits,
    repair_brief: subjectRun.failed.map(({ id, statement, detail: checkDetail }) => ({ id, statement, detail: checkDetail })),
    receipt,
    provenance: {
      fixture_id: workItem.id,
      fixture_sha256: fixtureSha,
      criteria_sha256: criteriaSha,
      subject_sha256: subjectName === 'baseline' ? baselineSha : candidateSha,
      reference_sha256: subjectName === 'baseline' ? candidateSha : baselineSha,
      module: request.module,
      environment: EVALUATION_KIND
    },
    events,
    limitations: [...LIMITATIONS]
  };

  return seal(body, 'verdict_sha256');
}

/** Verify a stored verdict against its request and fixture. */
export async function verifyVerdict(verdict, workItem, request) {
  const verdictSeal = await verifySeal(verdict, 'verdict_sha256');
  if (!verdictSeal.ok) return { ok: false, reason: `verdict ${verdictSeal.reason}` };
  const requestSeal = await verifySeal(request, 'request_sha256');
  if (!requestSeal.ok) return { ok: false, reason: `request ${requestSeal.reason}` };
  if (verdict.request_sha256 !== request.request_sha256) {
    return { ok: false, reason: 'verdict binds a different request' };
  }
  const replayed = await evaluate(workItem, request);
  if (replayed.verdict_sha256 !== verdict.verdict_sha256) {
    return { ok: false, reason: 'verdict digest diverged on replay' };
  }
  if (verdict.applied !== false || verdict.authority !== AUTHORITY) {
    return { ok: false, reason: 'verdict claims authority it must not have' };
  }
  return { ok: true, digest: verdict.verdict_sha256 };
}

/** Replay N times and report whether every digest is identical. */
export async function replay(workItem, request, times = 3) {
  const digests = [];
  for (let index = 0; index < times; index += 1) {
    const verdict = await evaluate(workItem, request);
    digests.push(verdict.verdict_sha256);
  }
  return {
    runs: times,
    digests,
    identical: digests.every((digest) => digest === digests[0])
  };
}
