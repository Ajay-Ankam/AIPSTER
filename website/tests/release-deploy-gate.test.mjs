import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDeployGate} from '../scripts/release-deploy-gate.mjs';

const LIVE = 'e'.repeat(40);
const TARGET = 'f'.repeat(40);
const HEAD1 = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const MERGE1 = 'c'.repeat(40);
const MERGE2 = 'd'.repeat(40);
const HOLD_SHA = LIVE;

const blockFor = (head) => ['RELEASE-EVIDENCE', 'reviewer: 948a',
  'model: muse-spark-1.3-contributor', 'sha: ' + head, 'verdict: PASS',
  'report: REVIEW-X.md', 'tests: 12/12', 'blocking: none'].join('\n');
const markerFor = (head) => blockFor(head) + '\nRELEASE-ACCEPT ' + head;
const siteCheck = (sha) => ({id: 9, name: 'Public site asset and build checks',
  head_sha: sha, status: 'completed', conclusion: 'success',
  app: {slug: 'github-actions'}});

function mockRequest(routes, failOn = []) {
  const seen = [];
  const request = async (path) => {
    seen.push(path);
    for (const fail of failOn) if (path.startsWith(fail)) {
      throw new Error('HTTP 401 for ' + path);
    }
    const [base] = path.split('?');
    assert(base in routes, 'unexpected API path: ' + path);
    const route = routes[base];
    return typeof route === 'function' ? route(path) : route;
  };
  return {seen, request};
}

const prDoc = (n, head, fork) => ({number: n, head: {sha: head, ref: 'x',
  repo: {full_name: fork ? 'someone/AIPSTER' : 'synchronic1/AIPSTER'}},
  base: {ref: 'main', repo: {full_name: 'synchronic1/AIPSTER'}},
  user: {login: 'author1'}, state: 'closed', merged: true, merge_commit_sha: n === 90 ? MERGE1 : MERGE2});
const reviewDoc = (head, over = {}) => ({id: 1, user: {login: '948a'},
  author_association: 'OWNER', state: 'APPROVED', commit_id: head,
  body: markerFor(head), submitted_at: '2026-11-03T00:00:00Z', ...over});
const assoc = (n) => ({number: n, state: 'closed', merged_at: '2026-11-03T00:00:00Z',
  merge_commit_sha: n === 90 ? MERGE1 : MERGE2,
  base: {ref: 'main', repo: {full_name: 'synchronic1/AIPSTER'}}});

function baseRoutes(over = {}) {
  return {[`commits/${MERGE1}/pulls`]: [assoc(90)],
    [`commits/${MERGE2}/pulls`]: [assoc(91)],
    'pulls/90': prDoc(90, HEAD1), 'pulls/91': prDoc(91, HEAD2),
    'pulls/90/reviews': [reviewDoc(HEAD1)],
    'pulls/91/reviews': [reviewDoc(HEAD2)],
    [`commits/${TARGET}/check-runs`]: {check_runs: [siteCheck(TARGET)]}, ...over};
}
const git = (over = {}) => ({mergesInRange: () => [MERGE1, MERGE2],
  secondParent: (m) => (m === MERGE1 ? HEAD1 : HEAD2),
  isAncestor: () => false,
  changedFiles: () => ['website/public/index.html'], ...over});
function gateInput(over = {}) {
  const {request} = mockRequest(baseRoutes());
  return {git: git(), request, fetchChecks: async () => [siteCheck(TARGET)],
    liveSha: LIVE, targetSha: TARGET, mode: 'auto', holds: {}, ...over};
}

test('happy path evaluates every included PR', async () => {
  const out = await evaluateDeployGate(gateInput());
  assert.equal(out.ok, true);
  assert.deepEqual(out.prs.map(p => p.number), [90, 91]);
  assert.equal(out.prs[0].acceptedBy, '948a');
});
test('fork-origin PR merged canonically is releasable', async () => {
  const {request} = mockRequest(baseRoutes({'pulls/90': prDoc(90, HEAD1, true)}));
  const out = await evaluateDeployGate({...gateInput(), request});
  assert.equal(out.ok, true);
});
test('unassociated merge fails closed', async () => {
  const {request} = mockRequest(baseRoutes({[`commits/${MERGE1}/pulls`]: []}));
  await assert.rejects(evaluateDeployGate({...gateInput(), request}), /no associated pull request/);
});
test('evidence on the wrong head fails', async () => {
  const {request} = mockRequest(baseRoutes(
    {'pulls/90/reviews': [reviewDoc(HEAD2)]}));
  await assert.rejects(evaluateDeployGate({...gateInput(), request}), /different head/);
});
test('second-parent mismatch fails integration proof', async () => {
  const badGit = git({secondParent: () => HEAD2});
  await assert.rejects(evaluateDeployGate({...gateInput(), git: badGit}),
    /does not integrate/);
});
test('hold descendant blocks both paths; unrelated does not', async () => {
  const holds = {[HOLD_SHA]: {sha: HOLD_SHA, active: true, reason: 'PR84 hold', setBy: 's'}};
  const covering = git({isAncestor: () => true});
  await assert.rejects(evaluateDeployGate({...gateInput(), holds, git: covering}),
    /HOLD active/);
  await assert.rejects(evaluateDeployGate({...gateInput(), holds, git: covering, mode: 'manual',
    dispatchActor: 'synchronic1'}), /HOLD active/);
  const out = await evaluateDeployGate({...gateInput(), holds});
  assert.equal(out.ok, true); // isAncestor false → unrelated
});
test('merged-main CI required at target; worker conditional', async () => {
  await assert.rejects(evaluateDeployGate(
    {...gateInput(), fetchChecks: async () => []}), /passing/);
  const workerGit = git({changedFiles: () => ['local-worker/x.py']});
  await assert.rejects(evaluateDeployGate({...gateInput(), git: workerGit}),
    /worker-covered/);
  const out = await evaluateDeployGate({...gateInput(), git: workerGit,
    fetchChecks: async () => [siteCheck(TARGET),
      {id: 3, name: 'mock-install', head_sha: TARGET, status: 'completed',
        conclusion: 'success', app: {slug: 'github-actions'}}]});
  assert.equal(out.ok, true);
});
test('already-live is a noop; manual dispatch actor accepted', async () => {
  const out = await evaluateDeployGate({...gateInput(), liveSha: TARGET});
  assert.deepEqual(out, {ok: true, noop: 'already-live'});
  const noMarker = baseRoutes({'pulls/90/reviews':
    [{...reviewDoc(HEAD1), body: blockFor(HEAD1)}]});
  const {request} = mockRequest(noMarker);
  const manual = await evaluateDeployGate({...gateInput(), request,
    mode: 'manual', dispatchActor: 'synchronic1'});
  assert.equal(manual.prs[0].via, 'dispatch');
  await assert.rejects(evaluateDeployGate({...gateInput(), request, mode: 'manual'}),
    /No maintainer acceptance/);
});
test('git and API failures fail closed', async () => {
  const badGit = git({mergesInRange: () => { throw new Error('git gone'); }});
  await assert.rejects(evaluateDeployGate({...gateInput(), git: badGit}), /git gone/);
  const {request} = mockRequest({[`commits/${MERGE1}/pulls`]: [assoc(90)]}, ['pulls/90']);
  await assert.rejects(evaluateDeployGate({...gateInput(), request}), /401/);
});
