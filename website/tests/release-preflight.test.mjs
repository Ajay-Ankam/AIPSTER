import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRelease, validateAutoRelease, isMigrationHold, isAlreadyLive} from '../scripts/release-preflight.mjs';
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
const autoGood = () => ({headSha: autoSha, builtSha: autoSha, mainSha: autoSha, ref: 'refs/heads/main',
  checks: [{id: 7, name: 'Public site asset and build checks', head_sha: autoSha,
    status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}}],
  workflowName: 'Public site checks', conclusion: 'success', headBranch: 'main',
  headRepo: 'synchronic1/AIPSTER', baseRepo: 'synchronic1/AIPSTER',
  mergeParents: 2, associatedPRs: []});
test('automatic release accepts the eligible merged main SHA', () => {
  assert.equal(validateAutoRelease(autoGood()).release_sha, autoSha);
});
test('automatic release accepts squash-style merge evidence from an associated merged PR', () => {
  const value = autoGood();
  value.mergeParents = 1;
  value.associatedPRs = [{state: 'closed', merged_at: '2026-11-03T00:00:00Z'}];
  assert.equal(validateAutoRelease(value).release_sha, autoSha);
});
test('automatic release accepts a newer successful rerun over an older failure', () => {
  const value = autoGood();
  value.checks = [{...value.checks[0], id: 6, conclusion: 'failure'}, {...value.checks[0], id: 8}];
  assert.equal(validateAutoRelease(value).check_run_id, 8);
});
for (const [label, change] of [
  ['failed conclusion', v => {v.conclusion = 'failure';}],
  ['cancelled conclusion', v => {v.conclusion = 'cancelled';}],
  ['pending check', v => {v.checks[0].status = 'in_progress';}],
  ['missing checks', v => {v.checks = [];}],
  ['cancelled latest rerun', v => {v.checks.push({...v.checks[0], id: 8, conclusion: 'cancelled'});}],
  ['newer failure over older success', v => {v.checks.push({...v.checks[0], id: 8, conclusion: 'failure'});}],
  ['stale main', v => {v.mainSha = 'b'.repeat(40);}],
  ['different build', v => {v.builtSha = 'b'.repeat(40);}],
  ['wrong workflow', v => {v.workflowName = 'Worker installer build';}],
  ['wrong repository', v => {v.baseRepo = 'someone/else';}],
  ['fork source', v => {v.headRepo = 'someone/AIPSTER';}],
  ['feature branch head', v => {v.headBranch = 'feature';}],
  ['direct push without merge evidence', v => {v.mergeParents = 1;}],
  ['open PR is not merge evidence', v => {v.mergeParents = 1; v.associatedPRs = [{state: 'open', merged_at: null}];}],
  ['other revision CI', v => {v.checks[0].head_sha = 'b'.repeat(40);}],
  ['non-actions check source', v => {v.checks[0].app = {slug: 'someone-else'};}],
]) test(`automatic release rejects ${label}`, () => {const value = autoGood(); change(value); assert.throws(() => validateAutoRelease(value));});
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
