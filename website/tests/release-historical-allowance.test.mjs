// RELEASE158: default-off historical allowance for the deploy gate.
// Focused on the new behavior only; the pre-existing deploy-gate suite
// (unchanged) proves the default path.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDeployGate, parseAllowancesFile, ALLOWANCE_PATH,
  ALLOWANCE_MARKER} from '../scripts/release-deploy-gate.mjs';

const h = (c) => c.repeat(40);
const LIVE = h('e');
const OLD83 = h('1');
const R97 = h('2');
const R99 = h('3');
const R104 = h('4');
const ALLOW = h('5');
const UNREL = h('6');
const OLD88 = '0d'.repeat(20);
const R98 = '9d'.repeat(20);
const M83 = h('a');
const M97 = h('b');
const M99 = h('c');
const M104 = h('d');
const MALLOW = h('9');
// The release target is exactly the allowance PR's merge onto BASE.
const TARGET = MALLOW;
const BASE = h('f');
const NOW = Date.parse('2026-11-05T00:00:00Z');
const MUNREL = h('8');
const M88 = 'b8'.repeat(20);
const M98 = 'c8'.repeat(20);
const TOUCHES = [h('7'), h('0'), 'ab'.repeat(20)];
const DIGEST = 'c0ffee'.padEnd(64, '0');
const ID = 'RELEASE158-8bcd4c7';
const SITE_SUITE = 900;
const WORKER_SUITE = 901;
const INSTALLER_SUITE = 902;
const REGISTRY = '.github/release-holds.json';

const entry = (over = {}) => ({liveSha: LIVE, mainBase: BASE,
  notAfter: '2026-11-11T23:59:59Z', registryTouches: [...TOUCHES],
  supersededHeads: [{pr: 83, head: OLD83, merge: M83,
    repairedBy: [{pr: 97, head: R97}, {pr: 99, head: R99}, {pr: 104, head: R104}],
    reason: 'Old head had two fail-open defects and no picker; repaired in-range.'},
  {pr: 88, head: OLD88, merge: M88,
    repairedBy: [{pr: 98, head: R98}],
    reason: 'Old head had dark-CSS self-cycles and overflows; repaired in-range by PR 98.'}],
  resolvedReviews: [],
  decision: 'Peter: historical release of the 8bcd4c7..target range only.',
  markerAuthor: 'synchronic1', ...over});
const allowances = (over) => parseAllowancesFile({version: 1, allowances: {[ID]: entry(over)}});

const evidenceBody = (head) => ['RELEASE-EVIDENCE', 'reviewer: 948a', 'author: fixture-author',
  'model: muse-spark-1.3-contributor', 'sha: ' + head, 'verdict: PASS', 'report: R.md',
  'tests: 3/3', 'blocking: none'].join('\n');
const review = (head, body, over = {}) => ({id: Math.floor(Math.random() * 1e9),
  user: {login: 'synchronic1'}, author_association: 'OWNER', state: 'COMMENTED',
  commit_id: head, body, submitted_at: '2026-11-04T00:00:00Z', ...over});
const markerReview = (head, id = ID, digest = DIGEST, over = {}) =>
  review(head, `${ALLOWANCE_MARKER} ${id} ${digest}\nOwner decision.`, over);

const site = (sha) => ({id: 9, name: 'Public site asset and build checks', head_sha: sha,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'},
  check_suite: {id: SITE_SUITE}});
const worker = (sha) => ({id: 7, name: 'mock-install', head_sha: sha, status: 'completed',
  conclusion: 'success', app: {slug: 'github-actions'}, check_suite: {id: WORKER_SUITE}});
const installer = (sha) => ({id: 12, name: 'Build and qualify Windows installer', head_sha: sha,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'},
  check_suite: {id: INSTALLER_SUITE}});

// PR table: number -> {head, merge, reviews, files}
function prTable(over = {}) {
  const t = {
    83: {head: OLD83, merge: M83, reviews: [], files: ['website/public/app/app.js']},
    88: {head: OLD88, merge: M88, reviews: [], files: ['website/public/app/styles.css']},
    97: {head: R97, merge: M97, reviews: [review(R97, evidenceBody(R97))], files: ['website/public/a.js']},
    98: {head: R98, merge: M98, reviews: [review(R98, evidenceBody(R98))], files: ['website/public/app/styles.css']},
    99: {head: R99, merge: M99, reviews: [review(R99, evidenceBody(R99))], files: ['website/public/b.js']},
    104: {head: R104, merge: M104, reviews: [review(R104, evidenceBody(R104))], files: ['website/public/c.js']},
    150: {head: ALLOW, merge: MALLOW,
      reviews: [review(ALLOW, evidenceBody(ALLOW)), markerReview(ALLOW)],
      files: [ALLOWANCE_PATH, 'website/scripts/release-deploy-gate.mjs']},
  };
  return {...t, ...over};
}

function harness({table = prTable(), order = [MALLOW, M104, M99, M98, M97, M88, M83],
  touches = TOUCHES, changed = ['website/public/x.html', REGISTRY], headBlob = 'blob1',
  targetBlob = 'blob1', headChecks = null, suitesFor = null,
  firstParent = (sha) => (sha === MALLOW ? BASE : null), registryBlobs = {}} = {}) {
  const byMerge = Object.fromEntries(Object.entries(table).map(([n, p]) => [p.merge, {n: Number(n), ...p}]));
  const byNum = Object.fromEntries(Object.entries(table).map(([n, p]) => [Number(n), p]));
  const request = async (path) => {
    const [base, query] = path.split('?');
    let m;
    if ((m = base.match(/^commits\/([0-9a-f]{40})\/pulls$/))) {
      const p = byMerge[m[1]];
      return p ? [{number: p.n, merged_at: 'x', merge_commit_sha: p.merge,
        base: {ref: 'main', repo: {full_name: 'synchronic1/AIPSTER'}}}] : [];
    }
    if ((m = base.match(/^pulls\/(\d+)$/))) {
      const p = byNum[Number(m[1])];
      return {number: Number(m[1]), head: {sha: p.head, ref: 'x',
        repo: {full_name: Number(m[1]) === 83 ? 'Ajay-Ankam/AIPSTER' : 'synchronic1/AIPSTER'}},
      base: {ref: 'main', repo: {full_name: 'synchronic1/AIPSTER'}}, user: {login: 'author1'},
      state: 'closed', merged: true, merge_commit_sha: p.merge};
    }
    if ((m = base.match(/^pulls\/(\d+)\/reviews$/))) return byNum[Number(m[1])].reviews;
    if ((m = base.match(/^pulls\/(\d+)\/files$/))) {
      return byNum[Number(m[1])].files.map((filename) => ({filename}));
    }
    if (/^collaborators\/[^/]+\/permission$/.test(base)) return {permission: 'read'};
    if (/^actions\/workflows\/[^/]+\/runs$/.test(base)) {
      const sha = (query.match(/head_sha=([0-9a-f]{40})/) || [])[1];
      const ids = suitesFor ? suitesFor(sha) : [SITE_SUITE, WORKER_SUITE, INSTALLER_SUITE];
      return {workflow_runs: ids.map((id) => ({id: 5000 + id, head_sha: sha, check_suite_id: id}))};
    }
    throw new Error('unexpected API path ' + path);
  };
  const git = {
    commitsInRange: () => order,
    firstParent,
    secondParent: (merge) => (byMerge[merge] ? byMerge[merge].head : null),
    isAncestor: () => false,
    changedFiles: () => changed,
    registryTouches: () => touches,
    blobAt: (sha, path) => (path === REGISTRY ? (sha in registryBlobs ? registryBlobs[sha] : 'reg1')
      : sha === ALLOW ? headBlob : targetBlob),
  };
  return {git, request, fetchChecks: async (sha) => [site(sha)],
    fetchHeadChecks: async (sha) => (headChecks ? headChecks(sha) : [site(sha)]),
    liveSha: LIVE, targetSha: TARGET, mode: 'manual', dispatchActor: 'synchronic1',
    dispatchActorAssociation: null, holds: {}, permissions: {}, now: NOW};
}

const run = (input, over = {}) => evaluateDeployGate({...input, ...over});

test('default off: no allowance keeps both original refusals', async () => {
  // No allowance entry names this head, so nothing is deferred: the
  // original per-PR refusal is thrown immediately, naming the refused head.
  await assert.rejects(run(harness()), /No independent review evidence bound to the current head/);
  await assert.rejects(run(harness()), /PR 88 head .*No independent review evidence/);
  const noOld = harness({table: (() => { const t = prTable(); t[83].reviews = [review(OLD83, evidenceBody(OLD83))]; t[88].reviews = [review(OLD88, evidenceBody(OLD88))]; return t; })()});
  await assert.rejects(run(noOld), /touches the hold registry .*no allowance pinned to this live SHA/);
});

test('intended historical chain releases and is fully recorded', async () => {
  const out = await run(harness(), {allowances: allowances(), allowanceDigest: DIGEST});
  assert.equal(out.ok, true);
  assert.deepEqual(out.historicalAllowances.map((u) => Object.keys(u).sort()),
    [['allowance', 'registryTouches'], ['allowance', 'supersededHead'], ['allowance', 'supersededHead']]);
  assert.deepEqual(out.historicalAllowances.slice(1).map((u) => u.supersededHead.pr).sort(), [83, 88]);
  assert.equal(out.prs.find((p) => p.number === 83).evidence, 0, 'old head is never called PASS');
  assert.equal(out.prs.find((p) => p.number === 88).evidence, 0, 'old head is never called PASS');
});

test('wrong or missing repair head refuses', async () => {
  const wrong = allowances({supersededHeads: [{...entry().supersededHeads[0],
    repairedBy: [{pr: 97, head: h('2').replace(/2$/, '3')}, {pr: 99, head: R99}, {pr: 104, head: R104}]},
    entry().supersededHeads[1]]});
  await assert.rejects(run(harness(), {allowances: wrong, allowanceDigest: DIGEST}),
    /repair PR 97 head .* is not merged in this range/);
  // Repair PR absent from the range.
  await assert.rejects(run(harness({order: [MALLOW, M104, M98, M97, M88, M83]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /repair PR 99 head/);
});

test('PR88 wrong or missing repair head refuses', async () => {
  const wrong = allowances({supersededHeads: [...entry().supersededHeads.slice(0, 1),
    {...entry().supersededHeads[1], repairedBy: [{pr: 98, head: R98.replace(/d$/, 'e')}]}]});
  await assert.rejects(run(harness(), {allowances: wrong, allowanceDigest: DIGEST}),
    /repair PR 98 head .* is not merged in this range/);
  // Repair PR absent from the range (PR98 merge missing, PR88 chain unsatisfied).
  await assert.rejects(run(harness({order: [MALLOW, M104, M99, M97, M88, M83]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /repair PR 98 head/);
});

test('PR88 repair without its own evidence refuses (no transitive pass)', async () => {
  const t = prTable(); t[98].reviews = [];
  await assert.rejects(run(harness({table: t}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 98 head|No independent review evidence/);
});

test('PR88 keeps its blocking-review requirement', async () => {
  const blocked = prTable({88: {...prTable()[88], reviews: [review(OLD88, 'Needs fix.',
    {state: 'CHANGES_REQUESTED'})]}});
  await assert.rejects(run(harness({table: blocked}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 88 has unresolved/);
});

test('repair head without its own evidence refuses (no transitive pass)', async () => {
  const t = prTable(); t[99].reviews = [];
  await assert.rejects(run(harness({table: t}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 99 head|No independent review evidence/);
});

test('activation requires the exact maintainer marker on the allowance PR head', async () => {
  const cases = {
    'no marker': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW))]}}),
    'wrong digest': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)), markerReview(ALLOW, ID, 'f'.repeat(64))]}}),
    'stale head': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)), markerReview(h('6'))]}}),
    'non-maintainer': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)),
      markerReview(ALLOW, ID, DIGEST, {user: {login: 'helper'}, author_association: 'CONTRIBUTOR'})]}}),
  };
  for (const [label, table] of Object.entries(cases)) {
    await assert.rejects(run(harness({table}), {allowances: allowances(), allowanceDigest: DIGEST}),
      /allowance inactive: PR 150 lacks a maintainer review/, label);
  }
});

test('auto mode, non-owner dispatch, stale live and blob drift all refuse', async () => {
  const a = {allowances: allowances(), allowanceDigest: DIGEST};
  await assert.rejects(run(harness(), {...a, mode: 'auto'}), /manual dispatch only/);
  // A non-owner dispatcher is refused before the allowance is consulted
  // (no maintainer acceptance); either refusal is acceptable, never a pass.
  await assert.rejects(run(harness(), {...a, dispatchActor: 'someone'}),
    /No maintainer acceptance|not the pinned owner/);
  await assert.rejects(run(harness(), {...a, liveSha: h('9').replace(/9$/, '8')}),
    /no allowance pinned to this live SHA/);
  await assert.rejects(run(harness({headBlob: 'blob2'}), a), /head blob .* differs from the target/);
  await assert.rejects(run(harness(), {...a, allowanceDigest: null}), /digest unavailable/);
});

test('an active hold still refuses with the allowance active', async () => {
  const holds = {[h('7')]: {sha: h('7'), active: true, reason: 'held', setBy: 'synchronic1',
    blockMerges: true}};
  await assert.rejects(run(harness(), {allowances: allowances(), allowanceDigest: DIGEST, holds}),
    /Release HOLD active/);
});

test('an additional registry touch refuses', async () => {
  await assert.rejects(run(harness({touches: [...TOUCHES, h('6')]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /pins 3 touch\(es\); range has 4/);
  await assert.rejects(run(harness({touches: TOUCHES.slice(0, 2)}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /range has 2/);
});

test('unrelated PR still needs its own evidence and CI', async () => {
  const t = prTable({160: {head: UNREL, merge: MUNREL, reviews: [], files: ['website/public/z.js']}});
  await assert.rejects(run(harness({table: t, order: [MUNREL, MALLOW, M104, M99, M98, M97, M88, M83]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /No independent review evidence/);
  const t2 = prTable({160: {head: UNREL, merge: MUNREL, reviews: [review(UNREL, evidenceBody(UNREL))],
    files: ['website/public/z.js']}});
  await assert.rejects(run(harness({table: t2, order: [MUNREL, MALLOW, M104, M99, M98, M97, M88, M83],
    headChecks: (sha) => (sha === UNREL ? [] : [site(sha)])}),
  {allowances: allowances(), allowanceDigest: DIGEST}), /PR 160 head lacks a passing/);
});

test('superseded head keeps its blocking-review and installer requirements', async () => {
  const blocked = prTable({83: {...prTable()[83], reviews: [review(OLD83, 'Picker missing.',
    {state: 'CHANGES_REQUESTED'})]}});
  await assert.rejects(run(harness({table: blocked}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 83 has unresolved/);
  const workerish = prTable({83: {...prTable()[83], files: ['local-worker/pairing.py']}});
  await assert.rejects(run(harness({table: workerish,
    headChecks: (sha) => (sha === OLD83 ? [site(sha), worker(sha)] : [site(sha)])}),
  {allowances: allowances(), allowanceDigest: DIGEST}), /PR 83 head .* installer|Build and qualify Windows installer/);
  // With installer evidence present it passes.
  const ok = await run(harness({table: workerish,
    headChecks: (sha) => (sha === OLD83 ? [site(sha), worker(sha), installer(sha)] : [site(sha)])}),
  {allowances: allowances(), allowanceDigest: DIGEST});
  assert.equal(ok.ok, true);
});

test('realGit registryTouches lists every touching commit on any parent; blobAt reads exact blobs', async () => {
  const {realGit} = await import('../scripts/release-deploy-gate.mjs');
  const {execFileSync} = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r158-'));
  const g = (...a) => execFileSync('git', a, {cwd: dir, encoding: 'utf8'}).trim();
  try {
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), '1'); g('add', '.'); g('commit', '-qm', 'live');
    const live = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'side');
    fs.mkdirSync(path.join(dir, '.github'));
    fs.writeFileSync(path.join(dir, REGISTRY), '{"version":1,"holds":{}}');
    g('add', '.'); g('commit', '-qm', 'side touch');
    const sideTouch = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
    fs.writeFileSync(path.join(dir, 'a.txt'), '2'); g('commit', '-qam', 'unrelated');
    fs.writeFileSync(path.join(dir, REGISTRY), '{"version":1,"holds":{"x":1}}');
    g('commit', '-qam', 'main touch');
    const mainTouch = g('rev-parse', 'HEAD');
    const target = mainTouch;
    const rg = realGit(dir);
    assert.deepEqual(rg.registryTouches(live, target, REGISTRY).sort(), [sideTouch, mainTouch].sort());
    assert.equal(rg.blobAt(target, REGISTRY), g('rev-parse', `${target}:${REGISTRY}`));
    assert.equal(rg.blobAt(live, REGISTRY), null);
    assert.equal(rg.firstParent(mainTouch), g('rev-parse', `${mainTouch}^1`));
    assert.equal(rg.firstParent(live), null);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('parser rejects wildcards, short SHAs, unknown keys and empty entries', () => {
  const bad = [
    {version: 1, allowances: {[ID]: entry({liveSha: '*'})}},
    {version: 1, allowances: {[ID]: entry({registryTouches: ['00c7d84']})}},
    {version: 1, allowances: {[ID]: {...entry(), extra: true}}},
    {version: 1, allowances: {[ID]: entry({markerAuthor: 'someone'})}},
    {version: 1, allowances: {[ID]: entry({mainBase: '0e6b608'})}},
    {version: 1, allowances: {[ID]: entry({notAfter: 'next week'})}},
    {version: 1, allowances: {[ID]: (() => { const e = entry(); delete e.mainBase; return e; })()}},
    {version: 1, allowances: {[ID]: (() => { const e = {...entry(), approvedBy: 'synchronic1'}; delete e.markerAuthor; return e; })()}},
    {version: 1, allowances: {[ID]: entry({registryTouches: [], supersededHeads: []})}},
    {version: 1, allowances: {[ID]: entry({supersededHeads: [{...entry().supersededHeads[0], repairedBy: []}]})}},
    {version: 2, allowances: {}},
  ];
  for (const b of bad) assert.throws(() => parseAllowancesFile(b));
  assert.deepEqual(parseAllowancesFile(null), {});
  assert.deepEqual(parseAllowancesFile({version: 1, allowances: {}}), {});
});

// ---- Final-head regressions for review 5776791336 (exact target binding,
// rollback re-arm bound, owner-only marker, activation edge cases).
const A = () => ({allowances: allowances(), allowanceDigest: DIGEST});

test('F1: a later tip with its own evidence never activates the allowance', async () => {
  const t = prTable({160: {head: UNREL, merge: MUNREL, reviews: [review(UNREL, evidenceBody(UNREL))],
    files: ['website/public/z.js']}});
  await assert.rejects(run(harness({table: t, order: [MUNREL, MALLOW, M104, M99, M98, M97, M88, M83]}),
    {...A(), targetSha: MUNREL}), /allowance inactive: the target must be the merge of a PR in range that touched .*none merged as target/);
});

test('F1: the target must sit on the pinned mainBase and integrate the PR head', async () => {
  await assert.rejects(run(harness({firstParent: () => h('3')}), A()),
    /allowance inactive: target first parent is not the pinned mainBase/);
  await assert.rejects(run(harness({firstParent: () => null}), A()),
    /target first parent is not the pinned mainBase/);
  // mainBase pinned to another tip (main moved before merge): refuses.
  await assert.rejects(run(harness(), {allowances: allowances({mainBase: h('2')}), allowanceDigest: DIGEST}),
    /not the pinned mainBase/);
});

test('rollback re-arm: after notAfter the allowance is inert even for the exact target', async () => {
  await assert.rejects(run(harness(), {...A(), now: Date.parse('2026-11-12T00:00:00Z')}),
    /allowance inactive: allowance .* expired/);
  await assert.rejects(run(harness(), {...A(), now: NaN}), /expired .*clock unavailable/);
  // Exactly at notAfter is still inside the window.
  const edge = await run(harness(), {...A(), now: Date.parse('2026-11-11T23:59:59Z')});
  assert.equal(edge.ok, true);
});

test('marker: a different maintainer (even admin) never activates; owner only', async () => {
  const t = prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)),
    markerReview(ALLOW, ID, DIGEST, {user: {login: 'helper'}, author_association: 'MEMBER'})]}});
  await assert.rejects(run(harness({table: t}), {...A(), permissions: {helper: 'admin'}}),
    /allowance inactive: PR 150 lacks a maintainer review by synchronic1/);
});

test('marker: a DISMISSED owner marker never activates', async () => {
  const t = prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)),
    markerReview(ALLOW, ID, DIGEST, {state: 'DISMISSED'})]}});
  await assert.rejects(run(harness({table: t}), A()), /allowance inactive: PR 150 lacks a maintainer review/);
});

test('RELEASE199: an earlier allowance-file toucher in range does not block activation by the target PR', async () => {
  // PR 160 introduced the file earlier in the range; PR 150 (the target
  // merge) carries the content named by the marker digest. PR 160 is still
  // evaluated as an ordinary PR (its own evidence, acceptance, CI).
  const t = prTable({160: {head: UNREL, merge: MUNREL, reviews: [review(UNREL, evidenceBody(UNREL))],
    files: [ALLOWANCE_PATH]}});
  const ok = await run(harness({table: t, order: [MALLOW, MUNREL, M104, M99, M98, M97, M88, M83]}), A());
  assert.equal(ok.ok, true);
  assert(ok.prs.some((p) => p.number === 160 && p.evidence > 0));
  // The target must itself be a toucher's merge: a non-touching target PR
  // never activates, even with the earlier toucher present.
  const nonToucher = prTable({150: {...prTable()[150], files: ['website/scripts/release-deploy-gate.mjs']},
    160: {head: UNREL, merge: MUNREL, reviews: [review(UNREL, evidenceBody(UNREL))], files: [ALLOWANCE_PATH]}});
  await assert.rejects(run(harness({table: nonToucher, order: [MALLOW, MUNREL, M104, M99, M98, M97, M88, M83]}), A()),
    /the target must be the merge of a PR in range that touched .*touching PRs: 1, none merged as target/);
});

// RELEASE199: named native changes-requested resolution.
const CR_ID = 5755949055;
const crReview = (head, id = CR_ID) => review(head, 'Picker missing.', {id, state: 'CHANGES_REQUESTED'});
const resolved = (over = {}) => ({pr: 83, reviewId: CR_ID, head: OLD83,
  reason: 'Owner-approved dismissal; GitHub leaves merged-PR reviews unchanged.', ...over});
const withResolved = (list = [resolved()]) => ({allowances: allowances({resolvedReviews: list}), allowanceDigest: DIGEST});

test('RELEASE199: an active allowance resolves exactly the named native changes-requested review', async () => {
  const blocked = prTable({83: {...prTable()[83], reviews: [crReview(OLD83)]}});
  // Without the record the original refusal stands (already covered above).
  await assert.rejects(run(harness({table: blocked}), A()), /PR 83 has unresolved changes-requested .*review 5755949055/);
  const ok = await run(harness({table: blocked}), withResolved());
  assert.equal(ok.ok, true);
  assert(ok.historicalAllowances.some((u) => u.resolvedReview && u.resolvedReview.pr === 83
    && u.resolvedReview.reviewId === CR_ID && u.resolvedReview.head === OLD83 && u.resolvedReview.by === 'synchronic1'));
});

test('RELEASE199: a different review id, head or PR is never resolved by the record', async () => {
  const otherId = prTable({83: {...prTable()[83], reviews: [crReview(OLD83, CR_ID + 1)]}});
  await assert.rejects(run(harness({table: otherId}), withResolved()), /PR 83 has unresolved changes-requested/);
  await assert.rejects(run(harness({table: prTable({83: {...prTable()[83], reviews: [crReview(OLD83)]}})}),
    withResolved([resolved({head: R97})])), /PR 83 has unresolved changes-requested/);
  await assert.rejects(run(harness({table: prTable({83: {...prTable()[83], reviews: [crReview(OLD83)]}})}),
    withResolved([resolved({pr: 88})])), /PR 83 has unresolved changes-requested/);
  // A block on another PR with the same review id is not covered either.
  const on97 = prTable({97: {...prTable()[97], reviews: [...prTable()[97].reviews, crReview(R97)]}});
  await assert.rejects(run(harness({table: on97}), withResolved()), /PR 97 has unresolved changes-requested/);
});

test('RELEASE199: the record is inert unless the allowance is active (auto mode, missing marker)', async () => {
  const blocked = prTable({83: {...prTable()[83], reviews: [crReview(OLD83)]}});
  await assert.rejects(run(harness({table: blocked}), {...withResolved(), mode: 'auto'}),
    /allowance inactive: allowances apply to manual dispatch only/);
  const noMarker = prTable({83: {...prTable()[83], reviews: [crReview(OLD83)]},
    150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW))]}});
  await assert.rejects(run(harness({table: noMarker}), withResolved()), /allowance inactive: PR 150 lacks a maintainer review/);
});

test('RELEASE199: a structured HOLD is never resolved by a resolvedReviews record', async () => {
  const holdBody = evidenceBody(R97).replace('blocking: none', 'blocking: F1 open');
  const held = prTable({97: {...prTable()[97], reviews: [review(R97, holdBody, {id: 777})]}});
  // The HOLD refuses at evidence binding (PR 97 is not a superseded head)
  // and would refuse as hold-block otherwise; a record never reaches it.
  await assert.rejects(run(harness({table: held}), withResolved([resolved({pr: 97, reviewId: 777, head: R97})])),
    /PR 97 head .*open blocking findings|PR 97 has unresolved hold-block/);
});

test('RELEASE199: parser rejects malformed resolvedReviews', () => {
  const bad = (over) => assert.throws(() => allowances({resolvedReviews: [resolved(over)]}));
  bad({head: 'abc'});
  bad({reviewId: '5755949055'});
  bad({pr: 0});
  bad({reason: 'short'});
  bad({extra: 1});
  assert.throws(() => allowances({resolvedReviews: [resolved(), resolved()]}), /duplicates/);
  assert.throws(() => allowances({resolvedReviews: 'x'}), /must be a list/);
  // An entry allowing only a resolved review is a valid (non-empty) allowance.
  const only = allowances({registryTouches: [], supersededHeads: [], resolvedReviews: [resolved()]});
  assert.equal(only[ID].resolvedReviews.length, 1);
  assert.throws(() => allowances({registryTouches: [], supersededHeads: [], resolvedReviews: []}), /allows nothing/);
});

test('two allowance entries on one live SHA fail closed', async () => {
  const two = parseAllowancesFile({version: 1, allowances: {[ID]: entry(), 'OTHER-1': entry()}});
  await assert.rejects(run(harness(), {allowances: two, allowanceDigest: DIGEST}),
    /More than one allowance pinned to this live SHA/);
});

test('superseded entry with a different head or merge does not cover the real head', async () => {
  for (const over of [{head: h('2').replace(/2$/, '4')}, {merge: h('b').replace(/b$/, 'c')}]) {
    const a = allowances({supersededHeads: [{...entry().supersededHeads[0], ...over},
      entry().supersededHeads[1]]});
    await assert.rejects(run(harness(), {allowances: a, allowanceDigest: DIGEST}),
      /PR 83 head .*No independent review evidence/);
  }
});

test('the allowance PR merge itself must not change the hold registry', async () => {
  await assert.rejects(run(harness({registryBlobs: {[MALLOW]: 'reg2'}}), A()),
    /allowance inactive: target .*release-holds.json differs from mainBase/);
  await assert.rejects(run(harness({registryBlobs: {[BASE]: null}}), A()),
    /differs from mainBase/);
});
