import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRelease, validateAutoRelease, isMigrationHold, isAlreadyLive, isWorkerApplicable,
  matchWorkerPath, migrationHoldDecision, fetchAllCheckRuns,
  WORKER_PATH_PATTERNS} from '../scripts/release-preflight.mjs';
const sha = '1'.repeat(40);
const good = () => ({reviewedSha: sha, builtSha: sha, mainSha: sha, ref: 'refs/heads/main',
  checks: [{id: 1, name: 'Public site asset and build checks', head_sha: sha,
    status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}}]});
test('release preflight accepts the exact reviewed current main with passing CI', () => {
  assert.equal(validateRelease(good()).reviewed_sha, sha);
});
for (const [label, change] of [
  ['short SHA', v => {v.reviewedSha = '1111111';}],
  ['changed main', v => {v.mainSha = '2'.repeat(40);}],
  ['different build', v => {v.builtSha = '2'.repeat(40);}],
  ['PR branch', v => {v.ref = 'refs/heads/feature';}],
  ['missing CI', v => {v.checks = [];}],
  ['pending CI', v => {v.checks[0].status = 'in_progress';}],
  ['failed latest rerun', v => {v.checks.push({...v.checks[0], id: 2, conclusion: 'failure'});}],
  ['other revision CI', v => {v.checks[0].head_sha = '2'.repeat(40);}],
]) test(`release preflight rejects ${label}`, () => {const value = good(); change(value); assert.throws(() => validateRelease(value));});

const autoSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const mergedPR = (over = {}) => ({state: 'closed', merged_at: '2026-11-03T00:00:00Z',
  merge_commit_sha: autoSha, ...over});
const siteCheck = (over = {}) => ({id: 7, name: 'Public site asset and build checks', head_sha: autoSha,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}, ...over});
const workerCheck = (over = {}) => ({id: 9, name: 'mock-install', head_sha: autoSha,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}, ...over});
const autoGood = () => ({headSha: autoSha, builtSha: autoSha, mainSha: autoSha, ref: 'refs/heads/main',
  checks: [siteCheck()], workerChecks: [siteCheck(), workerCheck()],
  workflowName: 'Public site checks', conclusion: 'success', headBranch: 'main',
  headRepo: 'synchronic1/AIPSTER', baseRepo: 'synchronic1/AIPSTER',
  associatedPRs: [mergedPR()], workerApplicable: false});
test('automatic release accepts the eligible merged main SHA', () => {
  assert.equal(validateAutoRelease(autoGood()).release_sha, autoSha);
});
test('automatic release accepts a worker-suite wake for a worker-covered merge', () => {
  const value = autoGood();
  value.workflowName = 'Public local worker installation';
  value.workerApplicable = true;
  const out = validateAutoRelease(value);
  assert.equal(out.release_sha, autoSha);
  assert.equal(out.worker_check_run_id, 9);
});
test('automatic release accepts a newer successful rerun over an older failure', () => {
  const value = autoGood();
  value.checks = [{...value.checks[0], id: 6, conclusion: 'failure'}, {...value.checks[0], id: 8}];
  assert.equal(validateAutoRelease(value).site_check_run_id, 8);
});
for (const [label, change] of [
  ['failed conclusion', v => {v.conclusion = 'failure';}],
  ['cancelled conclusion', v => {v.conclusion = 'cancelled';}],
  ['pending check', v => {v.checks[0].status = 'in_progress';}],
  ['missing checks', v => {v.checks = []; v.workerChecks = [];}],
  ['cancelled latest rerun', v => {const c = {...v.checks[0], id: 8, conclusion: 'cancelled'}; v.checks.push(c); v.workerChecks.push(c);}],
  ['newer failure over older success', v => {const c = {...v.checks[0], id: 8, conclusion: 'failure'}; v.checks.push(c); v.workerChecks.push(c);}],
  ['stale main', v => {v.mainSha = otherSha;}],
  ['different build', v => {v.builtSha = otherSha;}],
  ['wrong workflow', v => {v.workflowName = 'Worker installer build';}],
  ['wrong repository', v => {v.baseRepo = 'someone/else';}],
  ['fork source', v => {v.headRepo = 'someone/AIPSTER';}],
  ['feature branch head', v => {v.headBranch = 'feature';}],
  ['direct push without merge evidence', v => {v.associatedPRs = [];}],
  ['open PR is not merge evidence', v => {v.associatedPRs = [{state: 'open', merged_at: null, merge_commit_sha: autoSha}];}],
  ['merged PR for another commit is not evidence', v => {v.associatedPRs = [mergedPR({merge_commit_sha: otherSha})];}],
  ['merged PR without merge commit binding is not evidence', v => {v.associatedPRs = [{state: 'closed', merged_at: '2026-11-03T00:00:00Z'}];}],
  ['other revision CI', v => {v.checks[0].head_sha = otherSha; v.workerChecks[0].head_sha = otherSha;}],
  ['non-actions check source', v => {v.checks[0].app = {slug: 'someone-else'}; v.workerChecks[0].app = {slug: 'someone-else'};}],
]) test(`automatic release rejects ${label}`, () => {const value = autoGood(); change(value); assert.throws(() => validateAutoRelease(value));});
for (const [label, change] of [
  ['worker pending while site is green', v => {v.workerApplicable = true; v.workerChecks = [workerCheck({id: 10, status: 'in_progress', conclusion: null})];}],
  ['worker failed latest rerun', v => {v.workerApplicable = true; v.workerChecks = [workerCheck({id: 8}), workerCheck({id: 10, conclusion: 'failure'})];}],
  ['worker missing when applicable', v => {v.workerApplicable = true; v.workerChecks = [siteCheck({id: 8})];}],
  ['worker success for another revision', v => {v.workerApplicable = true; v.workerChecks = [workerCheck({head_sha: otherSha})];}],
  ['worker cancelled latest', v => {v.workerApplicable = true; v.workerChecks = [workerCheck({id: 10, conclusion: 'cancelled'})];}],
]) test(`automatic release rejects ${label}`, () => {const value = autoGood(); change(value); assert.throws(() => validateAutoRelease(value));});
test('automatic release accepts a newer worker success over an older worker failure', () => {
  const value = autoGood();
  value.workerApplicable = true;
  value.workerChecks = [workerCheck({id: 8, conclusion: 'failure'}), workerCheck({id: 10})];
  assert.equal(validateAutoRelease(value).worker_check_run_id, 10);
});
test('automatic release ignores absent worker runs when not applicable', () => {
  const value = autoGood();
  value.workerChecks = [];
  assert.equal(validateAutoRelease(value).release_sha, autoSha);
});
test('migration hold triggers on schema file changes only', () => {
  assert.equal(isMigrationHold(['website/migrations/0029_extra.sql']), true);
  assert.equal(isMigrationHold(['website/src/worker.js', 'website/tests/x.test.mjs']), false);
  assert.equal(isMigrationHold([]), false);
});
test('already-live matches only on exact known SHAs', () => {
  assert.equal(isAlreadyLive({liveCommit: autoSha, targetSha: autoSha}), true);
  assert.equal(isAlreadyLive({liveCommit: autoSha, targetSha: 'b'.repeat(40)}), false);
  assert.equal(isAlreadyLive({liveCommit: '', targetSha: autoSha}), false);
  assert.equal(isAlreadyLive({liveCommit: 'short', targetSha: autoSha}), false);
});
for (const [path, pattern, want] of [
  ['local-worker/install.py', 'local-worker/**', true],
  ['local-worker', 'local-worker/**', true],
  ['website/src/worker.js', 'website/src/**', true],
  ['website/migrations/0029_x.sql', 'website/migrations/**', true],
  ['website/package.json', 'website/package*.json', true],
  ['website/package-lock.json', 'website/package*.json', true],
  ['website/tests/d1-shim.mjs', 'website/tests/d1-shim.mjs', true],
  ['website/public/app.js', 'website/src/**', false],
  ['website/tests/other.test.mjs', 'website/tests/d1-shim.mjs', false],
  ['website/nested/package.json', 'website/package*.json', false],
  ['LICENSE', 'LICENSE', true],
  ['NOTICE', 'NOTICE', true],
  ['local-worker-old/x.py', 'local-worker/**', false],
]) test(`worker path filter ${pattern} ${want ? 'matches' : 'ignores'} ${path}`, () => {
  assert.equal(matchWorkerPath(pattern, path), want);
});
test('worker applicability follows the cumulative changed paths', () => {
  assert.equal(isWorkerApplicable(['website/src/worker.js']), true);
  assert.equal(isWorkerApplicable(['website/public/index.html', 'website/README.md']), false);
  assert.equal(isWorkerApplicable([]), false);
  assert.equal(isWorkerApplicable(undefined), false);
});
test('worker path patterns mirror the workflow trigger filters exactly', async () => {
  const {readFile} = await import('node:fs/promises');
  const yml = await readFile(new URL('../../.github/workflows/local-worker-checks.yml', import.meta.url), 'utf8');
  const sections = yml.split(/^  (?:pull_request|push):/m).slice(1);
  assert.equal(sections.length, 2);
  for (const section of sections) {
    const paths = [...section.matchAll(/^ {6}- '([^']+)'/gm)].map(m => m[1]);
    assert.deepEqual(paths, WORKER_PATH_PATTERNS);
  }
});
test('migration hold uses the cumulative live baseline and fails closed', () => {
  const base = {liveSha: otherSha, targetSha: autoSha, ancestor: true, diffOk: true, changedMigrationPaths: []};
  assert.deepEqual(migrationHoldDecision(base), {hold: false, reason: 'no schema changes since live baseline'});
  assert.equal(migrationHoldDecision({...base, changedMigrationPaths: ['website/migrations/0029_x.sql']}).hold, true);
  assert.equal(migrationHoldDecision({...base, liveSha: ''}).hold, true);
  assert.equal(migrationHoldDecision({...base, ancestor: false}).hold, true);
  assert.equal(migrationHoldDecision({...base, diffOk: false}).hold, true);
  assert.equal(migrationHoldDecision({...base, liveSha: otherSha, targetSha: otherSha}).hold, false);
});
test('paginated check-runs select the latest rerun across pages', async () => {
  const run = (id, over = {}) => ({id, name: 'Public site asset and build checks', head_sha: autoSha,
    status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}, ...over});
  const page1 = Array.from({length: 100}, (_, i) => run(1000 + i, i === 0 ? {conclusion: 'failure'} : {}));
  const pageOf = path => Number(new URL(path, 'http://localhost/').searchParams.get('page') || '1');
  const request = async path => ({check_runs: pageOf(path) === 1 ? page1 : [run(2000)]});
  const runs = await fetchAllCheckRuns(request, autoSha);
  assert.equal(runs.length, 101);
  assert.equal(validateAutoRelease({...autoGood(), checks: runs, workerChecks: runs}).site_check_run_id, 2000);
});
test('paginated check-runs surface a page-2 failure and API errors fail closed', async () => {
  const run = (id, over = {}) => ({id, name: 'Public site asset and build checks', head_sha: autoSha,
    status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}, ...over});
  const page1 = Array.from({length: 100}, (_, i) => run(1000 + i));
  const pageOf = path => Number(new URL(path, 'http://localhost/').searchParams.get('page') || '1');
  const failing = async path => ({check_runs: pageOf(path) === 1 ? page1 : [run(2000, {conclusion: 'failure'})]});
  const runs = await fetchAllCheckRuns(failing, autoSha);
  assert.throws(() => validateAutoRelease({...autoGood(), checks: runs, workerChecks: runs}));
  const forbidden = async () => { const e = new Error('Release verification API returned HTTP 403'); throw e; };
  await assert.rejects(() => fetchAllCheckRuns(forbidden, autoSha), /403/);
});
