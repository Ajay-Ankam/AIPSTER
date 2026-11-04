// Fixture-labelled focused tests for the isolated inference-demo experiment UI.
//
// Scope: pure request serialization + UI state classification + static policy
// self-checks for website/public/app/experiments/inference-demo/*, plus one
// route-conformance case driving the REAL worker.js with UI-serialized bodies.
// Everything here is offline: node:test, d1-shim (node:sqlite), and stubbed
// fetch responses. No live generation, no network, no inference execution.
// Labels "fixture" anywhere a stub stands in for a live response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encodeCpuTask } from '../src/inference/eif-task-contract.mjs';
import {
  ADMISSIONS_FIELDS, SUBMIT_FIELDS, CONTRACT_VERSION_UI, MAX_DEADLINE_MS_UI,
  serializeAdmissionsBody, serializeSubmitBody, isValidId, isValidRef,
  isValidIdempotencyKey, submitAllowed, pollDecision, classifyResponse,
} from '../public/app/experiments/inference-demo/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(HERE, '..', 'public', 'app', 'experiments', 'inference-demo');

// ---------- A. admissions serialization (mirrors worker.js:2912-2932) ----------

test('fixture: admissions serializer emits exactly the 4 server-accepted fields', () => {
  const out = serializeAdmissionsBody({ resourceId: 'r_jjp1', modelId: 'm1', maxTokens: 256 });
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.body).sort(), [...ADMISSIONS_FIELDS].sort());
  assert.deepEqual(out.body, { resource_id: 'r_jjp1', model_id: 'm1', max_tokens: 256, runtime_id: 'ganglion' });
});

test('fixture: admissions serializer rejects everything the route refuses', () => {
  const base = { resourceId: 'r_jjp1', modelId: 'm1', maxTokens: 256, runtimeId: 'llama-server' };
  assert.equal(serializeAdmissionsBody({ ...base, runtimeId: 'llama-server' }).ok, true);
  for (const bad of [
    { ...base, resourceId: '' }, { ...base, resourceId: 'has space' }, { ...base, resourceId: 'x'.repeat(65) },
    { ...base, modelId: '' }, { ...base, modelId: 'm'.repeat(257) },
    { ...base, maxTokens: 0 }, { ...base, maxTokens: 4097 }, { ...base, maxTokens: 1.5 }, { ...base, maxTokens: '256' },
    { ...base, runtimeId: 'cuda' }, { ...base, runtimeId: '' }, { ...base, runtimeId: 7 },
  ]) {
    const out = serializeAdmissionsBody(bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.match(out.error, /resource_id|model_id|max_tokens|runtime_id/);
  }
});

// ---------- B. submit serialization (mirrors dispatch-coordinator validateBody) ----------

const SUBMIT_BASE = {
  admissionRef: 'adm_abc123', idempotencyKey: 'idem-key-01', modelId: 'm1',
  prompt: 'Say hi.', maxTokens: 256, deadlineAt: Date.now() + 60000,
};

test('fixture: submit serializer emits exactly the 7 allowed fields with v1.0.0', () => {
  const out = serializeSubmitBody(SUBMIT_BASE);
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.body).sort(), [...SUBMIT_FIELDS].sort());
  assert.equal(out.body.contract_version, 'v1.0.0');
});

test('fixture: submit serializer rejects forged/unsupported fields and bad shapes', () => {
  for (const forged of ['runtime_id', 'node_id', 'placement', 'grant_id', 'principal_id',
    'tenant_id', 'temperature', 'stream', 'seed', 'model_fingerprint']) {
    const out = serializeSubmitBody({ ...SUBMIT_BASE, [forged]: 'x' });
    assert.equal(out.ok, false, forged);
  }
  for (const bad of [
    { ...SUBMIT_BASE, admissionRef: 'bad ref!' }, { ...SUBMIT_BASE, admissionRef: '' },
    { ...SUBMIT_BASE, idempotencyKey: 'short' }, { ...SUBMIT_BASE, idempotencyKey: 'has space in key' },
    { ...SUBMIT_BASE, prompt: '' }, { ...SUBMIT_BASE, prompt: '   ' }, { ...SUBMIT_BASE, prompt: 'p'.repeat(65537) },
    { ...SUBMIT_BASE, maxTokens: 0 }, { ...SUBMIT_BASE, maxTokens: 4097 },
    // Over-limit case sits well past MAX_DEADLINE_MS_UI (180000): the
    // serializer reads Date.now() itself after this array is built, so a
    // 1 ms margin (180001) flaked whenever a millisecond elapsed in between.
    { ...SUBMIT_BASE, deadlineAt: Date.now() - 1000 }, { ...SUBMIT_BASE, deadlineAt: Date.now() + 240000 },
    { ...SUBMIT_BASE, deadlineAt: 'soon' },
  ]) {
    assert.equal(serializeSubmitBody(bad).ok, false, JSON.stringify(bad).slice(0, 80));
  }
});

test('fixture: submit-accepted tuples pass the real server codec; rejected ones fail it', () => {
  const accepted = [
    ['m1', 'Hello.', 1, 'idem-key-01'],
    ['model/with:chars_ok-2', 'p'.repeat(65536), 4096, 'A1234567'],
  ];
  for (const [modelId, prompt, maxTokens, operationKey] of accepted) {
    encodeCpuTask({ modelId, prompt, maxTokens, operationKey }); // throws on mismatch
    assert.equal(serializeSubmitBody({ ...SUBMIT_BASE, modelId, prompt, maxTokens, idempotencyKey: operationKey }).ok, true);
  }
  const rejected = [
    ['', 'Hello.', 1, 'idem-key-01'], ['m1', '', 1, 'idem-key-01'],
    ['m1', 'Hello.', 0, 'idem-key-01'], ['m1', 'Hello.', 4097, 'idem-key-01'],
    ['m1', 'Hello.', 1, 'short'],
  ];
  for (const [modelId, prompt, maxTokens, operationKey] of rejected) {
    assert.throws(() => encodeCpuTask({ modelId, prompt, maxTokens, operationKey }));
    assert.equal(serializeSubmitBody({ ...SUBMIT_BASE, modelId, prompt, maxTokens, idempotencyKey: operationKey }).ok, false);
  }
});

test('fixture: UI id/key rules mirror the server regexes', () => {
  assert.equal(isValidId('r_jjp-1_2'), true);
  assert.equal(isValidId('bad id'), false);
  assert.equal(isValidRef('adm_abc123'), true);
  assert.equal(isValidRef('bad ref!'), false);
  assert.equal(isValidIdempotencyKey('idem-key-01'), true);
  assert.equal(isValidIdempotencyKey('short'), false);
  assert.equal(CONTRACT_VERSION_UI, 'v1.0.0');
  assert.equal(MAX_DEADLINE_MS_UI, 180000);
});

// ---------- C. no-duplicate-submit guard + poll bounds ----------

test('fixture: submit allowed exactly once per in-flight request', () => {
  assert.equal(submitAllowed({ inflight: false, terminal: false }), true);
  assert.equal(submitAllowed({ inflight: true, terminal: false }), false);
  assert.equal(submitAllowed({ inflight: false, terminal: true }), false);
});

test('fixture: polling continues only on dispatched/pending within bounds', () => {
  const now = Date.now();
  assert.deepEqual(pollDecision({ polls: 0, nowMs: now, deadlineAt: now + 60000, lastStatus: 'dispatched' }).cont, true);
  assert.deepEqual(pollDecision({ polls: 3, nowMs: now, deadlineAt: now + 60000, lastStatus: 'pending' }).cont, true);
  for (const lastStatus of ['settled', 'rejected', 'uncertain', 'cancelled_before_start', 'error']) {
    const d = pollDecision({ polls: 1, nowMs: now, deadlineAt: now + 60000, lastStatus });
    assert.equal(d.cont, false, lastStatus);
  }
  assert.equal(pollDecision({ polls: 60, nowMs: now, deadlineAt: now + 60000, lastStatus: 'dispatched' }).cont, false);
  assert.equal(pollDecision({ polls: 1, nowMs: now + 90000, deadlineAt: now + 60000, lastStatus: 'dispatched' }).cont, false);
});

// ---------- D. state classification: every code maps to a precise terminal UI state ----------

test('fixture: auth/flag/schema/placement failures classify distinctly', () => {
  assert.equal(classifyResponse({ stage: 'admissions', status: 401, body: { code: 'AUTH_REQUIRED' } }).state, 'auth');
  assert.equal(classifyResponse({ stage: 'submit', status: 403, body: { code: 'KEY_SCOPE' } }).state, 'auth');
  assert.equal(classifyResponse({ stage: 'submit', status: 501, body: { code: 'INFERENCE_DISABLED' } }).state, 'flag-off');
  assert.equal(classifyResponse({ stage: 'admissions', status: 503, body: { code: 'DISPATCH_UNAVAILABLE' } }).state, 'schema');
  assert.equal(classifyResponse({ stage: 'admissions', status: 409, body: { code: 'RESOURCE_STALE' } }).state, 'placement');
  assert.equal(classifyResponse({ stage: 'submit', status: 429, body: { code: 'BUDGET_EXHAUSTED' } }).state, 'budget');
  assert.equal(classifyResponse({ stage: 'submit', status: 403, body: { code: 'BINDING_MISMATCH' } }).state, 'binding');
  assert.equal(classifyResponse({ stage: 'submit', status: 403, body: { code: 'NO_MATCHING_GRANT' } }).state, 'binding');
  assert.equal(classifyResponse({ stage: 'submit', status: 400, body: { code: 'BAD_RUNTIME' } }).state, 'field');
});

test('fixture: settled-released shows content; settled-withheld shows reason and no content', () => {
  const released = classifyResponse({ stage: 'poll', status: 200, body: { status: 'settled',
    outcome: { finish: 'succeeded', released: true, content: 'hi', provenance: { simulated: false } } } });
  assert.equal(released.state, 'settled');
  assert.equal(released.content, 'hi');
  assert.match(released.provenanceNote, /worker-reported/i);
  const withheld = classifyResponse({ stage: 'poll', status: 200, body: { status: 'settled',
    outcome: { finish: 'succeeded', released: false, withheld_reason: 'authority_revoked_before_release' } } });
  assert.equal(withheld.state, 'withheld');
  assert.equal(withheld.content, null);
  assert.match(withheld.detail, /authority_revoked_before_release/);
  const failed = classifyResponse({ stage: 'poll', status: 200, body: { status: 'settled', outcome: { finish: 'failed' } } });
  assert.equal(failed.state, 'settled');
  assert.equal(failed.content, null);
});

test('fixture: uncertain/conflict/cancel/network never resubmit', () => {
  const u = classifyResponse({ stage: 'poll', status: 503, body: { status: 'uncertain', code: 'OUTCOME_UNCERTAIN' } });
  assert.equal(u.state, 'uncertain');
  assert.equal(u.resubmit, false);
  const c = classifyResponse({ stage: 'submit', status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
  assert.equal(c.state, 'conflict');
  assert.equal(c.resubmit, false);
  const k = classifyResponse({ stage: 'cancel', status: 200, body: { status: 'cancelled_before_start', code: 'CANCELLED' } });
  assert.equal(k.state, 'cancelled');
  const ku = classifyResponse({ stage: 'cancel', status: 202, body: { status: 'dispatched', cancel: 'UNSUPPORTED_CAPABILITY' } });
  assert.equal(ku.state, 'cancel-unsupported');
  const n = classifyResponse({ stage: 'submit', status: 0, body: null });
  assert.equal(n.state, 'network');
  assert.equal(n.resubmit, false);
});

// ---------- E. static public-policy self-check on the new files ----------

test('fixture: new demo files carry no private/credential patterns or active markup', () => {
  const names = ['index.html', 'app.js', 'contract.mjs', 'styles.css'];
  for (const name of names) {
    const text = readFileSync(path.join(DEMO, name), 'utf8');
    assert.ok(text.length > 0 && text.length < 1024 * 1024, name);
    assert.ok(!/127\.0\.0\.1|localhost|BEGIN (?:RSA |EC )?PRIVATE KEY|gh[pousr]_[\w]{20,}|sk-[\w]{20,}|C:\\Users/i.test(text), name);
  }
  const html = readFileSync(path.join(DEMO, 'index.html'), 'utf8');
  assert.ok(!/<form[\s>]/i.test(html), 'no form tags (static-site policy)');
  assert.ok(!/\son\w+\s*=/i.test(html), 'no inline handlers');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1].trim(), 'src="/app/experiments/inference-demo/app.js" type="module"');
  assert.equal(scripts[0][2].trim(), '');
  assert.ok(!/https?:\/\//.test(readFileSync(path.join(DEMO, 'app.js'), 'utf8')), 'same-origin fetch only');
  assert.ok(!/https?:\/\/|data:|@import|url\(/i.test(readFileSync(path.join(DEMO, 'styles.css'), 'utf8')));
});

// ---------- F. route conformance: UI-serialized bodies against the real worker ----------
// Requires the repo's pinned node_modules (better-auth), like inference-routes.
// Real L1 D1 store over the migrated shim (no injection), worker side played by
// this test with the worker's wire shapes — same pattern as inference-e2e-real-store.

test('fixture: UI-serialized admission+submit bodies complete a real-store round-trip', async () => {
  const { createTestEnv, readJson } = await import('./d1-shim.mjs');
  const t = await createTestEnv({ INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' });
  const S = (user) => ({ ...t.as(user), ...t.csrf });
  const reg = await readJson(await t.call('/api/inventory', { method: 'POST',
    headers: S(t.alice), body: { name: 'box', kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' } }));
  assert.equal(reg.status, 201, reg.text);
  const hb = await readJson(await t.call('/api/keys', { method: 'POST',
    headers: S(t.alice), body: { name: 'hb', scope: 'heartbeat', resourceId: reg.json.id } }));
  assert.equal(hb.status, 201, hb.text);
  const beat = await t.call(`/api/resources/${reg.json.id}/heartbeat`, { method: 'POST',
    headers: { Authorization: `Bearer ${hb.json.secret}` }, body: JSON.stringify({ usable: true }) });
  assert.equal(beat.status, 200, await beat.text());
  const adm = serializeAdmissionsBody({ resourceId: reg.json.id, modelId: 'demo-model', maxTokens: 64 });
  assert.equal(adm.ok, true);
  const issued = await readJson(await t.call('/api/inference/admissions', { method: 'POST', headers: S(t.alice), body: adm.body }));
  assert.equal(issued.status, 201, issued.text);
  const sub = serializeSubmitBody({ admissionRef: issued.json.admission_ref, idempotencyKey: 'demo-key-001',
    modelId: 'demo-model', prompt: 'Say hi.', maxTokens: 64, deadlineAt: Date.now() + 60000 });
  assert.equal(sub.ok, true);
  const sent = await readJson(await t.call('/api/jobs', { method: 'POST', headers: S(t.alice), body: sub.body }));
  assert.equal(sent.status, 202, sent.text);
  const seen = await readJson(await t.call('/api/jobs/demo-key-001', { headers: S(t.alice) }));
  assert.ok([202, 409].includes(seen.status), `reconcile polls, got ${seen.status}`);
});

test('fixture: UI flow surfaces the real flag-off 501 and anonymous 401', async () => {
  const { createTestEnv, readJson } = await import('./d1-shim.mjs');
  const off = await createTestEnv();
  const S = (user) => ({ ...off.as(user), ...off.csrf });
  const r = await readJson(await off.call('/api/jobs', { method: 'POST', headers: S(off.alice),
    body: { contract_version: 'v1.0.0', admission_ref: 'adm_x', idempotency_key: 'demo-key-002',
      model_id: 'm', prompt: 'hi', max_tokens: 64, deadline_at: Date.now() + 60000 } }));
  assert.equal(r.status, 501);
  assert.equal(r.json.code, 'INFERENCE_DISABLED');
  assert.equal(classifyResponse({ stage: 'submit', status: 501, body: r.json }).state, 'flag-off');
  // With the flag off the admissions route is not mounted (404 fall-through);
  // anonymous 401 applies where the route exists, i.e. flag on.
  const on = await createTestEnv({ INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' });
  const adm = serializeAdmissionsBody({ resourceId: 'r1', modelId: 'm', maxTokens: 64 });
  assert.equal(adm.ok, true);
  const anon = await readJson(await on.call('/api/inference/admissions', { method: 'POST', body: adm.body }));
  assert.equal(anon.status, 401);
  assert.equal(classifyResponse({ stage: 'admissions', status: 401, body: anon.json }).state, 'auth');
});

// ---------- G. B1: shell loader mode must match the entry payload (real HTML loading) ----------
// Browsers decide classic-vs-module from the <script> tag, not the file bytes:
// a top-level import/export entry under a classic tag throws `SyntaxError:
// Cannot use import statement outside a module` before any code runs (reproduced
// in real Chromium at d5af355, both viewports). Node ESM import and
// `node --check` cannot catch this — so this section parses the shell with the
// same parser the gate uses (parse5) and proves loader-mode × payload-syntax.

function shellScriptModes(parseFn, html) {
  const doc = parseFn(html);
  const modes = [];
  const visit = (node) => {
    if (node && node.tagName === 'script') {
      const attrs = Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));
      modes.push({ src: attrs.src ?? null, type: attrs.type ?? null,
        inline: (node.childNodes || []).some((c) => c.nodeName !== '#text' || c.value.trim() !== '') });
    }
    for (const child of (node && node.childNodes) || []) visit(child);
    if (node && node.content) visit(node.content);
  };
  visit(doc);
  return modes;
}

function entryUsesEsm(entrySrc) {
  return /^\s*import[\s{"]|^[^/\n]*\bexport\s+(default\b|const\b|function\b|class\b|\{)/m.test(entrySrc);
}

function loadingVerdict(modes, entrySrc) {
  if (modes.length !== 1 || modes[0].inline) return 'shell-invalid';
  if (!entryUsesEsm(entrySrc)) return 'classic-ok';
  return modes[0].type === 'module' ? 'module-ok' : 'classic-syntax-error';
}

test('fixture B1: demo shell declares module loading for its ESM entry', async () => {
  const { parse } = await import('parse5');
  const html = readFileSync(path.join(DEMO, 'index.html'), 'utf8');
  const entry = readFileSync(path.join(DEMO, 'app.js'), 'utf8');
  const modes = shellScriptModes(parse, html);
  assert.equal(modes.length, 1, 'exactly one shell script');
  assert.equal(modes[0].src, '/app/experiments/inference-demo/app.js');
  assert.equal(modes[0].type, 'module', 'entry is ESM: the shell must load it as a module (B1)');
  assert.equal(modes[0].inline, false);
  assert.equal(entryUsesEsm(entry), true, 'entry really is ESM (top-level import/export)');
  assert.equal(loadingVerdict(modes, entry), 'module-ok');
});

test('fixture B1: the same entry under a classic tag is proven unloadable', async () => {
  const { parse } = await import('parse5');
  const html = readFileSync(path.join(DEMO, 'index.html'), 'utf8');
  const entry = readFileSync(path.join(DEMO, 'app.js'), 'utf8');
  assert.ok(html.includes('type="module"'), 'precondition: fixed shell carries the attribute');
  const classicVariant = html.replace(' type="module"', '');
  assert.notEqual(classicVariant, html);
  const modes = shellScriptModes(parse, classicVariant);
  assert.equal(modes.length, 1);
  assert.equal(modes[0].type, null);
  assert.equal(loadingVerdict(modes, entry), 'classic-syntax-error',
    'this is the d5af355 failure mode: ESM entry + classic tag ⇒ browser SyntaxError before init');
});
