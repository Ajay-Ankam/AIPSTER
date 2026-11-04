// Focused regression for the installer-trigger coverage gap (RELEASE072).
//
// The merge gate (website/scripts/release-gate.mjs) requires the
// 'Build and qualify Windows installer' check at the PR head whenever
// isWorkerApplicable(changedFiles) is true, and binds that check to
// .github/workflows/worker-installer-build.yml by producer. If the
// installer's pull_request path filter is narrower than the gate's
// applicability, a PR touching only the missing paths (e.g.
// website/src/worker.js) can never produce the required run and the gate
// can never pass. This test pins trigger/applicability parity so the
// filter cannot silently drift narrower than the gate again.
//
// Text-based like deploy-workflow.test.mjs: Node has no YAML parser here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WORKER_PATH_PATTERNS, isWorkerApplicable, matchWorkerPath} from '../scripts/release-preflight.mjs';
import {INSTALLER_CHECK_NAME, INSTALLER_WORKFLOW_FILE} from '../scripts/release-gate.mjs';

const installerUrl = new URL('../../.github/workflows/worker-installer-build.yml', import.meta.url);
const installer = await readFile(installerUrl, 'utf8');

function prPaths(text) {
  const onBlock = text.slice(text.search(/^on:$/m), text.search(/^permissions:/m));
  const parts = onBlock.split(/^  pull_request:/m);
  assert.equal(parts.length, 2, 'installer workflow must declare exactly one pull_request trigger');
  const section = parts[1].split(/^  \w[\w-]*:/m)[0];
  return [...section.matchAll(/^ {6}- '([^']+)'/gm)].map(m => m[1]);
}

const paths = prPaths(installer);

// Exact parity: the installer fires on every gate worker-applicable
// pattern (including the worker-checks workflow file — a PR touching only
// it still owes the gate an installer run) plus its own workflow file, so
// no worker-applicable PR can starve the required installer check.
test('installer PR trigger covers every gate worker-applicable pattern', () => {
  const expected = [...WORKER_PATH_PATTERNS,
    '.github/workflows/worker-installer-build.yml'];
  assert.deepEqual([...paths].sort(), [...expected].sort());
});

test('installer triggers on its own workflow file (gate-inapplicable self-change)', () => {
  const self = '.github/workflows/worker-installer-build.yml';
  assert.equal(isWorkerApplicable([self]), false);
  assert.equal(paths.some(p => matchWorkerPath(p, self)), true,
    'installer trigger must fire for its own file');
});

test('installer workflow file constant matches the tested file', () => {
  assert.equal(INSTALLER_WORKFLOW_FILE, '.github/workflows/worker-installer-build.yml');
});

// Parity battery: for each example, the trigger fires exactly when the
// gate calls the change worker-applicable. Fires = some parsed installer
// path pattern matches via the gate's own matcher.
const FIRES = [
  'local-worker/pairing.py',
  'local-worker/packaging/windows/build.py',
  'website/src/worker.js',
  'website/src/inference/dispatch-store.mjs',
  'website/migrations/0029_x.sql',
  'website/tests/d1-shim.mjs',
  'website/scripts/pairing-e2e-bridge.mjs',
  'website/package.json',
  'website/package-lock.json',
  'LICENSE',
  'NOTICE',
  '.github/workflows/local-worker-checks.yml',
];
const QUIET = [
  'docs/redesign.md',
  'README.md',
  'website/README.md',
  'website/public/index.html',
  '.github/release-holds.json',
  '.github/workflows/public-site-checks.yml',
  'local-worker-old/x.py',
];

for (const file of FIRES) test(`trigger fires for worker-applicable ${file}`, () => {
  assert.equal(isWorkerApplicable([file]), true, `${file} must stay gate-applicable`);
  assert.equal(paths.some(p => matchWorkerPath(p, file)), true,
    `installer trigger must fire for ${file}`);
});

for (const file of QUIET) test(`trigger stays quiet for non-applicable ${file}`, () => {
  assert.equal(isWorkerApplicable([file]), false, `${file} must stay gate-inapplicable`);
  assert.equal(paths.some(p => matchWorkerPath(p, file)), false,
    `installer trigger must not fire for ${file}`);
});

test('installer keeps trusted ordinary-PR semantics and manual fallback', () => {
  assert(installer.includes('pull_request:'), 'ordinary PR trigger required');
  assert(installer.includes('workflow_dispatch:'), 'manual fallback required');
  assert(installer.includes('contents: read'), 'minimum read-only permissions required');
  assert(!/^ +\w[\w-]*: write$/m.test(installer), 'no write grants allowed (untrusted forks get no privilege)');
  assert(installer.includes('persist-credentials: false'), 'checkout must not persist credentials');
  assert(installer.includes('concurrency:'), 'concurrency group required');
  assert(installer.includes('cancel-in-progress: true'), 'superseded runs must cancel');
});

test('installer keeps the gate-bound job name and pinned actions', () => {
  assert(installer.includes(`name: ${INSTALLER_CHECK_NAME}`),
    'job name must match the gate INSTALLER_CHECK_NAME producer binding');
  for (const pin of ['actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
    'astral-sh/setup-uv@94527f2e458b27549849d47d273a16bec83a01e9',
    'actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4']) {
    assert(installer.includes(pin), `pinned action required: ${pin}`);
  }
});

test('installer publishes no release and grants no deployment', () => {
  assert(!/^environment:/m.test(installer), 'no deployment environment allowed');
  assert(!installer.includes('releases:'), 'no release publication allowed');
});
