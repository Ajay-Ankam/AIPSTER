// Fabric grant → dispatch read path on real D1 (node:sqlite shim).
// Two-principal fixture exercising actual store reads: an honestly
// consented share (register → invite → accept → preview → approve →
// commit via the real fabric store, no router involved) is projected by
// the dispatch store's fabric readGrant branch and re-verified by
// policy.matchGrant with a coordinator-shaped request. Refusals withhold
// the view (null), so a coordinator can only answer NO_MATCHING_GRANT.
// No worker.js, no dispatch, no execution, no network. Synthetic rows
// and identities only; not sharing proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv } from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import { matchGrant } from '../src/fabric/policy.mjs';

const RES = 'r_gpu1';
const INC = 'gen1';
const PEER_WS = 'default';

const alice = () => ({ kind: 'session', user: { id: 'u_alice' } });
const bob = () => ({ kind: 'session', user: { id: 'u_bob' } });

// Honest consent flow on a fresh isolated DB. Consumers name the actual
// user id: the dispatch side binds consumer = authenticated principal,
// so labels like 'bob-op' can never authorize execution.
async function consent(t) {
  const a = (await core.registerNode(t.DB, alice(), { label: 'exporter-node' })).body;
  const b = (await core.registerNode(t.DB, bob(), { label: 'importer-node' })).body;
  const inv = (await core.createInvitation(t.DB, alice(), {
    issuerNode: a.id, recipientNode: b.id, recipientWorkspace: PEER_WS,
  })).body;
  const conn = (await core.acceptInvitation(t.DB, bob(), {
    token: inv.token, nodeId: b.id, nodeKey: b.nodeSecret,
  })).body.id;
  const prev = (await core.createPreview(t.DB, alice(), {
    connectionId: conn, resourceIds: [RES], consumers: ['u_bob'],
    models: ['llama'], maxTokens: 1000, maxRequests: 10, route: 'internal',
  })).body;
  const appr = (await core.requestApproval(t.DB, alice(), { previewId: prev.id })).body;
  assert.equal((await core.decideApproval(t.DB, alice(), appr.id, { decision: 'approve' })).status, 200);
  const grant = (await core.commitGrant(t.DB, alice(), { approvalId: appr.id, previewHash: prev.digest })).body;
  assert.equal(grant.status, 'enforced');
  return { a, b, conn, grantId: grant.id };
}

async function setup(t) {
  const tEnv = t ?? (await fabricEnv());
  const c = await consent(tEnv);
  const store = createD1DispatchStore(tEnv.DB, { now: () => Date.now(), env: { FEDERATION_ENABLED: '1' } });
  return { t: tEnv, store, ...c };
}
const read = (s, principal, resource = RES) =>
  s.store.readGrant({ grant_id: s.grantId, principal_id: principal, resource_id: resource });
const gateRequest = (s, view, extra = {}) => ({
  resourceId: RES, incarnation: INC, action: 'inference', model: 'llama',
  peerNode: s.b.id, peerWorkspace: PEER_WS, consumer: 'u_bob',
  maxTokens: 100, route: 'internal', at: new Date().toISOString(),
  expectedRevision: view.revision, ...extra,
});

test('valid share reads back an enforced live-pinned view the gate accepts', async (t) => {
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  const view = await read(s, 'u_bob');
  assert.deepEqual(view, {
    id: s.grantId, status: 'enforced', revoked: false, revision: 1,
    recipientNode: s.b.id, recipientWorkspace: PEER_WS, consumers: ['u_bob'],
    resourceId: RES, incarnation: INC, actions: ['inference'],
    models: ['llama'], notBefore: view.notBefore, expiry: view.expiry,
    ceilings: view.ceilings, route: 'internal',
  });
  assert.equal(view.incarnation, INC, 'incarnation is the live pin, not a stale copy');
  assert.ok(matchGrant(gateRequest(s, view), view, []), 'coordinator gate accepts the emitted view');
});

test('stranger tenant gets null, never an existence oracle', async (t) => {
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  // The exporter is not a consumer; an unknown user owns no recipient node.
  assert.equal(await read(s, 'u_alice'), null);
  assert.equal(await read(s, 'u_mallory'), null);
  assert.equal(await read(s, 'u_bob', 'r_nope'), null);
  assert.equal(await s.store.readGrant({ grant_id: 'fg_missing' }), null);
  assert.equal(await s.store.readGrant({ grant_id: s.grantId }), null, 'principal is required');
});

test('revoked grant withholds the view', async (t) => {
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  assert.ok(await read(s, 'u_bob'), 'precondition: view resolves before revoke');
  const rev = await core.revokeGrant(s.t.DB, alice(), s.grantId, { expectedVersion: 1 });
  assert.equal(rev.status, 200);
  assert.equal(await read(s, 'u_bob'), null);
});

test('quarantined grant withholds the view', async (t) => {
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  assert.ok(await read(s, 'u_bob'), 'precondition: view resolves before quarantine');
  // No exported quarantine writer exists; this mirrors a migration- or
  // reviewer-quarantined row (status stays 'enforced' by design).
  await s.t.DB.prepare('UPDATE fabric_grants SET quarantine_reason = ? WHERE id = ?')
    .bind('issuer-ambiguous', s.grantId).run();
  assert.equal(await read(s, 'u_bob'), null);
});

test('suspended connection withholds the view', async (t) => {
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  const row = await s.t.DB.prepare('SELECT version FROM connections WHERE id = ?').bind(s.conn).first();
  const sus = await core.suspendConnection(s.t.DB, alice(), s.conn, { expectedVersion: row.version });
  assert.equal(sus.status, 200);
  assert.equal(await read(s, 'u_bob'), null);
});

test('stale incarnation and exporter drift withhold the view', async (t) => {
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  await s.t.DB.prepare("UPDATE resources SET incarnation = 'gen2' WHERE id = ?").bind(RES).run();
  assert.equal(await read(s, 'u_bob'), null, 'a re-registered resource is not authorized by the old snapshot');
  const now = new Date().toISOString();
  await s.t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind('u_mallory', 'Mallory', 'mallory@synthetic.invalid', now, now).run();
  await s.t.DB.prepare("UPDATE resources SET incarnation = 'gen1', owner_id = 'u_mallory' WHERE id = ?").bind(RES).run();
  assert.equal(await read(s, 'u_bob'), null, 'ownership drift authorizes nothing');
});

test('empty-string quarantine and array ceilings fail closed like the adapter', async (t) => {
  // Parity with grant-execution-adapter: it rejects every non-nullish
  // quarantine_reason and every non-object ceilings. The read path must
  // not be looser (truthy check lets '' through; typeof [] is 'object').
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  assert.deepEqual((await read(s, 'u_bob')).ceilings, { maxTokens: 1000, maxRequests: 10 },
    'precondition: the persisted object ceilings are accepted as committed');
  await s.t.DB.prepare('UPDATE fabric_grants SET quarantine_reason = ? WHERE id = ?').bind('', s.grantId).run();
  assert.equal(await read(s, 'u_bob'), null, 'empty-string quarantine is still quarantine');
  await s.t.DB.prepare('UPDATE fabric_grants SET quarantine_reason = NULL WHERE id = ?').bind(s.grantId).run();
  await s.t.DB.prepare('UPDATE fabric_grants SET ceilings = ? WHERE id = ?').bind('[1000]', s.grantId).run();
  assert.equal(await read(s, 'u_bob'), null, 'array ceilings carry no quota limit and are refused');
  // NULL ceilings are untestable here on purpose: the schema declares the
  // column NOT NULL, so a null row cannot persist. The adapter-side null
  // case stays covered by the pure unit suite.
});

test('owner-scoped deny withholds the view for its principal only', async (t) => {
  const s = await setup();
  t.after(() => s.t.sqlite.close());
  const now = new Date().toISOString();
  // Fabric persists the deny verbatim as 'infer' (store.mjs preview/discovery
  // paths); the fixture must use the real vocabulary, not the dispatch one.
  await s.t.DB.prepare(`INSERT INTO fabric_denies (id, owner_id, principal, resource_id, action, created_at)
    VALUES ('dn_demo_1', 'u_alice', 'u_bob', ?, 'infer', ?)`).bind(RES, now).run();
  assert.equal(await read(s, 'u_bob'), null, 'matching deny blocks the consumer');
  await s.t.DB.prepare('DELETE FROM fabric_denies WHERE id = ?').bind('dn_demo_1').run();
  assert.ok(await read(s, 'u_bob'), 'deny removed: view resolves again');
  await s.t.DB.prepare(`INSERT INTO fabric_denies (id, owner_id, principal, resource_id, action, created_at)
    VALUES ('dn_demo_2', 'u_alice', 'u_stranger', ?, 'infer', ?)`).bind(RES, now).run();
  assert.ok(await read(s, 'u_bob'), 'a deny scoped to someone else changes nothing');
});
