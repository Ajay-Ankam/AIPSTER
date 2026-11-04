// FABRIC067 narrow follow-up: the completeJob HTTP intake validator permits
// valid finish evidence and refuses anything else.
//
// This imports the REAL exported validateWorkerResultReport from
// worker-transport.mjs — the exact function the unchanged worker.js result
// route (POST /api/worker/jobs/:id/result, WEB066-owned) calls before
// completeJob. worker.js itself cannot load in this lane (better-auth is not
// installed and installs are out of scope), so this is the real intake
// boundary short of socket I/O; the route wiring is unchanged owner code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkerResultReport } from '../src/inference/worker-transport.mjs';

const leaseId = 'lease-000000000001';
const goodResult = () => ({ request_id: 'job-000000000001', node_id: 'res-A', runtime_id: 'ganglion',
  model_id: 'synth-model-a', runtime_instance: 'ganglion#7', model_fingerprint: 'sha256:synth-model-a-q4',
  simulated: false, content: 'ok', elapsed_ms: 3, usage: {}, cache: {} });
const report = (result) => ({ lease_id: leaseId, status: 'succeeded', result });

for (const finish of ['stop', 'length', 'content_filter']) {
  test(`HTTP intake permits finish_reason ${finish}`, () => {
    const out = validateWorkerResultReport(report({ ...goodResult(), finish_reason: finish }));
    assert.equal(out.ok, true);
  });
}

test('HTTP intake still accepts the legacy shape without finish evidence', () => {
  assert.equal(validateWorkerResultReport(report(goodResult())).ok, true);
});

for (const [name, change] of [['tool_calls', { finish_reason: 'tool_calls' }],
  ['malformed reason', { finish_reason: 'stopped-ish' }],
  ['non-string reason', { finish_reason: ['stop'] }],
  ['null reason', { finish_reason: null }]]) {
  test(`HTTP intake refuses ${name}`, () => {
    const out = validateWorkerResultReport(report({ ...goodResult(), ...change }));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'INVALID_RESULT');
  });
}
