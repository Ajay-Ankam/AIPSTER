/* Built with Meta Muse. */
// P1 repair regressions: (1) a cancellation that read `reserved` must not
// overwrite a newer live `fetching` receipt, and (2) a local settlement
// failure after provider acceptance must not be classified as a provider
// rejection. Deterministic offline only: injected fetch, node:sqlite D1 shim,
// controlled interleavings, no network and no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { DGM_MUSE_MODEL, museWorstCaseSpendMicros } from '../src/dgm/muse-provider.mjs';
import { handleMusePropose } from '../src/dgm/muse-router.mjs';

const LIVE = { DGM_PREVIEW_ENABLED: '1', DGM_MUSE_LIVE: '1', DGM_MUSE_API_KEY: 'stub-key', DGM_MUSE_SPEND_CAP_USD: '1' };
const BASE = '/api/admin/v1/dgm/preview/muse';
const alice = () => ({ user: { id: 'u_alice' } });
let grantSeq = 0;

async function grant(t, userId, role) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(`g_p1_${++grantSeq}`, userId, role, 'platform', null, now, 'operator', null).run();
}

const postMuse = async (t, path, body) => readJson(await t.call(path, {
  method: 'POST',
  headers: { ...t.as(t.alice), ...t.csrf },
  body,
}));

const proposalResponse = () => new Response(JSON.stringify({
  id: 'resp_p1',
  model: DGM_MUSE_MODEL,
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'P1 synthetic proposal.' }] }],
  usage: { input_tokens: 120, output_tokens: 40 },
}), { status: 200 });

const rowOf = (t, key) => t.DB.prepare(
  'SELECT * FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?'
).bind('u_alice', key).first();

const spendRow = (t) => t.DB.prepare(
  "SELECT reserved_micros, used_micros FROM dgm_muse_spend WHERE scope = 'global' AND window_key = 'all-time'"
).first();

/**
 * Intercept the exact statements the repair is about, and hold each one at a
 * promise gate. The gate is armed once per test and runs the real statement
 * after release, so the interleaving is real route/core control flow, not a
 * hand-written row mutation.
 */
function gateDb(t) {
  const realPrepare = t.DB.prepare.bind(t.DB);
  const gates = {
    atFetching: null,
    atCancelRead: null,
    releaseFetching: null,
    releaseCancelRead: null,
  };
  gates.fetching = new Promise((r) => { gates.atFetching = r; });
  gates.cancelRead = new Promise((r) => { gates.atCancelRead = r; });
  let fetchingGate = new Promise((r) => { gates.releaseFetching = r; });
  let cancelGate = new Promise((r) => { gates.releaseCancelRead = r; });
  let fetchingUsed = false;
  let cancelUsed = false;
  t.DB.prepare = (sql) => {
    const stmt = realPrepare(sql);
    return {
      ...stmt,
      sql,
      bind: (...params) => {
        const bound = stmt.bind(...params);
        if (!fetchingUsed && /^UPDATE dgm_muse_ops SET state = \?/.test(sql) && params[0] === 'fetching') {
          fetchingUsed = true;
          const realRun = bound.run.bind(bound);
          bound.run = async () => {
            gates.atFetching();
            await fetchingGate;
            return realRun();
          };
        }
        if (!cancelUsed && /^SELECT state, receipt_json, mode, unknown_outcome FROM dgm_muse_ops/.test(sql)) {
          cancelUsed = true;
          const realFirst = bound.first.bind(bound);
          bound.first = async (...args) => {
            const row = await realFirst(...args);
            gates.atCancelRead();
            await cancelGate;
            return row;
          };
        }
        return bound;
      },
    };
  };
  return {
    gates,
    releaseFetching: () => { gates.releaseFetching(); },
    releaseCancelRead: () => { gates.releaseCancelRead(); },
  };
}

test('P1 cancel: a stale reserved read cannot overwrite a newer live fetching receipt', async () => {
  const t = await createTestEnv(LIVE);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const key = 'p1-cancel-live';
  const g = gateDb(t);
  let releaseProvider;
  const providerGate = new Promise((r) => { releaseProvider = r; });
  let atProvider;
  const providerEntered = new Promise((r) => { atProvider = r; });
  let providerCalls = 0;

  const proposalPromise = handleMusePropose({
    db: t.DB,
    env: t.env,
    actor: alice(),
    body: { prompt: 'P1 cancellation interleaving.', opKey: key, mode: 'live' },
    fetchImpl: async () => {
      providerCalls += 1;
      atProvider();
      await providerGate;
      return proposalResponse();
    },
  });

  await g.gates.fetching; // row is `reserved`; the fetching update is paused
  const cancelPromise = postMuse(t, `${BASE}/ops/${key}/cancel`, {});
  await g.gates.cancelRead; // cancel read `reserved`; its update is paused

  g.releaseFetching();
  await providerEntered; // row is `fetching`, provider call is pending
  g.releaseCancelRead();
  const cancel = await cancelPromise;

  // While the first provider call is still pending, a new key must not be
  // admitted. Capture the outcome before any late evidence can mask it.
  let nextCalls = 0;
  let next = null;
  try {
    next = { ok: true, value: await handleMusePropose({
      db: t.DB,
      env: t.env,
      actor: alice(),
      body: { prompt: 'Next admission.', opKey: 'p1-cancel-next', mode: 'live' },
      fetchImpl: async () => { nextCalls += 1; return proposalResponse(); },
    }) };
  } catch (e) {
    next = { ok: false, error: e };
  }

  releaseProvider();
  const late = await proposalPromise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const row = await rowOf(t, key);
  const receipt = JSON.parse(row.receipt_json);

  assert.equal(providerCalls, 1, 'the accepted call is not retried');
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.state, 'cancelled');
  assert.equal(cancel.json.unknownOutcome, true, 'a possibly-sent cancellation keeps the durable flag');
  assert.equal(cancel.json.blocking, true);
  assert.equal(cancel.json.receipt.providerContact, 'sent');
  assert.equal(cancel.json.receipt.acceptance, 'unknown');
  assert.equal(cancel.json.receipt.billing, 'possibly-chargeable');
  assert.equal(cancel.json.receipt.cancelledFrom, 'fetching');
  assert.equal(row.state, 'cancelled');
  assert.equal(Number(row.unknown_outcome), 1);
  assert.equal(next.ok, false, 'a new key is denied while the first call is unresolved');
  assert.equal(next.error.code, 'DGM_MUSE_UNCERTAIN');
  assert.equal(nextCalls, 0, 'no second provider call');
  assert.equal(late.ok, true);
  assert.equal(late.value.status, 409);
  assert.match(late.value.body.note, /late result is recorded as evidence/);
  assert.equal(receipt.lateOutcome.acceptance, 'accepted');
  assert.equal(receipt.lateOutcome.billing, 'possibly-chargeable');
});

test('P1 cancel: fixture fetching cancellation stays provably unsent under the race', async () => {
  const t = await createTestEnv(LIVE);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const key = 'p1-cancel-fixture';
  const g = gateDb(t);
  const realBatch = t.DB.batch.bind(t.DB);
  let releaseSettle;
  const settleGate = new Promise((r) => { releaseSettle = r; });
  let atSettle;
  const settleEntered = new Promise((r) => { atSettle = r; });
  let settleUsed = false;
  t.DB.batch = async (stmts) => {
    if (!settleUsed && stmts.some((s) => /SET state = 'delivered'/.test(s.sql || ''))) {
      settleUsed = true;
      atSettle();
      await settleGate;
    }
    return realBatch(stmts);
  };

  const proposalPromise = handleMusePropose({
    db: t.DB,
    env: t.env,
    actor: alice(),
    body: { prompt: 'P1 fixture race.', opKey: key, mode: 'fixture' },
    fetchImpl: async () => { throw new Error('fixture mode must not call the provider'); },
  });

  await g.gates.fetching;
  const cancelPromise = postMuse(t, `${BASE}/ops/${key}/cancel`, {});
  await g.gates.cancelRead;
  g.releaseFetching();
  await settleEntered; // fixture row is `fetching`; settlement is paused
  g.releaseCancelRead();
  const cancel = await cancelPromise;
  releaseSettle();
  const late = await proposalPromise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const row = await rowOf(t, key);
  const next = await handleMusePropose({
    db: t.DB,
    env: t.env,
    actor: alice(),
    body: { prompt: 'Next fixture.', opKey: 'p1-cancel-fixture-next', mode: 'fixture' },
    fetchImpl: async () => { throw new Error('fixture mode must not call the provider'); },
  });

  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.state, 'cancelled');
  assert.equal(cancel.json.unknownOutcome, false, 'fixture cancellation is provably unsent');
  assert.equal(cancel.json.blocking, false);
  assert.equal(cancel.json.receipt.providerContact, 'none');
  assert.equal(cancel.json.receipt.acceptance, 'not-sent');
  assert.equal(cancel.json.receipt.billing, 'not-chargeable');
  assert.equal(Number(row.unknown_outcome), 0);
  assert.equal(late.ok, false);
  assert.equal(late.error.code, 'DGM_MUSE_CANCELLED');
  assert.equal(next.status, 200, 'a provably-unsent fixture cancellation does not quarantine');
});

test('P1 settlement: pre-commit local failure quarantines accepted evidence and denies admission', async () => {
  const t = await createTestEnv(LIVE);
  const key = 'p1-settle-pre';
  const prompt = 'P1 settlement failure injection.';
  let calls = 0;
  const stub = async () => { calls += 1; return proposalResponse(); };
  const realBatch = t.DB.batch.bind(t.DB);
  let injected = false;
  t.DB.batch = async (stmts) => {
    if (!injected && stmts.some((s) => /SET state = 'delivered'/.test(s.sql || ''))) {
      injected = true;
      throw new Error('injected settlement batch failure');
    }
    return realBatch(stmts);
  };

  const failure = await handleMusePropose({
    db: t.DB,
    env: t.env,
    actor: alice(),
    body: { prompt, opKey: key, mode: 'live' },
    fetchImpl: stub,
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const row = await rowOf(t, key);
  const receipt = JSON.parse(row.receipt_json);
  const spend = await spendRow(t);

  let nextCalls = 0;
  const next = await handleMusePropose({
    db: t.DB,
    env: t.env,
    actor: alice(),
    body: { prompt: 'Next settlement admission.', opKey: 'p1-settle-next', mode: 'live' },
    fetchImpl: async () => { nextCalls += 1; return proposalResponse(); },
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const spendAfterDenial = await spendRow(t);

  assert.equal(calls, 1, 'one accepted provider call, no automatic retry');
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'DGM_MUSE_UNCERTAIN');
  assert.equal(failure.error.status, 409);
  assert.equal(row.state, 'uncertain');
  assert.equal(Number(row.unknown_outcome), 1);
  assert.equal(receipt.providerContact, 'sent');
  assert.equal(receipt.acceptance, 'accepted');
  assert.equal(receipt.billing, 'possibly-chargeable');
  assert.equal(Number(spend.reserved_micros), museWorstCaseSpendMicros(prompt), 'the reservation is retained');
  assert.equal(Number(spend.used_micros), 0, 'no usage is booked without durable delivery');
  assert.equal(next.ok, false);
  assert.equal(next.error.code, 'DGM_MUSE_UNCERTAIN');
  assert.equal(nextCalls, 0, 'the next admission is denied before any provider call');
  assert.deepEqual(spendAfterDenial, spend, 'a denied admission does not mutate the aggregate ledger');
});

test('P1 settlement: post-commit local failure returns the durable delivery, never reclassifies', async () => {
  const t = await createTestEnv(LIVE);
  const key = 'p1-settle-post';
  let calls = 0;
  const stub = async () => { calls += 1; return proposalResponse(); };
  const realBatch = t.DB.batch.bind(t.DB);
  let injected = false;
  t.DB.batch = async (stmts) => {
    if (!injected && stmts.some((s) => /SET state = 'delivered'/.test(s.sql || ''))) {
      injected = true;
      await realBatch(stmts); // the batch committed, then the caller lost the response
      throw new Error('injected post-commit settlement failure');
    }
    return realBatch(stmts);
  };

  const out = await handleMusePropose({
    db: t.DB,
    env: t.env,
    actor: alice(),
    body: { prompt: 'P1 post-commit settlement.', opKey: key, mode: 'live' },
    fetchImpl: stub,
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const row = await rowOf(t, key);
  const spend = await spendRow(t);

  assert.equal(calls, 1, 'no retry after the committed result');
  assert.equal(out.ok, true);
  assert.equal(out.value.status, 200);
  assert.equal(out.value.body.proposal, 'P1 synthetic proposal.');
  assert.equal(out.value.body.receipt.acceptance, 'accepted');
  assert.equal(out.value.body.receipt.billing, 'possibly-chargeable');
  assert.equal(row.state, 'delivered');
  assert.equal(Number(row.unknown_outcome), 0);
  assert.ok(Number(spend.used_micros) > 0, 'the committed usage is booked once');
  assert.ok(Number(spend.reserved_micros) >= Number(spend.used_micros));
});
