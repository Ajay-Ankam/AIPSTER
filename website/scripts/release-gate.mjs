// Trusted release-gate metadata reader + merge/production decisions.
//
// Runs on TRUSTED BASE CODE only for enforcement (pull_request_target
// runs the base workflow version). It fetches GitHub metadata as JSON and
// decides; it never downloads, checks out, or executes head code,
// artifacts, or caches. `request` is an injected `async (path) => parsed
// JSON` over `repos/synchronic1/AIPSTER/` (same shape as
// release-preflight's api()). Endpoint shapes verified against the primary
// REST docs 2026-11-03: pulls/{n} → {number, head:{sha,ref,repo:
// {full_name}}, base:{...}, user:{login}, merged, merge_commit_sha, state};
// pulls/{n}/reviews → [{id, user:{login}, body, state, commit_id,
// submitted_at, author_association}]; pulls/{n}/files (paged) → [{filename}];
// collaborators/{user}/permission → {permission}; commits/{sha}/check-runs
// (paged); commits/{sha}/pulls → [{state, merged_at, merge_commit_sha,
// base:{ref, repo:{full_name}}}]; compare/{base}...{head} → {status}.
// Anything missing, paged-away, erroring, or misshapen fails closed:
// every normalize step asserts, so an API/auth failure is a gate failure,
// never a bypass.
//
// Identity without extra permissions: holder/acceptor standing is resolved
// from the pinned repository owner plus GitHub-computed
// `author_association` (OWNER) plus endpoint-proven admin/maintain — never
// from caller strings, PR-author prose, or a read/triage relationship.
// `fetchPermission` uses only the supported read permission; when it is
// inaccessible the gate fails closed (except the pinned owner).
// `prevent_self_review` is consciously NOT relied on: authorship is read
// directly, so self-approval counting can never lock the sole maintainer
// out; a maintainer may explicitly accept (including self-authored work)
// and that acceptance is recorded distinctly from independent review.
import assert from 'node:assert/strict';
import {CANONICAL_REPO, MAIN_CHECK_NAME, WORKER_CHECK_NAME,
  fetchAllCheckRuns, isWorkerApplicable} from './release-preflight.mjs';
import {evaluateReviewEvidence, holdCovers} from './release-hold.mjs';

export const GATE_VERSION = 'aipster-release-gate/2';
// Pinned verified repository owner (live-confirmed 2026-11-03: sole
// collaborator). Owner acceptance needs no further proof; everything else
// needs OWNER association or endpoint-proven admin/maintain.
export const PINNED_OWNER = 'synchronic1';
// Bounded data marker a maintainer puts in a submitted review body. Matched
// data — SHA-bound, standing-checked, head-bound — never an executed
// command, and issue-comment commands are not implemented.
export const ACCEPT_MARKER = 'RELEASE-ACCEPT';
const SHA_RE = /^[a-f0-9]{40}$/;
const CODE_ENDPOINTS = [/\/(zipball|tarball)([\/?]|$)/, /\/contents\//,
  /\/actions\/artifacts/, /raw\.githubusercontent/];
const COMPARE_STATUS = ['identical', 'behind', 'ahead', 'diverged'];
const MAX_PAGES = 10;

export function assertNoCodeFetch(requestedPaths) {
  for (const path of requestedPaths || []) {
    for (const re of CODE_ENDPOINTS) assert(!re.test(path),
      `Gate must never fetch code/artifacts: ${path}`);
  }
  return true;
}

function assertSha(value, label) {
  assert(SHA_RE.test(value || ''), `${label || 'SHA'} must be an exact 40-hex SHA`);
  return value;
}

async function getAllPages(request, path) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await request(`${path}?per_page=100&page=${page}`);
    const batch = Array.isArray(data) ? data : data.check_runs;
    assert(Array.isArray(batch), `Paged endpoint returned no list: ${path}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`Paged endpoint exceeded ${MAX_PAGES} pages (fail closed): ${path}`);
}

export async function fetchCheckRunsAll(request, sha) {
  assertSha(sha, 'Check-runs SHA');
  return getAllPages(request, `commits/${sha}/check-runs`);
}

export async function fetchPR(request, n) {
  const pr = await request(`pulls/${n}`);
  assert(pr && typeof pr.number === 'number', 'PR metadata missing');
  assertSha(pr.head?.sha, 'PR head SHA');
  return {number: pr.number, headSha: pr.head.sha, headRef: pr.head.ref,
    headRepo: pr.head.repo?.full_name, baseRef: pr.base?.ref,
    baseRepo: pr.base?.repo?.full_name, author: pr.user?.login || null,
    state: pr.state, merged: pr.merged === true,
    mergeCommit: pr.merge_commit_sha || null};
}

export async function fetchReviews(request, n) {
  const rows = await getAllPages(request, `pulls/${n}/reviews`);
  return rows.map(r => ({id: r.id, user: r.user?.login || null,
    association: r.author_association || null, state: r.state,
    commitId: r.commit_id || null, body: r.body || '',
    submittedAt: r.submitted_at || null}));
}

export async function fetchPRFiles(request, n) {
  const rows = await getAllPages(request, `pulls/${n}/files`);
  return rows.map(f => f.filename).filter(f => typeof f === 'string');
}

export async function fetchPermission(request, user) {
  assert(typeof user === 'string' && user.length > 0, 'A username is required');
  const data = await request(`collaborators/${user}/permission`);
  assert(data && typeof data.permission === 'string', `No permission record for ${user}`);
  return data.permission;
}

export async function fetchAssociatedPRs(request, sha) {
  const rows = await request(`commits/${sha}/pulls`);
  assert(Array.isArray(rows), 'Associated-PR metadata missing');
  return rows;
}

// Relation of a hold SHA to a head via the compare endpoint. Response shape
// is validated: unknown status/shape is UNKNOWN (hold), never unrelated.
export async function holdRelationTo(request, holdSha, headSha) {
  assertSha(holdSha, 'Hold SHA');
  assertSha(headSha, 'Head SHA');
  if (holdSha === headSha) return 'self';
  try {
    const cmp = await request(`compare/${holdSha}...${headSha}`);
    if (!cmp || !COMPARE_STATUS.includes(cmp.status)) return 'unknown';
    if (cmp.status === 'ahead') return 'descendant';
    if (cmp.status === 'identical') return 'self';
    return 'unrelated';
  } catch {
    return 'unknown';
  }
}

// Latest check-run wins per (name, sha), GitHub-Actions provenance only.
export function latestCheckFor(checks, name, sha) {
  const rows = (checks || []).filter(c => c && c.name === name
    && c.head_sha === sha && c.app?.slug === 'github-actions')
    .sort((a, b) => b.id - a.id);
  return rows[0] || null;
}

export function requireCheckPass(checks, name, sha, label) {
  const run = latestCheckFor(checks, name, sha);
  assert(run && run.status === 'completed' && run.conclusion === 'success',
    `${label} lacks a passing ${name} run for this exact head`);
  return run;
}

// Maintainer standing: pinned owner, OWNER association, or endpoint-proven
// admin/maintain. Read/triage relationships, stale associations, and
// inaccessible endpoints (permission undefined) never qualify — except the
// pinned owner, which needs no further proof.
export function resolveMaintainer({login, association, permission}) {
  if (login === PINNED_OWNER || association === 'OWNER') {
    return {maintainer: true, basis: 'owner'};
  }
  if (permission === 'admin' || permission === 'maintain') {
    return {maintainer: true, basis: 'permission:' + permission};
  }
  return {maintainer: false};
}

// Structured evidence block a review body must carry to count. Strict:
// an arbitrary SHA mention is NOT evidence. `blocking` must read exactly
// `none` — blocking findings cannot pass via disposition prose; they need
// a fix plus new exact-head review evidence. A HOLD verdict is an
// informative refusal, never a pass.
export function parseEvidenceBlock(body, headSha) {
  assertSha(headSha, 'Head SHA');
  if (typeof body !== 'string' || !body.includes('RELEASE-EVIDENCE')) return null;
  const get = (key) => {
    const m = body.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1] : null;
  };
  const fail = (why) => { throw new Error(`Malformed evidence block (${why})`); };
  const reviewer = get('reviewer');
  const model = get('model');
  const sha = get('sha');
  const verdict = get('verdict');
  const report = get('report');
  const tests = get('tests');
  const blocking = get('blocking');
  if (!reviewer || !model || !sha || !verdict || !report || !tests || !blocking) {
    fail('missing reviewer/model/sha/verdict/report/tests/blocking');
  }
  if (sha !== headSha) fail('evidence names a different head');
  if (/^(human|github-approval|n\/a)$/i.test(model)) fail('model must name the reviewing agent');
  const tm = tests.match(/^(\d+)\/(\d+)$/);
  if (!tm || !(Number(tm[2]) > 0) || tm[1] !== tm[2]) fail('tests must read passed/total unanimously');
  if (blocking.trim().toLowerCase() !== 'none') {
    fail('open blocking findings need a fix plus new exact-head review evidence');
  }
  if (verdict.trim().toUpperCase() !== 'PASS') {
    throw new Error(`Review verdict is ${verdict} in ${report} — not evidence of pass`);
  }
  return {reviewer, model, sha, report,
    tests: {passed: Number(tm[1]), total: Number(tm[2])}};
}

// Independent evidence: APPROVED/COMMENTED only (CHANGES_REQUESTED never
// counts), bound to the CURRENT head, reviewer agent distinct from the
// author (the poster may be the maintainer publishing the agent's report —
// recorded as publisher), evaluated through the shared evidence policy.
export function bindEvidence({pr, reviews}) {
  assert(pr && typeof pr.author === 'string', 'PR author is required');
  const bound = [];
  for (const r of reviews || []) {
    if (r.state !== 'APPROVED' && r.state !== 'COMMENTED') continue;
    const block = parseEvidenceBlock(r.body, pr.headSha);
    if (!block) continue;
    assert(block.reviewer !== pr.author,
      `Evidence reviewer ${block.reviewer} must be distinct from the author`);
    const record = evaluateReviewEvidence({sha: block.sha,
      reviewer: {model: block.model, reviewerId: block.reviewer},
      author: pr.author, report: block.report, tests: block.tests,
      status: 'pass', findings: [], sourceRepo: pr.baseRepo}, pr.headSha);
    bound.push({...record, reviewId: r.id, publisher: r.user});
  }
  assert(bound.length > 0,
    'No independent review evidence bound to the current head');
  return bound;
}

// Acceptance with authenticated authorship: a submitted review by a
// standing-holding maintainer carrying the SHA-bound marker at this head,
// or the manual-dispatch actor with proven standing. Stale (commit
// mismatch), revoked (dismissed), or edited (marker gone) acceptances do
// not resolve. Caller strings alone never suffice.
export function resolveAcceptance({reviews, headSha, permissions, dispatchActor,
  dispatchActorStanding}) {
  assertSha(headSha, 'Head SHA');
  for (const r of reviews || []) {
    if ((r.state === 'APPROVED' || r.state === 'COMMENTED')
      && r.commitId === headSha && typeof r.body === 'string'
      && r.body.includes(ACCEPT_MARKER) && r.body.includes(headSha)
      && resolveMaintainer({login: r.user, association: r.association,
        permission: permissions?.[r.user]}).maintainer) {
      return {by: r.user, via: 'review', reviewId: r.id};
    }
  }
  if (dispatchActor && (dispatchActorStanding === true || resolveMaintainer({
    login: dispatchActor, association: null,
    permission: permissions?.[dispatchActor]}).maintainer)) {
    return {by: dispatchActor, via: 'dispatch'};
  }
  return null;
}

function commonGates({pr, reviews, permissions, dispatchActor,
  dispatchActorStanding, holdMap, holdRelation, checks, workerApplicable, headSha, ciSha}) {
  // Evidence binds the reviewed head; CI validates the release SHA (for a
  // merged release these differ — ordinary merges must not fail). Callers
  // that release a merge pass ciSha: releaseSha; merge checks its own head.
  assertSha(headSha, 'Head SHA');
  assert(pr.baseRef === 'main' && pr.baseRepo === CANONICAL_REPO,
    'Only PRs against canonical main are eligible');
  const evidence = bindEvidence({pr, reviews});
  const acceptance = resolveAcceptance({reviews, headSha, permissions,
    dispatchActor, dispatchActorStanding});
  assert(acceptance, 'No maintainer acceptance for this head (author prose is not acceptance)');
  const hold = holdCovers(holdMap, headSha, holdRelation);
  assert(!hold.covered,
    `Release HOLD active: ${hold.holds.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  const ci = ciSha || headSha;
  requireCheckPass(checks, MAIN_CHECK_NAME, ci, 'This release');
  if (workerApplicable) {
    requireCheckPass(checks, WORKER_CHECK_NAME, ci,
      'This release touches worker-covered paths, so');
  }
  return {evidence: evidence.length, acceptance};
}

// Merge eligibility: holds block only the exact held head (targeted
// do-not-merge); release ancestry is a deploy question, so merging stays
// usable while a release hold is active.
export function mergeEligible(input) {
  const {evidence, acceptance} = commonGates({...input, holdRelation: 'unrelated'});
  return {ok: true, question: 'merge', sha: input.headSha,
    independentEvidence: evidence, acceptedBy: acceptance.by, via: acceptance.via};
}

export function mergedAssociation(associatedPRs, headSha) {
  return (associatedPRs || []).some(pr => pr && pr.state === 'closed'
    && pr.merged_at && pr.merge_commit_sha === headSha
    && pr.base?.ref === 'main' && pr.base?.repo?.full_name === CANONICAL_REPO);
}

// Production decisions split reviewed head from release SHA: evidence binds
// the reviewed PR head, while main-equality, association, holds, and CI
// validate the merged-main release SHA. A fork-origin PR merged to trusted
// canonical main is therefore releasable once merged — fork origin alone
// never refuses forever; the canonical merge source is what is validated.
export function autoDeployReady(input) {
  const {pr, reviewedHeadSha, releaseSha, recheckedMainSha, ancestryToMain,
    associatedPRs} = input;
  assertSha(reviewedHeadSha, 'Reviewed head SHA');
  assertSha(releaseSha, 'Release SHA');
  assertSha(recheckedMainSha, 'Rechecked main SHA');
  assert.equal(releaseSha, recheckedMainSha, 'Release is not the rechecked main revision');
  assert(ancestryToMain === 'self' || ancestryToMain === 'descendant',
    'Release ancestry to the release line must be proven (fail closed)');
  assert(mergedAssociation(associatedPRs, releaseSha),
    'No pull request merged to canonical main for this exact release');
  const {evidence, acceptance} = commonGates({...input, headSha: reviewedHeadSha, ciSha: releaseSha});
  return {ok: true, question: 'auto-deploy', reviewedHead: reviewedHeadSha,
    release: releaseSha, independentEvidence: evidence,
    acceptedBy: acceptance.by, via: acceptance.via,
    residualRace: 'Recheck main immediately before the irreversible step; this verdict expires on any new main commit.'};
}

export function manualDeployReady(input) {
  const {releaseSha, recheckedMainSha, ancestryToMain} = input;
  // Manual dispatch can only ever release the rechecked canonical main tip:
  // dispatching an older known-good SHA is NOT a supported rollback path
  // (preflight requires target == current main), so no bypass exists here.
  // Recovery ships a new restoring head through this same gate instead.
  assertSha(releaseSha, 'Release SHA');
  assertSha(recheckedMainSha, 'Rechecked main SHA');
  assert.equal(releaseSha, recheckedMainSha, 'Manual release must name the rechecked main tip');
  assert(ancestryToMain === 'self' || ancestryToMain === 'descendant',
    'Release ancestry to the release line must be proven (fail closed)');
  const {evidence, acceptance} = commonGates({...input, headSha: input.reviewedHeadSha, ciSha: releaseSha});
  return {ok: true, question: 'manual-deploy', reviewedHead: input.reviewedHeadSha,
    release: releaseSha, independentEvidence: evidence,
    acceptedBy: acceptance.by, via: acceptance.via,
    residualRace: 'Recheck main immediately before the irreversible step; this verdict expires on any new main commit.'};
}

// Holds file read from the TRUSTED BASE checkout (never the head).
// Shape: {version: 1, holds: {sha: {sha, active, reason, setBy, at?}}}.
export function parseHoldsFile(json) {
  assert(json && typeof json === 'object' && !Array.isArray(json), 'Holds file missing');
  assert.equal(json.version, 1, 'Unknown holds-file version');
  assert(json.holds && typeof json.holds === 'object', 'Holds map missing');
  for (const [sha, hold] of Object.entries(json.holds)) {
    assert(SHA_RE.test(sha) && hold && hold.sha === sha && typeof hold.active === 'boolean'
      && typeof hold.reason === 'string' && typeof hold.setBy === 'string',
      `Malformed hold entry for ${sha}`);
  }
  return json.holds;
}
