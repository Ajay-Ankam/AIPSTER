// Pure request/state contract for the isolated inference-demo experiment UI.
//
// Every bound below mirrors an existing server rule (sources cited); the
// maintained test cross-checks the shared tuples against the real server
// codec (eif-task-contract.mjs) and drives the real worker.js with
// UI-serialized bodies. This module performs no I/O and holds no credentials.
export const ADMISSIONS_FIELDS = ['resource_id', 'model_id', 'max_tokens', 'runtime_id'];
export const SUBMIT_FIELDS = ['contract_version', 'admission_ref', 'idempotency_key',
  'model_id', 'prompt', 'max_tokens', 'deadline_at'];
// Mirrors dispatch-coordinator.mjs CONTRACT_VERSION / MAX_DEADLINE_MS.
export const CONTRACT_VERSION_UI = 'v1.0.0';
export const MAX_DEADLINE_MS_UI = 180000;
// Mirrors worker.js INFERENCE_RUNTIME_IDS. Placement stays CPU-only regardless:
// choosing a runtime never authorizes GPU work (encodeBoundCpuTask).
export const RUNTIME_IDS_UI = ['ganglion', 'llama-server'];
export const POLL_CAP_UI = 60;
export const POLL_MS_UI = 2000;

// Mirrors lib/validate.js isId and dispatch-coordinator REF_RE / KEY_RE.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export const isValidId = (v) => typeof v === 'string' && ID_RE.test(v);
export const isValidRef = (v) => typeof v === 'string' && REF_RE.test(v);
export const isValidIdempotencyKey = (v) => typeof v === 'string' && KEY_RE.test(v);

// Mirrors the POST /api/inference/admissions field allowlist + bounds
// (worker.js). The server re-validates everything; this only avoids
// malformed requests and labels local mistakes before any fetch.
export function serializeAdmissionsBody({ resourceId, modelId, maxTokens, runtimeId = 'ganglion' } = {}) {
  if (!isValidId(resourceId)) return { ok: false, error: 'resource_id must be 1..64 id chars (letters, digits, _ -).' };
  if (typeof modelId !== 'string' || !modelId || modelId.length > 256) {
    return { ok: false, error: 'model_id must be a non-empty string of at most 256 chars.' };
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    return { ok: false, error: 'max_tokens must be an integer in 1..4096.' };
  }
  if (typeof runtimeId !== 'string' || !RUNTIME_IDS_UI.includes(runtimeId)) {
    return { ok: false, error: 'runtime_id must be one of: ganglion, llama-server.' };
  }
  return { ok: true, body: { resource_id: resourceId, model_id: modelId, max_tokens: maxTokens, runtime_id: runtimeId } };
}

// Mirrors dispatch-coordinator.mjs validateBody + validateDeadline. Any field
// outside the 7 allowed (including forged authority/placement fields) fails
// here before any fetch is attempted.
export function serializeSubmitBody(input = {}) {
  const { admissionRef, idempotencyKey, modelId, prompt, maxTokens, deadlineAt, ...rest } = input;
  const extras = Object.keys(rest);
  if (extras.length > 0) return { ok: false, error: `Unsupported field: ${extras[0]}. Only the 7 contract fields are sent.` };
  if (!isValidRef(admissionRef)) return { ok: false, error: 'admission_ref is invalid.' };
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return { ok: false, error: 'idempotency_key must start alnum and be 8..128 key chars.' };
  }
  if (typeof modelId !== 'string' || !modelId || modelId.length > 256) {
    return { ok: false, error: 'model_id must be a non-empty string of at most 256 chars.' };
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 65536) {
    return { ok: false, error: 'prompt must be non-empty and at most 65536 chars.' };
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    return { ok: false, error: 'max_tokens must be an integer in 1..4096.' };
  }
  const now = Date.now();
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now || deadlineAt - now > MAX_DEADLINE_MS_UI) {
    return { ok: false, error: 'deadline_at must be in the future and within 180 s.' };
  }
  return {
    ok: true,
    body: { contract_version: CONTRACT_VERSION_UI, admission_ref: admissionRef,
      idempotency_key: idempotencyKey, model_id: modelId, prompt,
      max_tokens: maxTokens, deadline_at: deadlineAt },
  };
}

// Exactly one submission per in-flight request. A terminal request needs an
// explicit reset (new idempotency key) before another submit is allowed.
export function submitAllowed({ inflight, terminal } = {}) {
  return inflight !== true && terminal !== true;
}

// Bounded status observation only. Polling continues solely on dispatched /
// pending inside the deadline and the poll cap; every other outcome stops.
// Polling re-reads state with GET — it never resubmits.
export function pollDecision({ polls, nowMs, deadlineAt, lastStatus } = {}) {
  if (lastStatus !== 'dispatched' && lastStatus !== 'pending') {
    return { cont: false, reason: `terminal:${String(lastStatus)}` };
  }
  if (!Number.isSafeInteger(polls) || polls >= POLL_CAP_UI) return { cont: false, reason: 'poll-cap' };
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(deadlineAt) || nowMs >= deadlineAt) {
    return { cont: false, reason: 'deadline' };
  }
  return { cont: true, reason: 'observing' };
}

const AUTH_CODES = new Set(['AUTH_REQUIRED', 'KEY_SCOPE', 'KEY_EXPIRED', 'KEY_REVOKED', 'SESSION_EXPIRED']);
const BINDING_CODES = new Set(['BINDING_MISMATCH', 'NO_MATCHING_GRANT', 'ADMISSION_NOT_AVAILABLE',
  'ADMISSION_EXPIRED', 'ADMISSION_REJECTED', 'OWNER_MISMATCH']);
const BUDGET_CODES = new Set(['BUDGET_EXHAUSTED', 'DISPATCH_LIMIT', 'GRANT_QUOTA_EXHAUSTED']);
const FIELD_CODES = new Set(['BAD_RESOURCE', 'BAD_MODEL', 'BAD_MAX_TOKENS', 'BAD_RUNTIME', 'UNSUPPORTED_FIELD',
  'UNSUPPORTED_CONTRACT_VERSION', 'UNSUPPORTED_PARAMETER', 'UNSUPPORTED_CAPABILITY', 'INVALID_REQUEST',
  'INVALID_DEADLINE', 'FORGED_CLIENT_AUTHORITY', 'BAD_IDEMPOTENCY', 'TARGET_CAPABILITY_UNSUPPORTED']);
const PLACEMENT_CODES = new Set(['RESOURCE_STALE', 'RESOURCE_UNAVAILABLE', 'RESOURCE_NOT_FOUND', 'SELECTION_UNQUALIFIED']);
const UNCERTAIN_CODES = new Set(['OUTCOME_UNCERTAIN', 'RESULT_UNAVAILABLE', 'RESULT_REJECTED', 'AUTHORITY_UNAVAILABLE']);

// Map one HTTP response to a precise terminal-or-observe UI state. resubmit is
// always false: this UI never re-POSTs on doubt. Unknown codes surface
// verbatim instead of being reinterpreted.
export function classifyResponse({ stage, status, body } = {}) {
  const code = body && typeof body.code === 'string' ? body.code : '';
  const fail = (state, title, detail) => ({ state, title, detail, content: null, resubmit: false });
  if (!Number.isSafeInteger(status) || status === 0) {
    return fail('network', 'Network error', 'The request did not reach the server. Nothing was resubmitted; terminal states are unknown — reconcile with the shown idempotency key before acting.');
  }
  if (status === 401 || AUTH_CODES.has(code)) {
    return fail('auth', 'Sign-in required', `The server refused the ${stage} call (${status} ${code || 'no code'}). Sign in from the control panel; this demo uses session auth only and never takes API keys.`);
  }
  if (status === 501 || code === 'INFERENCE_DISABLED') {
    return fail('flag-off', 'Inference disabled', 'The server answered 501 INFERENCE_DISABLED: dispatch is off on this deployment. No job was created and no compute ran.');
  }
  if (status === 503 && code === 'DISPATCH_UNAVAILABLE') {
    return fail('schema', 'Dispatch unavailable', 'The server answered 503 DISPATCH_UNAVAILABLE: the dispatch store/schema is missing on this deployment. This is an activation dependency, not a request error.');
  }
  if (PLACEMENT_CODES.has(code)) {
    return fail('placement', 'Resource not placeable', `The server refused placement (${status} ${code}). Eligibility (ownership, grant, heartbeat liveness) is decided server-side at admission time.`);
  }
  if (BUDGET_CODES.has(code)) {
    return fail('budget', 'Budget exhausted', `The server refused on budget/quota (${status} ${code}).`);
  }
  if (BINDING_CODES.has(code)) {
    return fail('binding', 'Binding refused', `The server refused the binding (${status} ${code}): model, token ceiling, grant revision or admission no longer match.`);
  }
  if (code === 'IDEMPOTENCY_CONFLICT') {
    return fail('conflict', 'Idempotency conflict', 'The same idempotency key was used with a different request body (409 IDEMPOTENCY_CONFLICT). Nothing was resubmitted; reset for a new key.');
  }
  if (FIELD_CODES.has(code) || status === 400) {
    return fail('field', 'Request refused', `The server refused the request shape (${status} ${code || 'no code'}).`);
  }
  if (stage === 'cancel') {
    if (body && body.cancel === 'UNSUPPORTED_CAPABILITY') {
      return { state: 'cancel-unsupported', title: 'Cancel unsupported after start',
        detail: 'The job already started: the contract has no execution-cancel frame, so the cancel intent was recorded and holds stay retained. The remote was not claimed stopped.',
        content: null, resubmit: false };
    }
    if (status === 200 && code === 'CANCELLED') {
      return { state: 'cancelled', title: 'Cancelled before start', detail: 'The start was fenced and holds were released. Nothing ran.', content: null, resubmit: false };
    }
  }
  const opStatus = body && typeof body.status === 'string' ? body.status : '';
  if (opStatus === 'dispatched' || opStatus === 'pending' || code === 'OPERATION_IN_PROGRESS') {
    return { state: opStatus === 'pending' ? 'pending' : 'dispatched', title: 'In progress',
      detail: `Operation is ${opStatus || 'pending'}; observing with bounded status polls (no resubmission).`,
      content: null, resubmit: false, poll: true };
  }
  if (opStatus === 'settled' && body && typeof body.outcome === 'object' && body.outcome !== null) {
    const outcome = body.outcome;
    if (outcome.finish === 'succeeded' && outcome.released === true && typeof outcome.content === 'string') {
      return { state: 'settled', title: 'Settled: content released', detail: 'The operation settled and live authority still held at release.',
        content: outcome.content, resubmit: false,
        provenanceNote: 'Worker-reported content: the server verified it echoes the admitted binding (runtime_instance, model_fingerprint). This is binding equality, not independent attestation.' };
    }
    if (outcome.finish === 'succeeded') {
      return fail('withheld', 'Settled: content withheld',
        `The operation settled but content was NOT released (reason: ${typeof outcome.withheld_reason === 'string' ? outcome.withheld_reason : 'release_not_authorized'}). Withheld output is never shown.`);
    }
    return { state: 'settled', title: `Settled: ${String(outcome.finish)}`,
      detail: 'The operation settled without releasable content. No metrics are shown because none were returned.',
      content: null, resubmit: false };
  }
  if (status === 504 || code === 'DEADLINE_EXCEEDED') {
    return fail('expired', 'Deadline exceeded', 'The deadline passed before the operation could proceed (504 DEADLINE_EXCEEDED).');
  }
  if (status === 503 || UNCERTAIN_CODES.has(code) || opStatus === 'uncertain') {
    return fail('uncertain', 'Outcome uncertain', `The server reports an uncertain outcome (${status} ${code || opStatus}). Holds are retained server-side; this UI stops here and never replays automatically.`);
  }
  if (status === 404) {
    return fail('placement', 'Not found', `The server answered 404 ${code || ''}: unknown, foreign, or unshared resource — existence is not disclosed.`.trim());
  }
  if (status >= 200 && status < 300) {
    return { state: 'ok', title: 'Done', detail: `The server answered ${status} ${code || ''}.`.trim(), content: null, resubmit: false };
  }
  return fail('error', 'Request failed', `The server answered ${status} ${code || 'no code'}. Nothing was resubmitted.`);
}
