// Structural regression for the production deploy workflow and the worker
// checks trigger. Node has no YAML parser and installs are out of scope, so
// this test works on the workflow text with indentation-aware step blocks:
// every property it asserts is a property a real defect already broke
// (pre-checkout working directory) or a finding required (permissions,
// triggers, wiring). The first real CI run is still the full YAML parse.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const deployUrl = new URL('../../.github/workflows/public-site-production-deploy.yml', import.meta.url);
const workerUrl = new URL('../../.github/workflows/local-worker-checks.yml', import.meta.url);
const deploy = await readFile(deployUrl, 'utf8');
const worker = await readFile(workerUrl, 'utf8');

// Steps sit at exactly six spaces of indent; a block runs to the next step.
function steps(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^      - (name|uses|run):/.test(line)) {
      current = {header: line, body: ''};
      blocks.push(current);
    } else if (current && (/^ {8,}\S/.test(line) || line.trim() === '')) {
      current.body += line + '\n';
    } else {
      current = null;
    }
  }
  return blocks;
}

test('deploy workflow has no tabs and the expected top-level shape', () => {
  assert(!deploy.includes('\t'), 'workflow must not contain tabs');
  for (const key of ['name: Public site production deploy', 'on:', 'permissions:',
    'concurrency:', 'jobs:', 'group: public-site-production', 'environment: production']) {
    assert(deploy.includes(key), `workflow must declare ${key}`);
  }
});

test('deploy workflow wakes on both applicable suites and keeps manual dispatch', () => {
  assert(deploy.includes("workflows: ['Public site checks', 'Public local worker installation']"));
  assert(deploy.includes('types: [completed]'));
  assert(deploy.includes('branches: [main]'));
  assert(deploy.includes('workflow_dispatch:'));
  assert(deploy.includes('reviewed_sha:'));
});

test('deploy workflow keeps minimum read-only permissions', () => {
  assert(deploy.includes('contents: read'));
  assert(deploy.includes('checks: read'));
  assert(deploy.includes('pull-requests: read'));
  assert(!/^ +\w[\w-]*: write$/m.test(deploy), 'no write grants allowed');
});

test('pre-checkout steps run in the workspace root, not website/', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const checkout = texts.findIndex(t => t.includes('actions/checkout@'));
  assert(checkout > 0, 'checkout step must exist');
  const pre = texts.slice(0, checkout).filter(t => /run:/.test(t));
  assert(pre.length >= 2, 'resolve and trust-gate steps must precede checkout');
  for (const t of pre) {
    assert(t.includes('working-directory: ${{ github.workspace }}'),
      `pre-checkout step must override working-directory: ${t.split('\n')[0].trim()}`);
  }
  for (const t of texts.slice(checkout + 1).filter(t => /run: npm (ci|run check|run test)/.test(t))) {
    assert(!t.includes('github.workspace'), 'post-checkout build steps keep the website default');
  }
});

test('trust gate rejects untrusted events before any fetch', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const checkout = texts.findIndex(t => t.includes('actions/checkout@'));
  const gate = texts.slice(0, checkout).find(t => t.includes('fork sources'));
  assert(gate, 'event trust gate must precede checkout');
  assert(gate.includes('main push event') && gate.includes('main branch'));
  assert(gate.includes('Public local worker installation'));
});

test('checkout is pinned and HEAD is verified before build', () => {
  assert(deploy.includes('ref: ${{ steps.release.outputs.sha }}'), 'checkout must pin the resolved SHA');
  const blocks = steps(deploy);
  const texts = blocks.map(b => b.header + '\n' + b.body);
  const verify = texts.findIndex(t => t.includes('git rev-parse HEAD'));
  const checkout = texts.findIndex(t => t.includes('actions/checkout@'));
  const build = texts.findIndex(t => t.includes('npm run build'));
  const preflight = texts.findIndex(t => t.includes('release-preflight.mjs') && t.includes('Require the verified'));
  assert(verify > checkout && verify < build, 'rev-parse verification sits between checkout and build');
  assert(preflight > build, 'preflight rechecks after the build, immediately before deploy');
  assert(deploy.includes('BUILT_SHA: ${{ steps.verify.outputs.built_sha }}'));
  assert(deploy.includes('WORKER_APPLICABLE: ${{ steps.worker.outputs.applicable }}'));
});

test('migration hold and worker applicability are fail-closed and visible', () => {
  assert(deploy.includes('export ANCESTOR DIFF_OK MIGRATIONS'), 'hold inputs must reach the decision');
  assert(deploy.includes('export W_OK CHANGED'), 'applicability inputs must reach the decision');
  const report = steps(deploy).find(b => b.header.includes('Report automatic hold'));
  assert(report && report.body.includes("steps.migration.outputs.hold == 'true'"), 'hold report runs on hold');
  assert(report.body.includes('exit 1'), 'a hold must not report success');
  assert(report.body.includes('$GITHUB_STEP_SUMMARY'), 'a hold must be explicit in the summary');
});

test('deploy and verify steps are skipped on hold or already-live', () => {
  assert(deploy.includes("steps.migration.outputs.hold != 'true' && steps.live.outputs.already != 'true'"));
});

test('no plain-scalar run step contains YAML-breaking colons', () => {
  // Regression for the line-123 workflow-validation failure: a plain scalar
  // `run: node ... -e "..."` containing ': ' ends the mapping and invalidates
  // the whole workflow file. Inline scripts must use literal block syntax.
  for (const line of deploy.split('\n')) {
    const m = /^(\s*)run: (.*)$/.exec(line);
    if (m && m[2] !== '|' && m[2] !== '>') {
      assert(!m[2].includes(': '), `plain-scalar run must not contain ': ': ${line.trim().slice(0, 80)}`);
    }
  }
});

test('inline node scripts use literal block syntax', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const inline = texts.filter(t => /node --input-type=module/.test(t));
  assert(inline.length > 0, 'expected inline node steps');
  for (const t of inline) {
    assert(t.includes('run: |'), 'inline node script must run under a literal block');
  }
});

test('preflight precedes wrangler deploy and live verification follows it', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const preflight = texts.findIndex(t => t.includes('release-preflight.mjs') && t.includes('Require the verified'));
  const wrangler = texts.findIndex(t => t.includes('npx wrangler deploy'));
  const verify = texts.findIndex(t => t.includes('npm run verify:live'));
  assert(preflight >= 0 && wrangler >= 0 && verify >= 0, 'preflight, deploy and verify steps must exist');
  assert(preflight < wrangler, 'the last recheck must run before any deployment');
  assert(wrangler < verify, 'live verification must run after the deployment');
});

test('worker checks run on main with the same path filters as PRs', () => {
  assert(worker.includes('push:'), 'worker checks need a main push trigger');
  assert(worker.includes('branches: [main]'), 'push trigger is scoped to main');
  const lists = [...worker.matchAll(/paths:\n((?: {6}- '[^\n']+'\n)+)/g)].map(m => m[1]);
  assert.equal(lists.length, 2, 'pull_request and push must both declare paths');
  assert.equal(lists[0], lists[1], 'PR and push filters must stay identical');
});
