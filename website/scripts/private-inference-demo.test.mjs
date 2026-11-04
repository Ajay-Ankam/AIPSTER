// Fixture-labelled focused tests for the private loopback demo harness.
// Offline synthetic mode only: real worker handlers + real UI bytes + real
// Better Auth session validation, ephemeral TEST identity in an isolated
// temp DB, fake-synthetic upstream. No engine, no model calls, no network
// beyond 127.0.0.1. Run explicitly:
//   node --test website/scripts/private-inference-demo.test.mjs
// (NOT in the repo's broad globs.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHarness, runFakePlayerOnce, buildProposal, authorizeRealRun,
  executeRealRun, sanitizeArgv, waitForJobQueued, SYNTHETIC_PREFIX } from './private-inference-demo.mjs';
import { classifyResponse } from '../public/app/experiments/inference-demo/contract.mjs';

const PORT = 18731;
let h;
let S;
let keySeq = 0;
const nextKey = (tag) => `test-${tag}-${Date.now()}-${(keySeq += 1)}`;

async function jget(pathname, headers = {}) {
  const res = await fetch(`${h.baseUrl}${pathname}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
async function jpost(pathname, headers, body) {
  const res = await fetch(`${h.baseUrl}${pathname}`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
function rawRequest({ host, origin, path = '/api/health' }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host !== undefined) headers.Host = host;
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function admitAndSubmit(tag, { deadlineMs = 60000, resourceId = null } = {}) {
  const adm = await jpost('/api/inference/admissions', S, {
    resource_id: resourceId || h.world.resourceId, model_id: 'TEST-model', max_tokens: 64 });
  assert.equal(adm.status, 201, `admissions: ${adm.text.slice(0, 200)}`);
  const idempotencyKey = nextKey(tag);
  const sub = await jpost('/api/jobs', S, { contract_version: 'v1.0.0',
    admission_ref: adm.json.admission_ref, idempotency_key: idempotencyKey,
    model_id: 'TEST-model', prompt: 'Say hi.', max_tokens: 64,
    deadline_at: Date.now() + deadlineMs });
  assert.equal(sub.status, 202, `submit: ${sub.text.slice(0, 200)}`);
  assert.ok(typeof sub.json.op_id === 'string' && typeof sub.json.job_id === 'string');
  return { admission: adm.json, idempotencyKey, op: sub.json };
}

before(async () => {
  h = await createHarness({ port: PORT });
  await h.start();
  S = { Cookie: h.world.operator.cookie, 'X-Aipster-CSRF': '1' };
});
after(async () => { await h.stop(); });

test('fixture: loopback confinement (Host/Origin/bind)', async () => {
  assert.equal(h.server.address().address, '127.0.0.1');
  const ok = await rawRequest({ host: `127.0.0.1:${PORT}` });
  assert.equal(ok.status, 200);
  const badHost = await rawRequest({ host: 'evil.example' });
  assert.equal(badHost.status, 403);
  assert.match(badHost.body, /HARNESS_HOST_REJECTED/);
  const badOrigin = await rawRequest({ host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' });
  assert.equal(badOrigin.status, 403);
  assert.match(badOrigin.body, /HARNESS_ORIGIN_REJECTED/);
  const goodOrigin = await rawRequest({ host: `127.0.0.1:${PORT}`, origin: h.baseUrl });
  assert.equal(goodOrigin.status, 200);
});

test('fixture: occupied port refuses without stealing', async () => {
  const d = await createHarness({ port: PORT });
  await assert.rejects(d.start(), /refusing to steal/);
  d.sqlite.close();
});

test('fixture: served UI bytes equal candidate bytes', async () => {
  for (const f of h.uiFiles) {
    const res = await fetch(`${h.baseUrl}/app/experiments/inference-demo/${path.basename(f.path)}`);
    assert.equal(res.status, 200, f.path);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), f.sha256, f.path);
  }
  assert.ok(h.assetsHits.length > 0);
});

test('fixture: auth/session isolation (peer 404 no-leak, anonymous 401)', async () => {
  const { idempotencyKey } = await admitAndSubmit('isol');
  const P = { Cookie: h.world.peer.cookie, 'X-Aipster-CSRF': '1' };
  const cross = await jget(`/api/jobs/${idempotencyKey}`, P);
  assert.equal(cross.status, 404);
  assert.equal(cross.json.code, 'OPERATION_NOT_FOUND');
  assert.ok(!('content' in (cross.json || {})) && !cross.text.includes('admission_ref'));
  const anon = await jget(`/api/jobs/${idempotencyKey}`);
  assert.equal(anon.status, 401);
  const own = await jget(`/api/jobs/${idempotencyKey}`, { Cookie: h.world.operator.cookie });
  assert.ok([202, 409].includes(own.status), `own reconcile polls, got ${own.status}`);
});

test('fixture: TEST labelling on identity, inventory, receipt', async () => {
  const me = await jget('/api/settings', { Cookie: h.world.operator.cookie });
  assert.equal(me.status, 200);
  assert.match(me.json.displayName, /^TEST /);
  const inv = await jget('/api/inventory?limit=50', { Cookie: h.world.operator.cookie });
  assert.equal(inv.status, 200);
  assert.ok(inv.json.items.some((c) => c.id === h.world.resourceId && c.name.startsWith('TEST-')));
  const receiptPath = h.writeReceipt();
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.mode, 'fake-synthetic');
  assert.equal(receipt.ui_files.length, 4);
});

test('fixture: idempotent resubmit reconciles; conflicting reuse 409s, no redispatch', async () => {
  const adm = await jpost('/api/inference/admissions', S, {
    resource_id: h.world.resourceId, model_id: 'TEST-model', max_tokens: 64 });
  assert.equal(adm.status, 201);
  const idempotencyKey = nextKey('idem');
  const body = { contract_version: 'v1.0.0', admission_ref: adm.json.admission_ref,
    idempotency_key: idempotencyKey, model_id: 'TEST-model', prompt: 'Say hi.',
    max_tokens: 64, deadline_at: Date.now() + 60000 };
  const first = await jpost('/api/jobs', S, body);
  const second = await jpost('/api/jobs', S, body);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.json.op_id, first.json.op_id);
  assert.equal(second.json.job_id, first.json.job_id);
  const conflict = await jpost('/api/jobs', S, { ...body, prompt: 'Different.' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');
});

async function drainQueue(target, secret, maxRounds = 8) {
  // Lease order is FIFO across tests sharing one harness: complete strictly
  // earlier leftovers (synthetic, labelled) so the test's own job is next.
  for (let i = 0; i < maxRounds; i++) {
    const out = await runFakePlayerOnce(target, { heartbeatSecret: secret, completionsAllowed: 99 });
    if (!out.played) return out.reason;
  }
  throw new Error('drainQueue: queue never emptied (bounded)');
}

test('fixture: synthetic completion settles with conspicuous labels, zero metrics', async () => {
  await drainQueue(h, h.world.heartbeatSecret);
  const { idempotencyKey } = await admitAndSubmit('synth');
  const played = await runFakePlayerOnce(h, { heartbeatSecret: h.world.heartbeatSecret, completionsAllowed: 99 });
  assert.equal(played.played, true);
  const seen = await jget(`/api/jobs/${idempotencyKey}`, { Cookie: h.world.operator.cookie });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.status, 'settled');
  assert.equal(seen.json.outcome.released, true);
  assert.ok(seen.json.outcome.content.startsWith(SYNTHETIC_PREFIX), 'synthetic prefix visible');
  const second = await runFakePlayerOnce(h, { heartbeatSecret: h.world.heartbeatSecret });
  assert.equal(second.reason, 'one-dispatch-limit');
});

test('fixture: fault-injected uncertainty reconciles 503 and never resubmits', async () => {
  const { idempotencyKey, op } = await admitAndSubmit('unc');
  h.sqlite.exec(`UPDATE dispatch_operations SET uncertain_phase = 'test-fault', uncertain_detail = 'harness-injected' WHERE op_id = '${op.op_id}'`);
  const seen = await jget(`/api/jobs/${idempotencyKey}`, { Cookie: h.world.operator.cookie });
  assert.equal(seen.status, 503);
  assert.equal(seen.json.code, 'OUTCOME_UNCERTAIN');
  const ui = classifyResponse({ stage: 'poll', status: seen.status, body: seen.json });
  assert.equal(ui.state, 'uncertain');
  assert.equal(ui.resubmit, false);
  // The harness issues no further submits for this key: reconcile again, still 503, same op.
  const again = await jget(`/api/jobs/${idempotencyKey}`, { Cookie: h.world.operator.cookie });
  assert.equal(again.status, 503);
  assert.equal(again.json.op_id, op.op_id);
});

test('fixture: late completion refused and expired work never leases', async () => {
  await drainQueue(h, h.world.heartbeatSecret);
  const adm = await jpost('/api/inference/admissions', S, {
    resource_id: h.world.resourceId, model_id: 'TEST-model', max_tokens: 64 });
  assert.equal(adm.status, 201);
  const idempotencyKey = nextKey('late');
  const sub = await jpost('/api/jobs', S, { contract_version: 'v1.0.0',
    admission_ref: adm.json.admission_ref, idempotency_key: idempotencyKey,
    model_id: 'TEST-model', prompt: 'Say hi.', max_tokens: 64, deadline_at: Date.now() + 2000 });
  assert.equal(sub.status, 202);
  const leaseRes = await fetch(`${h.baseUrl}/api/worker/jobs/next`, {
    headers: { Authorization: `Bearer ${h.world.heartbeatSecret}` } });
  assert.equal(leaseRes.status, 200);
  const lease = await leaseRes.json();
  await new Promise((r) => setTimeout(r, 2500));
  const posted = await fetch(`${h.baseUrl}/api/worker/jobs/${lease.job_id}/result`, { method: 'POST',
    headers: { Authorization: `Bearer ${h.world.heartbeatSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lease_id: lease.lease_id, status: 'failed', result: { reason: 'TEST_LATE' } }) });
  assert.equal(posted.status, 409);
  assert.match(await posted.text(), /RESULT_REJECTED/);
  const again = await fetch(`${h.baseUrl}/api/worker/jobs/next`, {
    headers: { Authorization: `Bearer ${h.world.heartbeatSecret}` } });
  assert.equal(again.status, 204, 'past-deadline work never leases');
});

test('fixture: one-dispatch enforcement on a fresh run (second job never completes)', async () => {
  const g = await createHarness({ port: 18732 });
  await g.start();
  try {
    const GS = { Cookie: g.world.operator.cookie, 'X-Aipster-CSRF': '1' };
    const flow = async (tag) => {
      const adm = await (await fetch(`${g.baseUrl}/api/inference/admissions`, { method: 'POST',
        headers: { ...GS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource_id: g.world.resourceId, model_id: 'TEST-model', max_tokens: 64 }) })).json();
      const key = `test-${tag}-fresh`;
      const sub = await fetch(`${g.baseUrl}/api/jobs`, { method: 'POST',
        headers: { ...GS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_version: 'v1.0.0', admission_ref: adm.admission_ref,
          idempotency_key: key, model_id: 'TEST-model', prompt: 'Say hi.', max_tokens: 64,
          deadline_at: Date.now() + 60000 }) });
      assert.equal(sub.status, 202);
      return key;
    };
    const k1 = await flow('one-a');
    const p1 = await runFakePlayerOnce(g, { heartbeatSecret: g.world.heartbeatSecret });
    assert.equal(p1.played, true);
    const k2 = await flow('one-b');
    const p2 = await runFakePlayerOnce(g, { heartbeatSecret: g.world.heartbeatSecret });
    assert.equal(p2.played, false);
    assert.equal(p2.reason, 'one-dispatch-limit');
    const seen2 = await (await fetch(`${g.baseUrl}/api/jobs/${k2}`, {
      headers: { Cookie: g.world.operator.cookie } })).json();
    assert.ok(['dispatched', 'pending'].includes(seen2.status), `second job uncompleted, got ${seen2.status}`);
    const seen1 = await (await fetch(`${g.baseUrl}/api/jobs/${k1}`, {
      headers: { Cookie: g.world.operator.cookie } })).json();
    assert.equal(seen1.status, 'settled');
    const completions = g.ledger.filter((e) => e.event === 'player-completed');
    assert.equal(completions.length, 1);
  } finally {
    await g.stop();
  }
});

function fixturePins(tag) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), `private-demo-pins-${tag}-`));
  const enginePath = path.join(tmp, 'engine.exe');
  const ggufPath = path.join(tmp, 'model.gguf');
  writeFileSync(enginePath, `fake-engine-${tag}`);
  writeFileSync(ggufPath, Buffer.alloc(64, 7));
  const sha = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
  return { tmp, pins: {
    engine: { path: enginePath, bytes: readFileSync(enginePath).length, sha256: sha(enginePath) },
    gguf: { path: ggufPath, bytes: 64, sha256: sha(ggufPath) } } };
}
function proposalBase(pins, port = 45679) {
  return { model_id: 'TEST-model', runtime_id: 'llama-server', endpoint: `http://127.0.0.1:${port}`,
    max_tokens: 32, deadline_s: 60, prompt: 'Say the word hello.', max_lifetime_s: 300,
    engine: { path: pins.engine.path,
      argv: ['-m', pins.gguf.path, '--port', String(port), '--alias', 'TEST-model', '--n-gpu-layers', '0'] },
    gguf: { path: pins.gguf.path } };
}

test('fixture: real-mode proposal validates strictly and authorizes nothing implicitly', () => {
  const { pins } = fixturePins('matrix');
  const base = proposalBase(pins);
  const good = buildProposal(base, { candidateRevOverride: 'rev-test', pins });
  assert.equal(good.ok, true);
  assert.equal(good.file.proposal.schema, 'private-demo-real-proposal/v1');
  assert.equal(good.file.proposal.candidate_rev, 'rev-test');
  assert.equal(good.file.proposal.engine.sha256, pins.engine.sha256);
  const bads = [
    [{ ...base, extra: 1 }, /unsupported proposal field/],
    [{ ...base, runtime_id: 'cuda' }, /runtime_id/],
    [{ ...base, max_tokens: 0 }, /max_tokens must be 1\.\.32/],
    [{ ...base, max_tokens: 33 }, /max_tokens must be 1\.\.32/],
    [{ ...base, deadline_s: 0 }, /deadline_s must be 30 or 60/],
    [{ ...base, deadline_s: 45 }, /deadline_s must be 30 or 60/],
    [{ ...base, deadline_s: 61 }, /deadline_s must be 30 or 60/],
    [{ ...base, prompt: '' }, /prompt must be one simple line/],
    [{ ...base, prompt: 'two\nlines' }, /prompt must be one simple line/],
    [{ ...base, prompt: 'x'.repeat(501) }, /prompt must be one simple line/],
    [{ ...base, max_lifetime_s: 0 }, /max_lifetime_s/],
    [{ ...base, max_lifetime_s: 301 }, /max_lifetime_s/],
    [{ ...base, endpoint: 'https://127.0.0.1:45679' }, /loopback http/],
    [{ ...base, endpoint: 'http://10.0.0.9:45679' }, /loopback http/],
    [{ ...base, endpoint: 'http://user@127.0.0.1:45679' }, /loopback http/],
    [{ ...base, endpoint: 'http://127.0.0.1:45679/?x=1' }, /loopback http/],
    [{ ...base, engine: { path: pins.gguf.path, argv: base.engine.argv } }, /pinned llama-server path/],
    [{ ...base, engine: { ...base.engine, argv: [...base.engine.argv, '--ctx-size', '99'] } }, /exactly the pinned argv/],
    [{ ...base, engine: { ...base.engine, argv: base.engine.argv.filter((a) => a !== '--n-gpu-layers') } }, /exactly the pinned argv/],
    [{ ...base, engine: { ...base.engine, argv: [...base.engine.argv.slice(0, 5), 'OTHER', ...base.engine.argv.slice(6)] } }, /exactly the pinned argv/],
    [{ ...base, engine: { ...base.engine, argv: [...base.engine.argv.slice(0, 3), '9999', ...base.engine.argv.slice(4)] } }, /exactly the pinned argv/],
    [{ ...base, gguf: { path: pins.engine.path } }, /pinned GGUF path/],
  ];
  for (const [params, re] of bads) {
    const out = buildProposal(params, { candidateRevOverride: 'rev-test', pins });
    assert.equal(out.ok, false, JSON.stringify(params).slice(0, 140));
    assert.match(out.reason, re);
  }
  // Tampered bytes after pinning refuse on hash (separate fixtures).
  const t1 = fixturePins('tamper-engine');
  writeFileSync(t1.pins.engine.path, 'tampered-bytes!!');
  const tamperedEngine = buildProposal(proposalBase(t1.pins), { candidateRevOverride: 'rev-test', pins: t1.pins });
  // NOTE: pins were snapshotted before tampering, so this must refuse.
  assert.equal(tamperedEngine.ok, false);
  assert.match(tamperedEngine.reason, /does not match pinned/);
  const t2 = fixturePins('tamper-gguf');
  writeFileSync(t2.pins.gguf.path, Buffer.alloc(64, 9));
  const tamperedGguf = buildProposal(proposalBase(t2.pins), { candidateRevOverride: 'rev-test', pins: t2.pins });
  assert.equal(tamperedGguf.ok, false);
  assert.match(tamperedGguf.reason, /does not match pinned/);
  // Authorization: tamper, confirm-mismatch, candidate-mismatch, reuse all refuse.
  const authOk = authorizeRealRun(good.file, good.file.sha256, { candidateRevOverride: 'rev-test', pins, runGit: () => '' });
  assert.equal(authOk.ok, true);
  const tampered = JSON.parse(JSON.stringify(good.file));
  tampered.proposal.max_tokens = 33;
  assert.equal(authorizeRealRun(tampered, good.file.sha256, { pins }).ok, false);
  assert.match(authorizeRealRun(good.file, '0'.repeat(64), { pins }).reason, /confirmation missing/);
  assert.match(authorizeRealRun(good.file, good.file.sha256, { candidateRevOverride: 'other', pins }).reason, /exact-build/);
  assert.match(authorizeRealRun(good.file, good.file.sha256, { candidateRevOverride: 'rev-test', consumed: true, pins }).reason, /consumed/);
  assert.match(authorizeRealRun(null, 'x', {}).reason, /must be \{proposal, sha256\}/);
});

test('fixture: F2 authorizeRealRun refuses a dirty candidate tree at the same rev', () => {
  const { pins } = fixturePins('f2-dirty');
  const good = buildProposal(proposalBase(pins), { candidateRevOverride: 'rev-clean', pins });
  assert.equal(good.ok, true);
  const authz = (porcelain) => authorizeRealRun(good.file, good.file.sha256,
    { candidateRevOverride: 'rev-clean', pins, runGit: () => porcelain });
  const dirties = [
    ' M website/src/worker.js\n',
    'M  website/src/worker.js\n',
    'MM website/src/worker.js\n',
    'A  local-worker/new_module.py\n',
    ' D website/src/inference/dispatch-store.mjs\n',
    'R  website/src/old.mjs -> website/src/new.mjs\n',
    'UU website/src/worker.js\n',
    ' M website/scripts/private-inference-demo.mjs\n M local-worker/pairing.py\n',
  ];
  for (const p of dirties) {
    const out = authz(p);
    assert.equal(out.ok, false, `dirty porcelain must refuse: ${JSON.stringify(p)}`);
    assert.match(out.reason, /dirty/);
  }
});

test('fixture: F2 untracked shadowing under routed source dirs refuses; unrelated untracked passes', () => {
  const { pins } = fixturePins('f2-shadow');
  const good = buildProposal(proposalBase(pins), { candidateRevOverride: 'rev-clean', pins });
  assert.equal(good.ok, true);
  const authz = (porcelain) => authorizeRealRun(good.file, good.file.sha256,
    { candidateRevOverride: 'rev-clean', pins, runGit: () => porcelain });
  const shadows = [
    '?? local-worker/dendrite.py\n',
    '?? local-worker/vendor/eif/dendrite/extra.py\n',
    '?? website/src/backdoor.mjs\n',
    '?? website/scripts/helper.mjs\n',
    '?? website/public/app/evil.js\n',
  ];
  for (const p of shadows) {
    const out = authz(p);
    assert.equal(out.ok, false, `shadowing porcelain must refuse: ${JSON.stringify(p)}`);
    assert.match(out.reason, /shadow/);
  }
  assert.equal(authz('').ok, true, 'clean tree passes');
  assert.equal(authz('?? notes/scratch.md\n?? proposal.json\n').ok, true, 'untracked outside source dirs passes');
  assert.equal(authz('!! website/node_modules/better-auth/package.json\n').ok, true, 'ignored entries pass');
});

test('fixture: F2 real git checkout — clean passes, tracked edit and source shadow refuse', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'private-demo-f2git-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['--version']);
  } catch {
    t.skip('git unavailable');
    return;
  }
  mkdirSync(path.join(repo, 'local-worker'), { recursive: true });
  mkdirSync(path.join(repo, 'website', 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'local-worker', 'pairing.py'), '# fixture\n');
  writeFileSync(path.join(repo, 'website', 'src', 'worker.js'), '// fixture\n');
  git(['init', '-q']);
  git(['-c', 'user.email=f2@test.invalid', '-c', 'user.name=f2', 'add', '.']);
  git(['-c', 'user.email=f2@test.invalid', '-c', 'user.name=f2', 'commit', '-qm', 'fixture']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const { pins } = fixturePins('f2-gitpins');
  const good = buildProposal(proposalBase(pins), { candidateRevOverride: head, pins });
  assert.equal(good.ok, true);
  // Default git path (no runGit injection) against the fixture checkout.
  const authz = () => authorizeRealRun(good.file, good.file.sha256,
    { candidateRevOverride: head, pins, sourceRoot: repo });
  assert.equal(authz().ok, true, 'clean fixture checkout passes');
  writeFileSync(path.join(repo, 'website', 'src', 'worker.js'), '// fixture MODIFIED\n');
  const dirty = authz();
  assert.equal(dirty.ok, false, 'same-HEAD tracked edit refuses');
  assert.match(dirty.reason, /dirty/);
  writeFileSync(path.join(repo, 'website', 'src', 'worker.js'), '// fixture\n');
  assert.equal(authz().ok, true, 'restored checkout passes again');
  writeFileSync(path.join(repo, 'local-worker', 'shadow.py'), '# untracked shadow\n');
  const shadow = authz();
  assert.equal(shadow.ok, false, 'untracked source shadow refuses');
  assert.match(shadow.reason, /shadow/);
});

test('fixture: real-mode entry refuses pre-spawn without spawning or marking', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'private-demo-refuse-'));
  const markerPath = path.join(tmp, 'run.attempted');
  let spawns = 0;
  const out = await executeRealRun({ proposalFile: path.join(tmp, 'missing.json'),
    confirmSha256: '0'.repeat(64), markerPath,
    deps: { spawnChild: () => { spawns += 1; throw new Error('must not spawn'); } } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /cannot read proposal/);
  assert.equal(spawns, 0);
  assert.ok(!existsSync(markerPath));
});

test('fixture: receipt hygiene (no secrets) and clean stop frees the port', async () => {
  const c = await createHarness({ port: 18733 });
  await c.start();
  const receiptPath = await c.stop();
  const text = readFileSync(receiptPath, 'utf8');
  assert.ok(!text.includes(c.world.operator.token), 'operator token absent');
  assert.ok(!text.includes(c.world.heartbeatSecret), 'heartbeat secret absent');
  assert.ok(!text.includes(c.world.operator.cookie), 'cookie absent');
  const receipt = JSON.parse(text);
  assert.equal(receipt.mode, 'fake-synthetic');
  assert.ok(typeof receipt.candidate_rev === 'string' && receipt.candidate_rev.length >= 7);
  assert.equal(receipt.ui_files.length, 4);
  assert.ok(receipt.ledger.some((e) => e.event === 'server-up'));
  assert.ok(receipt.ledger.some((e) => e.event === 'server-down'));
  await assert.rejects(fetch(`${c.baseUrl}/api/health`), 'port freed after stop');
});

test('fixture: HOLD029 repro — single-shot player reports no-lease when nothing is queued', async () => {
  const g = await createHarness({ port: 18732 });
  try {
    await g.start();
    // No dispatch submitted: this is the exact {played:false} seen at
    // browser :145 when the lease poll wins the race against the UI's
    // admission/job POSTs (the key line is written before they complete).
    const played = await runFakePlayerOnce(g, { heartbeatSecret: g.world.heartbeatSecret });
    assert.deepEqual(played, { played: false, reason: 'no-lease' });
    const ready = await waitForJobQueued(g.DB, { timeoutMs: 300, intervalMs: 50 });
    assert.deepEqual(ready, { ready: false, job_id: null });
  } finally {
    await g.stop();
  }
});

test('fixture: HOLD029 waitForJobQueued resolves once a delayed dispatch lands', async () => {
  const g = await createHarness({ port: 18733 });
  try {
    await g.start();
    const S2 = { Cookie: g.world.operator.cookie, 'X-Aipster-CSRF': '1' };
    const post = async (pathname, body) => (await (await fetch(`${g.baseUrl}${pathname}`, { method: 'POST',
      headers: { ...S2, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());
    const submit = (async () => {
      await new Promise((r) => setTimeout(r, 250));
      const adm = await post('/api/inference/admissions',
        { resource_id: g.world.resourceId, model_id: 'TEST-model', max_tokens: 64 });
      return post('/api/jobs', { contract_version: 'v1.0.0', admission_ref: adm.admission_ref,
        idempotency_key: `test-hold029-${Date.now()}`, model_id: 'TEST-model', prompt: 'Say hi.',
        max_tokens: 64, deadline_at: Date.now() + 60000 });
    })();
    const ready = await waitForJobQueued(g.DB, { timeoutMs: 10000 });
    const sub = await submit;
    assert.equal(ready.ready, true);
    assert.equal(ready.job_id, sub.job_id);
    // And the sequenced single-shot player then completes exactly that job.
    const played = await runFakePlayerOnce(g, { heartbeatSecret: g.world.heartbeatSecret });
    assert.equal(played.played, true);
    assert.equal(played.job_id, sub.job_id);
  } finally {
    await g.stop();
  }
});
