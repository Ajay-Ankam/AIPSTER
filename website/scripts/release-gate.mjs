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

export const GATE_VERSION = 'aipster-release-gate/4';
export const INSTALLER_CHECK_NAME = 'Build and qualify Windows installer';
// Control file whose edits can never authorize their own clearance: any
// ordinary evaluated PR touching it fails closed (owner-only recovery is
// a separate, explicitly approved operation — never auto-clear).
export const HOLD_REGISTRY_PATH = '.github/release-holds.json';
// Distinct commit-status context for the trusted publisher (never a
// native job name — job names prove nothing about authenticity).
export const PUBLISH_CONTEXT = 'aipster-release-gate/head';
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

// Expected producer workflow files (actual repository paths — the job
// names above are defined in these files). A same-named job from any
// other workflow, including a PR-controlled spoof workflow on a
// same-repo branch, must never substitute for the required suite.
export const SITE_WORKFLOW_FILE = '.github/workflows/public-site-checks.yml';
export const WORKER_WORKFLOW_FILE = '.github/workflows/local-worker-checks.yml';
export const INSTALLER_WORKFLOW_FILE = '.github/workflows/worker-installer-build.yml';

// Check-suite ids of a workflow file's runs at one head, via the
// supported Actions workflow-runs listing (matched client-side on
// head_sha; unknown/failed listings fail closed). Reading this endpoint
// needs the `actions: read` permission — recorded as an UNAPPLIED
// approval-gated proposal; without it every producer check refuses.
// The listing accepts a workflow ID or file NAME (documented route),
// never a repository path: requesting '.github/workflows/...' yields
// HTTP 404. The full expected file stays the producer identity for
// binding and diagnostics; only the validated basename is requested.
function workflowRouteName(workflowFile) {
  const name = workflowFile.slice(workflowFile.lastIndexOf('/') + 1);
  assert(name.length > 0 && !name.includes('/'),
    `Producer workflow file has no file name: ${workflowFile}`);
  return encodeURIComponent(name);
}
export async function fetchWorkflowSuiteIds(request, workflowFile, headSha) {
  assert(typeof request === 'function', 'A metadata requester is required');
  assert(typeof workflowFile === 'string' && workflowFile.length > 0,
    'A producer workflow file is required');
  assertSha(headSha, 'Suite head SHA');
  const routeName = workflowRouteName(workflowFile);
  const ids = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await request(
      `actions/workflows/${routeName}/runs?head_sha=${headSha}&per_page=100&page=${page}`);
    assert(data && Array.isArray(data.workflow_runs),
      `Workflow runs listing returned no list: ${workflowFile}`);
    for (const run of data.workflow_runs) {
      if (run && run.head_sha === headSha
        && Number.isInteger(run.check_suite_id)) {
        ids.push(run.check_suite_id);
      }
    }
    if (data.workflow_runs.length < 100) return ids;
  }
  throw new Error(`Workflow runs listing exceeded ${MAX_PAGES} pages (fail closed): ${workflowFile}`);
}

// Producer binding for required checks: the latest run of each named
// check must belong to a run of its expected workflow file at this head
// (joined by check-suite id). Pass/fail/latest semantics stay in
// requireCheckPass; this proves the producer. Specs: [{name, sha,
// workflowFile, label}].
export async function verifyCheckProducers({request, checks, specs}) {
  assert(Array.isArray(specs) && specs.length > 0, 'Check specs are required');
  for (const {name, sha, workflowFile, label} of specs) {
    const run = latestCheckFor(checks, name, sha);
    assert(run, `${label} has no ${name} run for this head at all`);
    const suiteId = run.check_suite && run.check_suite.id;
    assert(Number.isInteger(suiteId),
      `${label} ${name} run ${run.id} carries no suite provenance (fail closed)`);
    const suites = await fetchWorkflowSuiteIds(request, workflowFile, sha);
    assert(suites.includes(suiteId),
      `${label} ${name} run ${run.id} was not produced by ${workflowFile} at this head`);
  }
  return true;
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
// informative refusal, never a pass. `reviewer` (reviewing-agent
// identity) and `author` (source-author agent identity, as attested by
// the trusted publisher) are both required: agent-level self-review is
// rejected at bind time even when the PR GitHub author login differs.
// This is maintainer-attested report provenance, NOT cryptographic proof
// of model execution.
export function parseEvidenceBlock(body, headSha) {
  assertSha(headSha, 'Head SHA');
  if (typeof body !== 'string' || !body.includes('RELEASE-EVIDENCE')) return null;
  const get = (key) => {
    const m = body.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1] : null;
  };
  const fail = (why) => { throw new Error(`Malformed evidence block (${why})`); };
  const reviewer = get('reviewer');
  const author = get('author');
  const model = get('model');
  const sha = get('sha');
  const verdict = get('verdict');
  const report = get('report');
  const tests = get('tests');
  const blocking = get('blocking');
  if (!reviewer || !author || !model || !sha || !verdict || !report || !tests || !blocking) {
    fail('missing reviewer/author/model/sha/verdict/report/tests/blocking');
  }
  // Stale evidence is SKIPPED (null), never fatal: after a head move, old
  // reviews stay in history while fresh evidence supersedes them. Only a
  // well-formed block for THIS head can bind; malformed shape still throws.
  if (sha !== headSha) return null;
  if (/^(human|github-approval|n\/a)$/i.test(model)) fail('model must name the reviewing agent');
  const tm = tests.match(/^(\d+)\/(\d+)$/);
  if (!tm || !(Number(tm[2]) > 0) || tm[1] !== tm[2]) fail('tests must read passed/total unanimously');
  if (blocking.trim().toLowerCase() !== 'none') {
    fail('open blocking findings need a fix plus new exact-head review evidence');
  }
  if (verdict.trim().toUpperCase() !== 'PASS') {
    throw new Error(`Review verdict is ${verdict} in ${report} — not evidence of pass`);
  }
  return {reviewer, author, model, sha, report,
    tests: {passed: Number(tm[1]), total: Number(tm[2])}};
}

// Deterministic order between two normalized reviews: earlier
// submitted_at first, review id breaks ties. Returns -1/0/1; 0 means
// indistinguishable (exact tie or nothing decidable) — callers treat 0
// with conflicting states as fail-closed, never as a guess.
export function compareOrder(a, b) {
  const as = (a && a.submittedAt) || null;
  const bs = (b && b.submittedAt) || null;
  if (as && bs) {
    if (as < bs) return -1;
    if (as > bs) return 1;
  } else if (as || bs) {
    return 0;
  }
  const ai = (a && a.id !== undefined && a.id !== null) ? a.id : null;
  const bi = (b && b.id !== undefined && b.id !== null) ? b.id : null;
  if (ai !== null && bi !== null) {
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

// Structured HOLD signal in one body at one head: 'hold' (open blocking
// findings — blocks until resolved), 'clean' (unanimous PASS block), or
// 'none' (no block / stale). Malformed shapes propagate (fail closed).
function holdSignalOf(body, headSha) {
  if (typeof body !== 'string' || !body.includes('RELEASE-EVIDENCE')) {
    return 'none';
  }
  try {
    return parseEvidenceBlock(body, headSha) ? 'clean' : 'none';
  } catch (err) {
    if (/fix plus new/.test(err && err.message)) return 'hold';
    throw err;
  }
}

// Deterministic review-state resolution at one head, shared by the merge
// and deploy paths. Same-head records only: stale other-head history
// neither blocks nor passes. Per author, oldest to latest: a
// CHANGES_REQUESTED blocks; only a later same-author APPROVED clears it,
// or the direct dismissal of that exact review object (dismissal is the
// current state of one object — a DISMISSED record never clears a
// different still-unresolved object, even a newer one by the same
// publisher). A plain COMMENTED never resolves, and a different
// publisher's PASS never erases another author's block. A structured
// HOLD block stops the gate until a later same-reviewer APPROVED
// carrying a valid structured PASS supersedes it — native approval
// alone never erases a HOLD. Proven-absent outsiders have no blocking
// power; unknown standing or unattributable/ambiguously-ordered blocking
// fails closed. Returns {blocked: null | {by, via, reviewId}}.
export function resolveReviewState({reviews, headSha, permissions}) {
  assertSha(headSha, 'Head SHA');
  const same = [];
  for (const r of reviews || []) {
    if (!r || r.commitId !== headSha) continue;
    same.push(r);
  }
  const byAuthor = new Map();
  for (const r of same) {
    if (!r.user) {
      if (r.state === 'CHANGES_REQUESTED'
        || (typeof r.body === 'string' && r.body.includes('RELEASE-EVIDENCE')
          && (r.state === 'APPROVED' || r.state === 'COMMENTED'))) {
        throw new Error('Unattributable blocking review at this head: refusing');
      }
      continue;
    }
    if (!byAuthor.has(r.user)) byAuthor.set(r.user, []);
    byAuthor.get(r.user).push(r);
  }
  const orderGroup = (records) => {
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        if (compareOrder(records[i], records[j]) === 0
          && records[i].state !== records[j].state) {
          throw new Error(`Ambiguous review order for ${records[i].user} at this head: refusing`);
        }
      }
    }
    return records.slice().sort(compareOrder);
  };
  for (const [, records] of byAuthor) {
    const ordered = orderGroup(records);
    let block = null;
    for (const r of ordered) {
      // Structured signals authenticate through the publisher first: a
      // proved outsider's body is ignored entirely (no evidence, no
      // wedge); unknown standing fails closed; only proven-trusted
      // bodies are parsed at all.
      let signal = 'none';
      if ((r.state === 'APPROVED' || r.state === 'COMMENTED')
        && typeof r.body === 'string' && r.body.includes('RELEASE-EVIDENCE')) {
        const publisher = classifyStanding({login: r.user,
          association: r.association, permissions});
        if (publisher === 'absent') {
          signal = 'ignored';
        } else if (publisher === 'unknown') {
          throw new Error(`Unverified evidence publisher ${r.user} at this head: refusing`);
        } else {
          signal = holdSignalOf(r.body, headSha);
        }
      }
      if (r.state === 'CHANGES_REQUESTED') {
        block = {by: r.user, via: 'changes-requested', reviewId: r.id,
          association: r.association};
      } else if (r.state === 'APPROVED') {
        // Genuine superseding approval clears a native CR outright, but
        // a structured HOLD needs a valid structured PASS in the
        // approving record — otherwise the HOLD stands.
        if (!block || block.via !== 'hold-block' || signal === 'clean') {
          block = null;
        }
      } else if (r.state === 'DISMISSED') {
        // Direct dismissal of the blocking object itself clears it;
        // an unrelated dismissed object clears nothing.
        if (block && block.reviewId === r.id) block = null;
      }
      if (signal === 'hold') {
        block = {by: r.user, via: 'hold-block', reviewId: r.id,
          association: r.association};
      }
    }
    if (!block) continue;
    if (block.via === 'hold-block') return {blocked: block};
    const standing = classifyStanding({login: block.by,
      association: block.association, permissions});
    if (standing === 'absent') continue;
    if (standing === 'unknown') {
      return {blocked: {...block, via: 'changes-requested-unverified'}};
    }
    return {blocked: block};
  }
  return {blocked: null};
}

// Publisher standing shared by review-state resolution and evidence
// binding: 'proven' (pinned owner, OWNER association, or endpoint-proven
// admin/maintain), 'absent' (the endpoint itself reported a
// non-qualifying level), or 'unknown' (gap — fail closed). Standing can
// never be caller-asserted.
export function classifyStanding({login, association, permissions}) {
  if (resolveMaintainer({login, association,
    permission: permissions?.[login]}).maintainer) {
    return 'proven';
  }
  return (permissions && typeof permissions[login] === 'string')
    ? 'absent' : 'unknown';
}

// A HOLD-bearing record is dead only when a later same-reviewer APPROVED
// at the same head supersedes it with a valid structured PASS body
// (report/model/tests bound to this head — order decidable and strictly
// later) from a proven-trusted publisher. A plain native APPROVED, a
// COMMENTED, a malformed block, an untrusted publisher, or a different
// reviewer's record leaves the HOLD in force: publisher identity alone
// is never re-review evidence.
function holdSuperseded(record, reviews, headSha, permissions) {
  for (const q of reviews || []) {
    if (!q || q.user !== record.user || q.commitId !== headSha) continue;
    if (q.state !== 'APPROVED') continue;
    if (compareOrder(record, q) !== -1) continue;
    if (classifyStanding({login: q.user, association: q.association,
      permissions}) !== 'proven') {
      continue;
    }
    if (holdSignalOf(q.body, headSha) === 'clean') return true;
  }
  return false;
}

// Independent evidence: APPROVED/COMMENTED only (CHANGES_REQUESTED never
// counts), bound to the CURRENT head by BOTH the platform object's
// commit_id and the body sha, and only from proven-trusted
// publishers — string fields and report paths alone authenticate
// nothing. The GitHub poster is recorded as publisher, but independence
// is attested agent-to-agent: the block's reviewing-agent identity must
// differ from its attested source-author agent identity (the GitHub PR
// author login is never substituted as the source agent). Evaluated
// through the shared evidence policy. A structured HOLD still fails
// closed unless a later same-reviewer APPROVED carrying a valid
// structured PASS at this head superseded it (see resolveReviewState):
// native approval alone never revives old PASS.
export function bindEvidence({pr, reviews, permissions}) {
  assert(pr && typeof pr.author === 'string', 'PR author is required');
  const bound = [];
  for (const r of reviews || []) {
    if (r.state !== 'APPROVED' && r.state !== 'COMMENTED') continue;
    // Exact-head placement comes FIRST: the platform review object's
    // commit_id must be the target head before any trust or parsing
    // decision. A body sha never overwrites its object's placement, so
    // proven other-head history can neither bind nor wedge the current
    // head; records with missing/malformed placement never count as a
    // current match (skipped, never bound).
    if (!r || r.commitId !== pr.headSha) continue;
    if (typeof r.body !== 'string' || !r.body.includes('RELEASE-EVIDENCE')) {
      continue;
    }
    // Trusted-publisher gate BEFORE parsing/binding: a proved
    // outsider's body is ignored entirely (no evidence, no wedge);
    // unknown standing fails closed; only proven-trusted bodies parse.
    if (!r.user) {
      throw new Error('Unattributable evidence publisher at this head: refusing');
    }
    const publisher = classifyStanding({login: r.user,
      association: r.association, permissions});
    if (publisher === 'absent') continue;
    if (publisher === 'unknown') {
      throw new Error(`Unverified evidence publisher ${r.user} at this head: refusing`);
    }
    if (r.commitId === pr.headSha && holdSignalOf(r.body, pr.headSha) === 'hold'
      && holdSuperseded(r, reviews, pr.headSha, permissions)) {
      continue;
    }
    const block = parseEvidenceBlock(r.body, pr.headSha);
    if (!block) continue;
    assert(block.reviewer !== block.author,
      `Evidence reviewer ${block.reviewer} must be a different agent than the source author ${block.author}`);
    const record = evaluateReviewEvidence({sha: block.sha,
      reviewer: {model: block.model, reviewerId: block.reviewer},
      author: block.author, report: block.report, tests: block.tests,
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
  dispatchActorAssociation}) {
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
  // Dispatch-actor standing is resolved from supported metadata only: the
  // pinned owner, OWNER association passed through from the event record,
  // or an endpoint-proven permission in the map. There is no boolean
  // parameter — standing can never be caller-asserted.
  if (dispatchActor && resolveMaintainer({login: dispatchActor,
    association: dispatchActorAssociation || null,
    permission: permissions?.[dispatchActor]}).maintainer) {
    return {by: dispatchActor, via: 'dispatch'};
  }
  return null;
}

function commonGates({pr, reviews, permissions, dispatchActor,
  dispatchActorAssociation, holdMap, holdRelation, checks, workerApplicable, headSha}) {
  assertSha(headSha, 'Head SHA');
  assert(pr.baseRef === 'main' && pr.baseRepo === CANONICAL_REPO,
    'Only PRs against canonical main are eligible');
  const evidence = bindEvidence({pr, reviews, permissions});
  const acceptance = resolveAcceptance({reviews, headSha, permissions,
    dispatchActor, dispatchActorAssociation});
  assert(acceptance, 'No maintainer acceptance for this head (author prose is not acceptance)');
  // Acceptance does not erase blocking: a newer same-head
  // CHANGES_REQUESTED or an unresolved structured HOLD from any
  // still-blocking author refuses, whatever older PASS exists.
  const state = resolveReviewState({reviews, headSha, permissions});
  assert(!state.blocked,
    `Unresolved ${state.blocked?.via} by ${state.blocked?.by} at this head (review ${state.blocked?.reviewId}) — a later same-author APPROVED or dismissal is required`);
  const hold = holdCovers(holdMap, headSha, holdRelation);
  assert(!hold.covered,
    `Release HOLD active: ${hold.holds.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  requireCheckPass(checks, MAIN_CHECK_NAME, headSha, 'This head');
  if (workerApplicable) {
    // Worker changes additionally require worker + installer CI at the
    // PR head: no installer pass means no worker merge. Deployment
    // validates merged-main CI at the target through evaluateDeployGate.
    requireCheckPass(checks, WORKER_CHECK_NAME, headSha,
      'This head touches worker-covered paths, so');
    requireCheckPass(checks, INSTALLER_CHECK_NAME, headSha,
      'This head touches worker-covered paths, so its');
  }
  return {evidence: evidence.length, acceptance};
}

// Merge eligibility. Targeted holds block only the exact held head, but
// an ACTIVE GLOBAL (blockMerges) hold refuses every ordinary merge — the
// PR84 directive is all-merges-and-deployments, so no relation pretense:
// global coverage needs no ancestry proof. Inactive or non-global records
// behave as before.
export function mergeEligible(input) {
  const actives = Object.values(input.holdMap || {}).filter(h => h && h.active);
  const global = actives.filter(h => h.blockMerges === true);
  assert(global.length === 0,
    `Global merge HOLD active: ${global.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  const {evidence, acceptance} = commonGates({...input, holdRelation: 'unrelated'});
  return {ok: true, question: 'merge', sha: input.headSha,
    independentEvidence: evidence, acceptedBy: acceptance.by, via: acceptance.via};
}

// Production runs through evaluateDeployGate (release-deploy-gate.mjs),
// which binds each included PR's evidence to its own head, proves merge
// integration via second-parent, and validates holds plus merged-main CI
// at the target. The earlier single-head auto/manual primitives were
// removed here so tests cannot pass against an unwired path.
// (Manual dispatch can only ever release the rechecked canonical main tip:
// dispatching an older known-good SHA is NOT a supported rollback path —
// recovery ships a new restoring head through the same gate.)

// Full evaluation orchestration for one PR number: fresh reads, worker
// applicability from its changed files, merge verdict, then a stale-head
// race check (the head is re-read and must be unchanged) before anything
// may be published. Events are wake-ups, never authority: every output
// derives from data fetched inside this call.
export async function runGateEvaluation({request, n, holds}) {
  const pr = await fetchPR(request, n);
  const [reviews, files, checks] = await Promise.all([
    fetchReviews(request, n), fetchPRFiles(request, n),
    fetchCheckRunsAll(request, pr.headSha)]);
  // Control-file self-clearance guard: a PR touching the hold registry
  // cannot authorize its own clearance in the ordinary gate (owner-only
  // recovery is a separate, explicitly approved operation — never
  // auto-clear). Applies to modify/remove/replace alike: the PATH, not
  // the patch, is what fails closed.
  assert(!(files || []).includes(HOLD_REGISTRY_PATH),
    `PR touches the hold registry (${HOLD_REGISTRY_PATH}): refused — clearance needs a separately approved owner operation`);
  // Fresh standing for everyone whose standing the verdict may need
  // (acceptance authors plus same-head blocking authors): supported
  // endpoint reads, fail-closed gaps, never invented.
  const permissions = await resolvePermissionsFor(
    {request, logins: standingLogins(reviews, pr.headSha)});
  const applicable = isWorkerApplicable(files);
  const verdict = mergeEligible({pr, reviews, permissions, holdMap: holds,
    checks, workerApplicable: applicable, headSha: pr.headSha});
  // Producer binding for the same applicable checks: the passing runs
  // above must come from their expected workflow files, never from a
  // same-named job in another workflow.
  const specs = [{name: MAIN_CHECK_NAME, sha: pr.headSha,
    workflowFile: SITE_WORKFLOW_FILE, label: 'This head'}];
  if (applicable) {
    specs.push({name: WORKER_CHECK_NAME, sha: pr.headSha,
      workflowFile: WORKER_WORKFLOW_FILE,
      label: 'This head touches worker-covered paths, so its worker suite'},
    {name: INSTALLER_CHECK_NAME, sha: pr.headSha,
      workflowFile: INSTALLER_WORKFLOW_FILE,
      label: 'This head touches worker-covered paths, so its installer suite'});
  }
  await verifyCheckProducers({request, checks, specs});
  const fresh = await fetchPR(request, n);
  assert.equal(fresh.headSha, pr.headSha,
    'PR head moved during evaluation (stale race): discard this verdict and re-run');
  return {verdict, pr};
}

// Explicit exact-head STATUS publication under a caller-chosen DISTINCT
// context (never a native job name — job names prove nothing about
// authenticity or head binding). States: pending while re-reading,
// error on transport failure, failure for refusal, success only after a
// race-checked eligible verdict. `request` must support (path, init) here.
export async function publishHeadStatus({request, headSha, state, context,
  description}) {
  assert(['pending', 'success', 'error', 'failure'].includes(state),
    'Status state must be pending/success/error/failure');
  assertSha(headSha, 'Status head SHA');
  assert(typeof context === 'string' && context.length > 0
    && !/release-gate-refresh/.test(context),
    'Status context must be an explicit distinct context');
  return request(`statuses/${headSha}`, {method: 'POST',
    body: {state, context, description: description || '', target_url: ''}});
}

// Full publish cycle for one PR: pending first (a pending-write failure
// ABORTS before any evaluation), then evaluation, then success — or, on
// refusal, a failure write followed by the refusal itself. A failed
// failure-write is explicit (it throws); nothing here exits silent or
// resolves success without a published success. Never invoked live in
// this task; exercised with mocked HTTP only.
export async function publishEvaluation({request, n, holds, context}) {
  const opening = await fetchPR(request, n);
  await publishHeadStatus({request, headSha: opening.headSha,
    state: 'pending', context, description: 'release gate re-reading current state'});
  let verdict;
  try {
    ({verdict} = await runGateEvaluation({request, n, holds}));
  } catch (err) {
    const current = await fetchPR(request, n);
    await publishHeadStatus({request, headSha: current.headSha,
      state: 'failure', context,
      description: String((err && err.message) || err).slice(0, 140)});
    throw err;
  }
  // The verdict was race-checked inside evaluation, but the head may
  // have moved between the verdict and this write: re-read and refuse
  // stale rather than publishing success on a superseded SHA.
  const current = await fetchPR(request, n);
  if (current.headSha !== verdict.sha) {
    await publishHeadStatus({request, headSha: current.headSha,
      state: 'error', context,
      description: 'head moved after evaluation; refusing stale verdict'});
    throw new Error('publish refused: head moved after evaluation');
  }
  await publishHeadStatus({request, headSha: verdict.sha, state: 'success',
    context, description: `eligible: ${verdict.independentEvidence} evidence, ${verdict.acceptedBy}`});
  return {ok: true, verdict};
}

// Bounded open-PR listing for the scheduled evaluator: paginates, then
// fails LOUDLY past the cap (naming the cap) instead of silently
// truncating the tail.
export async function listOpenPRs({request, maxPages = 5}) {
  const numbers = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await request(`pulls?state=open&base=main&per_page=100&page=${page}`);
    assert(Array.isArray(batch), 'Open-PR listing returned no list');
    numbers.push(...batch.map((pr) => pr.number));
    if (batch.length < 100) return numbers;
  }
  throw new Error(`Open-PR listing exceeded ${maxPages} pages: refusing silent truncation`);
}

// Bootstrap canary (live, at activation only): the distinct context must
// be present and passing ON the head, and NO legacy `release-gate`
// enforcement run may exist on that head (the current advisory job is
// named `release-gate-advisory` precisely so it never matches this).
// Never invoked here.
export async function assertCanaryClean({request, headSha, context}) {
  assertSha(headSha, 'Canary head SHA');
  assert(typeof context === 'string' && context.length > 0, 'Canary context required');
  const runs = await fetchCheckRunsAll(request, headSha);
  const accepted = runs.filter((r) => r.name === context
    && r.status === 'completed' && r.conclusion === 'success');
  assert(accepted.length > 0,
    `Canary: no passing ${context} status on this head — do not install`);
  const competing = runs.filter((r) => r.name === 'release-gate');
  assert(competing.length === 0,
    'Canary: competing native release-gate run present — do not install');
  return true;
}

// Holds file read from a TRUSTED canonical-main checkout (base checkout
// for the merge gate, release-tip checkout for deploy — never a PR head,
// so a candidate can never clear its own hold through this file).
// Shape: {version: 1, holds: {sha: {sha, active, reason, setBy, at?,
// blockMerges?: bool}}}. blockMerges marks an all-merges hold (e.g. the
// PR84 directive): ordinary merge eligibility fails while one is active,
// without pretending ancestry is proven unrelated.
export function parseHoldsFile(json) {
  assert(json && typeof json === 'object' && !Array.isArray(json), 'Holds file missing');
  assert.equal(json.version, 1, 'Unknown holds-file version');
  assert(json.holds && typeof json.holds === 'object', 'Holds map missing');
  for (const [sha, hold] of Object.entries(json.holds)) {
    assert(SHA_RE.test(sha) && hold && hold.sha === sha && typeof hold.active === 'boolean'
      && typeof hold.reason === 'string' && typeof hold.setBy === 'string'
      && (hold.blockMerges === undefined || typeof hold.blockMerges === 'boolean'),
      `Malformed hold entry for ${sha}`);
  }
  return json.holds;
}

// Fresh supported collaborator-permission reads for the logins that
// actually need standing (marker-carrying reviewers). Best-effort per
// login: failures resolve to undefined and fail closed downstream
// (except the pinned owner). Read-only metadata — not new credential
// access. Returns {login: permission}.
export async function resolvePermissionsFor({request, logins}) {
  const permissions = {};
  for (const login of new Set(logins || [])) {
    if (typeof login !== 'string' || !login) continue;
    try {
      const level = await fetchPermission(request, login);
      if (typeof level === 'string') permissions[login] = level;
    } catch {
      // Inaccessible: fail closed later. Never invent a level.
    }
  }
  return permissions;
}

export function markerAuthors(reviews, headSha) {
  return (reviews || []).filter(r => r && typeof r.body === 'string'
    && r.body.includes(ACCEPT_MARKER) && r.body.includes(headSha))
    .map(r => r.user).filter(Boolean);
}

// Every login whose standing the evaluator may need: acceptance
// authors, same-head blocking authors (CHANGES_REQUESTED), and same-head
// structured-evidence publishers — including marker-less reports, whose
// standing must be proven before anything they carry can bind. Resolved
// with fresh supported endpoint reads; fail-closed gaps, never invented.
export function standingLogins(reviews, headSha) {
  const logins = new Set(markerAuthors(reviews, headSha));
  for (const r of reviews || []) {
    if (!r || r.commitId !== headSha || typeof r.user !== 'string'
      || !r.user) {
      continue;
    }
    if (r.state === 'CHANGES_REQUESTED') logins.add(r.user);
    if ((r.state === 'APPROVED' || r.state === 'COMMENTED')
      && typeof r.body === 'string' && r.body.includes('RELEASE-EVIDENCE')) {
      logins.add(r.user);
    }
  }
  return [...logins];
}
