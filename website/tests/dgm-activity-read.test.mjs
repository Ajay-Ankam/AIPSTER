/* Built with Meta Muse. */
// DGM local-report reader tests: fixed filenames only, bounded reads,
// digest verification, no invented data. Valid payloads are generated with
// the real runExperiment + buildReport over the real workload — never
// handcrafted. Temp directories only; the ignored artifacts tree is read,
// never written, by these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  readLocalReports, buildLocalActivity, REPORT_FILENAME, LOCAL_ACTIVITY_SCHEMA,
} from '../../experiments/dgm-routing/activity-read.mjs';
import { buildWorkload, WORKLOAD_VERSION, WORKLOAD_SEED } from '../../experiments/dgm-routing/workload.mjs';
import { runExperiment } from '../../experiments/dgm-routing/runner.mjs';
import { buildReport, stableStringify, sha256Hex } from '../../experiments/dgm-routing/report.mjs';

const VALID_W = { EXACT_TOKEN: 60, ONLINE: 30, FRESHNESS_MAX: 20, OWNED: 10, HEADROOM: 5 };

function realPair() {
  const workload = buildWorkload();
  const experiment = runExperiment({ candidate: { weights: { ...VALID_W } }, workload, proposalsUsed: 0 });
  assert.equal(experiment.refused, false);
  return buildReport({ experiment, workloadVersion: WORKLOAD_VERSION, workloadSeed: WORKLOAD_SEED, sourceSha: 'test' });
}

function stage(files) {
  // files: {name: stringContent}. Returns a lane-root-like dir whose
  // artifacts/ subdir holds exactly those files.
  const root = mkdtempSync(join(tmpdir(), 'dgm-read-'));
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, 'artifacts', name), content);
  }
  return root;
}

test('dgm read: missing tree is an honest empty, never an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'dgm-read-empty-'));
  const { reports, failures } = readLocalReports({ root });
  assert.deepEqual(reports, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'NO_ARTIFACTS');
});

test('dgm read: only fixed report-<16hex>.json filenames are read', () => {
  const { report, digest } = realPair();
  const root = stage({
    [`report-${digest.slice(0, 16)}.json`]: JSON.stringify({ report, digest }),
    'report-xyz.json': JSON.stringify({ report, digest }),
    'notes.txt': 'not a report',
    'report-ABCDEF1234567890.json': JSON.stringify({ report, digest }),
  });
  const { reports, failures } = readLocalReports({ root });
  assert.equal(reports.length, 1);
  assert.equal(failures.length, 0);
  assert.ok(REPORT_FILENAME.test(`report-${digest.slice(0, 16)}.json`));
});

test('dgm read: digest mismatch drops the file and retains the failure', () => {
  const { report, digest } = realPair();
  const tampered = { ...report, outcome: 'improvement' };
  const root = stage({ [`report-${digest.slice(0, 16)}.json`]: JSON.stringify({ report: tampered, digest }) });
  const { reports, failures } = readLocalReports({ root });
  assert.deepEqual(reports, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'DIGEST_MISMATCH');
});

test('dgm read: oversize and malformed files are refused with reasons', () => {
  const root = stage({
    'report-aaaaaaaaaaaaaaaa.json': 'x'.repeat(300 * 1024),
    'report-bbbbbbbbbbbbbbbb.json': '{not json',
  });
  const { reports, failures } = readLocalReports({ root });
  assert.deepEqual(reports, []);
  assert.deepEqual(failures.map((f) => f.code).sort(), ['MALFORMED', 'OVERSIZE']);
});

test('dgm read: injected extras with a valid recomputed hash are stripped, never exposed', () => {
  const { report, digest } = realPair();
  const polluted = {
    ...report,
    apiKey: 'SECRET-KEY-MATERIAL',
    privatePrompt: 'submit this tenant data',
    rawProposal: '```something executable```',
    proposalProvenance: { ...(report.proposalProvenance || {}), apiKey: 'SECRET-KEY-2' },
    nested: { deeper: { secret: 'x' } },
  };
  // Recompute the digest over the polluted payload with the real canonical
  // stringifier, so integrity passes and only the projection stands between
  // the secret and the output.
  const digest2 = sha256Hex(stableStringify(polluted));
  const root = stage({ [`report-${digest2.slice(0, 16)}.json`]: JSON.stringify({ report: polluted, digest: digest2 }) });
  const { reports, failures } = readLocalReports({ root });
  assert.equal(failures.length, 0);
  assert.equal(reports.length, 1);
  const dumped = JSON.stringify(reports[0]);
  for (const secret of ['SECRET-KEY-MATERIAL', 'SECRET-KEY-2', 'submit this tenant data', 'something executable', 'apiKey', 'privatePrompt', 'rawProposal', 'nested']) {
    assert.ok(!dumped.includes(secret), `leaked: ${secret}`);
  }
  assert.deepEqual(Object.keys(reports[0]).sort(), [
    'baseline', 'candidate', 'evalVersion', 'generatedAt', 'guardrails',
    'outcome', 'outcomeDetail', 'promotionEligible', 'proposalProvenance', 'proposalsUsed', 'sourceSha',
  ]);
  void digest;
});

test('dgm read: filename must agree with the verified digest', () => {
  const { report, digest } = realPair();
  const root = stage({ 'report-0000000000000000.json': JSON.stringify({ report, digest }) });
  const { reports, failures } = readLocalReports({ root });
  assert.deepEqual(reports, []);
  assert.equal(failures[0].code, 'NAME_MISMATCH');
});

test('dgm read: directories and parent-segment roots refuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'dgm-read-dir-'));
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  mkdirSync(join(root, 'artifacts', 'report-cccccccccccccccc.json'));
  const { reports, failures } = readLocalReports({ root });
  assert.deepEqual(reports, []);
  assert.equal(failures[0].code, 'NOT_A_FILE');
  assert.throws(() => readLocalReports({ root: `x${sep}..${sep}y` }), /parent segments/);
});

test('dgm read: hook failures are read failures only, never rendered rows', () => {
  const { report, digest } = realPair();
  const root = stage({ [`report-${digest.slice(0, 16)}.json`]: JSON.stringify({ report, digest }) });
  const out = buildLocalActivity({ root, runs: [] });
  assert.ok(out.failures.every((f) => f.kind === 'local-report'));
  // Rendered view rows (gates/guardrails/proposals) stay inside the view,
  // never relabeled as dropped unread reports.
  assert.ok(!out.failures.some((f) => f.kind === 'guardrail' || f.kind === 'gate' || f.kind === 'proposal'));
});

test('dgm read: swapped dev/ino refuses; linked artifacts dir refuses', async () => {
  const { report, digest } = realPair();
  const root = stage({ [`report-${digest.slice(0, 16)}.json`]: JSON.stringify({ report, digest }) });
  const { readBoundedBytes } = await import('../../experiments/dgm-routing/activity-read.mjs');
  const target = join(root, 'artifacts', `report-${digest.slice(0, 16)}.json`);
  const direct = readBoundedBytes(target);
  assert.equal(direct.ok, true);
  const swapped = readBoundedBytes(target, { dev: -1, ino: -1 });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.code, 'SWAPPED');
  // Linked artifacts dir: attempt a junction; skip honestly without privilege.
  const { symlinkSync } = await import('node:fs');
  const linkRoot = mkdtempSync(join(tmpdir(), 'dgm-read-link-'));
  try {
    symlinkSync(join(root, 'artifacts'), join(linkRoot, 'artifacts'), 'junction');
  } catch {
    return;
  }
  const linked = readLocalReports({ root: linkRoot });
  assert.deepEqual(linked.reports, []);
  assert.equal(linked.failures[0].code, 'DIR_UNSAFE');
});

test('dgm read: buildLocalActivity merges verified reports into the view', () => {
  const { report, digest } = realPair();
  const root = stage({ [`report-${digest.slice(0, 16)}.json`]: JSON.stringify({ report, digest }) });
  const out = buildLocalActivity({ root, runs: [], runDetails: [] });
  assert.equal(out.schema, LOCAL_ACTIVITY_SCHEMA);
  assert.equal(out.reports.length, 1);
  const local = out.view.experiments.filter((e) => e.kind === 'local-report');
  assert.equal(local.length, 1);
  const ms = out.view.metrics.filter((m) => m.source === 'synthetic-local');
  assert.ok(ms.length >= 1 && ms.every((m) => m.synthetic === true));
  assert.ok(out.view.outcomes.some((o) => o.promotion && o.promotion.approved === false));
});

test('dgm read: buildLocalActivity carries the computed search-space ceiling', async () => {
  const { localCeilingSummary } = await import('../../experiments/dgm-routing/activity-read.mjs');
  const root = stage({});
  const out = buildLocalActivity({ root, runs: [], runDetails: [] });
  const c = out.ceiling;
  assert.equal(c.state, 'computed');
  assert.equal(c.synthetic, true);
  assert.equal(c.ceiling, 'tie-archived');
  assert.equal(c.proposalCanImprove, false);
  assert.equal(c.evaluated, 161);
  assert.deepEqual(c.counts, { improvement: 0, 'tie-archived': 54, regression: 107 });
  assert.equal(c.baselineHeldoutTop1, 20);
  assert.equal(c.heldoutN, 24);
  assert.equal(c.best.outcome, 'tie-archived');
  assert.deepEqual(c.best.variables.map((v) => v.name), ['EXACT_TOKEN', 'ONLINE', 'FRESHNESS_MAX', 'OWNED', 'HEADROOM']);
  for (const v of c.best.variables) {
    assert.equal(v.direction, v.best > v.baseline ? 'up' : v.best < v.baseline ? 'down' : 'same');
  }
  // Allowlisted projection only: no workload items, descriptors or weights maps leak.
  assert.deepEqual(Object.keys(c).sort(), ['baselineHeldoutTop1', 'best', 'ceiling', 'counts', 'evaluated', 'heldoutN', 'proposalCanImprove', 'state', 'synthetic', 'workload']);
  assert.ok(!JSON.stringify(c).includes('descriptors'));
  // Memoized: a second call returns the same object without recomputing.
  assert.equal(localCeilingSummary(), localCeilingSummary());
});
