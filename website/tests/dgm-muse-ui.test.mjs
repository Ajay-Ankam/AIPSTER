/* Built with Meta Muse. */
// DGM Muse admin UI tests: the panel is a shell around server authority. It
// renders the server's readiness honestly, offers one explicit generation per
// click, never generates on load, never resubmits an uncertain outcome under a
// new key, escapes proposal/receipt text, and attaches only the delivered
// operation whose result is on screen. All responses are local fixtures; no
// network, provider or secret is involved.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';

const source = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');

const MUSE = '/api/admin/v1/dgm/preview/muse';
const RUNS = '/api/admin/v1/dgm/preview/runs';

function makeEl(tag, id) {
  const children = [];
  return {
    tag, id: id || null, children,
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    listeners: {}, attrs: {},
    addEventListener(k, v) { this.listeners[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    get firstChild() { return children.length ? children[0] : null; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
    appendChild(c) { children.push(c); return c; },
    click() { if (this.listeners.click) return this.listeners.click(); }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(routes) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const calls = [];
  const fetcher = async (path, init) => {
    calls.push({ path: String(path), init: init || {} });
    const route = routes[String(path)];
    if (route) {
      const out = await route({ path: String(path), init: init || {}, index: calls.length });
      if (out instanceof Error) throw out;
      if (out && typeof out.then === 'function') return out;
      return out;
    }
    return Response.json({ error: 'No route', code: 'UNKNOWN' }, { status: 404 });
  };
  // Mirror the shell's initial text so the panel's own placeholder handling is
  // exercised, not an empty harness default.
  el('dgm-muse-state').textContent = 'Not loaded.';
  el('dgm-muse-gen-state').textContent = 'Load Muse status first.';
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll() { return []; },
      createElement(tag) { return makeEl(tag, null); }
    },
    fetch: fetcher,
    encodeURIComponent: globalThis.encodeURIComponent,
    Uint8Array,
    crypto: globalThis.crypto,
    console,
    location: { origin: 'https://admin.local' }
  });
  vm.runInContext(source, context);
  el('dgm-muse-reconcile').hidden = true;
  return { el, context, calls };
}

async function settled(pred, what) {
  for (let i = 0; i < 800; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('never settled: ' + what);
}

const grant = () => Response.json({ grant: { role: 'engineering_reviewer', scope: 'platform' }, elevation: 'none', mutations: 'allowed' });

function statusBody(over = {}) {
  return {
    schema: 'aipster.dgm.muse/v1',
    evaluation: 'fixture',
    provider: {
      schema: 'aipster.dgm.muse/v1',
      model: 'muse-spark-1.3-contributor',
      configured: false,
      evaluation: 'fixture',
      endpoint: { host: 'api.meta.ai', path: '/v1/responses' },
      bounds: { promptMaxBytes: 8192, outputMaxTokens: 512, responseMaxBytes: 65536, deadlineMs: 60000 }
    },
    authorization: { read: 'admin.dgm.preview', write: 'admin.engineering.assign', reconcile: 'admin.engineering.assign' },
    modes: ['fixture', 'live'],
    spendCapUsd: 0,
    spend: { scope: 'global', window: 'all-time', capUsd: 0, status: 'uninitialised' },
    observedAt: '2026-11-02T21:45:00.000Z',
    ...over
  };
}

function delivered(over = {}) {
  const proposal = over.proposal === undefined ? 'Synthetic advisory.\nfixture: good' : over.proposal;
  return {
    proposal,
    receipt: {
      opKey: over.opKey || 'ui-1',
      mode: over.mode || 'fixture',
      evaluation: over.mode === 'live' ? 'synthetic-live' : 'fixture',
      model: over.mode === 'live' ? 'muse-spark-1.3-contributor' : 'fixture',
      responseId: over.mode === 'live' ? 'resp_1' : null,
      usage: over.mode === 'live' ? { input_tokens: 120, output_tokens: 40 } : null,
      elapsedMs: 3,
      spendUsdReserved: 0,
      spendUsdUsed: null,
      providerContact: over.mode === 'live' ? 'sent' : 'none',
      acceptance: over.mode === 'live' ? 'accepted' : 'not-sent',
      billing: over.mode === 'live' ? 'possibly-chargeable' : 'not-chargeable',
      proposalHash: 'a'.repeat(64),
      proposalChars: typeof proposal === 'string' ? proposal.length : 0,
      proposalInput: { fixture: over.fixture === undefined ? 'good' : over.fixture },
      ...(over.receipt || {})
    },
    replay: false
  };
}

test('muse ui: load renders honest readiness and gates live on server capability', async () => {
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody())
  });
  // No generation may happen merely by loading the shell.
  assert.equal(ui.calls.filter((c) => c.init.method === 'POST').length, 0);
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'muse status');

  const html = ui.el('dgm-muse-status').innerHTML;
  for (const needle of ['muse-spark-1.3-contributor', 'no (fixture only)',
    'live generation disabled', 'live budget unset', 'write grant (admin.engineering.assign)',
    'no admission recorded yet']) {
    assert.ok(html.includes(needle), 'readiness names ' + needle);
  }
  assert.equal(ui.el('dgm-muse-mode-live').disabled, true, 'live option disabled when server says not configured');
  assert.equal(ui.el('dgm-muse-generate').disabled, false, 'fixture dry run stays available');
  assert.match(ui.el('dgm-muse-gen-state').textContent, /^Ready:/, 'the initial placeholder is replaced once status is loaded');
  // Selecting live without capability disables generation; no request is sent.
  ui.el('dgm-muse-mode').value = 'live';
  ui.el('dgm-muse-mode').listeners.change();
  assert.equal(ui.el('dgm-muse-generate').disabled, true);
  assert.equal(ui.calls.filter((c) => c.init.method === 'POST').length, 0, 'no request on capability change');
  assert.equal(ui.calls.filter((c) => c.path === `${MUSE}/status`).length, 1, 'status is loaded only on explicit click');
});

test('muse ui: missing schema disables generation and says so', async () => {
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody({
      spend: { scope: 'global', window: 'all-time', capUsd: 0, status: 'store-not-migrated' }
    }))
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  assert.ok(ui.el('dgm-muse-status').innerHTML.includes('proposal store not migrated'));
  assert.equal(ui.el('dgm-muse-generate').disabled, true, 'nothing may be generated without the store');
  ui.el('dgm-muse-prompt').value = 'Synthetic test.';
  ui.el('dgm-muse-generate').click();
  await settled(() => /not migrated/.test(ui.el('dgm-muse-gen-state').textContent), 'refusal');
  assert.equal(ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length, 0, 'no request was attempted');
});

test('muse ui: role denial (and the same server denial for demo sessions) leaves controls closed', async () => {
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json({ error: 'Administration is not authorized for this caller.', code: 'ADMIN_FORBIDDEN' }, { status: 403 })
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /ADMIN_FORBIDDEN/.test(ui.el('dgm-muse-state').textContent), 'denial');
  assert.match(ui.el('dgm-muse-state').textContent, /ADMIN_FORBIDDEN \(HTTP 403\)/);
  assert.equal(ui.el('dgm-muse-generate').disabled, true);
  assert.equal(ui.el('dgm-muse-mode-live').disabled, true);
  assert.equal(ui.calls.filter((c) => c.init.method === 'POST').length, 0);

  // The write route applies the same denial to a role without the engineering
  // assignment (demo sessions are refused by the identical server check).
  const writeDenied = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    [`${MUSE}/proposals`]: () => Response.json({ error: 'Administration is not authorized for this caller.', code: 'ADMIN_FORBIDDEN' }, { status: 403 })
  });
  writeDenied.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(writeDenied.el('dgm-muse-state').textContent), 'status');
  writeDenied.el('dgm-muse-prompt').value = 'Synthetic test.';
  writeDenied.el('dgm-muse-generate').click();
  await settled(() => /ADMIN_FORBIDDEN/.test(writeDenied.el('dgm-muse-gen-state').textContent), 'write denial');
  assert.match(writeDenied.el('dgm-muse-gen-state').textContent, /ADMIN_FORBIDDEN \(HTTP 403\)/);
  assert.equal(writeDenied.el('dgm-muse-result').innerHTML, '', 'a denial renders no receipt');
  assert.equal(writeDenied.el('dgm-muse-generate').disabled, false, 'a plain denial is not an uncertain quarantine');
});

test('muse ui: one deliberate click sends one request; duplicate clicks are ignored', async () => {
  const gate = deferred();
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    [`${MUSE}/proposals`]: () => gate.promise
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  ui.el('dgm-muse-prompt').value = 'Draft a boundary test.';
  ui.el('dgm-muse-generate').click();
  ui.el('dgm-muse-generate').click();
  ui.el('dgm-muse-generate').click();
  const posts = ui.calls.filter((c) => c.path === `${MUSE}/proposals`);
  assert.equal(posts.length, 1, 'one click, one request');
  assert.equal(posts[0].init.headers['X-Aipster-CSRF'], '1');
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
  assert.equal(posts[0].init.credentials, 'same-origin');
  const sent = JSON.parse(posts[0].init.body);
  assert.equal(sent.prompt, 'Draft a boundary test.');
  assert.equal(sent.mode, 'fixture');
  assert.match(sent.opKey, /^ui-[0-9a-f]{16}$/);
  gate.resolve(Response.json(delivered({ opKey: sent.opKey })));
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent), 'delivery');
  const html = ui.el('dgm-muse-result').innerHTML;
  assert.ok(html.includes('Synthetic advisory.'));
  assert.ok(html.includes('evaluated input'));
  assert.ok(html.includes('id="dgm-muse-attach"'));
  assert.ok(html.includes('fixture'));
  assert.equal(ui.el('dgm-muse-generate').disabled, false);
});

test('muse ui: a superseded status response never overwrites the newer one', async () => {
  const first = deferred();
  const second = deferred();
  let statusCalls = 0;
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => { statusCalls += 1; return statusCalls === 1 ? first.promise : second.promise; }
  });
  ui.el('dgm-muse-load').click();
  ui.el('dgm-muse-load').click();
  second.resolve(Response.json(statusBody({
    spendCapUsd: 5,
    spend: { scope: 'global', window: 'all-time', capUsd: 5, reservedUsd: 1, usedUsd: 0.25, remainingUsd: 4, updatedAt: '2026-11-02T21:44:00.000Z' }
  })));
  await settled(() => ui.el('dgm-muse-status').innerHTML.includes('$5.000000'), 'newer status');
  first.resolve(Response.json(statusBody({ spendCapUsd: 2, spend: { status: 'uninitialised', capUsd: 2 } })));
  await new Promise((r) => setTimeout(r, 10));
  const html = ui.el('dgm-muse-status').innerHTML;
  assert.ok(html.includes('$5.000000'), 'newer cap stays');
  assert.ok(!html.includes('$2.000000'), 'stale cap never wins');
  assert.ok(!html.includes('no admission recorded yet'), 'stale store state never wins');
  assert.ok(html.includes('$4.000000'), 'newer remaining stays');
});

test('muse ui: uncertain outcome is inspected and reconciled, never resubmitted', async () => {
  let attempts = 0;
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    [`${MUSE}/proposals`]: () => {
      attempts += 1;
      if (attempts === 1) return Response.json(delivered({ opKey: 'ui-first' }));
      return Response.json({ error: 'Tenant has unresolved quarantined DGM proposal(s) (old1).', code: 'DGM_MUSE_UNCERTAIN' }, { status: 409 });
    },
    [`${MUSE}/ops/old1`]: () => Response.json({
      opKey: 'old1', state: 'uncertain', unknownOutcome: true, blocking: true,
      receipt: { opKey: 'old1', mode: 'live', evaluation: 'synthetic-live', providerContact: 'sent', acceptance: 'unknown', billing: 'unknown', spendUsdReserved: 0.0001, error: 'DGM_MUSE_UNREACHABLE' }
    }),
    [`${MUSE}/ops/old1/reconcile`]: () => Response.json({
      opKey: 'old1', state: 'reconciled', unknownOutcome: true, blocking: false,
      receipt: { opKey: 'old1', mode: 'live', evaluation: 'synthetic-live', providerContact: 'sent', acceptance: 'unknown', billing: 'unknown', reconciledFrom: 'uncertain' }
    })
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  ui.el('dgm-muse-prompt').value = 'Synthetic test.';
  // A prior delivery leaves a result and attach button on screen; entering the
  // quarantine must invalidate them so nothing from the old op can be attached
  // or reconciled without inspecting the quarantined key first.
  ui.el('dgm-muse-generate').click();
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent), 'prior delivery');
  assert.ok(ui.el('dgm-muse-result').innerHTML.includes('Synthetic advisory'));
  ui.el('dgm-muse-generate').click();
  await settled(() => /Quarantined/.test(ui.el('dgm-muse-gen-state').textContent), 'quarantine');
  assert.match(ui.el('dgm-muse-gen-state').textContent, /DGM_MUSE_UNCERTAIN \(HTTP 409\)/);
  const attempted = JSON.parse(ui.calls.filter((c) => c.path === `${MUSE}/proposals`).at(-1).init.body).opKey;
  assert.ok(ui.el('dgm-muse-gen-state').textContent.includes(attempted), 'the attempted operation key is revealed even when admission is refused');
  assert.equal(ui.el('dgm-muse-generate').disabled, true, 'a quarantined tenant cannot generate again');
  assert.equal(ui.el('dgm-muse-reconcile').hidden, false, 'inspect/reconcile is offered');
  assert.equal(ui.el('dgm-muse-result').innerHTML, '', 'the previous result is no longer presented as current');
  assert.equal(ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length, 2, 'exactly the two clicked attempts');

  ui.el('dgm-muse-ack').checked = true;
  ui.el('dgm-muse-ack').listeners.change();
  assert.equal(ui.el('dgm-muse-reconcile-submit').disabled, true, 'acknowledgement alone cannot reconcile without inspecting');
  ui.el('dgm-muse-op-key').value = 'old1';
  ui.el('dgm-muse-inspect').click();
  await settled(() => /blocking admission yes/.test(ui.el('dgm-muse-reconcile-state').textContent), 'inspect');
  assert.match(ui.el('dgm-muse-reconcile-state').textContent, /unknown outcome yes/);
  assert.ok(ui.el('dgm-muse-result').innerHTML.includes('uncertain'));
  assert.ok(ui.el('dgm-muse-result').innerHTML.includes('sent'));
  assert.equal(ui.el('dgm-muse-reconcile-submit').disabled, false, 'inspection plus acknowledgement enables reconcile');
  ui.el('dgm-muse-reconcile-submit').click();
  await settled(() => /Reconciled/.test(ui.el('dgm-muse-reconcile-state').textContent), 'reconcile');
  const post = ui.calls.find((c) => c.path === `${MUSE}/ops/old1/reconcile`);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['X-Aipster-CSRF'], '1');
  assert.deepEqual(JSON.parse(post.init.body), { acknowledge: true });
  assert.equal(ui.el('dgm-muse-generate').disabled, false, 'an explicit reconciliation releases the panel');
  assert.equal(ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length, 2, 'still exactly the clicked attempts');
});

test('muse ui: a transport failure keeps the key for inspection and sends nothing else', async () => {
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    [`${MUSE}/proposals`]: () => new Error('socket closed')
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  ui.el('dgm-muse-prompt').value = 'Synthetic test.';
  ui.el('dgm-muse-generate').click();
  await settled(() => /Outcome unknown/.test(ui.el('dgm-muse-gen-state').textContent), 'unknown');
  const posts = ui.calls.filter((c) => c.path === `${MUSE}/proposals`);
  assert.equal(posts.length, 1);
  const key = JSON.parse(posts[0].init.body).opKey;
  assert.equal(ui.el('dgm-muse-op-key').value, key, 'the uncertain key is kept for inspection');
  assert.equal(ui.el('dgm-muse-generate').disabled, true, 'no blind retry');
});

test('muse ui: proposal and receipt text are escaped, never markup', async () => {
  const payload = '<img id="dgm-injected" src=x onerror=alert(1)>\nfixture: good';
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    [`${MUSE}/proposals`]: () => Response.json(delivered({
      proposal: payload,
      receipt: { model: '<b id="dgm-model-injected">model</b>', responseId: '<i>resp</i>' }
    }))
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  ui.el('dgm-muse-prompt').value = 'Synthetic test.';
  ui.el('dgm-muse-generate').click();
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent), 'delivery');
  const html = ui.el('dgm-muse-result').innerHTML;
  assert.ok(!html.includes('<img id="dgm-injected"'), 'proposal text never becomes markup');
  assert.ok(!html.includes('<b id="dgm-model-injected">'), 'receipt text never becomes markup');
  assert.ok(html.includes('&lt;img id=&quot;dgm-injected&quot;'), 'escaped proposal is still readable');
  const doc = parseFragment(html);
  const hasId = (n, id) => (n.attrs || []).some((a) => a.name === 'id' && a.value === id)
    || (n.childNodes || []).some((k) => hasId(k, id));
  assert.ok(!hasId(doc, 'dgm-injected'));
  assert.ok(!hasId(doc, 'dgm-model-injected'));
});

test('muse ui: attach binds the delivered operation on screen, never a newer selection', async () => {
  let n = 0;
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    [`${MUSE}/proposals`]: () => {
      n += 1;
      const opKey = 'ui-gen' + n;
      return Response.json(delivered({
        opKey,
        proposal: 'Synthetic advisory ' + n + '.\nfixture: ' + (n === 1 ? 'good' : 'bad-advice'),
        fixture: n === 1 ? 'good' : 'bad-advice'
      }));
    },
    [`${RUNS}`]: ({ init }) => {
      if (init.method === 'POST') {
        return Response.json({ runId: 'run_attached', fixture: 'bad-advice', status: 'validation-rejected', envelopeLabel: 'REJECTED' });
      }
      return Response.json({ items: [], total: 0 });
    },
    [`${RUNS}/run_attached`]: () => Response.json({
      runId: 'run_attached', fixture: 'bad-advice', evaluation: 'fixture', status: 'validation-rejected',
      envelopeLabel: 'REJECTED', label: '', adviceReason: 'fixture', settlement: 'rejected',
      gates: [], provenance: { archive: [] }, events: [],
      telemetry: { readStatus: 'unavailable', freshnessNote: 'unavailable', outcomeCounts: {}, latencySummary: { count: 0, p50_ms: null, p95_ms: null }, tokensSummary: { prompt_tokens_est: null, completion_tokens_est: null } }
    })
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  ui.el('dgm-muse-prompt').value = 'First synthetic test.';
  ui.el('dgm-muse-generate').click();
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent), 'first delivery');
  ui.el('dgm-muse-prompt').value = 'Second synthetic test.';
  ui.el('dgm-muse-generate').click();
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent)
    && ui.el('dgm-muse-result').innerHTML.includes('bad-advice'), 'second delivery');
  const proposalPosts = ui.calls.filter((c) => c.path === `${MUSE}/proposals`);
  assert.equal(proposalPosts.length, 2, 'two deliberate clicks, two requests');
  const firstKey = JSON.parse(proposalPosts[0].init.body).opKey;
  const secondKey = JSON.parse(proposalPosts[1].init.body).opKey;
  assert.notEqual(firstKey, secondKey, 'each deliberate action gets its own key');

  ui.el('dgm-muse-attach').click();
  await settled(() => /Attached|Attach refused|Attach failed/.test(ui.el('dgm-muse-gen-state').textContent), 'attach');
  assert.match(ui.el('dgm-muse-gen-state').textContent, /^Attached/);
  const post = ui.calls.find((c) => c.path === RUNS && c.init.method === 'POST');
  assert.ok(post);
  assert.equal(post.init.headers['X-Aipster-CSRF'], '1');
  assert.deepEqual(JSON.parse(post.init.body), { proposalOpKey: secondKey }, 'the on-screen delivered op is attached, with no direct fixture override');
  assert.equal(ui.el('dgm-muse-attach').disabled, true, 'one attach per result');
  assert.ok(ui.calls.some((c) => c.path === RUNS), 'the existing runs view is refreshed');
});

test('muse ui: shell carries the panel, labels it, and keeps controls native', () => {
  for (const id of ['dgm-muse', 'dgm-muse-state', 'dgm-muse-load', 'dgm-muse-status',
    'dgm-muse-prompt', 'dgm-muse-mode', 'dgm-muse-mode-live', 'dgm-muse-generate',
    'dgm-muse-gen-state', 'dgm-muse-result', 'dgm-muse-reconcile', 'dgm-muse-op-key',
    'dgm-muse-inspect', 'dgm-muse-note', 'dgm-muse-ack', 'dgm-muse-reconcile-submit']) {
    assert.ok(shell.includes(`id="${id}"`), id + ' present');
  }
  assert.ok(shell.includes('href="#dgm-muse"'), 'nav entry present');
  const frag = parseFragment(shell);
  const found = {};
  const walk = (node) => {
    const byName = Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));
    if (byName.id) found[byName.id] = { tag: node.tagName, attrs: byName };
    for (const kid of node.childNodes || []) walk(kid);
  };
  walk(frag);
  for (const id of ['dgm-muse-state', 'dgm-muse-result', 'dgm-muse-gen-state', 'dgm-muse-reconcile-state']) {
    assert.equal(found[id].attrs['aria-live'], 'polite', id + ' announced');
  }
  for (const id of ['dgm-muse-generate', 'dgm-muse-inspect', 'dgm-muse-reconcile-submit', 'dgm-muse-load']) {
    assert.equal(found[id].tag, 'button', id + ' is a native button');
    assert.equal(found[id].attrs.type, 'button', id + ' never submits a form');
  }
  assert.ok('hidden' in found['dgm-muse-reconcile'].attrs, 'reconcile starts hidden');
  assert.ok(shell.includes('Nothing executes, promotes or reserves.'));
  assert.ok(shell.includes('never resubmitted'));
  assert.equal((shell.match(/<script/g) || []).length, 1);
});

// F-1 regression: an inspection is a read and must not own or supersede a
// generation's busy state. Both resolution orders are exercised after the panel
// has been through a real quarantine/inspect/reconcile cycle, because that is
// where an operator can see the reconcile controls while generating.

function interleavingRoutes(genGate, inspectGate) {
  let proposals = 0;
  return {
    [`${MUSE}/proposals`]: () => {
      proposals += 1;
      if (proposals === 1) {
        return Response.json({ error: 'Tenant has unresolved quarantined DGM proposal(s) (old1).', code: 'DGM_MUSE_UNCERTAIN' }, { status: 409 });
      }
      if (proposals === 2) return genGate.promise;
      return Response.json(delivered({ opKey: 'ui-third', proposal: 'Deliberate third delivery.\nfixture: good' }));
    },
    [`${MUSE}/ops/old1`]: () => Response.json({
      opKey: 'old1', state: 'uncertain', unknownOutcome: true, blocking: true,
      receipt: { opKey: 'old1', mode: 'live', evaluation: 'synthetic-live', providerContact: 'sent', acceptance: 'unknown', billing: 'unknown', spendUsdReserved: 0.0001 }
    }),
    [`${MUSE}/ops/old1/reconcile`]: () => Response.json({
      opKey: 'old1', state: 'reconciled', unknownOutcome: false, blocking: false,
      receipt: { opKey: 'old1', mode: 'live', evaluation: 'synthetic-live', providerContact: 'sent', acceptance: 'unknown', billing: 'unknown' }
    }),
    [`${MUSE}/ops/other1`]: () => inspectGate.promise
  };
}

async function primeQuarantineCycle(ui) {
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  ui.el('dgm-muse-prompt').value = 'Synthetic interleaving test.';
  ui.el('dgm-muse-generate').click();
  await settled(() => /Quarantined/.test(ui.el('dgm-muse-gen-state').textContent), 'quarantine');
  ui.el('dgm-muse-op-key').value = 'old1';
  ui.el('dgm-muse-inspect').click();
  await settled(() => /blocking admission yes/.test(ui.el('dgm-muse-reconcile-state').textContent), 'inspect old1');
  ui.el('dgm-muse-ack').checked = true;
  ui.el('dgm-muse-ack').listeners.change();
  ui.el('dgm-muse-reconcile-submit').click();
  await settled(() => /Reconciled/.test(ui.el('dgm-muse-reconcile-state').textContent), 'reconcile old1');
  assert.equal(ui.el('dgm-muse-generate').disabled, false, 'precondition: the panel is open again');
  assert.equal(ui.el('dgm-muse-reconcile').hidden, false, 'precondition: reconcile controls stay visible');
}

async function startDeliberateGeneration(ui) {
  const before = ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length;
  ui.el('dgm-muse-generate').click();
  await settled(() => ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length === before + 1, 'generation request');
  const posts = ui.calls.filter((c) => c.path === `${MUSE}/proposals`);
  return { count: posts.length, key: JSON.parse(posts[posts.length - 1].init.body).opKey };
}

const uncertainInspect = () => Response.json({
  opKey: 'other1', state: 'uncertain', unknownOutcome: true, blocking: true,
  receipt: { opKey: 'other1', mode: 'live', evaluation: 'synthetic-live', providerContact: 'sent', acceptance: 'unknown', billing: 'unknown' }
});

test('muse ui: inspection during generation never wedges the panel (generation resolves first)', async () => {
  const genGate = deferred();
  const inspectGate = deferred();
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    ...interleavingRoutes(genGate, inspectGate)
  });
  await primeQuarantineCycle(ui);
  const gen = await startDeliberateGeneration(ui);
  assert.equal(gen.count, 2);

  ui.el('dgm-muse-op-key').value = 'other1';
  ui.el('dgm-muse-inspect').click();
  genGate.resolve(Response.json(delivered({ opKey: gen.key, proposal: 'Delivered while inspecting.\nfixture: good' })));
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent), 'generation settle');
  inspectGate.resolve(uncertainInspect());
  await settled(() => /other1/.test(ui.el('dgm-muse-reconcile-state').textContent), 'inspection settle');

  assert.equal(ui.el('dgm-muse-generate').disabled, false, 'generation busy state settled');
  assert.ok(ui.el('dgm-muse-gen-state').textContent.includes(gen.key), 'the delivered operation key is revealed');
  assert.ok(ui.el('dgm-muse-result').innerHTML.includes(gen.key), 'the delivered receipt is not discarded by the inspection');
  assert.ok(ui.el('dgm-muse-result').innerHTML.includes('Delivered while inspecting.'), 'delivered receipt content survives');
  assert.equal(ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length, 2, 'no automatic resubmission');
  const third = await startDeliberateGeneration(ui);
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent), 'third delivery');
  assert.equal(third.count, 3, 'only the subsequent deliberate action sends another proposal');
  assert.equal(third.key === gen.key, false, 'the next deliberate action uses its own key');
});

test('muse ui: inspection during generation never wedges the panel (inspection resolves first)', async () => {
  const genGate = deferred();
  const inspectGate = deferred();
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    ...interleavingRoutes(genGate, inspectGate)
  });
  await primeQuarantineCycle(ui);
  const gen = await startDeliberateGeneration(ui);

  ui.el('dgm-muse-op-key').value = 'other1';
  ui.el('dgm-muse-inspect').click();
  inspectGate.resolve(uncertainInspect());
  await settled(() => /State uncertain/.test(ui.el('dgm-muse-reconcile-state').textContent), 'inspection settle');
  genGate.resolve(Response.json(delivered({ opKey: gen.key, proposal: 'Delivered after inspection.\nfixture: good' })));
  await settled(() => /Delivered/.test(ui.el('dgm-muse-gen-state').textContent), 'generation settle');

  assert.equal(ui.el('dgm-muse-generate').disabled, false, 'generation busy state settled');
  assert.ok(ui.el('dgm-muse-gen-state').textContent.includes(gen.key), 'the delivered operation key is revealed');
  assert.ok(ui.el('dgm-muse-result').innerHTML.includes(gen.key), 'the generation receipt is on screen');
  assert.ok(ui.el('dgm-muse-result').innerHTML.includes('Delivered after inspection.'), 'the generation receipt is not lost');
  assert.equal(ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length, 2, 'no automatic resubmission');
  const third = await startDeliberateGeneration(ui);
  assert.equal(third.count, 3, 'only the subsequent deliberate action sends another proposal');
});

test('muse ui: inspection during reconcile never wedges the panel', async () => {
  const inspectGate = deferred();
  const reconcileGate = deferred();
  let proposals = 0;
  const ui = harness({
    '/api/admin/v1/status': grant,
    [`${MUSE}/status`]: () => Response.json(statusBody()),
    [`${MUSE}/proposals`]: () => {
      proposals += 1;
      if (proposals === 1) {
        return Response.json({ error: 'Tenant has unresolved quarantined DGM proposal(s) (old1).', code: 'DGM_MUSE_UNCERTAIN' }, { status: 409 });
      }
      return Response.json(delivered({ opKey: 'ui-after-reconcile', proposal: 'After reconcile.\nfixture: good' }));
    },
    [`${MUSE}/ops/old1`]: () => Response.json({
      opKey: 'old1', state: 'uncertain', unknownOutcome: true, blocking: true,
      receipt: { opKey: 'old1', mode: 'live', evaluation: 'synthetic-live', providerContact: 'sent', acceptance: 'unknown', billing: 'unknown' }
    }),
    [`${MUSE}/ops/old1/reconcile`]: () => reconcileGate.promise,
    [`${MUSE}/ops/other1`]: () => inspectGate.promise
  });
  ui.el('dgm-muse-load').click();
  await settled(() => /Loaded/.test(ui.el('dgm-muse-state').textContent), 'status');
  ui.el('dgm-muse-prompt').value = 'Synthetic reconcile interleaving.';
  ui.el('dgm-muse-generate').click();
  await settled(() => /Quarantined/.test(ui.el('dgm-muse-gen-state').textContent), 'quarantine');
  ui.el('dgm-muse-op-key').value = 'old1';
  ui.el('dgm-muse-inspect').click();
  await settled(() => /blocking admission yes/.test(ui.el('dgm-muse-reconcile-state').textContent), 'inspect old1');
  ui.el('dgm-muse-ack').checked = true;
  ui.el('dgm-muse-ack').listeners.change();
  ui.el('dgm-muse-reconcile-submit').click();
  await settled(() => /Reconciling old1/.test(ui.el('dgm-muse-reconcile-state').textContent), 'reconcile in flight');

  ui.el('dgm-muse-op-key').value = 'other1';
  ui.el('dgm-muse-inspect').click();
  inspectGate.resolve(uncertainInspect());
  await settled(() => /State uncertain/.test(ui.el('dgm-muse-reconcile-state').textContent), 'inspection settle');
  reconcileGate.resolve(Response.json({
    opKey: 'old1', state: 'reconciled', unknownOutcome: false, blocking: false,
    receipt: { opKey: 'old1', mode: 'live', evaluation: 'synthetic-live', providerContact: 'sent', acceptance: 'unknown', billing: 'unknown' }
  }));
  await settled(() => /Reconciled old1/.test(ui.el('dgm-muse-reconcile-state').textContent), 'reconcile settle');

  assert.equal(ui.el('dgm-muse-generate').disabled, false, 'reconcile busy state settled');
  const before = ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length;
  ui.el('dgm-muse-generate').click();
  await settled(() => ui.calls.filter((c) => c.path === `${MUSE}/proposals`).length === before + 1, 'next deliberate generation');
  assert.equal(before, 1, 'no automatic resubmission during the interleaving');
});
