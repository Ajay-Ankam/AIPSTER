// Maintainer-controlled release HOLD + exact-head review-evidence policy.
//
// Pure, dependency-free decision functions (node:assert/strict only).
// They evaluate evidence records; they do NOT call the GitHub API, mutate
// settings, merge, or deploy. Callers (CI on trusted base code, the
// maintainer) supply freshly rechecked authoritative data on every call:
// nothing here caches an old verdict across a new head.
//
// Design rules honored throughout:
// - Exact head: evidence names one full SHA; anything else is stale.
// - Blocking findings must be fixed and re-reviewed at the exact new head;
//   tracked nonblocking notes need explicit disposition + evidence.
// - AI-review evidence states model/reviewer identity, a SEPARATE author,
//   the exact SHA, and report/tests. Quota/error outcomes never count, and
//   AI evidence can never assert native GitHub human approval.
// - Release additionally requires explicit maintainer acceptance of that
//   exact-head evidence. Author prose or untrusted fork artifacts alone
//   authorize nothing.
// - HOLD is cumulative over release ancestry: a hold placed on SHA H covers
//   H and every descendant, so a later unrelated main commit cannot bypass
//   it. Missing/ambiguous ancestry fails closed (treated as covered).
// - Clearing a hold requires a maintainer identity plus a reason; anything
//   else is refused and the hold stands.
import assert from 'node:assert/strict';

export const HOLD_POLICY_VERSION = 'aipster-release-hold/1';
export const CANONICAL_REPO = 'synchronic1/AIPSTER';
// Proposed required-check name for controller approval (NOT installed by
// this change; local code cannot enforce GitHub UI merges until required
// checks/settings exist — see release-hold.md).
export const PROPOSED_GATE_CHECK = 'release-gate';

const SHA_RE = /^[a-f0-9]{40}$/;
const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
const nonEmpty = (s) => typeof s === 'string' && s.length > 0;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function dispositioned(finding) {
  const d = finding?.disposition;
  return isObj(d) && nonEmpty(d.decision) && nonEmpty(d.evidence) && nonEmpty(d.by);
}

/**
 * Evaluate one review-evidence record against an exact head SHA.
 * Throws closed on: wrong/stale SHA, missing reviewer identity, author ==
 * reviewer, missing report/tests, non-unanimous tests, quota/error outcome,
 * fabricated human approval, fork-only provenance, undispositioned notes,
 * or any open blocking finding.
 */
export function evaluateReviewEvidence(evidence, headSha) {
  assert(isObj(evidence), 'Review evidence must be an object');
  assert(isSha(headSha || ''), 'An exact head SHA is required');
  assert(isSha(evidence.sha || ''), 'Evidence must name an exact SHA');
  assert.equal(evidence.sha, headSha, 'Evidence is stale: it names a different head');
  const reviewer = evidence.reviewer || {};
  assert(nonEmpty(reviewer.model), 'Evidence must state the reviewer model');
  assert(nonEmpty(reviewer.reviewerId), 'Evidence must state the reviewer identity');
  assert(nonEmpty(evidence.author), 'Evidence must state the author');
  assert.notEqual(evidence.author, reviewer.reviewerId,
    'Author and reviewer must be separate identities');
  assert(nonEmpty(evidence.report), 'Evidence must cite its report');
  const tests = evidence.tests || {};
  assert(Number.isSafeInteger(tests.total) && tests.total > 0,
    'Evidence must cite a real test run (total > 0)');
  assert.equal(tests.passed, tests.total, 'Evidence with failing tests authorizes nothing');
  assert.equal(evidence.status, 'pass', 'Only a pass verdict counts as evidence');
  assert(!evidence.quotaFailure, 'Quota/error outcomes never count as evidence');
  assert(!evidence.claimsHumanApproval,
    'AI evidence must never assert native GitHub human approval');
  assert.equal(evidence.sourceRepo || CANONICAL_REPO, CANONICAL_REPO,
    'Untrusted fork artifacts alone cannot authorize release');
  const tracked = [];
  for (const finding of evidence.findings || []) {
    assert(isObj(finding) && nonEmpty(finding.id), 'Each finding needs an id');
    if (finding.severity === 'blocking') {
      assert(dispositioned(finding),
        `Blocking finding ${finding.id} must be fixed and re-reviewed at the exact new head`);
    } else {
      assert(dispositioned(finding),
        `Tracked note ${finding.id} needs explicit disposition and evidence`);
      tracked.push({id: finding.id, decision: finding.disposition.decision});
    }
  }
  return {ok: true, sha: headSha, trackedNonblocking: tracked};
}

/**
 * Maintainer acceptance of exact-head evidence. Acceptance is a separate
 * record (not author prose): a listed maintainer, naming the same SHA the
 * evidence names. Either mode (automatic or manual dispatch) requires it —
 * there is no manual-path bypass.
 */
export function maintainerAcceptance({acceptance, evidence, headSha, maintainers}) {
  assert(Array.isArray(maintainers) && maintainers.length > 0,
    'A maintainer list is required (one maintainer suffices; no second human is mandated)');
  assert(isObj(acceptance), 'Explicit maintainer acceptance is required; author prose is not acceptance');
  assert(maintainers.includes(acceptance.by), 'Acceptance must come from a listed maintainer');
  assert(isSha(acceptance.sha || ''), 'Acceptance must name an exact SHA');
  assert.equal(acceptance.sha, headSha, 'Acceptance names a different head');
  const verdict = evaluateReviewEvidence(evidence, headSha);
  assert.equal(evidence.sha, acceptance.sha, 'Acceptance and evidence must agree on the SHA');
  return {ok: true, acceptedBy: acceptance.by, ...verdict};
}

/**
 * Holds are immutable records; apply/clear return a NEW holds map and never
 * mutate the input. A hold: {sha, active, reason, setBy, at}.
 */
export function applyHold(holds, {sha, reason, setBy}) {
  assert(isSha(sha || ''), 'A hold needs an exact SHA');
  assert(nonEmpty(reason), 'A hold needs a reason');
  assert(nonEmpty(setBy), 'A hold needs an identity');
  return {...(holds || {}), [sha]: {sha, active: true, reason, setBy, at: new Date().toISOString()}};
}

export function clearHold(holds, {sha, clearedBy, reason, maintainers}) {
  assert(isObj(holds || {}), 'A holds map is required');
  assert(isSha(sha || ''), 'Clearing needs an exact SHA');
  assert(Array.isArray(maintainers) && maintainers.includes(clearedBy),
    'Only a listed maintainer can clear a hold; the hold stands');
  assert(nonEmpty(reason), 'Clearing needs a reason');
  const hold = holds[sha];
  assert(hold && hold.active, 'No active hold covers that SHA');
  const next = {...holds};
  next[sha] = {...hold, active: false, clearedBy, clearReason: reason};
  return next;
}

/**
 * Does any active hold cover headSha? A hold on H covers H itself and every
 * descendant (ancestryToHold: 'self' | 'descendant'). Anything missing or
 * ambiguous fails closed (covered). Pass ancestryToHold 'unrelated' only
 * with proven non-ancestry; 'unknown' (default) holds.
 */
export function holdCovers(holds, headSha, ancestryToHold = 'unknown') {
  assert(isSha(headSha || ''), 'An exact head SHA is required');
  const actives = Object.values(holds || {}).filter(h => h && h.active);
  if (actives.length === 0) return {covered: false, holds: []};
  const covering = actives.filter(h => h.sha === headSha || ancestryToHold !== 'unrelated');
  return {covered: covering.length > 0, holds: covering.map(h => ({sha: h.sha, reason: h.reason}))};
}

/**
 * Full deployment decision for one head in either mode. Inputs must be
 * freshly rechecked authoritative data (main SHA, ancestry, checks); the
 * returned receipt documents the residual race honestly: main can move
 * between this evaluation and the irreversible deploy, so the deploy step
 * must re-verify the SHA itself (as the workflow does with rev-parse).
 */
export function deploymentDecision({mode, headSha, recheckedMainSha, ancestryToMain,
  review, acceptance, holdMap, holdRelation = 'unknown', requiredChecks, maintainers}) {
  assert(mode === 'auto' || mode === 'manual', 'Mode must be auto or manual');
  assert(isSha(headSha || ''), 'An exact head SHA is required');
  assert(isSha(recheckedMainSha || ''), 'A freshly rechecked main SHA is required');
  assert.equal(headSha, recheckedMainSha, 'Head is not the rechecked main revision');
  assert(ancestryToMain === 'self' || ancestryToMain === 'descendant',
    'Head ancestry to the release line must be proven (fail closed)');
  const accepted = maintainerAcceptance({acceptance, evidence: review, headSha, maintainers});
  const hold = holdCovers(holdMap, headSha, holdRelation);
  assert(!hold.covered, `Release HOLD active: ${hold.holds.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  assert(Array.isArray(requiredChecks) && requiredChecks.length > 0,
    'At least one applicable check is required');
  for (const check of requiredChecks) {
    assert(isObj(check) && nonEmpty(check.name), 'Each required check needs a name');
    assert.equal(check.status, 'pass', `Required check ${check.name} is not passing`);
    assert.equal(check.sha, headSha, `Required check ${check.name} is not for this head`);
  }
  return {ok: true, mode, sha: headSha, acceptedBy: accepted.acceptedBy,
    residualRace: 'Main may move between this evaluation and deploy; the deploy step re-verifies the exact SHA before acting.'};
}

/**
 * Deterministic known-good revision receipt shape (see release-hold.md).
 * Pure shape check: callers fill it from the live deployment.json they just
 * read; nothing here fetches the network.
 */
export function knownGoodReceipt({receipt, expectedCommit}) {
  assert(isObj(receipt), 'A revision receipt object is required');
  assert(isSha(expectedCommit || ''), 'An exact expected commit is required');
  assert.equal(receipt.site, 'aipster-public-site', 'Receipt is not the public site deployment');
  assert.equal(receipt.git_commit, expectedCommit, 'Receipt is not the expected commit');
  assert(nonEmpty(receipt.site_revision), 'Receipt lacks a site revision');
  assert(nonEmpty(receipt.source_manifest_sha256), 'Receipt lacks a source manifest digest');
  return {ok: true, commit: expectedCommit, site_revision: receipt.site_revision};
}
