// DGM evaluation core: the Worker-safe single source for the daily cron
// self-test and the local experiment lane. Offline, synthetic, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  computeSelfTestSnapshot, SELF_TEST_SCHEMA, buildWorkload, weightsKey, enumerateAllowlist,
  scoreWithWeights, WEIGHT_ALLOWLIST,
} from '../src/dgm/eval-core.mjs';
import { scoreCandidates, ROUTING_SCORE } from '../src/routing/policy.mjs';
import { searchCeiling } from '../../experiments/dgm-routing/ceiling.mjs';
import * as laneWorkload from '../../experiments/dgm-routing/workload.mjs';
import * as laneRunner from '../../experiments/dgm-routing/runner.mjs';
import * as laneSchema from '../../experiments/dgm-routing/candidate-schema.mjs';

test('dgm eval core: Worker-safe — no node:* imports, no I/O, no clock, no network', async () => {
  const src = await readFile(new URL('../src/dgm/eval-core.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/from\s+['"]node:/.test(code), 'no node: imports (wrangler has nodejs_als only)');
  for (const banned of ['fetch(', 'Date.now', 'new Date', 'readFile', 'process.', 'crypto.', 'Math.random']) {
    assert.ok(!code.includes(banned), `no ${banned}`);
  }
  const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../routing/policy.mjs']);
});

test('dgm eval core: canonical snapshot is tie-only with green guardrails', () => {
  const s = computeSelfTestSnapshot();
  assert.equal(s.schema, SELF_TEST_SCHEMA);
  assert.equal(s.synthetic, true);
  assert.equal(s.policyVersion, 'route/v1');
  assert.deepEqual(s.workload, { version: 'dgm-routing-workload/v1', seed: 20261105, trainN: 24, heldoutN: 24 });
  assert.deepEqual(s.guardrails.map((g) => [g.name, g.passed]), [
    ['permutation_integrity', true], ['replay_determinism', true], ['mirror_fidelity', true], ['split_independence', true],
  ]);
  assert.deepEqual(s.baseline.weights, { ...ROUTING_SCORE });
  assert.equal(s.baseline.heldoutTop1, 20);
  assert.equal(s.evaluated, 161);
  assert.deepEqual(s.counts, { improvement: 0, 'tie-archived': 54, regression: 107 });
  assert.equal(s.ceiling, 'tie-archived');
  assert.equal(s.proposalCanImprove, false);
  assert.equal(s.best.heldoutTop1, 20);
  assert.equal(s.best.weightsKey, weightsKey(s.best.weights));
  assert.deepEqual(s.variables.map((v) => v.name), ['EXACT_TOKEN', 'ONLINE', 'FRESHNESS_MAX', 'OWNED', 'HEADROOM']);
  for (const v of s.variables) assert.equal(v.direction, v.best > v.baseline ? 'up' : v.best < v.baseline ? 'down' : 'same');
});

test('dgm eval core: deterministic across calls and serializable', () => {
  assert.equal(JSON.stringify(computeSelfTestSnapshot()), JSON.stringify(computeSelfTestSnapshot()));
  assert.ok(JSON.stringify(computeSelfTestSnapshot()).length < 4096, 'snapshot stays small for D1');
});

test('dgm eval core: the local lane uses the core (single source) and agrees with it', () => {
  assert.equal(laneWorkload.buildWorkload, buildWorkload);
  assert.equal(laneRunner.scoreWithWeights, scoreWithWeights);
  assert.equal(laneSchema.WEIGHT_ALLOWLIST, WEIGHT_ALLOWLIST);
  const s = computeSelfTestSnapshot();
  const c = searchCeiling(buildWorkload());
  assert.deepEqual(c.counts, s.counts);
  assert.equal(c.ceiling, s.ceiling);
  assert.equal(weightsKey(c.best.weights), s.best.weightsKey, 'same best candidate named by both paths');
});

test('dgm eval core: mirror reproduces the authoritative scorer at live weights', () => {
  const wl = buildWorkload();
  for (const item of [...wl.train, ...wl.heldout]) {
    const a = scoreCandidates(item.descriptors, item.features).ranked.map((r) => [r.alias, r.score]);
    const b = scoreWithWeights(item.descriptors, item.features, { ...ROUTING_SCORE }).ranked.map((r) => [r.alias, r.score]);
    assert.deepEqual(b, a, item.id);
  }
  assert.equal(enumerateAllowlist().length, 162);
});
