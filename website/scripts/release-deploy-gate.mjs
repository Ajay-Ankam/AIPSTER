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
import {bindEvidence, fetchAssociatedPRs, fetchPR, fetchReviews,
  parseHoldsFile, requireCheckPass, resolveAcceptance} from './release-gate.mjs';

const SHA_RE = /^[a-f0-9]{40}$/;

export async function evaluateDeployGate({git, request, fetchChecks,
  liveSha, targetSha, mode, dispatchActor, dispatchActorAssociation,
  holds, permissions}) {
  assert(SHA_RE.test(liveSha || ''), 'An exact live SHA is required');
  assert(SHA_RE.test(targetSha || ''), 'An exact target SHA is required');
  assert(mode === 'auto' || mode === 'manual', 'Mode must be auto or manual');
  if (liveSha === targetSha) return {ok: true, noop: 'already-live'};
  assert(holds && typeof holds === 'object', 'Trusted holds map is required');
  const merges = git.mergesInRange(liveSha, targetSha);
  assert(Array.isArray(merges) && merges.length > 0,
    'No merge commits in range: unassociated main pushes cannot release');
  const evaluated = [];
  for (const merge of merges) {
    assert(SHA_RE.test(merge || ''), 'Merge range returned a non-SHA');
    const associated = await fetchAssociatedPRs(request, merge);
    assert(associated.length > 0,
      `Merge ${merge} has no associated pull request to canonical main`);
    for (const assoc of associated) {
      assert(assoc.base?.ref === 'main'
        && assoc.base?.repo?.full_name === CANONICAL_REPO,
        `Associated PR for ${merge} is not merged to canonical main`);
      const pr = await fetchPR(request, assoc.number ?? assoc.id);
      const reviews = await fetchReviews(request, pr.number);
      const evidence = bindEvidence({pr, reviews});
      const second = git.secondParent(merge);
      assert(second === pr.headSha,
        `Merge ${merge} does not integrate reviewed head ${pr.headSha}`);
      const acceptance = resolveAcceptance({reviews: reviews,
        headSha: pr.headSha, permissions, dispatchActor,
        dispatchActorAssociation});
      assert(acceptance,
        `No maintainer acceptance for PR ${pr.number} head ${pr.headSha}`);
      evaluated.push({merge, number: pr.number, head: pr.headSha,
        evidence: evidence.length, acceptedBy: acceptance.by, via: acceptance.via});
    }
  }
  // Fresh trusted hold governs before any production step: any active hold
  // on an ancestor-or-self of the target (proven by git, never assumed)
  // blocks both paths. Unknown git outcomes throw (fail closed).
  const covering = [];
  for (const hold of Object.values(holds)) {
    if (!hold || !hold.active) continue;
    if (hold.sha === targetSha) { covering.push(hold); continue; }
    if (git.isAncestor(hold.sha, targetSha)) covering.push(hold);
  }
  assert(covering.length === 0,
    `Release HOLD active: ${covering.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  const checks = await fetchChecks(targetSha);
  requireCheckPass(checks, MAIN_CHECK_NAME, targetSha, 'The release revision');
  const changed = git.changedFiles(liveSha, targetSha);
  if (isWorkerApplicable(changed)) {
    requireCheckPass(checks, WORKER_CHECK_NAME, targetSha,
      'The release touches worker-covered paths, so');
  }
  return {ok: true, mode, live: liveSha, target: targetSha, prs: evaluated,
    residualRace: 'Recheck main immediately before the irreversible step.'};
}

function realGit(cwd) {
  const run = (args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
  return {
    mergesInRange: (live, target) =>
      run(['log', '--format=%H', '--merges', `${live}..${target}`])
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
      } catch {
        return false;
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
    fetchChecks: (sha) => fetchCheckRunsAll(api, sha), liveSha,
    targetSha, mode, dispatchActor: process.env.DISPATCH_ACTOR || null,
    dispatchActorAssociation: null, holds, permissions});
  console.log(JSON.stringify(verdict));
}
