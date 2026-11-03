import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const CANONICAL_REPO = 'synchronic1/AIPSTER';
export const MAIN_CHECK_NAME = 'Public site asset and build checks';
export const MAIN_WORKFLOW_NAME = 'Public site checks';
export const MAIN_REF = 'refs/heads/main';
export const MIGRATIONS_PREFIX = 'website/migrations/';

// Latest check-run wins: a stale successful run must not override a newer
// failed, pending or cancelled run for the same check and revision.
function latestCheckFor(checks, name, sha) {
  return (checks || []).filter(c => c.name === name
    && c.head_sha === sha && c.app?.slug === 'github-actions').sort((a,b) => b.id - a.id)[0];
}

function assertSuccessfulMainCheck(checks, sha) {
  const expected = latestCheckFor(checks, MAIN_CHECK_NAME, sha);
  assert(expected && expected.status === 'completed' && expected.conclusion === 'success',
    'The reviewed main revision must have successful Public site asset and build checks');
  return expected;
}

export function validateRelease({reviewedSha, builtSha, mainSha, ref, checks}) {
  assert.equal(ref, 'refs/heads/main', 'Only main may be deployed');
  assert(/^[a-f0-9]{40}$/.test(reviewedSha || ''), 'An exact reviewed SHA is required');
  assert.equal(builtSha, reviewedSha, 'Built commit differs from the reviewed commit');
  assert.equal(mainSha, reviewedSha, 'Main changed after the release was selected');
  const expected = assertSuccessfulMainCheck(checks, reviewedSha);
  return {verified: true, reviewed_sha: reviewedSha, check_run_id: expected.id};
}

// Automatic path: same SHA/CI guards as manual, plus event-trust guards.
// Direct unassociated main pushes carry no merge evidence and are rejected;
// they remain deployable only through the explicit manual dispatch.
export function validateAutoRelease({headSha, builtSha, mainSha, ref, checks,
  workflowName, conclusion, headBranch, headRepo, baseRepo, mergeParents, associatedPRs}) {
  assert.equal(ref, MAIN_REF, 'Only main may be deployed');
  assert.equal(baseRepo, CANONICAL_REPO, 'Unexpected repository');
  assert.equal(headRepo, CANONICAL_REPO, 'Automatic deploy refuses fork or untrusted sources');
  assert.equal(workflowName, MAIN_WORKFLOW_NAME, 'Automatic deploy only follows Public site checks');
  assert.equal(conclusion, 'success', 'Automatic deploy requires successful checks');
  assert.equal(headBranch, 'main', 'Automatic deploy only follows main pushes');
  assert(/^[a-f0-9]{40}$/.test(headSha || ''), 'An exact merged SHA is required');
  assert.equal(builtSha, headSha, 'Built commit differs from the verified commit');
  assert.equal(mainSha, headSha, 'Main changed after the release was selected');
  const mergedPR = (associatedPRs || []).some(pr => pr && pr.state === 'closed' && pr.merged_at);
  assert(Number(mergeParents) > 1 || mergedPR,
    'Automatic deploy requires a merged pull request; use manual dispatch');
  const expected = assertSuccessfulMainCheck(checks, headSha);
  return {verified: true, mode: 'auto', release_sha: headSha, check_run_id: expected.id};
}

// Schema changes are never auto-applied or silently deployed: when the merge
// itself touches website/migrations, the automatic path holds and the release
// stays on manual dispatch after review.
export function isMigrationHold(changedFiles) {
  return (changedFiles || []).some(f => f === 'website/migrations' || f.startsWith(MIGRATIONS_PREFIX));
}

// Unknown live state never counts as a match; the post-deploy verifier still
// proves the live revision independently.
export function isAlreadyLive({liveCommit, targetSha}) {
  if (!/^[a-f0-9]{40}$/.test(liveCommit || '') || !/^[a-f0-9]{40}$/.test(targetSha || '')) return false;
  return liveCommit === targetSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.env.GITHUB_REPOSITORY, 'synchronic1/AIPSTER');
  assert(process.env.GH_TOKEN, 'GitHub read credential is required');
  assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || ''));
  async function api(path) {
    const response = await fetch('https://api.github.com/repos/synchronic1/AIPSTER/' + path, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'}, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    assert(response.ok, `Release verification API returned HTTP ${response.status}`);
    return response.json();
  }
  // The check-runs endpoint is paged; a single 100-item page can hide the
  // latest rerun behind older runs.
  async function allCheckRuns(sha) {
    const runs = [];
    for (let page = 1;; page++) {
      const data = await api(`commits/${sha}/check-runs?per_page=100&page=${page}`);
      runs.push(...data.check_runs);
      if (data.check_runs.length < 100) break;
    }
    return runs;
  }
  if (process.env.RELEASE_MODE === 'auto') {
    for (const name of ['HEAD_SHA', 'WORKFLOW_NAME', 'CONCLUSION', 'HEAD_BRANCH', 'HEAD_REPO'])
      assert(process.env[name], `Automatic release requires ${name}`);
    const [main, checks, pulls] = await Promise.all([api('commits/main'),
      allCheckRuns(process.env.GITHUB_SHA), api(`commits/${process.env.GITHUB_SHA}/pulls`)]);
    console.log(JSON.stringify(validateAutoRelease({headSha: process.env.HEAD_SHA,
      builtSha: process.env.GITHUB_SHA, mainSha: main.sha, ref: process.env.GITHUB_REF, checks,
      workflowName: process.env.WORKFLOW_NAME, conclusion: process.env.CONCLUSION,
      headBranch: process.env.HEAD_BRANCH, headRepo: process.env.HEAD_REPO,
      baseRepo: process.env.GITHUB_REPOSITORY, mergeParents: main.parents?.length,
      associatedPRs: Array.isArray(pulls) ? pulls : []})));
  } else {
    const [main, checks] = await Promise.all([api('commits/main'), allCheckRuns(process.env.GITHUB_SHA)]);
    console.log(JSON.stringify(validateRelease({reviewedSha: process.env.REVIEWED_SHA,
      builtSha: process.env.GITHUB_SHA, mainSha: main.sha, ref: process.env.GITHUB_REF, checks})));
  }
}
