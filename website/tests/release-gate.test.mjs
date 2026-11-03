import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertNoCodeFetch, autoDeployReady, fetchAssociatedPRs, fetchPR,
  fetchPRFiles, fetchPermission, fetchReviews, findIndependentReviews,
  holdRelationTo, manualDeployReady, mergeEligible, parseHoldsFile,
  requireCheckPass, resolveAcceptance} from '../scripts/release-gate.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const HOLD_SHA = 'd'.repeat(40);

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
  body: '## Verdict: PASS\nRELEASE-ACCEPT ' + HEAD, submitted_at: '2026-11-03T00:00:00Z',
  ...over});
const siteCheck = (over = {}) => ({id: 9, name: 'Public site asset and build checks',
  head_sha: HEAD, status: 'completed', conclusion: 'success',
  app: {slug: 'github-actions'}, ...over});
const workerCheck = (over = {}) => ({id: 7, name: 'mock-install', head_sha: HEAD,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}, ...over});

function baseRoutes(over = {}) {
  return {'pulls/86': prDoc(),
    'pulls/86/reviews': [reviewDoc()],
    'pulls/86/files': [{filename: 'website/src/inference/x.mjs'}],
    [`commits/${HEAD}/check-runs`]: {check_runs: [siteCheck()]},
    [`commits/${HEAD}/pulls`]: [],
    [`compare/${HOLD_SHA}...${HEAD}`]: {status: 'unrelated'},
    'collaborators/synchronic1/permission': {permission: 'admin'}, ...over};
}
function gateInput(over = {}) {
  return {pr: {baseRef: 'main', baseRepo: 'synchronic1/AIPSTER',
    headRepo: 'synchronic1/AIPSTER', author: 'author1'},
    reviews: [{id: 1, user: '948a', association: 'COLLABORATOR',
      state: 'APPROVED', commitId: HEAD, body: 'RELEASE-ACCEPT ' + HEAD}],
    holdMap: {}, holdRelation: 'unrelated',
    checks: [siteCheck()], workerApplicable: false, headSha: HEAD, ...over};
}

// reader shapes + pagination
test('fetchPR normalizes the doc shape; missing SHA fails', async () => {
  const {request} = mockRequest(baseRoutes());
  assert.deepEqual(await fetchPR(request, 86), {number: 86, headSha: HEAD,
    headRef: 'muse/x', headRepo: 'synchronic1/AIPSTER', baseRef: 'main',
    baseRepo: 'synchronic1/AIPSTER', author: 'author1', state: 'open',
    merged: false, mergeCommit: null});
  const bad = mockRequest({'pulls/86': {...prDoc(), head: {}}});
  await assert.rejects(fetchPR(bad.request, 86), /head SHA/);
});
test('reviews and files paginate; permission resolves', async () => {
  const pages = {'pulls/86/reviews': (path) =>
    path.includes('page=1') ? [reviewDoc({id: 1}), reviewDoc({id: 2})] : []};
  const {request} = mockRequest({...baseRoutes(), ...pages});
  assert.equal((await fetchReviews(request, 86)).length, 2);
  assert.deepEqual(await fetchPRFiles(request, 86), ['website/src/inference/x.mjs']);
  assert.equal(await fetchPermission(request, 'synchronic1'), 'admin');
  const missing = mockRequest({'collaborators/ghost/permission': {}});
  await assert.rejects(fetchPermission(missing.request, 'ghost'), /No permission/);
});
test('compare maps ancestry; errors fail closed to unknown', async () => {
  const {request} = mockRequest(baseRoutes({[`compare/${HOLD_SHA}...${HEAD}`]: {status: 'ahead'}}));
  assert.equal(await holdRelationTo(request, HOLD_SHA, HEAD), 'descendant');
  assert.equal(await holdRelationTo(request, HEAD, HEAD), 'self');
  const err = mockRequest({}, [`compare/${HOLD_SHA}...${HEAD}`]);
  assert.equal(await holdRelationTo(err.request, HOLD_SHA, HEAD), 'unknown');
});
test('associated PRs pass through; malformed fails', async () => {
  const {request} = mockRequest(baseRoutes());
  assert.deepEqual(await fetchAssociatedPRs(request, HEAD), []);
  const bad = mockRequest({[`commits/${HEAD}/pulls`]: {}});
  await assert.rejects(fetchAssociatedPRs(bad.request, HEAD), /missing/);
});

// acceptance: trust, staleness, revocation, edits
test('OWNER/MEMBER/COLLABORATOR accept; others refused', () => {
  const rev = (association) => ({id: 1, user: '948a', association,
    state: 'APPROVED', commitId: HEAD, body: 'RELEASE-ACCEPT ' + HEAD});
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.deepEqual(resolveAcceptance({reviews: [rev(a)], headSha: HEAD}),
      {by: '948a', via: 'review', reviewId: 1});
  }
  for (const a of ['CONTRIBUTOR', 'NONE', null]) {
    assert.equal(resolveAcceptance({reviews: [rev(a)], headSha: HEAD}), null);
  }
});
test('stale, dismissed, edited, or wrong-state acceptance does not resolve', () => {
  const good = {id: 1, user: '948a', association: 'OWNER', state: 'APPROVED',
    commitId: HEAD, body: 'RELEASE-ACCEPT ' + HEAD};
  assert.equal(resolveAcceptance({reviews: [{...good, commitId: OTHER}],
    headSha: HEAD}), null); // changed head invalidates
  assert.equal(resolveAcceptance({reviews: [{...good, state: 'DISMISSED'}],
    headSha: HEAD}), null); // revoked
  assert.equal(resolveAcceptance({reviews: [{...good, body: 'looks fine'}],
    headSha: HEAD}), null); // marker edited away
  assert.equal(resolveAcceptance({reviews: [{...good, state: 'PENDING'}],
    headSha: HEAD}), null);
  assert.deepEqual(resolveAcceptance({reviews: [], headSha: HEAD,
    dispatchActor: 'synchronic1', dispatchActorAssociation: 'OWNER'}),
    {by: 'synchronic1', via: 'dispatch'});
  assert.equal(resolveAcceptance({reviews: [], headSha: HEAD,
    dispatchActor: 'synchronic1', dispatchActorAssociation: 'NONE'}), null);
});
test('independent reviews exclude author, stale, and dismissed rows', () => {
  const rows = [
    {user: 'author1', association: 'OWNER', state: 'APPROVED', commitId: HEAD, body: HEAD},
    {user: '948a', association: 'COLLABORATOR', state: 'APPROVED', commitId: OTHER, body: OTHER},
    {user: '948a', association: 'COLLABORATOR', state: 'DISMISSED', commitId: HEAD, body: HEAD},
    {user: '948a', association: 'COLLABORATOR', state: 'APPROVED', commitId: HEAD, body: 'pass ' + HEAD}];
  assert.deepEqual(findIndependentReviews({reviews: rows, headSha: HEAD, author: 'author1'}),
    [rows[3]]);
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
  const heldReviews = [{id: 1, user: '948a', association: 'OWNER',
    state: 'APPROVED', commitId: HOLD_SHA,
    body: 'RELEASE-ACCEPT ' + HOLD_SHA}];
  assert.throws(() => mergeEligible(gateInput({headSha: HOLD_SHA,
    reviews: heldReviews, holdMap, holdRelation: 'self'})), /HOLD active/);
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

// production paths
function deployInput(over = {}) {
  return {...gateInput(), recheckedMainSha: HEAD, ancestryToMain: 'self',
    associatedPRs: [{state: 'closed', merged_at: '2026-11-03T00:00:00Z',
      merge_commit_sha: HEAD, base: {ref: 'main',
        repo: {full_name: 'synchronic1/AIPSTER'}}}], ...over};
}
test('auto: fork, moved main, missing association, and held ancestry refused', () => {
  assert.throws(() => autoDeployReady(deployInput(
    {pr: {...deployInput().pr, headRepo: 'fork/AIPSTER'}})), /fork/);
  assert.throws(() => autoDeployReady(deployInput({recheckedMainSha: NEXT})),
    /rechecked main/);
  assert.throws(() => autoDeployReady(deployInput({associatedPRs: []})),
    /merged to canonical main/);
  assert.throws(() => autoDeployReady(deployInput({ancestryToMain: 'unknown'})),
    /ancestry/);
  // Hold placed on the merged SHA still covers a later main descendant.
  const holdMap = {[HOLD_SHA]: {sha: HOLD_SHA, active: true, reason: 'PR84 hold', setBy: 's'}};
  assert.throws(() => autoDeployReady(deployInput({holdMap, holdRelation: 'descendant'})),
    /HOLD active/);
  const out = autoDeployReady(deployInput());
  assert.equal(out.ok, true);
  assert.match(out.residualRace, /expires/);
});
test('manual: no bypass without acceptance; older SHA is not a rollback', () => {
  assert.throws(() => manualDeployReady(deployInput({reviews: []})),
    /independent review/);
  const independent = [{id: 2, user: '948a', association: 'COLLABORATOR',
    state: 'COMMENTED', commitId: HEAD, body: 'review notes ' + HEAD}];
  const out = manualDeployReady(deployInput({reviews: independent,
    dispatchActor: 'synchronic1', dispatchActorAssociation: 'OWNER'}));
  assert.equal(out.via, 'dispatch');
  assert.throws(() => manualDeployReady(deployInput({headSha: OTHER})),
    /rechecked main tip/);
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
  const {seen, request} = mockRequest(baseRoutes());
  await fetchPR(request, 86);
  await fetchReviews(request, 86);
  await fetchPRFiles(request, 86);
  await fetchAssociatedPRs(request, HEAD);
  await holdRelationTo(request, HOLD_SHA, HEAD);
  assert(seen.length >= 5);
  assertNoCodeFetch(seen);
});
