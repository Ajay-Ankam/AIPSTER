import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifySnapshot, selectModelCandidate, listAdvertisedModels,
  MODEL_EVIDENCE_FRESH_MS } from '../src/inference/model-readiness.mjs';

const NOW = 1767225600000;
const iso = (ms) => new Date(ms).toISOString();
const runtimes = (list) => JSON.stringify(list);
const row = (o = {}) => ({ resourceId: 'res-a', ownerId: 'user-alice', usable: true,
  online: true, heartbeatAt: iso(NOW - 1000), reportedAt: iso(NOW - 2000),
  runtimesJson: runtimes([{ name: 'ganglion', models: ['synth-a'] }]), ...o });
const qual = (r, opts = {}) => qualifySnapshot(r, { nowMs: NOW, ...opts });

test('qualifies fresh evidence with exact tuples', () => {
  const q = qual(row());
  assert.equal(q.excluded, null);
  assert.deepEqual(q.tuples, [{ runtime_id: 'ganglion', model_id: 'synth-a', evidenceAgeMs: 2000 }]);
});

for (const [name, change, code] of [
  ['unusable', { usable: false }, 'NOT_USABLE'],
  ['offline', { online: false }, 'UNREACHABLE'],
  ['stale heartbeat', { heartbeatAt: iso(NOW - 600000) }, 'STALE_HEARTBEAT'],
  ['missing report', { reportedAt: null }, 'NO_EVIDENCE'],
  ['stale evidence', { reportedAt: iso(NOW - MODEL_EVIDENCE_FRESH_MS - 1) }, 'STALE_EVIDENCE'],
  ['unparseable snapshot', { runtimesJson: 'nope' }, 'INVALID_EVIDENCE'],
  ['malformed models', { runtimesJson: runtimes([{ name: 'ganglion', models: 'x' }]) }, 'INVALID_EVIDENCE'],
  ['no models anywhere', { runtimesJson: runtimes([{ name: 'ganglion' }]) }, 'NO_EVIDENCE'],
]) {
  test(`excludes ${name} (${code})`, () => {
    const q = qual(row(change));
    assert.equal(q.excluded.code, code);
    assert.deepEqual(q.tuples, []);
  });
}

test('foreign runtimes are skipped, never mapped; tenant enforced', () => {
  const q = qual(row({ runtimesJson: runtimes([{ name: 'cuda-native', models: ['m'] },
    { name: 'llama-server', models: ['synth-b'] }]) }));
  assert.equal(q.excluded, null);
  assert.deepEqual(q.tuples.map((t) => t.model_id), ['synth-b']);
  const cross = qual(row(), { tenantId: 'user-bob' });
  assert.equal(cross.excluded.code, 'TENANT_MISMATCH');
});

test('explicit model selects exact evidence; unknown is explicitly excluded', () => {
  const qa = qual(row());
  const qb = qual(row({ resourceId: 'res-b', ownerId: 'user-alice',
    runtimesJson: runtimes([{ name: 'llama-server', models: ['synth-b'] }]) }));
  const hit = selectModelCandidate([qa, qb], { tenantId: 'user-alice', model: 'synth-b' });
  assert.equal(hit.code, 'SELECTED');
  assert.deepEqual(hit.selected, { resourceId: 'res-b', runtimeId: 'llama-server',
    modelId: 'synth-b', evidenceAgeMs: 2000 });
  const miss = selectModelCandidate([qa, qb], { tenantId: 'user-alice', model: 'not-advertised' });
  assert.equal(miss.code, 'MODEL_NOT_ADVERTISED');
  assert.equal(miss.selected, null);
  assert.deepEqual(miss.excluded.map((e) => e.reason), ['MODEL_NOT_ADVERTISED', 'MODEL_NOT_ADVERTISED']);
});

test('auto picks freshest evidence deterministically', () => {
  const old = qual(row({ resourceId: 'res-old', reportedAt: iso(NOW - 60000) }));
  const fresh = qual(row({ resourceId: 'res-fresh', reportedAt: iso(NOW - 1000),
    runtimesJson: runtimes([{ name: 'llama-server', models: ['synth-b'] }]) }));
  const out = selectModelCandidate([old, fresh], { tenantId: 'user-alice', model: null });
  assert.equal(out.selected.resourceId, 'res-fresh');
  const tie = selectModelCandidate([fresh, old], { tenantId: 'user-alice', model: null });
  assert.equal(tie.selected.resourceId, 'res-fresh');
  const empty = selectModelCandidate([], { tenantId: 'user-alice', model: null });
  assert.equal(empty.code, 'NO_ELIGIBLE_NODE');
});

test('advertised list carries only evidenced models', () => {
  const entries = listAdvertisedModels([qual(row()),
    qual(row({ resourceId: 'res-b', runtimesJson: runtimes([{ name: 'llama-server', models: ['synth-b'] }]) })),
    qual(row({ resourceId: 'res-stale', heartbeatAt: iso(NOW - 600000) }))]);
  assert.deepEqual(entries.map((e) => e.model_id).sort(), ['synth-a', 'synth-b']);
});
