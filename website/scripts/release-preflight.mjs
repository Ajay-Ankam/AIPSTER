import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const CANONICAL_REPO = 'synchronic1/AIPSTER';
export const MAIN_CHECK_NAME = 'Public site asset and build checks';
export const MAIN_WORKFLOW_NAME = 'Public site checks';
export const WORKER_CHECK_NAME = 'mock-install';
export const WORKER_WORKFLOW_NAME = 'Public local worker installation';
export const MAIN_REF = 'refs/heads/main';
export const MIGRATIONS_PREFIX = 'website/migrations/';

// Path filters mirrored from .github/workflows/local-worker-checks.yml
// (both the pull_request and the push section). The deploy-workflow structure
// test fails if the two lists drift apart.
export const WORKER_PATH_PATTERNS = ['local-worker/**', 'website/src/**', 'website/migrations/**',
  'website/tests/d1-shim.mjs', 'website/scripts/pairing-e2e-bridge.mjs', 'website/package*.json',
  '.github/workflows/local-worker-checks.yml', 'LICENSE', 'NOTICE'];

function escapeRegExp(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// GitHub path-filter semantics: `*` stays inside a segment, a trailing
// `/**` covers the directory and everything under it. Anything uncertain is
// treated as applicable: over-requiring a check fails closed to manual.
export function matchWorkerPath(pattern, path) {
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return path === dir || path.startsWith(dir + '/');
  }
  return new RegExp('^' + pattern.split('*').map(escapeRegExp).join('[^/]*') + '$').test(path);
}

export function isWorkerApplicable(changedFiles) {
  return (changedFiles || []).some(f => WORKER_PATH_PATTERNS.some(p => matchWorkerPath(p, f)));
}

// Latest check-run wins: a stale successful run must not override a newer
// failed, pending or cancelled run for the same check and revision.
function latestCheckFor(checks, name, sha) {
  return (checks || []).filter(c => c.name === name
    && c.head_sha === sha && c.app?.slug === 'github-actions').sort((a,b) => b.id - a.id)[0];
}

function assertSuccessfulCheck(checks, name, sha, label) {
  const expected = latestCheckFor(checks, name, sha);
  assert(expected && expected.status === 'completed' && expected.conclusion === 'success',
    `${label} must have a successful ${name} check run for the merged revision`);
  return expected;
}

export function validateRelease({reviewedSha, builtSha, mainSha, ref, checks}) {
  assert.equal(ref, 'refs/heads/main', 'Only main may be deployed');
  assert(/^[a-f0-9]{40}$/.test(reviewedSha || ''), 'An exact reviewed SHA is required');
  assert.equal(builtSha, reviewedSha, 'Built commit differs from the reviewed commit');
  assert.equal(mainSha, reviewedSha, 'Main changed after the release was selected');
  const expected = assertSuccessfulCheck(checks, MAIN_CHECK_NAME, reviewedSha, 'The reviewed revision');
  return {verified: true, reviewed_sha: reviewedSha, check_run_id: expected.id};
}

// Automatic path: same SHA/CI guards as manual, plus event-trust guards and
// every applicable suite. Merge evidence is a merged pull request whose merge
// commit is exactly this SHA: a locally created merge commit or any other
// unassociated main push is rejected and stays on manual dispatch.
export function validateAutoRelease({headSha, builtSha, mainSha, ref, checks,
  workflowName, conclusion, headBranch, headRepo, baseRepo, associatedPRs,
  workerApplicable, workerChecks}) {
  assert.equal(ref, MAIN_REF, 'Only main may be deployed');
  assert.equal(baseRepo, CANONICAL_REPO, 'Unexpected repository');
  assert.equal(headRepo, CANONICAL_REPO, 'Automatic deploy refuses fork or untrusted sources');
  assert([MAIN_WORKFLOW_NAME, WORKER_WORKFLOW_NAME].includes(workflowName),
    'Automatic deploy only follows the site or local-worker check suites');
  assert.equal(conclusion, 'success', 'Automatic deploy requires successful checks');
  assert.equal(headBranch, 'main', 'Automatic deploy only follows main pushes');
  assert(/^[a-f0-9]{40}$/.test(headSha || ''), 'An exact merged SHA is required');
  assert.equal(builtSha, headSha, 'Built commit differs from the verified commit');
  assert.equal(mainSha, headSha, 'Main changed after the release was selected');
  const mergedPR = (associatedPRs || []).some(pr => pr && pr.state === 'closed'
    && pr.merged_at && pr.merge_commit_sha === headSha);
  assert(mergedPR, 'Automatic deploy requires a merged pull request for this exact commit; use manual dispatch');
  const site = assertSuccessfulCheck(checks, MAIN_CHECK_NAME, headSha, 'The merged revision');
  if (workerApplicable) {
    const worker = assertSuccessfulCheck(workerChecks ?? checks, WORKER_CHECK_NAME, headSha,
      'The merged revision touches worker-covered paths, so');
    return {verified: true, mode: 'auto', release_sha: headSha,
      site_check_run_id: site.id, worker_check_run_id: worker.id};
  }
  return {verified: true, mode: 'auto', release_sha: headSha, site_check_run_id: site.id};
}

// Schema changes are never auto-applied or silently deployed. The baseline is
// the verified live revision, not the merge's first parent, so schema changes
// in skipped intermediate merges also hold. Unknown baselines, non-ancestor
// baselines and uncomputable deltas all hold: no unknown schema delta may
// auto-deploy. The workflow gathers the inputs with git; this pure decision is
// what production evaluates and what the suite tests.
export function migrationHoldDecision({liveSha, targetSha, ancestor, diffOk, changedMigrationPaths}) {
  if (!/^[a-f0-9]{40}$/.test(liveSha || '') || !/^[a-f0-9]{40}$/.test(targetSha || ''))
    return {hold: true, reason: 'unknown live baseline or target'};
  if (!ancestor) return {hold: true, reason: 'live baseline is not an ancestor of the target'};
  if (!diffOk) return {hold: true, reason: 'schema delta since live baseline is uncomputable'};
  if ((changedMigrationPaths || []).length > 0)
    return {hold: true, reason: `schema changes since live baseline: ${changedMigrationPaths.join(', ')}`};
  return {hold: false, reason: 'no schema changes since live baseline'};
}

// Single-merge helper kept for the focused suite; production uses the
// cumulative migrationHoldDecision above.
export function isMigrationHold(changedFiles) {
  return (changedFiles || []).some(f => f === 'website/migrations' || f.startsWith(MIGRATIONS_PREFIX));
}

// Unknown live state never counts as a match; the post-deploy verifier still
// proves the live revision independently.
export function isAlreadyLive({liveCommit, targetSha}) {
  if (!/^[a-f0-9]{40}$/.test(liveCommit || '') || !/^[a-f0-9]{40}$/.test(targetSha || '')) return false;
  return liveCommit === targetSha;
}

// The check-runs endpoint is paged; a single 100-item page can hide the
// latest rerun behind older runs. Exported for the focused suite; production
// passes the authenticated request below.
export async function fetchAllCheckRuns(request, sha) {
  const runs = [];
  for (let page = 1;; page++) {
    const data = await request(`commits/${sha}/check-runs?per_page=100&page=${page}`);
    runs.push(...data.check_runs);
    if (data.check_runs.length < 100) break;
  }
  return runs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // BUILT_SHA is measured with `git rev-parse HEAD` after checkout, never
  // copied from an event field, so the comparisons below are not tautological.
  const builtSha = process.env.BUILT_SHA || process.env.GITHUB_SHA;
  assert.equal(process.env.GITHUB_REPOSITORY, 'synchronic1/AIPSTER');
  assert(process.env.GH_TOKEN, 'GitHub read credential is required');
  assert(/^[a-f0-9]{40}$/.test(builtSha || ''));
  async function api(path) {
    const response = await fetch('https://api.github.com/repos/synchronic1/AIPSTER/' + path, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'}, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    assert(response.ok, `Release verification API returned HTTP ${response.status}`);
    return response.json();
  }
  if (process.env.RELEASE_MODE === 'auto') {
    for (const name of ['HEAD_SHA', 'WORKFLOW_NAME', 'CONCLUSION', 'HEAD_BRANCH', 'HEAD_REPO'])
      assert(process.env[name], `Automatic release requires ${name}`);
    const [main, checks, pulls] = await Promise.all([api('commits/main'),
      fetchAllCheckRuns(api, builtSha), api(`commits/${builtSha}/pulls`)]);
    console.log(JSON.stringify(validateAutoRelease({headSha: process.env.HEAD_SHA,
      builtSha, mainSha: main.sha, ref: process.env.GITHUB_REF, checks,
      workflowName: process.env.WORKFLOW_NAME, conclusion: process.env.CONCLUSION,
      headBranch: process.env.HEAD_BRANCH, headRepo: process.env.HEAD_REPO,
      baseRepo: process.env.GITHUB_REPOSITORY,
      associatedPRs: Array.isArray(pulls) ? pulls : [],
      workerApplicable: process.env.WORKER_APPLICABLE === 'true', workerChecks: checks})));
  } else {
    const [main, checks] = await Promise.all([api('commits/main'), fetchAllCheckRuns(api, builtSha)]);
    console.log(JSON.stringify(validateRelease({reviewedSha: process.env.REVIEWED_SHA,
      builtSha, mainSha: main.sha, ref: process.env.GITHUB_REF, checks})));
  }
}
