import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertNoCodeFetch, autoDeployReady, bindEvidence, fetchAssociatedPRs,
  fetchPR, fetchPRFiles, fetchPermission, fetchReviews, holdRelationTo,
  manualDeployReady, mergeEligible, parseEvidenceBlock, parseHoldsFile,
  requireCheckPass, resolveAcceptance, resolveMaintainer} from '../scripts/release-gate.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const HOLD_SHA = 'd'.repeat(40);

const BLOCK = ['RELEASE-EVIDENCE', 'reviewer: 948a',
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
test('malformed blocks fail closed', () => {
  assert.throws(() => parseEvidenceBlock('RELEASE-EVIDENCE\nreviewer: x', HEAD), /missing/);
  assert.throws(() => parseEvidenceBlock(BLOCK.replace(HEAD, OTHER), HEAD), /different head/);
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
  assert.throws(() => bindEvidence({pr, reviews: [normReview({body: MARKER_BODY.replace('reviewer: 948a', 'reviewer: author1')})]}), /distinct/);
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
  assert.equal(mergeEligible(gateInput({workerApplicable: true,
    checks: [siteCheck(), workerCheck()]})).ok, true);
});
test('malformed head SHA fails at the boundary', () => {
  assert.throws(() => mergeEligible(gateInput({headSha: 'zzz'})), /exact 40-hex/);
});

// production paths split reviewed head from release SHA
function deployInput(over = {}) {
  return {...gateInput(), reviewedHeadSha: HEAD, releaseSha: NEXT,
    recheckedMainSha: NEXT, ancestryToMain: 'self',
    associatedPRs: [{state: 'closed', merged_at: '2026-11-03T00:00:00Z',
      merge_commit_sha: NEXT, base: {ref: 'main',
        repo: {full_name: 'synchronic1/AIPSTER'}}}],
    checks: [siteCheck({head_sha: NEXT, id: 11})], ...over};
}
test('auto: fork-origin merged PR is releasable once merged canonically', () => {
  const forkPr = {...deployInput().pr, headRepo: 'someone/AIPSTER'};
  const out = autoDeployReady(deployInput({pr: forkPr}));
  assert.equal(out.reviewedHead, HEAD);
  assert.equal(out.release, NEXT);
});
test('auto: moved main, missing association, held ancestry refused', () => {
  assert.throws(() => autoDeployReady(deployInput({recheckedMainSha: OTHER})),
    /rechecked main/);
  assert.throws(() => autoDeployReady(deployInput({associatedPRs: []})),
    /merged to canonical main/);
  assert.throws(() => autoDeployReady(deployInput({ancestryToMain: 'unknown'})),
    /ancestry/);
  const holdMap = {[HOLD_SHA]: {sha: HOLD_SHA, active: true, reason: 'PR84 hold', setBy: 's'}};
  assert.throws(() => autoDeployReady(deployInput({holdMap, holdRelation: 'descendant'})),
    /HOLD active/);
  const out = autoDeployReady(deployInput());
  assert.equal(out.ok, true);
  assert.match(out.residualRace, /expires/);
});
test('manual: no bypass without evidence; older SHA is not a rollback', () => {
  assert.throws(() => manualDeployReady({...deployInput(), headSha: HEAD,
    reviews: [], reviewedHeadSha: HEAD}), /bound to the current head/);
  const independent = [{id: 2, user: 'agent2', association: 'COLLABORATOR',
    state: 'COMMENTED', commitId: HEAD,
    body: BLOCK.replace('reviewer: 948a', 'reviewer: agent2')}];
  const out = manualDeployReady({...deployInput(), reviews: independent,
    releaseSha: NEXT, recheckedMainSha: NEXT,
    dispatchActor: 'synchronic1'});
  assert.equal(out.via, 'dispatch');
  assert.throws(() => manualDeployReady(deployInput({releaseSha: OTHER,
    recheckedMainSha: NEXT})), /rechecked main tip/);
});
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
