// Trusted release-gate metadata reader + merge/production decisions.
//
// Runs on TRUSTED BASE CODE only (the gate workflow checks out the base
// ref, never the PR head). It fetches GitHub metadata as JSON and decides;
// it never downloads, checks out, or executes head code, artifacts, or
// caches. `request` is an injected `async (path) => parsed JSON` over
// `repos/synchronic1/AIPSTER/` (same shape as release-preflight's api()).
// Endpoint shapes verified against the primary REST docs 2026-11-03:
// pulls/{n} → {number, head:{sha,ref,repo:{full_name}}, base:{...},
// user:{login}, merged, merge_commit_sha, state};
// pulls/{n}/reviews → [{id, user:{login}, body, state, commit_id,
// submitted_at, author_association}];
// pulls/{n}/files (paged) → [{filename}];
// collaborators/{user}/permission → {permission} (exported utility only);
// commits/{sha}/check-runs (paged); commits/{sha}/pulls → [{state,
// merged_at, merge_commit_sha, base:{ref, repo:{full_name}}}];
// compare/{base}...{head} → {status: identical|behind|ahead|diverged}.
// Anything missing, paged-away, erroring, or misshapen fails closed:
// every normalize step asserts, so an API/auth failure is a gate failure,
// never a bypass.
//
// Identity without extra permissions: holder/acceptor standing is resolved
// from GitHub-computed `author_association` (OWNER/MEMBER/COLLABORATOR)
// on review objects plus SHA-bound markers — never from caller-provided
// strings or PR-author prose. This deliberately avoids a collaborators
// read that GITHUB_TOKEN cannot grant, keeping the gate least-privilege.
// `fetchPermission` remains an exported, tested utility for controller
// tooling with a stronger token; the gate does not depend on it.
import assert from 'node:assert/strict';
import {CANONICAL_REPO, MAIN_CHECK_NAME, WORKER_CHECK_NAME,
  fetchAllCheckRuns, isWorkerApplicable} from './release-preflight.mjs';
import {holdCovers} from './release-hold.mjs';

export const GATE_VERSION = 'aipster-release-gate/1';
// Bounded data marker a maintainer puts in a submitted review body. It is
// matched data — SHA-bound, association-checked, head-bound — never an
// executed command, and issue-comment commands are not implemented.
export const ACCEPT_MARKER = 'RELEASE-ACCEPT';
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const SHA_RE = /^[a-f0-9]{40}$/;
const CODE_ENDPOINTS = [/\/(zipball|tarball)([\/?]|$)/, /\/contents\//,
  /\/actions\/artifacts/, /raw\.githubusercontent/];

export function assertNoCodeFetch(requestedPaths) {
  for (const path of requestedPaths || []) {
    for (const re of CODE_ENDPOINTS) assert(!re.test(path),
      `Gate must never fetch code/artifacts: ${path}`);
  }
  return true;
}

async function getAllPages(request, path) {
  const items = [];
  for (let page = 1;; page++) {
    const data = await request(`${path}?per_page=100&page=${page}`);
    const batch = Array.isArray(data) ? data : data.check_runs;
    assert(Array.isArray(batch), `Paged endpoint returned no list: ${path}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

export async function fetchPR(request, n) {
  const pr = await request(`pulls/${n}`);
  assert(pr && typeof pr.number === 'number', 'PR metadata missing');
  assert(SHA_RE.test(pr.head?.sha || ''), 'PR head SHA missing');
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

// Relation of each hold SHA to a head via the compare endpoint.
// identical → self, ahead → descendant, anything else → unrelated.
// Compare failures fail closed (unknown), never assumed unrelated.
export async function holdRelationTo(request, holdSha, headSha) {
  assert(SHA_RE.test(holdSha || '') && SHA_RE.test(headSha || ''),
    'Exact SHAs are required for ancestry');
  if (holdSha === headSha) return 'self';
  try {
    const cmp = await request(`compare/${holdSha}...${headSha}`);
    if (cmp && cmp.status === 'ahead') return 'descendant';
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

const trusted = (assoc) => TRUSTED_ASSOCIATIONS.includes(assoc);

// Independent review: submitted by someone other than the author, bound to
// the CURRENT head (a changed head invalidates it), body cites that head.
// Dismissed/pending reviews and edited-away bodies stop matching.
export function findIndependentReviews({reviews, headSha, author}) {
  return (reviews || []).filter(r => r && r.user && r.user !== author
    && r.state !== 'PENDING' && r.state !== 'DISMISSED'
    && r.commitId === headSha && typeof r.body === 'string'
    && r.body.includes(headSha));
}

// Acceptance with authenticated authorship: a submitted review by a
// trust-associated maintainer carrying the SHA-bound marker at this head,
// or the manual-dispatch actor whose association the caller resolved from
// the event. Caller strings alone never suffice. Stale (commit mismatch),
// revoked (dismissed), or edited (marker gone) acceptances do not resolve.
// prevent_self_review is consciously NOT relied on: the gate reads review
// authorship itself, so GitHub's self-approval counting can never lock the
// sole maintainer out of their own PRs; author≠reviewer is enforced only
// for independent-review evidence, while a maintainer may explicitly accept
// (including self-authored work) through the marker.
export function resolveAcceptance({reviews, headSha, dispatchActor, dispatchActorAssociation}) {
  for (const r of reviews || []) {
    if ((r.state === 'APPROVED' || r.state === 'COMMENTED')
      && trusted(r.association) && r.commitId === headSha
      && typeof r.body === 'string'
      && r.body.includes(ACCEPT_MARKER) && r.body.includes(headSha)) {
      return {by: r.user, via: 'review', reviewId: r.id};
    }
  }
  if (dispatchActor && trusted(dispatchActorAssociation)) {
    return {by: dispatchActor, via: 'dispatch'};
  }
  return null;
}

function commonGates({pr, reviews, dispatchActor, dispatchActorAssociation,
  holdMap, holdRelation, checks, workerApplicable, headSha}) {
  assert(pr.baseRef === 'main' && pr.baseRepo === CANONICAL_REPO,
    'Only PRs against canonical main are eligible');
  const independent = findIndependentReviews({reviews, headSha, author: pr.author});
  assert(independent.length > 0,
    'No independent review bound to the current head (author reviews do not count)');
  const acceptance = resolveAcceptance({reviews, headSha, dispatchActor, dispatchActorAssociation});
  assert(acceptance, 'No maintainer acceptance for this head (author prose is not acceptance)');
  const hold = holdCovers(holdMap, headSha, holdRelation);
  assert(!hold.covered,
    `Release HOLD active: ${hold.holds.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  requireCheckPass(checks, MAIN_CHECK_NAME, headSha, 'This head');
  if (workerApplicable) {
    requireCheckPass(checks, WORKER_CHECK_NAME, headSha,
      'This head touches worker-covered paths, so');
  }
  return {independent: independent.length, acceptance};
}

// Merge eligibility: holds block only the exact held head (a targeted
// do-not-merge); release ancestry is a deploy question, so merging stays
// usable while a release hold is active.
export function mergeEligible(input) {
  const {independent, acceptance} = commonGates({...input, holdRelation: 'unrelated'});
  return {ok: true, question: 'merge', sha: input.headSha,
    independentReviews: independent, acceptedBy: acceptance.by, via: acceptance.via};
}

function mergedAssociation(associatedPRs, headSha) {
  return (associatedPRs || []).some(pr => pr && pr.state === 'closed'
    && pr.merged_at && pr.merge_commit_sha === headSha
    && pr.base?.ref === 'main' && pr.base?.repo?.full_name === CANONICAL_REPO);
}

export function autoDeployReady(input) {
  const {pr, headSha, recheckedMainSha, ancestryToMain, associatedPRs} = input;
  // No bypass through a fork head or a moved main: the auto path only ever
  // follows a canonical-main push it just rechecked.
  assert(pr.headRepo === CANONICAL_REPO, 'Automatic path refuses fork heads');
  assert(SHA_RE.test(recheckedMainSha || ''), 'A freshly rechecked main SHA is required');
  assert.equal(headSha, recheckedMainSha, 'Head is not the rechecked main revision');
  assert(ancestryToMain === 'self' || ancestryToMain === 'descendant',
    'Head ancestry to the release line must be proven (fail closed)');
  assert(mergedAssociation(associatedPRs, headSha),
    'No pull request merged to canonical main for this exact commit');
  const {independent, acceptance} = commonGates(input);
  return {ok: true, question: 'auto-deploy', sha: headSha,
    independentReviews: independent, acceptedBy: acceptance.by, via: acceptance.via,
    residualRace: 'Recheck main immediately before the irreversible step; this verdict expires on any new main commit.'};
}

export function manualDeployReady(input) {
  const {headSha, recheckedMainSha, ancestryToMain} = input;
  // Manual dispatch can only ever release the rechecked canonical main tip:
  // dispatching an older known-good SHA is NOT a supported rollback path
  // (preflight requires target == current main), so no bypass exists here.
  // Recovery ships a new restoring head through this same gate instead.
  assert(SHA_RE.test(recheckedMainSha || ''), 'A freshly rechecked main SHA is required');
  assert.equal(headSha, recheckedMainSha, 'Manual release must name the rechecked main tip');
  assert(ancestryToMain === 'self' || ancestryToMain === 'descendant',
    'Head ancestry to the release line must be proven (fail closed)');
  const {independent, acceptance} = commonGates(input);
  return {ok: true, question: 'manual-deploy', sha: headSha,
    independentReviews: independent, acceptedBy: acceptance.by, via: acceptance.via,
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
