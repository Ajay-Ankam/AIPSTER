// Entry script for the isolated inference-demo experiment page (single-user,
// explicit-resource dispatch demo). Session auth + CSRF reuse the existing
// control-panel contract: same-origin fetch, `X-Aipster-CSRF: 1` on POST,
// no API keys in the browser. All request shapes and state decisions come
// from ./contract.mjs; every terminal state stops without resubmission.
import {
  serializeAdmissionsBody, serializeSubmitBody, submitAllowed, pollDecision,
  classifyResponse, POLL_MS_UI, POLL_CAP_UI,
} from './contract.mjs';

const CSRF_HEADER = 'X-Aipster-CSRF';
const INVENTORY_LIMIT = 50;

function el(doc, id) {
  const node = doc.getElementById(id);
  if (!node) throw new Error(`inference-demo: missing #${id}`);
  return node;
}

export function createDemo({ document: doc, fetchFn, cryptoObj, timer }) {
  const ui = {
    sessionState: el(doc, 'session-state'),
    inventorySelect: el(doc, 'inventory-select'),
    inventoryNote: el(doc, 'inventory-note'),
    manualToggle: el(doc, 'manual-toggle'),
    manualWrap: el(doc, 'manual-wrap'),
    resourceManual: el(doc, 'resource-manual'),
    modelInput: el(doc, 'model-input'),
    runtimeSelect: el(doc, 'runtime-select'),
    tokensInput: el(doc, 'tokens-input'),
    deadlineSelect: el(doc, 'deadline-select'),
    promptInput: el(doc, 'prompt-input'),
    submitBtn: el(doc, 'submit-btn'),
    cancelBtn: el(doc, 'cancel-btn'),
    resetBtn: el(doc, 'reset-btn'),
    keyLine: el(doc, 'key-line'),
    statusLine: el(doc, 'status-line'),
    resultPre: el(doc, 'result-pre'),
    provenanceLine: el(doc, 'provenance-line'),
    pollLine: el(doc, 'poll-line'),
  };
  const state = {
    signedIn: false, inflight: false, terminal: false, observing: false,
    key: null, polls: 0, deadlineAt: 0, timerId: null, cards: new Map(),
  };

  function setStatus(text, kind) {
    ui.statusLine.textContent = text;
    ui.statusLine.setAttribute('data-kind', kind || 'info');
  }

  function syncButtons() {
    ui.submitBtn.disabled = !(state.signedIn && submitAllowed(state));
    ui.cancelBtn.disabled = !state.observing;
    ui.resetBtn.disabled = !(state.terminal || state.key !== null);
  }

  function stopPolling() {
    state.observing = false;
    if (state.timerId !== null) {
      timer.clear(state.timerId);
      state.timerId = null;
    }
    ui.pollLine.textContent = '';
    syncButtons();
  }

  function renderTerminal(out) {
    stopPolling();
    state.inflight = false;
    state.terminal = true;
    setStatus(`${out.title}: ${out.detail}`, out.state === 'settled' ? 'ok' : 'error');
    ui.resultPre.textContent = typeof out.content === 'string' ? out.content : '';
    ui.provenanceLine.textContent = typeof out.provenanceNote === 'string' ? out.provenanceNote : '';
    syncButtons();
  }

  async function callApi(path, { method = 'GET', body } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('same-origin API paths only');
    const init = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.headers[CSRF_HEADER] = '1';
      init.body = JSON.stringify(body === undefined ? {} : body);
    }
    let res;
    try {
      res = await fetchFn(path, init);
    } catch {
      return { status: 0, body: null };
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  function heartbeatAge(iso, nowMs) {
    if (typeof iso !== 'string' || !iso) return 'no heartbeat reported';
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return 'heartbeat timestamp unparseable';
    const s = Math.max(0, Math.round((nowMs - at) / 1000));
    return `heartbeat ${s}s ago (as reported)`;
  }

  async function checkSession() {
    const { status, body } = await callApi('/api/auth/get-session');
    const user = body && typeof body === 'object' ? body.user : null;
    if (status === 200 && user && typeof user === 'object') {
      state.signedIn = true;
      const who = user.email || user.name || user.id || 'signed-in user';
      ui.sessionState.textContent = `Signed in as ${who} (session auth; no API keys used).`;
    } else {
      state.signedIn = false;
      ui.sessionState.textContent = 'Not signed in. Sign in from the control panel, then reload this page.';
    }
    syncButtons();
  }

  async function loadInventory() {
    const { status, body } = await callApi(`/api/inventory?limit=${INVENTORY_LIMIT}`);
    const items = status === 200 && body && Array.isArray(body.items) ? body.items : null;
    if (!items) {
      ui.inventoryNote.textContent = `Live inventory unavailable (${status || 'network'}). Manual resource id below — the server validates ownership and liveness.`;
      ui.manualToggle.checked = true;
      syncManual();
      return;
    }
    state.cards.clear();
    while (ui.inventorySelect.firstChild) ui.inventorySelect.removeChild(ui.inventorySelect.firstChild);
    const nowMs = Date.now();
    for (const card of items) {
      if (!card || typeof card.id !== 'string') continue;
      state.cards.set(card.id, card);
      const opt = doc.createElement('option');
      opt.value = card.id;
      const rung = card.state && typeof card.state.status === 'string' ? card.state.status : 'unknown';
      opt.textContent = `${card.name || card.id} — ${rung} — ${heartbeatAge(card.heartbeatAt, nowMs)}`;
      ui.inventorySelect.appendChild(opt);
    }
    ui.inventoryNote.textContent = items.length === 0
      ? 'Inventory is empty for this user. Register a resource from the control panel, or enter an id manually.'
      : 'Live inventory (read scope). The list is a chooser only: ownership, grant and liveness are decided by the server at admission time.';
  }

  function syncManual() {
    const manual = ui.manualToggle.checked === true;
    ui.manualWrap.hidden = !manual;
    ui.inventorySelect.disabled = manual;
  }

  function selectedResourceId() {
    if (ui.manualToggle.checked === true) return ui.resourceManual.value.trim();
    return ui.inventorySelect.value;
  }

  async function pollOnce() {
    state.polls += 1;
    ui.pollLine.textContent = `Poll ${state.polls} of ${POLL_CAP_UI}: reading operation state (no resubmission).`;
    const { status, body } = await callApi(`/api/jobs/${state.key}`);
    const out = classifyResponse({ stage: 'poll', status, body });
    if ((out.state === 'dispatched' || out.state === 'pending') && out.poll === true) {
      const decision = pollDecision({ polls: state.polls, nowMs: Date.now(), deadlineAt: state.deadlineAt, lastStatus: out.state });
      if (decision.cont) {
        setStatus(`${out.title}: ${out.detail}`, 'info');
        state.timerId = timer.set(pollOnce, POLL_MS_UI);
        return;
      }
      renderTerminal({ state: 'expired', title: 'Observation stopped', detail: `Polling stopped (${decision.reason}); the operation may still settle server-side — reconcile later with the shown idempotency key.`, content: null });
      return;
    }
    renderTerminal(out);
  }

  async function onSubmit() {
    if (!submitAllowed(state) || !state.signedIn) return;
    const adm = serializeAdmissionsBody({
      resourceId: selectedResourceId(),
      modelId: ui.modelInput.value.trim(),
      maxTokens: Number(ui.tokensInput.value),
      runtimeId: ui.runtimeSelect.value,
    });
    if (!adm.ok) {
      setStatus(`Cannot submit: ${adm.error}`, 'error');
      return;
    }
    const prompt = ui.promptInput.value;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      setStatus('Cannot submit: prompt must be non-empty.', 'error');
      return;
    }
    state.inflight = true;
    state.terminal = false;
    state.key = cryptoObj.randomUUID();
    state.polls = 0;
    ui.keyLine.textContent = `Idempotency key for this request (retained, never reused): ${state.key}`;
    ui.resultPre.textContent = '';
    ui.provenanceLine.textContent = '';
    syncButtons();
    setStatus('Requesting admission for the named resource…', 'info');
    const issued = await callApi('/api/inference/admissions', { method: 'POST', body: adm.body });
    if (!(issued.status === 201 && issued.body && typeof issued.body.admission_ref === 'string')) {
      renderTerminal(classifyResponse({ stage: 'admissions', status: issued.status, body: issued.body }));
      return;
    }
    const deadlineMs = Number(ui.deadlineSelect.value) * 1000;
    const sub = serializeSubmitBody({
      admissionRef: issued.body.admission_ref, idempotencyKey: state.key,
      modelId: adm.body.model_id, prompt, maxTokens: adm.body.max_tokens,
      deadlineAt: Date.now() + deadlineMs,
    });
    if (!sub.ok) {
      renderTerminal({ state: 'field', title: 'Cannot submit', detail: sub.error, content: null, resubmit: false });
      return;
    }
    state.deadlineAt = sub.body.deadline_at;
    setStatus('Admission issued. Submitting the job (same model and token ceiling as the admission)…', 'info');
    const sent = await callApi('/api/jobs', { method: 'POST', body: sub.body });
    const out = classifyResponse({ stage: 'submit', status: sent.status, body: sent.body });
    if ((out.state === 'dispatched' || out.state === 'pending') && out.poll === true) {
      state.observing = true;
      syncButtons();
      setStatus(`${out.title}: ${out.detail}`, 'info');
      state.timerId = timer.set(pollOnce, POLL_MS_UI);
      return;
    }
    renderTerminal(out);
  }

  async function onCancel() {
    if (!state.observing || !state.key) return;
    ui.cancelBtn.disabled = true;
    const { status, body } = await callApi(`/api/jobs/${state.key}/cancel`, { method: 'POST', body: {} });
    renderTerminal(classifyResponse({ stage: 'cancel', status, body }));
  }

  function onReset() {
    stopPolling();
    state.inflight = false;
    state.terminal = false;
    state.key = null;
    state.polls = 0;
    ui.keyLine.textContent = '';
    ui.resultPre.textContent = '';
    ui.provenanceLine.textContent = '';
    setStatus('Cleared. A new submit generates a new idempotency key.', 'info');
    syncButtons();
  }

  ui.submitBtn.addEventListener('click', () => { void onSubmit(); });
  ui.cancelBtn.addEventListener('click', () => { void onCancel(); });
  ui.resetBtn.addEventListener('click', onReset);
  ui.manualToggle.addEventListener('change', syncManual);
  syncManual();
  syncButtons();

  return {
    ready: (async () => { await checkSession(); await loadInventory(); })(),
    onSubmit, onCancel, onReset, state,
  };
}

export function init(doc) {
  const target = doc || globalThis.document;
  return createDemo({
    document: target,
    fetchFn: (...args) => globalThis.fetch(...args),
    cryptoObj: globalThis.crypto,
    timer: { set: (...args) => globalThis.setTimeout(...args), clear: (...args) => globalThis.clearTimeout(...args) },
  });
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', () => { void init(document).ready; });
}
