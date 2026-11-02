/* Built with Meta Muse. */
// DGM Muse provider tests: bounded adapter contract, explicit fixture/live
// modes, read/write permission split, idempotency, uncertain quarantine,
// cancellation, denial matrix, redaction and bounds. All provider I/O is
// stubbed except the finite qualification smoke (documented separately);
// no test transmits a real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestEnv, readJson, sessionCookieHeader, TEST_SECRET } from './d1-shim.mjs';
import {
  DGM_MUSE_MODEL, DGM_MUSE_RESPONSES_URL, DGM_MUSE_PROMPT_MAX_BYTES,
  DGM_MUSE_OUTPUT_MAX_TOKENS, DGM_MUSE_RESPONSE_MAX, DGM_MUSE_DEADLINE_MS,
  museLiveEnabled, museProviderStatus, buildProposeRequest,
  proposeLive, runFixtureProposal, redactMuseText,
} from '../src/dgm/muse-provider.mjs';
import { handleMusePropose, DGM_MUSE_WRITE_PERMISSION } from '../src/dgm/muse-router.mjs';

const FLAG = { DGM_PREVIEW_ENABLED: '1' };
const LIVE = { DGM_PREVIEW_ENABLED: '1', DGM_MUSE_LIVE: '1', DGM_MUSE_API_KEY: 'stub-key' };
const BASE = '/api/admin/v1/dgm/preview/muse';
let grantSeq = 0;

async function grant(t, userId, role) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(`g_muse${++grantSeq}`, userId, role, 'platform', null, now, 'operator', null).run();
}

function wireProposal(text, over = {}) {
  return {
    id: 'resp_muse_1', model: DGM_MUSE_MODEL,
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 120, output_tokens: 40 },
    ...over,
  };
}

const okFetch = (seen) => async (url, init) => {
  if (seen) seen.push({ url, init });
  return new Response(JSON.stringify(wireProposal('Synthetic proposal text.')), { status: 200 });
};

// ---------- provider: request shape ----------

test('muse provider: request pins exact model, endpoint, bounds, no tools', async () => {
  const seen = [];
  await proposeLive({ fetchImpl: okFetch(seen), apiKey: 'k', prompt: 'Draft a boundary test.' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.meta.ai/v1/responses');
  assert.equal(seen[0].url, DGM_MUSE_RESPONSES_URL);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'muse-spark-1.3-contributor');
  assert.equal(body.model, DGM_MUSE_MODEL);
  assert.equal(body.max_output_tokens, 512);
  assert.equal(body.max_output_tokens, DGM_MUSE_OUTPUT_MAX_TOKENS);
  assert.deepEqual(body.reasoning, { effort: 'minimal' }, 'shortest documented reasoning pass keeps output budget for the proposal');
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.ok(!('tools' in body), 'no tool surface on a qualification call');
  assert.ok(!('tool_choice' in body));
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer k');
  assert.ok(seen[0].init.signal, 'abort signal bound');
});

test('muse provider: live gate needs flag plus bound key', () => {
  assert.equal(museLiveEnabled({}), false);
  assert.equal(museLiveEnabled({ DGM_MUSE_LIVE: '1' }), false);
  assert.equal(museLiveEnabled({ DGM_MUSE_API_KEY: 'k' }), false);
  assert.equal(museLiveEnabled({ DGM_MUSE_LIVE: 'yes', DGM_MUSE_API_KEY: 'k' }), false);
  assert.equal(museLiveEnabled({ DGM_MUSE_LIVE: '1', DGM_MUSE_API_KEY: 'k' }), true);
});

test('muse provider: status reports configured/not-configured without key material', () => {
  const off = museProviderStatus({});
  assert.equal(off.configured, false);
  assert.equal(off.evaluation, 'fixture');
  assert.equal(off.model, DGM_MUSE_MODEL);
  assert.deepEqual(off.endpoint, { host: 'api.meta.ai', path: '/v1/responses' });
  const on = museProviderStatus({ DGM_MUSE_LIVE: '1', DGM_MUSE_API_KEY: 'k' });
  assert.equal(on.configured, true);
  assert.equal(on.evaluation, 'synthetic-live');
  assert.ok(!JSON.stringify(on).includes('stub-key'));
});

// ---------- provider: failure taxonomy ----------

const baseArgs = () => ({ apiKey: 'k', prompt: 'Draft a boundary test.' });

test('muse provider: missing key fails closed before fetch', async () => {
  let calls = 0;
  await assert.rejects(
    proposeLive({ fetchImpl: async () => { calls += 1; }, prompt: 'x' }),
    (e) => e.code === 'DGM_MUSE_NOT_CONFIGURED' && e.status === 503);
  assert.equal(calls, 0);
});

test('muse provider: wrong model is rejected, never delivered', async () => {
  await assert.rejects(
    proposeLive({ ...baseArgs(), fetchImpl: async () => new Response(JSON.stringify(wireProposal('t', { model: 'muse-spark-1.3' })), { status: 200 }) }),
    (e) => e.code === 'DGM_MUSE_WRONG_MODEL');
});

test('muse provider: malformed outputs never partially deliver', async () => {
  const bad = [
    'not json',
    JSON.stringify(null),
    JSON.stringify({ id: 'x', model: DGM_MUSE_MODEL, output: [], usage: {} }),
    JSON.stringify({ id: 'x', model: DGM_MUSE_MODEL, output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }], usage: {} }),
    JSON.stringify({ id: 'x', model: DGM_MUSE_MODEL, output: [{ type: 'refusal', refusal: 'no' }], usage: {} }),
  ];
  for (const body of bad) {
    await assert.rejects(
      proposeLive({ ...baseArgs(), fetchImpl: async () => new Response(body, { status: 200 }) }),
      (e) => e.code === 'DGM_MUSE_MALFORMED', body.slice(0, 40));
  }
});

test('muse provider: truncated responses are refused', async () => {
  const trunc = JSON.stringify({ id: 'x', model: DGM_MUSE_MODEL, status: 'incomplete', output: [], usage: {} });
  await assert.rejects(
    proposeLive({ ...baseArgs(), fetchImpl: async () => new Response(trunc, { status: 200 }) }),
    (e) => e.code === 'DGM_MUSE_TRUNCATED');
});

test('muse provider: known-truncated keeps safe metadata; unknown outcomes carry none', async () => {
  const wire = {
    id: 'resp_trunc_1', model: DGM_MUSE_MODEL, status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' }, output: [],
    usage: { input_tokens: 90, output_tokens: 512 },
  };
  await assert.rejects(
    proposeLive({ ...baseArgs(), fetchImpl: async () => new Response(JSON.stringify(wire), { status: 200 }) }),
    (e) => {
      assert.equal(e.code, 'DGM_MUSE_TRUNCATED');
      assert.deepEqual(Object.keys(e.detail).sort(), ['incompleteReason', 'model', 'responseId', 'status', 'usage']);
      assert.equal(e.detail.status, 'incomplete');
      assert.equal(e.detail.incompleteReason, 'max_output_tokens');
      assert.equal(e.detail.model, DGM_MUSE_MODEL);
      assert.equal(e.detail.responseId, 'resp_trunc_1');
      assert.deepEqual(e.detail.usage, { input_tokens: 90, output_tokens: 512 });
      assert.ok(!JSON.stringify(e.detail).includes('SECRET'), 'no key material in retained metadata');
      return true;
    });
  await assert.rejects(
    proposeLive({ ...baseArgs(), fetchImpl: async () => { throw Object.assign(new Error('lost'), { name: 'TimeoutError' }); } }),
    (e) => e.code === 'DGM_MUSE_TIMEOUT' && e.detail === undefined);
});

test('muse provider: oversize responses are cut off, never delivered', async () => {
  const huge = JSON.stringify(wireProposal('p'.repeat(DGM_MUSE_RESPONSE_MAX + 1)));
  await assert.rejects(
    proposeLive({ ...baseArgs(), fetchImpl: async () => new Response(huge, { status: 200 }) }),
    (e) => e.code === 'DGM_MUSE_RESPONSE_TOO_LARGE');
});

test('muse provider: oversize prompts fail before fetch', async () => {
  let calls = 0;
  await assert.rejects(
    proposeLive({ apiKey: 'k', prompt: 'p'.repeat(DGM_MUSE_PROMPT_MAX_BYTES + 1), fetchImpl: async () => { calls += 1; } }),
    (e) => e.code === 'DGM_MUSE_BAD_PROMPT');
  assert.equal(calls, 0);
});

test('muse provider: prompt bound counts UTF-8 bytes without node Buffer', async () => {
  const { readFileSync } = await import('node:fs');
  const url = new URL('../src/dgm/', import.meta.url);
  for (const f of ['muse-provider.mjs', 'muse-router.mjs']) {
    const src = readFileSync(new URL(f, url), 'utf8');
    assert.ok(!/\bBuffer\./.test(src), `${f} must not depend on node Buffer (Worker nodejs_als only)`);
  }
  // 'é' is 2 UTF-8 bytes: 5000 chars exceed the 8 KiB byte bound.
  let calls = 0;
  await assert.rejects(
    proposeLive({ apiKey: 'k', prompt: 'é'.repeat(5000), fetchImpl: async () => { calls += 1; } }),
    (e) => e.code === 'DGM_MUSE_BAD_PROMPT');
  assert.equal(calls, 0);
});

test('muse provider: timeout and unreachable map sanitized', async () => {
  await assert.rejects(
    proposeLive({ ...baseArgs(), fetchImpl: async (_u, i) => { await new Promise((_r, j) => i.signal.addEventListener('abort', () => j(Object.assign(new Error('x'), { name: 'TimeoutError' })))); } }),
    (e) => e.code === 'DGM_MUSE_TIMEOUT' && e.status === 504);
  await assert.rejects(
    proposeLive({ ...baseArgs(), fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    (e) => e.code === 'DGM_MUSE_UNREACHABLE' && e.status === 502);
});

test('muse provider: 401/403/400/429/5xx map sanitized without leaks', async () => {
  for (const [status, code] of [[401, 'DGM_MUSE_AUTH'], [403, 'DGM_MUSE_AUTH'], [400, 'DGM_MUSE_REJECTED'], [429, 'DGM_MUSE_RATE_LIMITED'], [500, 'DGM_MUSE_UPSTREAM']]) {
    await assert.rejects(
      proposeLive({ ...baseArgs(), fetchImpl: async () => new Response(JSON.stringify({ error: 'secret-detail' }), { status }) }),
      (e) => {
        assert.equal(e.code, code, String(status));
        assert.ok(!String(e.message).includes('secret-detail'));
        return true;
      });
  }
});

test('muse provider: happy path extracts proposal, usage, identity; never echoes key', async () => {
  const seen = [];
  const out = await proposeLive({ fetchImpl: okFetch(seen), apiKey: 'SECRET-KEY', prompt: 'Draft a boundary test.' });
  assert.equal(out.proposal, 'Synthetic proposal text.');
  assert.deepEqual(out.usage, { input_tokens: 120, output_tokens: 40 });
  assert.equal(out.responseId, 'resp_muse_1');
  assert.equal(out.model, DGM_MUSE_MODEL);
  assert.ok(!JSON.stringify(out).includes('SECRET-KEY'));
});

test('muse provider: unusable usage parses to null, not zeros', async () => {
  const out = await proposeLive({
    ...baseArgs(),
    fetchImpl: async () => new Response(JSON.stringify(wireProposal('t', { usage: { input_tokens: -1 } })), { status: 200 }),
  });
  assert.equal(out.usage, null);
});

test('muse provider: redaction scrubs bearer and email, passes counts through', () => {
  assert.equal(redactMuseText('use Bearer abcDEF-123_~/+= and me@example.com ok'), 'use [redacted] and [redacted] ok');
  assert.equal(redactMuseText('7 tokens'), '7 tokens');
});

test('muse provider: fixture proposal is deterministic and labelled', () => {
  const a = runFixtureProposal('Draft a boundary test.');
  const b = runFixtureProposal('Draft a boundary test.');
  assert.equal(a, b);
  assert.match(a, /Fixture DGM test proposal/);
});

// ---------- propose core: explicit modes, idempotency, quarantine ----------

const alice = () => ({ user: { id: 'u_alice' } });

test('muse propose: default mode is labelled fixture, no fetch', async () => {
  const t = await createTestEnv(FLAG);
  let calls = 0;
  const out = await handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Draft a boundary test.', opKey: 'm1' }, fetchImpl: async () => { calls += 1; } });
  assert.equal(out.status, 200);
  assert.match(out.body.proposal, /Fixture DGM test proposal/);
  assert.equal(out.body.receipt.mode, 'fixture');
  assert.equal(out.body.receipt.evaluation, 'fixture');
  assert.equal(out.body.receipt.model, 'fixture');
  assert.equal(calls, 0);
});

test('muse propose: requested live without config is unavailable, never fixture', async () => {
  const t = await createTestEnv(FLAG);
  let calls = 0;
  await assert.rejects(
    handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Real test please.', opKey: 'm2', mode: 'live' }, fetchImpl: async () => { calls += 1; } }),
    (e) => e.code === 'DGM_MUSE_UNAVAILABLE' && e.status === 503);
  assert.equal(calls, 0);
  const row = await t.DB.prepare('SELECT * FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?').bind('u_alice', 'm2').first();
  assert.equal(row, null);
});

test('muse propose: explicit fixture mode stays fixture even when live is configured', async () => {
  const t = await createTestEnv(LIVE);
  let calls = 0;
  const out = await handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Dry run.', opKey: 'm3', mode: 'fixture' }, fetchImpl: async () => { calls += 1; } });
  assert.equal(out.body.receipt.evaluation, 'fixture');
  assert.equal(calls, 0);
});

test('muse propose: live happy path is one bounded call with pinned identity', async () => {
  const t = await createTestEnv(LIVE);
  let calls = 0;
  const out = await handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Draft a boundary test.', opKey: 'm4', mode: 'live' }, fetchImpl: async (...a) => { calls += 1; return okFetch()(...a); } });
  assert.equal(out.status, 200);
  assert.equal(out.body.proposal, 'Synthetic proposal text.');
  assert.equal(out.body.receipt.mode, 'live');
  assert.equal(out.body.receipt.evaluation, 'synthetic-live');
  assert.equal(out.body.receipt.model, DGM_MUSE_MODEL);
  assert.equal(out.body.receipt.responseId, 'resp_muse_1');
  assert.deepEqual(out.body.receipt.usage, { input_tokens: 120, output_tokens: 40 });
  assert.equal(calls, 1);
});

test('muse propose: same key and digest replays without a new call', async () => {
  const t = await createTestEnv(LIVE);
  let calls = 0;
  const stub = async (...a) => { calls += 1; return okFetch()(...a); };
  const first = await handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Repeat me.', opKey: 'm5', mode: 'live' }, fetchImpl: stub });
  const replay = await handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Repeat me.', opKey: 'm5', mode: 'live' }, fetchImpl: stub });
  assert.equal(calls, 1);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.proposal, null);
  assert.match(replay.body.note || '', /receipt only/);
  assert.equal(first.body.receipt.opKey, 'm5');
});

test('muse propose: same key across modes is a changed replay', async () => {
  const t = await createTestEnv(LIVE);
  await handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Same prompt.', opKey: 'm6', mode: 'fixture' }, fetchImpl: okFetch() });
  await assert.rejects(
    handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Same prompt.', opKey: 'm6', mode: 'live' }, fetchImpl: okFetch() }),
    (e) => e.code === 'CHANGED_REPLAY');
});

test('muse propose: uncertain quarantines evidence, forbids blind re-drive', async () => {
  const t = await createTestEnv(LIVE);
  let calls = 0;
  const timeout = async () => { calls += 1; throw Object.assign(new Error('lost'), { name: 'TimeoutError' }); };
  await assert.rejects(
    handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Uncertain.', opKey: 'm7', mode: 'live' }, fetchImpl: timeout }),
    (e) => e.code === 'DGM_MUSE_TIMEOUT');
  assert.equal(calls, 1);
  const before = calls;
  await assert.rejects(
    handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Uncertain.', opKey: 'm7', mode: 'live' }, fetchImpl: timeout }),
    (e) => {
      assert.equal(e.code, 'DGM_MUSE_UNCERTAIN');
      assert.match(e.message, /quarantined/i);
      assert.match(e.message, /does not reconcile/);
      return true;
    });
  assert.equal(calls, before, 'no new provider call on quarantined replay');
  const row = await t.DB.prepare('SELECT state, receipt_json FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?').bind('u_alice', 'm7').first();
  assert.equal(row.state, 'uncertain');
  assert.match(row.receipt_json, /DGM_MUSE_TIMEOUT/);
});

// ---------- worker routes: denial matrix, split authority, budgets ----------

const MUSE_ROUTES = [
  ['GET', `${BASE}/status`],
  ['POST', `${BASE}/proposals`],
  ['GET', `${BASE}/ops/op_m9`],
  ['POST', `${BASE}/ops/op_m9/cancel`],
  ['POST', `${BASE}/ops/op_m9/promote`],
  ['POST', `${BASE}/ops/op_m9/execute`],
  ['GET', `${BASE}/nope`],
];

async function seedDemo(t) {
  const now = new Date().toISOString();
  const token = randomBytes(32).toString('hex');
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Synthetic Demo', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const future = new Date(Date.now() + 12 * 3600e3).toISOString();
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('s_demo01', future, token, now, now, null, 'test', 'u_demo').run();
  return { id: 'u_demo', token };
}

async function budgetRows(t, uid) {
  return Number(await t.DB.prepare('SELECT COUNT(*) AS n FROM write_budget WHERE user_id = ?').bind(uid).first('n'));
}

async function opRows(t, uid) {
  return Number(await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_muse_ops WHERE tenant_id = ?').bind(uid).first('n'));
}

test('muse routes: flag off keeps the slice dark without leaking existence', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'engineering_reviewer');
  const authed = await readJson(await t.call(`${BASE}/status`, { headers: t.as(t.alice) }));
  assert.equal(authed.status, 404);
  assert.equal(authed.json.code, 'NOT_FOUND');
});

test('muse routes: anonymous callers get 401 everywhere', async () => {
  const t = await createTestEnv(FLAG);
  for (const [method, path] of MUSE_ROUTES) {
    const out = await readJson(await t.call(path, { method, ...(method === 'POST' ? { body: { prompt: 'x' } } : {}) }));
    assert.equal(out.status, 401, `${method} ${path}`);
    assert.equal(out.json.code, 'AUTH_REQUIRED');
  }
});

test('muse routes: grantless and wrong-role sessions get uniform 403', async () => {
  const t = await createTestEnv(FLAG);
  for (const [method, path] of MUSE_ROUTES) {
    const out = await readJson(await t.call(path, { method, headers: { ...t.as(t.alice), ...t.csrf }, ...(method === 'POST' ? { body: { prompt: 'x' } } : {}) }));
    assert.equal(out.status, 403, `${method} ${path}`);
    assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
  }
  await grant(t, 'u_alice', 'access_administrator');
  for (const [method, path] of MUSE_ROUTES) {
    const out = await readJson(await t.call(path, { method, headers: { ...t.as(t.alice), ...t.csrf }, ...(method === 'POST' ? { body: { prompt: 'x' } } : {}) }));
    assert.equal(out.status, 403, `${method} ${path}`);
    assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
  }
});

test('muse routes: read-only observer is denied billable mutation even when live is configured', async () => {
  const t = await createTestEnv(LIVE);
  await grant(t, 'u_alice', 'operations_observer');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  try {
    const budgetBefore = await budgetRows(t, 'u_alice');
    const propose = await readJson(await t.call(`${BASE}/proposals`, {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'Real test.', opKey: 'obs1', mode: 'live' },
    }));
    assert.equal(propose.status, 403);
    assert.equal(propose.json.code, 'ADMIN_FORBIDDEN');
    const cancel = await readJson(await t.call(`${BASE}/ops/obs1/cancel`, {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {},
    }));
    assert.equal(cancel.status, 403);
    assert.equal(cancel.json.code, 'ADMIN_FORBIDDEN');
    assert.equal(calls, 0, 'observer denial makes no provider call');
    assert.equal(await opRows(t, 'u_alice'), 0, 'observer denial writes no op row');
    assert.equal(await budgetRows(t, 'u_alice'), budgetBefore, 'observer denial charges no budget');
    const status = await readJson(await t.call(`${BASE}/status`, { headers: t.as(t.alice) }));
    assert.equal(status.status, 200, 'observer keeps read access');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('muse routes: demo sessions never administer the slice', async () => {
  const t = await createTestEnv(LIVE);
  const demo = await seedDemo(t);
  const out = await readJson(await t.call(`${BASE}/proposals`, {
    method: 'POST', headers: { Cookie: sessionCookieHeader(demo.token, TEST_SECRET), ...t.csrf }, body: { prompt: 'x', mode: 'live' },
  }));
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
});

test('muse routes: mutations require CSRF', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const out = await readJson(await t.call(`${BASE}/proposals`, {
    method: 'POST', headers: t.as(t.alice), body: { prompt: 'x' },
  }));
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'CSRF_REQUIRED');
});

test('muse routes: status names model, bounds, split authority, never the key', async () => {
  const t = await createTestEnv(LIVE);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const out = await readJson(await t.call(`${BASE}/status`, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema, 'aipster.dgm.muse/v1');
  assert.equal(out.json.provider.model, 'muse-spark-1.3-contributor');
  assert.equal(out.json.provider.configured, true);
  assert.equal(out.json.evaluation, 'synthetic-live');
  assert.equal(out.json.authorization.read, 'admin.dgm.preview');
  assert.equal(out.json.authorization.write, DGM_MUSE_WRITE_PERMISSION);
  assert.deepEqual(out.json.modes, ['fixture', 'live']);
  assert.ok(!JSON.stringify(out.json).includes('stub-key'));
  const off = await createTestEnv(FLAG);
  await grant(off, 'u_alice', 'engineering_reviewer');
  const offStatus = await readJson(await off.call(`${BASE}/status`, { headers: off.as(off.alice) }));
  assert.equal(offStatus.json.provider.configured, false);
  assert.equal(offStatus.json.evaluation, 'fixture');
});

test('muse routes: fixture proposal charges one budget and stores one op', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const budgetBefore = await budgetRows(t, 'u_alice');
  const out = await readJson(await t.call(`${BASE}/proposals`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'Draft a boundary test.', opKey: 'r1' },
  }));
  assert.equal(out.status, 200);
  assert.match(out.json.proposal, /Fixture DGM test proposal/);
  assert.equal(out.json.receipt.evaluation, 'fixture');
  assert.equal(await opRows(t, 'u_alice'), 1);
  assert.ok((await budgetRows(t, 'u_alice')) > budgetBefore, 'write budget charged once');
});

test('muse routes: oversize prompt is refused before budget or store', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const budgetBefore = await budgetRows(t, 'u_alice');
  const out = await readJson(await t.call(`${BASE}/proposals`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'p'.repeat(9000), opKey: 'r2' },
  }));
  assert.equal(out.status, 400);
  assert.equal(await opRows(t, 'u_alice'), 0);
  assert.equal(await budgetRows(t, 'u_alice'), budgetBefore);
});

test('muse routes: live requested while unconfigured is unavailable, not fixture', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const out = await readJson(await t.call(`${BASE}/proposals`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'Real test.', opKey: 'r3', mode: 'live' },
  }));
  assert.equal(out.status, 503);
  assert.equal(out.json.code, 'DGM_MUSE_UNAVAILABLE');
  assert.equal(await opRows(t, 'u_alice'), 0);
});

test('muse routes: full-stack live proposal is exactly one official call', async () => {
  const t = await createTestEnv(LIVE);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(wireProposal('Live via full stack.')), { status: 200 });
  };
  try {
    const out = await readJson(await t.call(`${BASE}/proposals`, {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'Draft a boundary test.', opKey: 'r4', mode: 'live' },
    }));
    assert.equal(out.status, 200);
    assert.equal(out.json.proposal, 'Live via full stack.');
    assert.equal(out.json.receipt.evaluation, 'synthetic-live');
    assert.equal(out.json.receipt.model, 'muse-spark-1.3-contributor');
    assert.equal(calls.length, 1, 'exactly one accepted provider call');
    assert.equal(calls[0].url, 'https://api.meta.ai/v1/responses');
    assert.ok(!JSON.stringify(out.json).includes('stub-key'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('muse propose: cancel during provider flight keeps cancellation, discards response', async () => {
  const t = await createTestEnv(LIVE);
  let calls = 0;
  const racing = async () => {
    calls += 1;
    const now = new Date().toISOString();
    await t.DB.prepare("UPDATE dgm_muse_ops SET state = 'cancelled', receipt_json = ?, updated_at = ? WHERE tenant_id = ? AND op_key = ?")
      .bind(JSON.stringify({ opKey: 'm8', mode: 'live', evaluation: 'synthetic-live', error: 'DGM_MUSE_CANCELLED', status: 200, at: now }), now, 'u_alice', 'm8').run();
    return new Response(JSON.stringify(wireProposal('Too late.')), { status: 200 });
  };
  const out = await handleMusePropose({ db: t.DB, env: t.env, actor: alice(), body: { prompt: 'Race.', opKey: 'm8', mode: 'live' }, fetchImpl: racing });
  assert.equal(calls, 1, 'the already-sent call counts as accepted');
  assert.equal(out.status, 409);
  assert.equal(out.body.proposal, null, 'cancelled response is discarded, never delivered');
  const row = await t.DB.prepare('SELECT state FROM dgm_muse_ops WHERE tenant_id = ? AND op_key = ?').bind('u_alice', 'm8').first();
  assert.equal(row.state, 'cancelled', 'operator cancellation is never overwritten as delivered');
});

test('muse routes: uncertain quarantines new keys until operator cancel closes it', async () => {
  const t = await createTestEnv(LIVE);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const realFetch = globalThis.fetch;
  let mode = 'timeout';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (mode === 'timeout') throw Object.assign(new Error('lost'), { name: 'TimeoutError' });
    return new Response(JSON.stringify(wireProposal('After reconcile.')), { status: 200 });
  };
  const post = (opKey) => t.call(`${BASE}/proposals`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'Quarantine test.', opKey, mode: 'live' },
  }).then(readJson);
  try {
    const fail = await post('q1');
    assert.equal(fail.status, 504);
    assert.equal(fail.json.code, 'DGM_MUSE_TIMEOUT');
    assert.equal(calls, 1);
    const blocked = await post('q2');
    assert.equal(blocked.status, 409, 'a new key does not bypass quarantine');
    assert.equal(blocked.json.code, 'DGM_MUSE_UNCERTAIN');
    assert.match(blocked.json.error, /q1/);
    assert.equal(calls, 1, 'quarantine sends no duplicate provider call');
    const sameKey = await post('q1');
    assert.equal(sameKey.status, 409);
    assert.equal(sameKey.json.code, 'DGM_MUSE_UNCERTAIN');
    assert.equal(calls, 1);
    const cancelled = await readJson(await t.call(`${BASE}/ops/q1/cancel`, {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {},
    }));
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.state, 'cancelled');
    mode = 'ok';
    const retry = await post('q2');
    assert.equal(retry.status, 200, 'explicit operator reconciliation unblocks a new attempt');
    assert.equal(retry.json.receipt.evaluation, 'synthetic-live');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('muse routes: ops readback is tenant-isolated', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  await grant(t, 'u_bob', 'engineering_reviewer');
  await readJson(await t.call(`${BASE}/proposals`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'Alice test.', opKey: 'r5' },
  }));
  const mine = await readJson(await t.call(`${BASE}/ops/r5`, { headers: t.as(t.alice) }));
  assert.equal(mine.status, 200);
  assert.equal(mine.json.opKey, 'r5');
  const foreign = await readJson(await t.call(`${BASE}/ops/r5`, { headers: t.as(t.bob) }));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.code, 'DGM_MUSE_UNKNOWN_OP');
});

test('muse routes: cancel closes an in-flight op, then refuses as settled', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO dgm_muse_ops (tenant_id, op_key, input_digest, state, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('u_alice', 'r6', 'digest-inflight', 'fetching', null, now, now).run();
  const cancelled = await readJson(await t.call(`${BASE}/ops/r6/cancel`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {},
  }));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.state, 'cancelled');
  const again = await readJson(await t.call(`${BASE}/ops/r6/cancel`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {},
  }));
  assert.equal(again.status, 409);
  const missing = await readJson(await t.call(`${BASE}/ops/nope/cancel`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {},
  }));
  assert.equal(missing.status, 404);
});

test('muse routes: promote and execute stay refused before any lookup', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const budgetBefore = await budgetRows(t, 'u_alice');
  for (const action of ['promote', 'execute']) {
    const out = await readJson(await t.call(`${BASE}/ops/r_unknown/${action}`, {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {},
    }));
    assert.equal(out.status, 501, action);
    assert.equal(out.json.code, 'ADMIN_NOT_IMPLEMENTED');
  }
  assert.equal(await opRows(t, 'u_alice'), 0, 'disabled actions write nothing');
  assert.equal(await budgetRows(t, 'u_alice'), budgetBefore, 'disabled actions charge nothing');
});

test('muse routes: unmigrated store fails closed with explicit code', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  t.sqlite.exec('DROP TABLE dgm_muse_ops');
  const propose = await readJson(await t.call(`${BASE}/proposals`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { prompt: 'x', opKey: 'r7' },
  }));
  assert.equal(propose.status, 503);
  assert.equal(propose.json.code, 'DGM_MUSE_UNAVAILABLE');
  const read = await readJson(await t.call(`${BASE}/ops/r7`, { headers: t.as(t.alice) }));
  assert.equal(read.status, 503);
  assert.equal(read.json.code, 'DGM_MUSE_UNAVAILABLE');
});

test('muse routes: unknown muse paths answer 404 to authorized readers', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'engineering_reviewer');
  const out = await readJson(await t.call(`${BASE}/nope`, { headers: t.as(t.alice) }));
  assert.equal(out.status, 404);
  assert.equal(out.json.code, 'NOT_FOUND');
});
