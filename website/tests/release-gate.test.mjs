import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertCanaryClean, assertNoCodeFetch, bindEvidence,
  fetchAssociatedPRs, fetchPR, fetchPRFiles, fetchPermission, fetchReviews,
  holdRelationTo, listOpenPRs, mergeEligible, parseEvidenceBlock,
  parseHoldsFile, publishEvaluation, publishHeadStatus,
  requireCheckPass, resolveAcceptance, resolveMaintainer, resolveReviewState,
  runGateEvaluation} from '../scripts/release-gate.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const HOLD_SHA = 'd'.repeat(40);

const BLOCK = ['RELEASE-EVIDENCE', 'reviewer: 948a',
  'author: fixture-source-agent',
  'model: muse-spark-1.3-contributor', 'sha: ' + HEAD, 'verdict: PASS',
  'report: REVIEW-X.md', 'tests: 22/22', 'blocking: none'].join('\n');
const MARKER_BODY = BLOCK + '\nRELEASE-ACCEPT ' + HEAD;

// Mocked HTTP only: routes keyed by path prefix; every requested path is
// recorded so tests can prove no code/artifact endpoint is ever fetched.
function mockRequest(routes, failOn = []) {
  const seen = [];
  const request = async (path) => {
    seen.push(path);
    for (const fail of failOn) if (path.startsWith(fail)) {
      const err = new Error('HTTP 401 for ' + path);
      err.status = 401;
      throw err;
    }
    const [base] = path.split('?');
    assert(base in routes, 'unexpected API path: ' + path);
    const route = routes[base];
    return typeof route === 'function' ? route(path) : route;
  };
  return {seen, request};
}

const prDoc = (over = {}) => ({number: 86, head: {sha: HEAD, ref: 'muse/x',
  repo: {full_name: 'synchronic1/AIPSTER'}}, base: {ref: 'main',
  repo: {full_name: 'synchronic1/AIPSTER'}}, user: {login: 'author1'},
  state: 'open', merged: false, merge_commit_sha: null, ...over});
const reviewDoc = (over = {}) => ({id: 1, user: {login: '948a'},
  author_association: 'COLLABORATOR', state: 'APPROVED', commit_id: HEAD,
  body: MARKER_BODY, submitted_at: '2026-11-03T00:00:00Z', ...over});
const siteCheck = (over = {}) => ({id: 9, name: 'Public site asset and build checks',
  head_sha: HEAD, status: 'completed', conclusion: 'success',
  app: {slug: 'github-actions'}, ...over});
const workerCheck = (over = {}) => ({id: 7, name: 'mock-install', head_sha: HEAD,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}, ...over});

function normReview(over = {}) {
  return {id: 1, user: '948a', association: 'OWNER', state: 'APPROVED',
    commitId: HEAD, body: MARKER_BODY, submittedAt: null, ...over};
}
function gateInput(over = {}) {
  return {pr: {baseRef: 'main', baseRepo: 'synchronic1/AIPSTER',
    headRepo: 'synchronic1/AIPSTER', author: 'author1', headSha: HEAD},
    reviews: [normReview()], holdMap: {}, holdRelation: 'unrelated',
    checks: [siteCheck()], workerApplicable: false, headSha: HEAD, ...over};
}

// evidence blocks: strict, never a bare SHA mention
test('evidence block parses; bare SHA mention is not evidence', () => {
  const record = parseEvidenceBlock(BLOCK, HEAD);
  assert.equal(record.reviewer, '948a');
  assert.deepEqual(record.tests, {passed: 22, total: 22});
  assert.equal(parseEvidenceBlock('looks good ' + HEAD, HEAD), null);
  assert.equal(parseEvidenceBlock(null, HEAD), null);
});
test('stale blocks are skipped, malformed shapes fail', () => {
  const stale = BLOCK.split(HEAD).join(OTHER);
  assert.equal(parseEvidenceBlock(stale, HEAD), null);
  const pr = {author: 'author1', headSha: HEAD, baseRepo: 'synchronic1/AIPSTER'};
  const fresh = {id: 2, user: '948a', association: 'OWNER', state: 'APPROVED',
    commitId: HEAD, body: BLOCK};
  const old = {id: 1, user: '948a', association: 'OWNER', state: 'APPROVED',
    commitId: OTHER, body: stale};
  const bound = bindEvidence({pr, reviews: [old, fresh]});
  assert.equal(bound.length, 1);
  assert.equal(bound[0].reviewId, 2);
});
test('malformed blocks fail closed', () => {
  assert.throws(() => parseEvidenceBlock('RELEASE-EVIDENCE\nreviewer: x', HEAD), /missing/);
  assert.equal(parseEvidenceBlock(BLOCK.replace(HEAD, OTHER), HEAD), null); // stale ⇒ skip
  assert.throws(() => parseEvidenceBlock(BLOCK.replace('muse-spark-1.3-contributor', 'human'), HEAD), /model/);
  assert.throws(() => parseEvidenceBlock(BLOCK.replace('22/22', '20/22'), HEAD), /unanimously/);
  assert.throws(() => parseEvidenceBlock(BLOCK.replace('blocking: none', 'blocking: B1 accepted'), HEAD), /fix plus new/);
  assert.throws(() => parseEvidenceBlock(BLOCK.replace('verdict: PASS', 'verdict: HOLD'), HEAD), /not evidence of pass/);
});
test('bindEvidence needs APPROVED/COMMENTED, distinct reviewer, bound head', () => {
  const pr = {author: 'author1', headSha: HEAD, baseRepo: 'synchronic1/AIPSTER'};
  const bound = bindEvidence({pr, reviews: [normReview()]});
  assert.equal(bound.length, 1);
  assert.equal(bound[0].reviewId, 1);
  assert.throws(() => bindEvidence({pr, reviews: [normReview({state: 'CHANGES_REQUESTED'})]}), /bound to the current head/);
  assert.throws(() => bindEvidence({pr, reviews: [normReview({body: MARKER_BODY.replace('reviewer: 948a', 'reviewer: fixture-source-agent')})]}), /different agent/);
  assert.throws(() => bindEvidence({pr, reviews: [normReview({body: 'nice ' + HEAD})]}), /bound to the current head/);
});

// maintainer standing: owner, OWNER association, or proven admin/maintain
test('maintainer resolution refuses read/triage and gaps', () => {
  assert.deepEqual(resolveMaintainer({login: 'synchronic1'}), {maintainer: true, basis: 'owner'});
  assert.deepEqual(resolveMaintainer({login: 'x', association: 'OWNER'}), {maintainer: true, basis: 'owner'});
  assert.deepEqual(resolveMaintainer({login: 'x', association: 'COLLABORATOR', permission: 'admin'}), {maintainer: true, basis: 'permission:admin'});
  assert.deepEqual(resolveMaintainer({login: 'x', association: 'COLLABORATOR', permission: 'maintain'}), {maintainer: true, basis: 'permission:maintain'});
  assert.deepEqual(resolveMaintainer({login: 'x', association: 'COLLABORATOR', permission: 'push'}), {maintainer: false});
  assert.deepEqual(resolveMaintainer({login: 'x', association: 'COLLABORATOR', permission: 'triage'}), {maintainer: false});
  assert.deepEqual(resolveMaintainer({login: 'x', association: 'COLLABORATOR'}), {maintainer: false});
  assert.deepEqual(resolveMaintainer({login: 'x', association: 'CONTRIBUTOR'}), {maintainer: false});
});
test('acceptance needs standing plus marker at this head', () => {
  assert.deepEqual(resolveAcceptance({reviews: [normReview()], headSha: HEAD}),
    {by: '948a', via: 'review', reviewId: 1}); // OWNER association
  const collab = normReview({user: 'helper', association: 'COLLABORATOR'});
  assert.equal(resolveAcceptance({reviews: [collab], headSha: HEAD}), null);
  assert.deepEqual(resolveAcceptance({reviews: [collab], headSha: HEAD,
    permissions: {helper: 'admin'}}), {by: 'helper', via: 'review', reviewId: 1});
  assert.equal(resolveAcceptance({reviews: [normReview({commitId: OTHER})],
    headSha: HEAD}), null); // stale
  assert.equal(resolveAcceptance({reviews: [normReview({state: 'DISMISSED'})],
    headSha: HEAD}), null); // revoked
  assert.equal(resolveAcceptance(
    {reviews: [normReview({body: BLOCK})], headSha: HEAD}), null); // marker edited away
  assert.deepEqual(resolveAcceptance({reviews: [], headSha: HEAD,
    dispatchActor: 'synchronic1'}), {by: 'synchronic1', via: 'dispatch'});
  // No caller-asserted standing boolean exists: unknown association + no
  // permission + non-owner login resolves to null, never to manufactured standing.
  assert.equal(resolveAcceptance({reviews: [], headSha: HEAD,
    dispatchActor: 'stranger'}), null);
  assert.equal(resolveAcceptance({reviews: [], headSha: HEAD,
    dispatchActor: 'stranger', dispatchActorStanding: true}), null);
});

// E: deterministic review-state resolution. A newer same-head blocking
// verdict beats an older PASS; array order never decides; a plain
// comment never resolves; only a later same-author APPROVED or an
// explicit dismissal does. Unknown order or unattributable blocking
// fails closed.
const T0 = '2026-11-03T00:00:00Z';
const T1 = '2026-11-03T01:00:00Z';
const T2 = '2026-11-03T02:00:00Z';
const passAt = (over = {}) => normReview({id: 1, submittedAt: T0, ...over});
const crAt = (over = {}) => normReview({id: 2, state: 'CHANGES_REQUESTED',
  body: 'needs work ' + HEAD, submittedAt: T1, ...over});
test('newer same-head CHANGES_REQUESTED beats older PASS either array order', () => {
  const pass = passAt();
  const cr = crAt();
  for (const reviews of [[pass, cr], [cr, pass]]) {
    const state = resolveReviewState({reviews, headSha: HEAD});
    assert.equal(state.blocked.by, '948a');
    assert.equal(state.blocked.via, 'changes-requested');
  }
  assert.throws(() => mergeEligible(gateInput({reviews: [pass, cr]})),
    /changes-requested by 948a/);
});
test('another authorized publisher blocks; a PASS cannot erase it', () => {
  const pass = passAt();
  const cr = crAt({id: 3, user: 'helper', association: 'COLLABORATOR',
    submittedAt: T2});
  const perms = {helper: 'admin'};
  const state = resolveReviewState({reviews: [pass, cr], headSha: HEAD,
    permissions: perms});
  assert.equal(state.blocked.by, 'helper');
  assert.throws(() => mergeEligible(gateInput({reviews: [pass, cr],
    permissions: perms})), /changes-requested by helper/);
});
test('plain COMMENTED after CR does not resolve it', () => {
  const comment = normReview({id: 3, state: 'COMMENTED', body: 'noted',
    submittedAt: T2});
  const state = resolveReviewState(
    {reviews: [passAt(), crAt(), comment], headSha: HEAD});
  assert.equal(state.blocked.by, '948a');
  assert.throws(() => mergeEligible(
    gateInput({reviews: [passAt(), crAt(), comment]})),
  /changes-requested by 948a/);
});
test('later same-publisher APPROVED resolves; dismissal resolves', () => {
  const approved = normReview({id: 4, submittedAt: T2});
  assert.equal(resolveReviewState(
    {reviews: [passAt(), crAt(), approved], headSha: HEAD}).blocked, null);
  assert.equal(mergeEligible(
    gateInput({reviews: [passAt(), crAt(), approved]})).ok, true);
  const dismissed = normReview({id: 2, state: 'DISMISSED', submittedAt: T2});
  assert.equal(resolveReviewState(
    {reviews: [passAt(), crAt(), dismissed], headSha: HEAD}).blocked, null);
});
test('stale other-head blocking history is inert', () => {
  const staleCR = crAt({commitId: OTHER});
  assert.equal(resolveReviewState(
    {reviews: [passAt(), staleCR], headSha: HEAD}).blocked, null);
  assert.equal(
    mergeEligible(gateInput({reviews: [passAt(), staleCR]})).ok, true);
});
test('missing/ambiguous order and unattributable blocking fail closed', () => {
  const noOrder = (state) => normReview({id: null, submittedAt: null, state,
    body: state === 'CHANGES_REQUESTED' ? 'needs work ' + HEAD : MARKER_BODY});
  assert.throws(() => resolveReviewState(
    {reviews: [noOrder('APPROVED'), noOrder('CHANGES_REQUESTED')],
      headSha: HEAD}), /Ambiguous review order/);
  assert.throws(() => resolveReviewState(
    {reviews: [normReview({id: 9, user: null, state: 'CHANGES_REQUESTED',
      body: 'needs work ' + HEAD, submittedAt: T1})], headSha: HEAD}),
  /Unattributable blocking review/);
});
test('proven-absent outsider cannot block; unknown standing blocks closed', () => {
  const outsider = () => crAt({id: 5, user: 'stranger',
    association: 'COLLABORATOR', submittedAt: T2});
  assert.equal(resolveReviewState({reviews: [passAt(), outsider()],
    headSha: HEAD, permissions: {stranger: 'read'}}).blocked, null);
  const unknown = resolveReviewState(
    {reviews: [passAt(), outsider()], headSha: HEAD});
  assert.equal(unknown.blocked.by, 'stranger');
});
test('dismissal clears only its own review object, not an unrelated blocker', () => {
  const U10 = '2026-11-03T10:00:00Z';
  const U11 = '2026-11-03T10:01:00Z';
  const blocker = {login: 'helper', assoc: 'COLLABORATOR'};
  const cr10 = normReview({id: 10, user: blocker.login,
    association: blocker.assoc, state: 'CHANGES_REQUESTED',
    body: 'needs work ' + HEAD, submittedAt: U10});
  const dis11 = normReview({id: 11, user: blocker.login,
    association: blocker.assoc, state: 'DISMISSED', body: '',
    submittedAt: U11});
  const perms = {helper: 'admin'};
  // Distinct later DISMISSED object: the unresolved CR still blocks,
  // whichever array order the API returns.
  for (const reviews of [[cr10, dis11], [dis11, cr10]]) {
    const state = resolveReviewState({reviews, headSha: HEAD,
      permissions: perms});
    assert.equal(state.blocked.by, 'helper');
    assert.equal(state.blocked.reviewId, 10);
  }
  assert.throws(() => mergeEligible(
    gateInput({reviews: [passAt(), cr10, dis11], permissions: perms})),
  /review 10/);
  // Negative control: direct dismissal of the blocking object itself
  // clears it (GitHub flips that review's own state on dismiss).
  assert.equal(resolveReviewState({reviews: [{...cr10, state: 'DISMISSED'}],
    headSha: HEAD, permissions: perms}).blocked, null);
});
test('plain APPROVED cannot erase a structured HOLD or revive old PASS', () => {
  const V20 = '2026-11-03T11:00:00Z';
  const V21 = '2026-11-03T11:01:00Z';
  const V22 = '2026-11-03T11:02:00Z';
  const pass20 = normReview({id: 20, submittedAt: V20});
  const hold21 = normReview({id: 21, state: 'COMMENTED',
    body: BLOCK.replace('blocking: none', 'blocking: needs-fix'),
    submittedAt: V21});
  const plain22 = normReview({id: 22, body: '', submittedAt: V22});
  const reviews = [pass20, hold21, plain22];
  const state = resolveReviewState({reviews, headSha: HEAD});
  assert.equal(state.blocked.via, 'hold-block');
  assert.equal(state.blocked.reviewId, 21);
  assert.throws(() => mergeEligible(gateInput({reviews})), /fix plus new/);
});
test('fresh structured PASS by a later agent report supersedes a HOLD', () => {
  const V20 = '2026-11-03T11:00:00Z';
  const V21 = '2026-11-03T11:01:00Z';
  const V22 = '2026-11-03T11:02:00Z';
  const pass20 = normReview({id: 20, submittedAt: V20});
  const hold21 = normReview({id: 21, state: 'COMMENTED',
    body: BLOCK.replace('blocking: none', 'blocking: needs-fix'),
    submittedAt: V21});
  // Same GitHub publisher posts a different agent's fresh re-review:
  // valid structured PASS (report/model/tests) at this head.
  const block2 = ['RELEASE-EVIDENCE', 'reviewer: agent-2',
    'author: fixture-source-agent',
    'model: muse-spark-1.3-contributor', 'sha: ' + HEAD, 'verdict: PASS',
    'report: REVIEW-Y.md', 'tests: 3/3', 'blocking: none',
    'RELEASE-ACCEPT ' + HEAD].join('\n');
  const pass22 = normReview({id: 22, body: block2, submittedAt: V22});
  const reviews = [pass20, hold21, pass22];
  assert.equal(resolveReviewState({reviews, headSha: HEAD}).blocked, null);
  assert.equal(mergeEligible(gateInput({reviews})).ok, true);
  const pr = {author: 'author1', headSha: HEAD,
    baseRepo: 'synchronic1/AIPSTER'};
  assert.deepEqual(bindEvidence({pr, reviews}).map((b) => b.reviewId),
    [20, 22]);
});

// FIX-016: structured evidence authenticates through the publisher, not
// through string fields. A proved outsider's invented PASS supplies no
// evidence; their HOLD/malformed bodies wedge nothing; unknown standing
// fails closed; only trusted publishers bind.
const OUTSIDER_PASS = ['RELEASE-EVIDENCE', 'reviewer: claimed-independent-agent',
  'author: fixture-source-agent',
  'model: muse-spark-1.3-contributor', 'sha: ' + HEAD, 'verdict: PASS',
  'report: invented-fixture-report.md', 'tests: 1/1', 'blocking: none'].join('\n');
test('proved-outsider invented PASS supplies no evidence (controller case)', () => {
  const outsider = normReview({id: 2, user: 'fixture-outsider',
    association: 'NONE', state: 'COMMENTED', body: OUTSIDER_PASS,
    submittedAt: T1});
  // Owner acceptance marker only — no owner evidence of its own, exactly
  // the controller counterexample shape.
  const ownerMarker = normReview({id: 1, submittedAt: T0,
    body: 'RELEASE-ACCEPT ' + HEAD});
  assert.throws(() => mergeEligible(gateInput({reviews: [ownerMarker, outsider],
    permissions: {synchronic1: 'admin', 'fixture-outsider': 'read'}})),
  /No independent review evidence/);
});
test('proved-outsider HOLD and malformed bodies wedge nothing', () => {
  const holdBody = BLOCK.replace('blocking: none', 'blocking: needs-fix');
  const outsiderHold = normReview({id: 2, user: 'fixture-outsider',
    association: 'NONE', state: 'COMMENTED', body: holdBody,
    submittedAt: T1});
  const outsiderGarbage = normReview({id: 3, user: 'fixture-outsider',
    association: 'NONE', state: 'COMMENTED',
    body: 'RELEASE-EVIDENCE\nreviewer: x', submittedAt: T2});
  const perms = {'fixture-outsider': 'read'};
  assert.equal(mergeEligible(gateInput({reviews: [passAt(), outsiderHold],
    permissions: perms})).ok, true);
  assert.equal(mergeEligible(gateInput({reviews: [passAt(), outsiderGarbage],
    permissions: perms})).ok, true);
});
test('unknown-standing evidence publisher fails closed', () => {
  const mystery = normReview({id: 2, user: 'mystery', association: 'NONE',
    state: 'COMMENTED', body: BLOCK, submittedAt: T1});
  assert.throws(() => mergeEligible(gateInput({reviews: [passAt(), mystery]})),
    /Unverified evidence publisher/);
});
test('self-review at agent identity refuses despite different GitHub logins', () => {
  const selfBody = BLOCK.replace('reviewer: 948a',
    'reviewer: fixture-source-agent');
  assert.throws(() => mergeEligible(gateInput({reviews: [normReview({
    body: selfBody, submittedAt: T0})]})),
  /different agent/);
});
test('structured HOLD blocks until a later same-reviewer approval', () => {
  const holdBody = BLOCK.replace('blocking: none', 'blocking: needs-fix');
  const hold = normReview({id: 3, state: 'COMMENTED', body: holdBody,
    submittedAt: T1});
  assert.throws(() => mergeEligible(gateInput({reviews: [passAt(), hold]})),
    /fix plus new/);
  const later = normReview({id: 4, submittedAt: T2});
  assert.equal(mergeEligible(
    gateInput({reviews: [passAt(), hold, later]})).ok, true);
});
test('worker-applicable heads also require installer CI', () => {
  const installer = {id: 12, name: 'Build and qualify Windows installer',
    head_sha: HEAD, status: 'completed', conclusion: 'success',
    app: {slug: 'github-actions'}};
  assert.throws(() => mergeEligible(gateInput({workerApplicable: true,
    checks: [siteCheck(), workerCheck()]})), /installer/i);
  assert.equal(mergeEligible(gateInput({workerApplicable: true,
    checks: [siteCheck(), workerCheck(), installer]})).ok, true);
});

// reader shapes + bounded pagination + SHA asserts
test('fetchPR normalizes the doc shape; missing SHA fails', async () => {
  const routes = {'pulls/86': prDoc(), [`commits/${HEAD}/check-runs`]: {check_runs: []}};
  const {request} = mockRequest(routes);
  const pr = await fetchPR(request, 86);
  assert.equal(pr.headSha, HEAD);
  assert.equal(pr.author, 'author1');
  const bad = mockRequest({'pulls/86': {...prDoc(), head: {}}});
  await assert.rejects(fetchPR(bad.request, 86), /head SHA/);
});
test('reviews and files paginate with a cap; permission resolves', async () => {
  const pages = {'pulls/86/reviews': (path) =>
    path.includes('page=1') ? [reviewDoc({id: 1}), reviewDoc({id: 2})] : []};
  const {request} = mockRequest({'pulls/86': prDoc(),
    'pulls/86/files': [{filename: 'a.mjs'}], ...pages,
    'collaborators/synchronic1/permission': {permission: 'admin'}});
  assert.equal((await fetchReviews(request, 86)).length, 2);
  assert.deepEqual(await fetchPRFiles(request, 86), ['a.mjs']);
  assert.equal(await fetchPermission(request, 'synchronic1'), 'admin');
  const full = Array.from({length: 100}, (_, i) => reviewDoc({id: 100 + i}));
  const endless = mockRequest({'pulls/86/reviews': full});
  await assert.rejects(fetchReviews(endless.request, 86), /exceeded 10 pages/);
});
test('compare maps ancestry; unknown shape is UNKNOWN', async () => {
  const {request} = mockRequest({[`compare/${HOLD_SHA}...${HEAD}`]: {status: 'ahead'}});
  assert.equal(await holdRelationTo(request, HOLD_SHA, HEAD), 'descendant');
  assert.equal(await holdRelationTo(request, HEAD, HEAD), 'self');
  const weird = mockRequest({[`compare/${HOLD_SHA}...${HEAD}`]: {status: 'weird'}});
  assert.equal(await holdRelationTo(weird.request, HOLD_SHA, HEAD), 'unknown');
  const err = mockRequest({}, [`compare/${HOLD_SHA}...${HEAD}`]);
  assert.equal(await holdRelationTo(err.request, HOLD_SHA, HEAD), 'unknown');
});

// merge eligibility
test('merge eligible happy path; non-main base refused', () => {
  const out = mergeEligible(gateInput());
  assert.equal(out.ok, true);
  assert.equal(out.acceptedBy, '948a');
  assert.throws(() => mergeEligible(gateInput({pr: {...gateInput().pr, baseRef: 'other'}})),
    /canonical main/);
});
test('held head blocks merge; unrelated hold does not', () => {
  const holdMap = {[HOLD_SHA]: {sha: HOLD_SHA, active: true, reason: 'PR84 hold', setBy: 's'}};
  const held = normReview({commitId: HOLD_SHA,
    body: MARKER_BODY.split(HEAD).join(HOLD_SHA)});
  assert.throws(() => mergeEligible(gateInput({headSha: HOLD_SHA,
    pr: {...gateInput().pr, headSha: HOLD_SHA},
    reviews: [held], holdMap, holdRelation: 'self'})), /HOLD active/);
  assert.equal(mergeEligible(gateInput({holdMap, holdRelation: 'unrelated'})).ok, true);
});
test('CI provenance: latest wins, third-party and wrong-SHA runs do not count', () => {
  const oldFail = siteCheck({id: 3, status: 'completed', conclusion: 'failure'});
  assert.equal(mergeEligible(gateInput({checks: [oldFail, siteCheck()]})).ok, true);
  assert.throws(() => mergeEligible(gateInput({checks: [oldFail]})), /passing/);
  assert.throws(() => mergeEligible(gateInput(
    {checks: [siteCheck({app: {slug: 'other-ci'}})]})), /passing/);
  assert.throws(() => mergeEligible(gateInput(
    {checks: [siteCheck({head_sha: OTHER})]})), /passing/);
  assert.throws(() => mergeEligible(gateInput({workerApplicable: true})), /worker-covered/);
  assert.equal(mergeEligible(gateInput({workerApplicable: false,
    checks: [siteCheck()]})).ok, true);
});
test('malformed head SHA fails at the boundary', () => {
  assert.throws(() => mergeEligible(gateInput({headSha: 'zzz'})), /exact 40-hex/);
});

// single-head production primitives were removed: deployment runs through
// evaluateDeployGate (release-deploy-gate.mjs), covered by its own suite.
test('auth/API failure fails closed', async () => {
  const {request} = mockRequest({}, ['pulls/86']);
  await assert.rejects(fetchPR(request, 86), /401/);
});

// holds file
test('holds file parses; malformed entries fail', () => {
  const holds = parseHoldsFile({version: 1, holds: {[HOLD_SHA]: {sha: HOLD_SHA,
    active: true, reason: 'x', setBy: 's'}}});
  assert.equal(holds[HOLD_SHA].active, true);
  assert.throws(() => parseHoldsFile({version: 2, holds: {}}), /version/);
  assert.throws(() => parseHoldsFile({version: 1, holds: {[HOLD_SHA]: {}}}),
    /Malformed/);
});

test('runGateEvaluation races fresh; moved head discarded', async () => {
  const ownerReview = reviewDoc({author_association: 'OWNER'});
  const routes = {'pulls/86': prDoc(),
    'pulls/86/reviews': [ownerReview],
    'pulls/86/files': [{filename: 'website/x.html'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]}};
  const {request} = mockRequest(routes);
  const {verdict, pr} = await runGateEvaluation({request, n: 86, holds: {}});
  assert.equal(verdict.ok, true);
  assert.equal(pr.headSha, HEAD);
  let calls = 0;
  const moving = mockRequest({'pulls/86': () => prDoc(
    calls++ === 0 ? {} : {head: {sha: OTHER, ref: 'x',
      repo: {full_name: 'synchronic1/AIPSTER'}}}),
    'pulls/86/reviews': [ownerReview],
    'pulls/86/files': [],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]}});
  await assert.rejects(runGateEvaluation({request: moving.request, n: 86, holds: {}}),
    /moved during evaluation/);
});
test('global merge hold refuses ordinary merges; inactive does not', () => {
  const global = {[HOLD_SHA]: {sha: HOLD_SHA, active: true,
    reason: 'PR84 all-merges hold', setBy: 's', blockMerges: true}};
  assert.throws(() => mergeEligible(gateInput({holdMap: global})), /Global merge HOLD/);
  const off = {[HOLD_SHA]: {sha: HOLD_SHA, active: false,
    reason: 'resolved', setBy: 's', blockMerges: true}};
  assert.equal(mergeEligible(gateInput({holdMap: off})).ok, true);
});
test('PRs touching the hold registry fail closed (all variants)', async () => {
  for (const file of [{filename: '.github/release-holds.json', status: 'modified'},
    {filename: '.github/release-holds.json', status: 'removed'},
    {filename: '.github/release-holds.json', status: 'added'}]) {
    const routes = {'pulls/86': prDoc(),
      'pulls/86/reviews': [reviewDoc({author_association: 'OWNER'})],
      'pulls/86/files': [file],
      [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]}};
    const {request} = mockRequest(routes);
    await assert.rejects(runGateEvaluation({request, n: 86, holds: {}}),
      /hold registry/);
  }
  // Controller hold-clear probe: a candidate editing the registry from
  // active to inactive cannot clear its own hold even when the trusted
  // base map still carries an active (legacy non-global) PR84 record —
  // the registry touch itself fails closed before eligibility is reached.
  {
    const legacy = {[HOLD_SHA]: {sha: HOLD_SHA, active: true,
      reason: 'PR84 release hold', setBy: 'safeguards-seed'}};
    const routes = {'pulls/86': prDoc(),
      'pulls/86/reviews': [reviewDoc({author_association: 'OWNER'})],
      'pulls/86/files': [{filename: '.github/release-holds.json'}],
      [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
      'collaborators/948a/permission': {permission: 'read'}};
    const {request} = mockRequest(routes);
    await assert.rejects(runGateEvaluation({request, n: 86, holds: legacy}),
      /hold registry/);
  }
});
test('standing resolves via fresh endpoint reads, not caller claims', async () => {
  const collab = reviewDoc({author_association: 'COLLABORATOR'});
  const routes = {'pulls/86': prDoc(),
    'pulls/86/reviews': [collab],
    'pulls/86/files': [{filename: 'website/x.html'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
    'collaborators/948a/permission': {permission: 'admin'}};
  const {seen, request} = mockRequest(routes);
  const {verdict} = await runGateEvaluation({request, n: 86, holds: {}});
  assert.equal(verdict.acceptedBy, '948a');
  assert(seen.some((p) => p.startsWith('collaborators/948a/permission')),
    'endpoint permission must actually be read');
});
test('blocking authors get fresh permission lookup in orchestration', async () => {
  const T0 = '2026-11-03T00:00:00Z';
  const T1 = '2026-11-03T01:00:00Z';
  const approved = reviewDoc({author_association: 'OWNER',
    submitted_at: T0});
  const cr = {id: 2, user: {login: 'helper'},
    author_association: 'COLLABORATOR', state: 'CHANGES_REQUESTED',
    commit_id: HEAD, body: 'needs work ' + HEAD, submitted_at: T1};
  const routes = (permission) => ({'pulls/86': prDoc(),
    'pulls/86/reviews': [approved, cr],
    'pulls/86/files': [{filename: 'website/x.html'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
    'collaborators/948a/permission': {permission: 'read'},
    'collaborators/helper/permission': {permission}});
  // Fresh endpoint-proven admin for the blocker: merge refuses.
  {
    const {seen, request} = mockRequest(routes('admin'));
    await assert.rejects(runGateEvaluation({request, n: 86, holds: {}}),
      /changes-requested by helper/);
    assert(seen.some((p) => p.startsWith('collaborators/helper/permission')),
      'blocker standing must be read, not assumed');
  }
  // Fresh endpoint-proven read for the blocker: no blocking power.
  {
    const {request} = mockRequest(routes('read'));
    const {verdict} = await runGateEvaluation({request, n: 86, holds: {}});
    assert.equal(verdict.ok, true);
  }
});
test('unrelated dismissal cannot clear a live blocker (merge path)', async () => {
  const T0 = '2026-11-03T00:00:00Z';
  const T1 = '2026-11-03T10:00:00Z';
  const T2 = '2026-11-03T10:01:00Z';
  const approved = reviewDoc({author_association: 'OWNER',
    submitted_at: T0});
  const cr10 = {id: 10, user: {login: 'helper'},
    author_association: 'COLLABORATOR', state: 'CHANGES_REQUESTED',
    commit_id: HEAD, body: 'needs work ' + HEAD, submitted_at: T1};
  const dis11 = {id: 11, user: {login: 'helper'},
    author_association: 'COLLABORATOR', state: 'DISMISSED', body: '',
    commit_id: HEAD, submitted_at: T2};
  const routes = {'pulls/86': prDoc(),
    'pulls/86/reviews': [approved, cr10, dis11],
    'pulls/86/files': [{filename: 'website/x.html'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
    'collaborators/948a/permission': {permission: 'read'},
    'collaborators/helper/permission': {permission: 'admin'}};
  const {seen, request} = mockRequest(routes);
  await assert.rejects(runGateEvaluation({request, n: 86, holds: {}}),
    /review 10/);
  assert(seen.some((p) => p.startsWith('collaborators/helper/permission')),
    'blocker standing must be read, not assumed');
});
test('orchestration refuses outsider evidence, fetches reporter standing', async () => {
  const T0 = '2026-11-03T00:00:00Z';
  const T1 = '2026-11-03T10:01:00Z';
  const ownerAccept = reviewDoc({author_association: 'OWNER',
    body: 'RELEASE-ACCEPT ' + HEAD, submitted_at: T0});
  const outsiderReport = {id: 2, user: {login: 'fixture-outsider'},
    author_association: 'NONE', state: 'COMMENTED', commit_id: HEAD,
    body: OUTSIDER_PASS, submitted_at: T1};
  const routes = {'pulls/86': prDoc(),
    'pulls/86/reviews': [ownerAccept, outsiderReport],
    'pulls/86/files': [{filename: 'website/x.html'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
    'collaborators/948a/permission': {permission: 'read'},
    'collaborators/fixture-outsider/permission': {permission: 'read'}};
  const {seen, request} = mockRequest(routes);
  await assert.rejects(runGateEvaluation({request, n: 86, holds: {}}),
    /No independent review evidence/);
  assert(seen.some((p) => p.startsWith('collaborators/fixture-outsider/permission')),
    'marker-less reporter standing must be read, not assumed');
});
test('trusted marker-less report binds after fresh standing proof', async () => {
  const T0 = '2026-11-03T00:00:00Z';
  const T1 = '2026-11-03T10:01:00Z';
  const ownerAccept = reviewDoc({author_association: 'OWNER',
    submitted_at: T0});
  // Marker-less structured PASS from a collaborator: binds only after
  // the endpoint proves standing.
  const reporterPass = {id: 2, user: {login: 'helper'},
    author_association: 'COLLABORATOR', state: 'APPROVED', commit_id: HEAD,
    body: BLOCK, submitted_at: T1};
  const routes = {'pulls/86': prDoc(),
    'pulls/86/reviews': [ownerAccept, reporterPass],
    'pulls/86/files': [{filename: 'website/x.html'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
    'collaborators/948a/permission': {permission: 'read'},
    'collaborators/helper/permission': {permission: 'admin'}};
  const {seen, request} = mockRequest(routes);
  const {verdict} = await runGateEvaluation({request, n: 86, holds: {}});
  assert.equal(verdict.ok, true);
  assert(seen.some((p) => p.startsWith('collaborators/helper/permission')),
    'reporter standing must be read before binding');
});
test('publishHeadStatus uses POST statuses/{sha}', async () => {
  const posts = [];
  const request = async (path, init) => {
    posts.push({path, init});
    return {id: 1, state: init.body.state};
  };
  await publishHeadStatus({request, headSha: HEAD, state: 'pending',
    context: 'aipster-release-gate/head', description: 're-reading'});
  assert.equal(posts[0].path, `statuses/${HEAD}`);
  assert.equal(posts[0].init.method, 'POST');
  assert.equal(posts[0].init.body.context, 'aipster-release-gate/head');
  await assert.rejects(publishHeadStatus({request, headSha: HEAD,
    state: 'bogus', context: 'aipster-release-gate/head'}), /pending\/success/);
  await assert.rejects(publishHeadStatus({request, headSha: HEAD,
    state: 'success', context: 'release-gate-refresh'}), /distinct context/);
  await assert.rejects(publishHeadStatus({request, headSha: 'zzz',
    state: 'success', context: 'aipster-release-gate/head'}), /40-hex/);
});
test('publishEvaluation never swallows writes or exits silent', async () => {
  const ownerRoutes = () => ({'pulls/86': prDoc(),
    'pulls/86/reviews': [reviewDoc({author_association: 'OWNER'})],
    'pulls/86/files': [{filename: 'website/x.html'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
    // Fresh standing is always read for marker authors, even when OWNER
    // association alone would qualify: read proves nothing here by design.
    'collaborators/948a/permission': {permission: 'read'}});
  // Status posts go to POST statuses/{sha}; the PR read must succeed
  // before any publish is attempted.
  const isStatusPost = (path) => path.startsWith('statuses/');
  // Pending-write failure aborts before any evaluation.
  {
    let evaluated = false;
    const request = async (path) => {
      if (path === 'pulls/86') return prDoc();
      if (isStatusPost(path)) throw new Error('HTTP 500 on publish');
      evaluated = true;
      return {};
    };
    await assert.rejects(publishEvaluation({request, n: 86, holds: {},
      context: 'aipster-release-gate/head'}), /500/);
    assert.equal(evaluated, false);
  }
  // Refusal publishes failure, then the refusal (not silence) propagates.
  {
    const states = [];
    const noEvidence = {...reviewDoc({author_association: 'OWNER'}),
      body: 'nothing here ' + HEAD};
    const request = async (path, init) => {
      if (isStatusPost(path)) {
        states.push(init.body.state);
        return {id: states.length};
      }
      const routes = {...ownerRoutes(),
        'pulls/86/reviews': [noEvidence]};
      const [base] = path.split('?');
      assert(base in routes, 'unexpected ' + path);
      return routes[base];
    };
    await assert.rejects(publishEvaluation({request, n: 86,
      holds: {}, context: 'aipster-release-gate/head'}), /independent review/);
    assert.deepEqual(states, ['pending', 'failure']);
  }
  // Failure-publish failure is explicit, never exit-0 silence.
  {
    const request = async (path) => {
      if (path === 'pulls/86') return prDoc();
      if (isStatusPost(path)) throw new Error('HTTP 403 on publish');
      throw new Error('evaluation boom');
    };
    await assert.rejects(publishEvaluation({request, n: 86, holds: {},
      context: 'aipster-release-gate/head'}), /403/);
  }
  // Head moving between verdict and success refuses stale success: an
  // error is published on the new head and no success ever lands.
  {
    const states = [];
    let pulls = 0;
    const moved = prDoc({head: {sha: NEXT, ref: 'muse/x',
      repo: {full_name: 'synchronic1/AIPSTER'}}});
    const request = async (path, init) => {
      if (isStatusPost(path)) {
        states.push(path.slice('statuses/'.length) + ':' + init.body.state);
        return {id: states.length};
      }
      if (path === 'pulls/86') return ++pulls < 4 ? prDoc() : moved;
      const routes = ownerRoutes();
      const [base] = path.split('?');
      assert(base in routes, 'unexpected ' + path);
      return routes[base];
    };
    await assert.rejects(publishEvaluation({request, n: 86, holds: {},
      context: 'aipster-release-gate/head'}), /moved after evaluation/);
    assert.deepEqual(states, [`${HEAD}:pending`, `${NEXT}:error`]);
  }
});
test('listOpenPRs paginates and fails loudly beyond cap', async () => {
  const two = [];
  for (let i = 0; i < 150; i++) two.push({number: i + 1});
  const {request} = mockRequest({'pulls': (path) =>
    path.includes('&page=1') ? two.slice(0, 100) : two.slice(100)});
  assert.deepEqual(await listOpenPRs({request}), two.map((p) => p.number));
  const full = Array.from({length: 100}, (_, i) => ({number: 1000 + i}));
  const endless = mockRequest({pulls: full});
  await assert.rejects(listOpenPRs({request: endless.request, maxPages: 2}),
    /exceeded 2 pages/);
});
test('canary requires the context and no competing native run', async () => {
  const good = [{id: 1, name: 'aipster-release-gate/head', head_sha: HEAD,
    status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}}];
  const {request} = mockRequest({[`commits/${HEAD}/check-runs`]: {check_runs: good}});
  assert.equal(await assertCanaryClean({request, headSha: HEAD,
    context: 'aipster-release-gate/head'}), true);
  const rival = mockRequest({[`commits/${HEAD}/check-runs`]: {check_runs: [...good,
    {id: 2, name: 'release-gate', head_sha: HEAD, status: 'completed',
      conclusion: 'success', app: {slug: 'github-actions'}}]}});
  await assert.rejects(assertCanaryClean({request: rival.request, headSha: HEAD,
    context: 'aipster-release-gate/head'}), /competing/);
  const missing = mockRequest({[`commits/${HEAD}/check-runs`]: {check_runs: []}});
  await assert.rejects(assertCanaryClean({request: missing.request, headSha: HEAD,
    context: 'aipster-release-gate/head'}), /no passing/);
});

// no code fetched across the whole exercised surface
test('loader never requests code or artifact endpoints', async () => {
  const {seen, request} = mockRequest({'pulls/86': prDoc(),
    'pulls/86/reviews': [reviewDoc()], 'pulls/86/files': [],
    [`commits/${HEAD}/check-runs`]: {check_runs: []},
    [`commits/${HEAD}/pulls`]: [],
    [`compare/${HOLD_SHA}...${HEAD}`]: {status: 'diverged'}});
  await fetchPR(request, 86);
  await fetchReviews(request, 86);
  await fetchPRFiles(request, 86);
  await fetchAssociatedPRs(request, HEAD);
  await holdRelationTo(request, HOLD_SHA, HEAD);
  assert(seen.length >= 5);
  assertNoCodeFetch(seen);
});

