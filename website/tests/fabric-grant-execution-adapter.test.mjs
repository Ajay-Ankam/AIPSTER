// OFFLINE DEMO FIXTURES — synthetic fabric_grants / connections / resources
// rows mirroring store.mjs shapes for the grant-to-execution adapter ONLY.
// No D1, no worker, no network, no inference. The identities below are
// simulated test labels, not real users; nothing here is sharing proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGrant } from '../src/fabric/policy.mjs';
import { adaptGrantEntryToExecution, adaptGrantToExecution } from '../src/fabric/grant-execution-adapter.mjs';

const EXPORTER = 'u_exporter_alice';
const CONSUMER = 'u_consumer_bob';
const STRANGER = 'u_stranger_mallory';
const CONN = 'conn_demo_1';
const NODE_EXPORT = 'node_export_1';
const NODE_IMPORT = 'node_import_1';
const RES = 'res_demo_gpu_1';
const INC = 'inc_0001';

function grant(overrides = {}) {
  return {
    id: 'fg_demo_1',
    connection_id: CONN,
    recipient_node: NODE_IMPORT,
    recipient_workspace: CONSUMER,
    consumers: [CONSUMER],
    snapshot: [{ resourceId: RES, incarnation: INC }],
    actions: ['inference'],
    models: ['demo-model'],
    ceilings: { maxTokens: 1000 },
    route: 'fabric',
    expiry: '2027-01-01T00:00:00.000Z',
    status: 'enforced',
    version: 3,
    exporter_id: EXPORTER,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
function connection(overrides = {}) {
  return { id: CONN, state: 'active', version: 7, ...overrides };
}
function resource(overrides = {}) {
  return { id: RES, owner_id: EXPORTER, incarnation: INC, ...overrides };
}
function request(overrides = {}) {
  return {
    consumer: CONSUMER, peerNode: NODE_IMPORT, peerWorkspace: CONSUMER,
    action: 'inference', model: 'demo-model', maxTokens: 100,
    route: 'fabric', at: '2026-06-01T00:00:00.000Z', resourceId: RES,
    ...overrides,
  };
}
const LIVE = () => ({ grant: grant(), connection: connection(), resource: resource(), request: request(), denies: [] });

test('valid share adapts to an execution view the dispatch matcher accepts', () => {
  const d = adaptGrantToExecution(LIVE());
  assert.equal(d.decision, 'allow', JSON.stringify(d));
  assert.equal(d.witness, 'fg_demo_1');
  assert.deepEqual(d.execution, {
    id: 'fg_demo_1', status: 'enforced', revoked: false, revision: 3,
    recipientNode: NODE_IMPORT, recipientWorkspace: CONSUMER, consumers: [CONSUMER],
    resourceId: RES, incarnation: INC, actions: ['inference'], models: ['demo-model'],
    notBefore: '2026-01-01T00:00:00.000Z', expiry: '2027-01-01T00:00:00.000Z',
    ceilings: { maxTokens: 1000 }, route: 'fabric',
  });
  assert.equal(d.binding.grantId, 'fg_demo_1');
  assert.equal(d.binding.grantRevision, 3);
  assert.equal(d.binding.connectionId, CONN);
  // Round trip: the emitted view satisfies the coordinator's gate inputs.
  const gateRequest = {
    resourceId: RES, incarnation: INC, action: 'inference', model: 'demo-model',
    peerNode: NODE_IMPORT, peerWorkspace: CONSUMER, consumer: CONSUMER,
    maxTokens: 100, route: 'fabric', at: '2026-06-01T00:00:00.000Z', expectedRevision: 3,
  };
  assert.equal(matchGrant(gateRequest, d.execution, []), true, 'adapter output is exactly what matchGrant accepts');
});

test('stranger tenant is denied without leaking terms', () => {
  const d = adaptGrantToExecution({ ...LIVE(), request: request({ consumer: STRANGER }) });
  assert.equal(d.decision, 'deny');
  assert.equal(d.code, 'CONSUMER_NOT_COVERED');
  assert.equal(d.execution, null);
});

test('revoked grant never adapts, even when everything else is valid', () => {
  const d = adaptGrantToExecution({ ...LIVE(), grant: grant({ status: 'revoked' }) });
  assert.equal(d.decision, 'deny');
  assert.equal(d.code, 'GRANT_REVOKED');
  assert.equal(d.execution, null);
});

test('expired grant never adapts', () => {
  const d = adaptGrantToExecution({ ...LIVE(), request: request({ at: '2028-01-01T00:00:00.000Z' }) });
  assert.equal(d.decision, 'deny');
  assert.equal(d.code, 'GRANT_EXPIRED');
  assert.equal(d.execution, null);
});

test('stale resource incarnation and wrong resource both fail closed', () => {
  const stale = adaptGrantToExecution({ ...LIVE(), resource: resource({ incarnation: 'inc_0002' }) });
  assert.equal(stale.decision, 'deny');
  assert.equal(stale.code, 'STALE_INCARNATION');
  const wrong = adaptGrantToExecution({ ...LIVE(), resource: resource({ id: 'res_other', incarnation: 'inc_0001' }) });
  assert.equal(wrong.decision, 'deny');
  assert.ok(['RESOURCE_MISMATCH', 'STALE_INCARNATION'].includes(wrong.code), wrong.code);
});

test('peer confusion is denied: wrong recipient node and wrong connection', () => {
  const peer = adaptGrantToExecution({ ...LIVE(), request: request({ peerNode: 'node_impostor_9' }) });
  assert.equal(peer.decision, 'deny');
  assert.equal(peer.code, 'RECIPIENT_MISMATCH');
  const conn = adaptGrantToExecution({ ...LIVE(), connection: connection({ id: 'conn_other_9' }) });
  assert.equal(conn.decision, 'deny');
  assert.equal(conn.code, 'CONNECTION_MISMATCH');
  const down = adaptGrantToExecution({ ...LIVE(), connection: connection({ state: 'suspended' }) });
  assert.equal(down.decision, 'deny');
  assert.equal(down.code, 'CONNECTION_DOWN');
});

test('no grant on accept: active connection without a grant authorizes nothing', () => {
  const d = adaptGrantToExecution({ ...LIVE(), grant: null });
  assert.equal(d.decision, 'deny');
  assert.equal(d.code, 'NO_MATCHING_GRANT');
  assert.equal(d.execution, null);
  const paused = adaptGrantToExecution({ ...LIVE(), grant: grant({ status: 'paused' }) });
  assert.equal(paused.decision, 'deny');
  assert.equal(paused.code, 'GRANT_NOT_ENFORCED');
});

test('no fallback: malformed input and unknown action deny, never allow', () => {
  for (const bad of [{}, { grant: null }, { grant: grant(), request: null }, { ...LIVE(), grant: { id: 'x' } }]) {
    const d = adaptGrantToExecution(bad);
    assert.equal(d.decision, 'deny', JSON.stringify(bad));
    assert.equal(d.execution, null);
  }
  const action = adaptGrantToExecution({ ...LIVE(), request: request({ action: 'admin' }) });
  assert.equal(action.decision, 'deny');
  assert.equal(action.code, 'ACTION_DENIED');
});

test('matching deny row vetoes before any grant term is consulted', () => {
  const d = adaptGrantToExecution({ ...LIVE(), denies: [{ principal: CONSUMER, resourceId: RES, action: 'inference' }] });
  assert.equal(d.decision, 'deny');
  assert.equal(d.code, 'EXPLICIT_DENY');
  const other = adaptGrantToExecution({ ...LIVE(), denies: [{ principal: STRANGER, resourceId: RES, action: 'inference' }] });
  assert.equal(other.decision, 'allow', 'a deny scoped to someone else changes nothing');
});

test('quarantined enforced grant with preserved exporter stays inert', () => {
  // Stored D1 shape: JSON columns stringified exactly as commitGrant writes
  // them; quarantine_reason set, exporter preserved (the exposed case).
  const stored = {
    ...grant(),
    consumers: JSON.stringify([CONSUMER]),
    snapshot: JSON.stringify([{ resourceId: RES, incarnation: INC }]),
    actions: JSON.stringify(['inference']),
    models: JSON.stringify(['demo-model']),
    ceilings: JSON.stringify({ maxTokens: 1000 }),
    quarantine_reason: 'issuer-ambiguous',
  };
  const d = adaptGrantToExecution({ ...LIVE(), grant: stored });
  assert.equal(d.decision, 'deny', JSON.stringify(d));
  assert.equal(d.code, 'GRANT_QUARANTINED');
  assert.equal(d.execution, null);
  // Control: the same stored shape without quarantine adapts (D1 compat).
  const clean = adaptGrantToExecution({ ...LIVE(), grant: { ...stored, quarantine_reason: null } });
  assert.equal(clean.decision, 'allow', JSON.stringify(clean));
});

test('stored D1 shapes: null, scalar, and object JSON columns fail closed cleanly', () => {
  const obj = JSON.stringify({ x: 1 });
  const shapes = [
    ['consumers', obj], ['actions', obj], ['models', obj], ['snapshot', obj],
    ['consumers', null], ['models', JSON.stringify('Q4_K_M')], ['snapshot', null],
  ];
  for (const [field, value] of shapes) {
    const g = grant({ [field]: value });
    let d;
    try {
      d = adaptGrantToExecution({ ...LIVE(), grant: g });
    } catch (e) {
      assert.fail(`shape ${field}=${String(value)} threw instead of denying: ${e && e.message}`);
    }
    assert.equal(d.decision, 'deny', `shape ${field}=${String(value)}`);
    assert.equal(d.code, 'INPUT_MALFORMED', `shape ${field}=${String(value)}`);
    assert.equal(d.execution, null);
  }
  // Absent snapshot is "no cover", not malformed.
  const missing = grant();
  delete missing.snapshot;
  const d = adaptGrantToExecution({ ...LIVE(), grant: missing });
  assert.equal(d.decision, 'deny');
  assert.equal(d.code, 'NO_MATCHING_GRANT');
});

test('exporter drift and multi-resource snapshots stay honest', () => {
  const drift = adaptGrantToExecution({ ...LIVE(), resource: resource({ owner_id: 'u_someone_else' }) });
  assert.equal(drift.decision, 'deny');
  assert.equal(drift.code, 'EXPORTER_MISMATCH');
  const multi = adaptGrantToExecution({
    ...LIVE(),
    grant: grant({ snapshot: [{ resourceId: 'res_other_2', incarnation: 'inc_a' }, { resourceId: RES, incarnation: INC }] }),
    resource: [resource({ id: 'res_other_2', incarnation: 'inc_a' }), resource()],
  });
  assert.equal(multi.decision, 'allow', JSON.stringify(multi));
  assert.equal(multi.execution.resourceId, RES, 'one complete entry covers the request; entries are not stitched');
  const absent = adaptGrantToExecution({ ...LIVE(), request: request({ resourceId: 'res_nowhere' }) });
  assert.equal(absent.decision, 'deny');
  assert.equal(absent.code, 'RESOURCE_MISMATCH', 'a request naming a resource outside the snapshot authorizes nothing');
});
