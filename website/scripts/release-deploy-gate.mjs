// Release-deploy gate: evaluates EVERY PR included in a release range,
// not just the newest merge, before any production step.
//
// Runs inside the deploy workflow on the trusted release checkout (a
// canonical-main tip) with full git history. It reads the holds file from
// that checkout (never candidate-controlled content), enumerates merge
// commits liveSha..targetSha with git, resolves each merge to its PRs via
// the API, binds each PR's evidence to its OWN head, proves integration
// via second-parent equality, then validates holds and merged-main CI at
// the target. Pure `evaluateDeployGate` takes injected git/request; the
// CLI runner below wires real git + fetch. No push/merge/deploy here.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CANONICAL_REPO, MAIN_CHECK_NAME, WORKER_CHECK_NAME,
  isWorkerApplicable} from './release-preflight.mjs';
import {bindEvidence, fetchAssociatedPRs, fetchPR,
  fetchPRFiles, fetchReviews, parseHoldsFile,
  requireCheckPass, resolveAcceptance, resolvePermissionsFor,
  resolveReviewState, standingLogins,
  INSTALLER_CHECK_NAME} from './release-gate.mjs';

const SHA_RE = /^[a-f0-9]{40}$/;

export async function evaluateDeployGate({git, request, fetchChecks,
  fetchHeadChecks, liveSha, targetSha, mode, dispatchActor,
  dispatchActorAssociation, holds, permissions}) {
  assert(SHA_RE.test(liveSha || ''), 'An exact live SHA is required');
  assert(SHA_RE.test(targetSha || ''), 'An exact target SHA is required');
  assert(mode === 'auto' || mode === 'manual', 'Mode must be auto or manual');
  if (liveSha === targetSha) return {ok: true, noop: 'already-live'};
  assert(holds && typeof holds === 'object', 'Trusted holds map is required');
  // Entire first-parent live..target range is inspected. Regular
  // (non-merge) commits — direct pushes, squash or rebase content — are
  // UNSUPPORTED by this initial evaluator and always refused: ancestry in
  // a later branch proves nothing about review coverage, and no
  // association equivalence is invented for them. Remote merge methods are
  // NOT changed; such content simply cannot release here (a strict
  // merge-base refinement is a documented later option, not this gate).
  const range = git.commitsInRange(liveSha, targetSha);
  assert(Array.isArray(range) && range.length > 0,
    'Empty range without equality: refetch main (fail closed)');
  const evaluated = [];
  for (const sha of range) {
    assert(SHA_RE.test(sha || ''), 'Range returned a non-SHA');
    const second = git.secondParent(sha);
    assert(second !== null,
      `Unbound mainline commit ${sha}: direct/squash/rebase content is unsupported by this evaluator (no remote methods changed; this content cannot release)`);
    const associated = await fetchAssociatedPRs(request, sha);
    assert(associated.length > 0,
      `Merge ${sha} has no associated pull request to canonical main`);
    for (const assoc of associated) {
      assert(assoc.base?.ref === 'main'
        && assoc.base?.repo?.full_name === CANONICAL_REPO,
        `Associated PR for ${sha} is not merged to canonical main`);
      const pr = await fetchPR(request, assoc.number ?? assoc.id);
      const reviews = await fetchReviews(request, pr.number);
      // Fresh standing first: acceptance authors, same-head blocking
      // authors, and structured-evidence publishers (supported endpoint
      // reads, fail-closed gaps). Fresh reads take precedence over the
      // caller map: caller booleans can be stale, never authoritative.
      // Evidence binding below needs the fresh map — a proved outsider's
      // body must be ignorable before anything is parsed.
      const fresh = await resolvePermissionsFor({request,
        logins: standingLogins(reviews, pr.headSha)});
      permissions = {...(permissions || {}), ...fresh};
      const evidence = bindEvidence({pr, reviews, permissions});
      assert(second === pr.headSha,
        `Merge ${sha} does not integrate reviewed head ${pr.headSha}`);
      const acceptance = resolveAcceptance({reviews: reviews,
        headSha: pr.headSha, permissions, dispatchActor,
        dispatchActorAssociation});
      assert(acceptance,
        `No maintainer acceptance for PR ${pr.number} head ${pr.headSha}`);
      // Acceptance does not erase blocking: an unresolved same-head
      // CHANGES_REQUESTED or structured HOLD refuses this PR too.
      const state = resolveReviewState({reviews, headSha: pr.headSha,
        permissions});
      assert(!state.blocked,
        `PR ${pr.number} has unresolved ${state.blocked?.via} by ${state.blocked?.by} at head ${pr.headSha} (review ${state.blocked?.reviewId})`);
      // Per-PR head CI: the installer workflow is PR-only, so installer
      // results exist only at the head — re-verify them here rather than
      // trusting target CI alone. Merged-main CI below covers site plus
      // conditional worker only (installer at a merge target would
      // deadlock every deploy: verified requirement asymmetry, kept).
      assert(typeof fetchHeadChecks === 'function',
        'Per-PR head check fetcher is required (no silent target-only CI)');
      const headChecks = await fetchHeadChecks(pr.headSha);
      requireCheckPass(headChecks, MAIN_CHECK_NAME, pr.headSha,
        `PR ${pr.number} head`);
      const files = await fetchPRFiles(request, pr.number);
      if (isWorkerApplicable(files)) {
        requireCheckPass(headChecks, WORKER_CHECK_NAME, pr.headSha,
          `PR ${pr.number} head touches worker-covered paths, so`);
        requireCheckPass(headChecks, INSTALLER_CHECK_NAME, pr.headSha,
          `PR ${pr.number} head touches worker-covered paths, so its`);
      }
      evaluated.push({merge: sha, number: pr.number, head: pr.headSha,
        evidence: evidence.length, acceptedBy: acceptance.by, via: acceptance.via});
    }
  }
  assert(evaluated.length > 0,
    'No merge with bound PR evidence in range: unassociated main pushes cannot release');
  // The range aggregate is computed once: it drives BOTH the hold-registry
  // guard below and worker conditionality. A range touching the control
  // file fails closed however it touches it (modify/remove/replace) —
  // history is preserved by refusing, never by rewriting it.
  const changed = git.changedFiles(liveSha, targetSha);
  const {HOLD_REGISTRY_PATH} = await import('./release-gate.mjs');
  assert(!changed.includes(HOLD_REGISTRY_PATH),
    `Release range touches the hold registry (${HOLD_REGISTRY_PATH}): refused — clearance needs a separately approved owner operation`);
  // Fresh trusted hold governs before any production step: any active
  // GLOBAL hold, or any active hold on an ancestor-or-self of the target
  // (proven by git, never assumed), blocks both paths. A descendant
  // release with an UNCHANGED registry stays held. Unknown git outcomes
  // throw (fail closed).
  const covering = [];
  for (const hold of Object.values(holds)) {
    if (!hold || !hold.active) continue;
    if (hold.blockMerges === true) { covering.push(hold); continue; }
    if (hold.sha === targetSha) { covering.push(hold); continue; }
    if (git.isAncestor(hold.sha, targetSha)) covering.push(hold);
  }
  assert(covering.length === 0,
    `Release HOLD active: ${covering.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  const checks = await fetchChecks(targetSha);
  requireCheckPass(checks, MAIN_CHECK_NAME, targetSha, 'The release revision');
  if (isWorkerApplicable(changed)) {
    requireCheckPass(checks, WORKER_CHECK_NAME, targetSha,
      'The release touches worker-covered paths, so');
  }
  return {ok: true, mode, live: liveSha, target: targetSha, prs: evaluated,
    residualRace: 'Recheck main immediately before the irreversible step.'};
}

// Real git wrapper (exported for offline testing on tiny repositories).
// Exit codes are HONEST: merge-base exit 1 means proven non-ancestry and
// returns false; any other failure (missing objects, corruption —
// typically exit 128) THROWS so unknown git outcomes fail closed and a
// hold can never vanish on a read error. rev-parse ^2 on a non-merge
// commit fails and yields null, which marks the commit as regular.
export function realGit(cwd) {
  const run = (args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
  return {
    commitsInRange: (live, target) =>
      run(['log', '--format=%H', '--first-parent', `${live}..${target}`])
        .split('\n').map(s => s.trim()).filter(Boolean),
    secondParent: (merge) => {
      try {
        return run(['rev-parse', `${merge}^2`]);
      } catch {
        return null;
      }
    },
    isAncestor: (a, b) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', a, b], {cwd});
        return true;
      } catch (e) {
        if (e && e.status === 1) return false;
        throw new Error(`Ancestry unknown for ${a}..${b}: git exit ${e && e.status}`);
      }
    },
    changedFiles: (live, target) =>
      run(['diff', '--name-only', live, target]).split('\n')
        .map(s => s.trim()).filter(Boolean),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const liveSha = process.env.LIVE_SHA;
  const targetSha = process.env.TARGET_SHA;
  const mode = process.env.RELEASE_MODE === 'manual' ? 'manual' : 'auto';
  assert.equal(process.env.GITHUB_REPOSITORY, CANONICAL_REPO);
  assert(process.env.GH_TOKEN, 'GitHub read credential is required');
  const {readFile: read} = await import('node:fs/promises');
  const holds = parseHoldsFile(JSON.parse(
    await read(resolve(root, '.github/release-holds.json'), 'utf8')));
  async function api(path) {
    const res = await fetch(`https://api.github.com/repos/${CANONICAL_REPO}/${path}`, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'},
      signal: AbortSignal.timeout(15000), redirect: 'error'});
    assert(res.ok, `Metadata API returned HTTP ${res.status} for ${path}`);
    return res.json();
  }
  const {fetchCheckRunsAll} = await import('./release-gate.mjs');
  const fetchHeadChecks = (sha) => fetchCheckRunsAll(api, sha);
  // Best-effort standing for the dispatch actor: the read token usually
  // cannot read collaborator permission (fail closed to the pinned owner /
  // OWNER association inside resolveAcceptance via permissions map gaps).
  let permissions;
  if (process.env.DISPATCH_ACTOR) {
    try {
      const data = await api(`collaborators/${process.env.DISPATCH_ACTOR}/permission`);
      if (data && typeof data.permission === 'string') {
        permissions = {[process.env.DISPATCH_ACTOR]: data.permission};
      }
    } catch {
      permissions = undefined;
    }
  }
  const verdict = await evaluateDeployGate({git: realGit(root), request: api,
    fetchChecks: (sha) => fetchCheckRunsAll(api, sha),
    fetchHeadChecks, liveSha,
    targetSha, mode, dispatchActor: process.env.DISPATCH_ACTOR || null,
    dispatchActorAssociation: null, holds, permissions});
  console.log(JSON.stringify(verdict));
}
