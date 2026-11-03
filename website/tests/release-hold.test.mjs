import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyHold, clearHold, deploymentDecision, evaluateReviewEvidence,
  holdCovers, knownGoodReceipt, maintainerAcceptance} from '../scripts/release-hold.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const MAINTAINERS = ['synchronic1'];

function evidence(over = {}) {
  return {sha: HEAD, reviewer: {model: 'muse-spark-1.3', reviewerId: '948a'},
    author: '1e4d81d3', report: 'REVIEW-X.md', tests: {passed: 22, total: 22},
    status: 'pass', sourceRepo: 'synchronic1/AIPSTER', findings: [], ...over};
}
function acceptance(over = {}) {
  return {by: 'synchronic1', sha: HEAD, at: '2026-11-03T00:00:00Z', ...over};
}
function checks(over = {}) {
  return [{name: 'mock-install', status: 'pass', sha: HEAD, ...over}];
}

// success / stale / missing head
test('exact-head pass evidence verifies', () => {
  assert.deepEqual(evaluateReviewEvidence(evidence(), HEAD),
    {ok: true, sha: HEAD, trackedNonblocking: []});
});
test('stale evidence SHA fails closed', () => {
  assert.throws(() => evaluateReviewEvidence(evidence({sha: OTHER}), HEAD), /stale/);
});
test('missing SHA fails closed', () => {
  assert.throws(() => evaluateReviewEvidence(evidence({sha: undefined}), HEAD), /exact SHA/);
});

// untrusted review / actor / fork
test('author equal to reviewer is refused', () => {
  assert.throws(() => evaluateReviewEvidence(evidence({author: '948a'}), HEAD), /separate/);
});
test('missing reviewer model is refused', () => {
  assert.throws(() => evaluateReviewEvidence(
    evidence({reviewer: {reviewerId: '948a'}}), HEAD), /model/);
});
test('quota failure never counts', () => {
  assert.throws(() => evaluateReviewEvidence(
    evidence({status: 'error', quotaFailure: true}), HEAD), /never count|Only a pass/);
});
test('fabricated human approval is refused', () => {
  assert.throws(() => evaluateReviewEvidence(
    evidence({claimsHumanApproval: true}), HEAD), /human approval/);
});
test('fork-only provenance is refused', () => {
  assert.throws(() => evaluateReviewEvidence(
    evidence({sourceRepo: 'someone/AIPSTER'}), HEAD), /fork/);
});
test('missing report or useless tests are refused', () => {
  assert.throws(() => evaluateReviewEvidence(evidence({report: ''}), HEAD), /report/);
  assert.throws(() => evaluateReviewEvidence(
    evidence({tests: {passed: 0, total: 0}}), HEAD), /real test run/);
  assert.throws(() => evaluateReviewEvidence(
    evidence({tests: {passed: 20, total: 22}}), HEAD), /failing tests/);
});

// blocking vs nonblocking
test('open blocking finding fails', () => {
  assert.throws(() => evaluateReviewEvidence(evidence({findings: [
    {id: 'B1', severity: 'blocking'}]}), HEAD), /Blocking finding B1/);
});
test('dispositioned blocking finding passes evidence shape', () => {
  const out = evaluateReviewEvidence(evidence({findings: [{id: 'B1',
    severity: 'blocking', disposition: {decision: 'fixed', evidence: 'r2', by: '948a'}}]}), HEAD);
  assert.equal(out.ok, true);
});
test('undispositioned note fails; dispositioned note is tracked', () => {
  assert.throws(() => evaluateReviewEvidence(evidence({findings: [
    {id: 'N1', severity: 'note'}]}), HEAD), /N1/);
  const out = evaluateReviewEvidence(evidence({findings: [{id: 'N1',
    severity: 'note', disposition: {decision: 'accepted residual', evidence: 'R', by: '948a'}}]}), HEAD);
  assert.deepEqual(out.trackedNonblocking, [{id: 'N1', decision: 'accepted residual'}]);
});

// hold applied after merge, inherited by later main
test('hold covers its SHA and descendants, not proven-unrelated heads', () => {
  const holds = applyHold({}, {sha: HEAD, reason: 'PR84 hold', setBy: 'synchronic1'});
  assert.equal(holdCovers(holds, HEAD).covered, true);
  assert.equal(holdCovers(holds, NEXT, 'descendant').covered, true);
  assert.equal(holdCovers(holds, NEXT).covered, true); // unknown fails closed
  assert.equal(holdCovers(holds, OTHER, 'unrelated').covered, false);
  assert.equal(holdCovers({}, NEXT).covered, false);
});
test('unauthorized clearing is refused and the hold stands', () => {
  const holds = applyHold({}, {sha: HEAD, reason: 'PR84 hold', setBy: 'synchronic1'});
  assert.throws(() => clearHold(holds, {sha: HEAD, clearedBy: 'intruder',
    reason: 'x', maintainers: MAINTAINERS}), /Only a listed maintainer/);
  assert.equal(holdCovers(holds, HEAD).covered, true);
  assert.throws(() => clearHold(holds, {sha: HEAD, clearedBy: 'synchronic1',
    reason: '', maintainers: MAINTAINERS}), /reason/);
  const cleared = clearHold(holds, {sha: HEAD, clearedBy: 'synchronic1',
    reason: 'resolved', maintainers: MAINTAINERS});
  assert.equal(holdCovers(cleared, HEAD).covered, false);
  assert.throws(() => clearHold(cleared, {sha: HEAD, clearedBy: 'synchronic1',
    reason: 'again', maintainers: MAINTAINERS}), /No active hold/);
});

// maintainer acceptance, both modes, no manual bypass
test('acceptance requires a listed maintainer and the exact SHA', () => {
  assert.throws(() => maintainerAcceptance({acceptance: null,
    evidence: evidence(), headSha: HEAD, maintainers: MAINTAINERS}), /Explicit/);
  assert.throws(() => maintainerAcceptance({acceptance: acceptance({by: 'stranger'}),
    evidence: evidence(), headSha: HEAD, maintainers: MAINTAINERS}), /listed maintainer/);
  assert.throws(() => maintainerAcceptance({acceptance: acceptance({sha: OTHER}),
    evidence: evidence(), headSha: HEAD, maintainers: MAINTAINERS}), /different head/);
  const out = maintainerAcceptance({acceptance: acceptance(),
    evidence: evidence(), headSha: HEAD, maintainers: MAINTAINERS});
  assert.equal(out.acceptedBy, 'synchronic1');
});
test('single-maintainer recovery accepts fresh evidence', () => {
  const fresh = evidence({sha: NEXT, report: 'REVIEW-Y.md'});
  const out = maintainerAcceptance({acceptance: acceptance({sha: NEXT}),
    evidence: fresh, headSha: NEXT, maintainers: ['synchronic1']});
  assert.equal(out.ok, true);
});

// full deployment decision
function decision(over = {}) {
  return {mode: 'auto', headSha: HEAD, recheckedMainSha: HEAD,
    ancestryToMain: 'self', review: evidence(), acceptance: acceptance(),
    holdMap: {}, requiredChecks: checks(), maintainers: MAINTAINERS, ...over};
}
test('deployment verifies in both modes', () => {
  for (const mode of ['auto', 'manual']) {
    const out = deploymentDecision(decision({mode}));
    assert.equal(out.ok, true);
    assert.match(out.residualRace, /re-verifies/);
  }
});
test('head not equal to rechecked main fails', () => {
  assert.throws(() => deploymentDecision(decision({recheckedMainSha: NEXT})),
    /not the rechecked main/);
});
test('unproven ancestry fails', () => {
  assert.throws(() => deploymentDecision(decision({ancestryToMain: 'unknown'})),
    /ancestry/);
});
test('active hold blocks both modes', () => {
  const holdMap = applyHold({}, {sha: HEAD, reason: 'PR84 hold', setBy: 'synchronic1'});
  assert.throws(() => deploymentDecision(decision({holdMap})), /HOLD active/);
  assert.throws(() => deploymentDecision(decision({mode: 'manual', holdMap})), /HOLD active/);
});
test('applicable CI is required for the exact head', () => {
  assert.throws(() => deploymentDecision(decision({requiredChecks: []})), /applicable check/);
  assert.throws(() => deploymentDecision(decision({requiredChecks: checks({status: 'pending'})})),
    /not passing/);
  assert.throws(() => deploymentDecision(decision({requiredChecks: checks({sha: OTHER})})),
    /not for this head/);
});
test('missing data fails closed', () => {
  assert.throws(() => deploymentDecision(decision({review: null})), /object/);
  assert.throws(() => deploymentDecision(decision({maintainers: []})), /maintainer list/);
});

// known-good receipt
test('known-good receipt shape verifies; wrong commit or site fails', () => {
  const receipt = {site: 'aipster-public-site', site_revision: '2026-11-02.2',
    git_commit: HEAD, source_manifest_sha256: 'x'.repeat(64)};
  assert.deepEqual(knownGoodReceipt({receipt, expectedCommit: HEAD}),
    {ok: true, commit: HEAD, site_revision: '2026-11-02.2'});
  assert.throws(() => knownGoodReceipt({receipt, expectedCommit: OTHER}), /expected commit/);
  assert.throws(() => knownGoodReceipt(
    {receipt: {...receipt, site: 'other'}, expectedCommit: HEAD}), /public site/);
});
