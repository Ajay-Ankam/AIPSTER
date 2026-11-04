// FABRIC067: real fabric OpenAI route handler (owned by FABRIC067).
//
// This module performs actual I/O through the EXISTING scoped inventory,
// admission, placement and dispatch-store APIs. It is-imported, not wired:
// WEB066 applies the exact minimal insertion in worker.js (see
// docs/fabric-openai067-integration-contract.md) that constructs
// createFabricOpenAIRoute with the worker's own verified actor/context.
//
// Dependencies (exact, all injected or existing):
//   needAuthz - the worker.js authorization closure (reused verbatim; no
//               alternate auth authority is invented here). Returns null when
//               allowed, or a ready-to-return Response when denied.
//   actor     - the worker's verified actor {kind, user:{id}, key?:{scope}}.
//   db, env   - D1 database and worker env (for getDispatchStore).
//   getStore  - default getDispatchStore (dispatch-wiring.mjs); tests inject
//               a deterministic fixture store with the SAME method names.
//   candidateProvider - default listOwnerCandidates (this module, real SQL
//               over the resources table); tests inject fixed rows.
//   clock/sleep/generateKey/maxWaitMs/pollIntervalMs - injectable bounds.
//
// Flow per chat request: auth -> bounded validation -> fresh owner-scoped
// candidates -> server-side selectPlacement -> real store.issueAdmission ->
// real coordinator submit -> bounded reconcile poll -> verified settlement
// mapping. Grant-shared resources are NOT served by this initial route: the
// placement selector excludes non-owned provenance, which surfaces as an
// honest 409 no_eligible_worker (documented, not silent).
//
// A 202 dispatch envelope is an interim fabric receipt and is NEVER
// presented as an OpenAI chat completion.
import {
  validateChatCompletionRequest, resolveModel, buildDispatchRequest, buildModelsList,
  noEligibleWorker, mapDispatchResult, mapSettledJobToCompletion, openAIError,
  IDEMPOTENCY_KEY_RE,
} from './fabric-openai.mjs';
import { createDispatchCoordinator, MAX_DEADLINE_MS } from './dispatch-coordinator.mjs';
import { createWorkerTransport } from './worker-transport.mjs';
import { selectPlacement } from './placement-binding.mjs';
import { getDispatchStore } from './dispatch-wiring.mjs';
import { resourceLiveness } from '../lib/status.mjs';

export const FABRIC_OPENAI_ROUTE_INTERFACE = 'aipster-fabric-openai-route/1';
export const ROUTE_MAX_WAIT_MS = 60000;
export const ROUTE_POLL_MS = 2000;
export const ROUTE_CANDIDATE_LIMIT = 50;
export const ROUTE_MODEL_MAX = 256;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= ROUTE_MODEL_MAX;

const unavailable = () => ({ http: 503,
  body: openAIError(503, 'dispatch_unavailable', 'Inference dispatch is not available on this deployment.').body });

function modelTokensOf(row) {
  try {
    const parsed = JSON.parse(row.capabilities_json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isId).slice(0, 20);
  } catch {
    return [];
  }
}

function ageMs(heartbeatAt, liveness, nowMs) {
  if (liveness !== 'online' && liveness !== 'stale') return null;
  const seen = Date.parse(heartbeatAt);
  if (!Number.isFinite(seen)) return null;
  return Math.max(0, nowMs - seen);
}

/**
 * Real owner-scoped candidate listing over the resources table. Only rows
 * owned by the principal are read (no caller machine/tenant override: the
 * owner id comes from the verified actor, never the request body).
 */
export async function listOwnerCandidates({ db, principalId, nowMs, model = null } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const page = await db.prepare(
    `SELECT id, capabilities_json, online, heartbeat_at, usable FROM resources WHERE owner_id = ? LIMIT ${ROUTE_CANDIDATE_LIMIT}`)
    .bind(principalId).all();
  const rows = page && Array.isArray(page.results) ? page.results : [];
  const candidates = [];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    const liveness = resourceLiveness(
      { online: Number(row.online) === 1, heartbeatAt: row.heartbeat_at ?? null }, now);
    const modelIds = modelTokensOf(row);
    candidates.push({
      resourceId: row.id, ownerId: principalId, via: { owned: true }, liveness,
      lastSeenAgeMs: ageMs(row.heartbeat_at ?? null, liveness, now),
      usable: Number(row.usable) === 1,
      modelIds,
      exactTokenMatch: typeof model === 'string' && model.length > 0 ? modelIds.includes(model) : false,
    });
  }
  return candidates;
}

const defaultGenerateKey = () => {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch { /* fall through to the counter shape below */ }
  return `op-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 31).toString(36)}`;
};

function principalOf(actor) {
  if (!isObj(actor) || !isObj(actor.user) || typeof actor.user.id !== 'string' || !actor.user.id) return null;
  if (actor.kind === 'session') return { principal_id: actor.user.id, tenant_id: actor.user.id, actor_kind: 'session' };
  if (actor.kind === 'key' && isObj(actor.key) && typeof actor.key.scope === 'string') {
    return { principal_id: actor.user.id, tenant_id: actor.user.id, actor_kind: 'key', key_scope: actor.key.scope };
  }
  return null;
}

export function createFabricOpenAIRoute({
  needAuthz, actor, db = null, env = null, getStore = getDispatchStore,
  candidateProvider = listOwnerCandidates, clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  generateKey = defaultGenerateKey, maxWaitMs = ROUTE_MAX_WAIT_MS, pollIntervalMs = ROUTE_POLL_MS,
} = {}) {
  if (typeof needAuthz !== 'function') throw new TypeError('createFabricOpenAIRoute requires needAuthz');
  if (!isObj(actor)) throw new TypeError('createFabricOpenAIRoute requires the verified actor');

  const coordinatorFor = (store, principal) => createDispatchCoordinator({
    resolvePrincipal: async () => principal,
    authority: store,
    transport: createWorkerTransport(store),
    now: clock,
  });

  async function authorized() {
    const denied = needAuthz('inference');
    if (denied) return { denied };
    const principal = principalOf(actor);
    if (!principal) {
      return { denied: null, refusal: { http: 401,
        body: openAIError(401, 'auth_required', 'Sign-in or API key required.', 'invalid_request_error').body } };
    }
    return { denied: null, principal };
  }

  function issuanceError(err) {
    const status = err && Number.isSafeInteger(err.status) ? err.status : 503;
    const code = err && typeof err.code === 'string' ? err.code : 'DISPATCH_UNAVAILABLE';
    if (code === 'NO_MATCHING_GRANT' || code === 'RESOURCE_NOT_FOUND') {
      return { http: 404, body: openAIError(404, 'not_found',
        'Resource not found or not shared with you.', 'invalid_request_error').body };
    }
    if (status === 429) {
      return { http: 429, body: openAIError(429, code.toLowerCase(),
        err && typeof err.message === 'string' ? err.message : 'Capacity is exhausted for this request.', 'server_error').body };
    }
    if (status === 400 || status === 403) {
      return { http: status, body: openAIError(status, code.toLowerCase(),
        err && typeof err.message === 'string' ? err.message : 'The admission was refused.', 'invalid_request_error').body };
    }
    return unavailable();
  }

  async function mapSettled({ store, principal, admissionRef, out }) {
    const outcome = isObj(out.outcome) ? out.outcome : {};
    if (outcome.finish !== 'succeeded') {
      return mapDispatchResult(out);
    }
    // Content is NEVER taken from the recorded view (it carries none): the
    // completion comes only from the re-verified durable job row below.
    let job = null;
    let admission = null;
    try {
      job = await store.readJob({ job_id: out.job_id });
      admission = await store.resolveAdmission({ principal: { principal_id: principal.principal_id,
        tenant_id: principal.tenant_id }, admission_ref: admissionRef });
    } catch {
      return { http: 503, body: openAIError(503, 'result_unavailable',
        'The job settled but its row could not be re-read; no completion is surfaced.').body };
    }
    if (!isObj(job) || !isObj(admission)) {
      return { http: 503, body: openAIError(503, 'result_unavailable',
        'The job settled but its row could not be re-read; no completion is surfaced.').body };
    }
    // Binding identity is rebuilt from the SERVER-ISSUED admission record,
    // never from the request body or the client.
    const binding = { node_id: admission.node_id, runtime_id: admission.runtime_id,
      model_id: admission.model_id, runtime_instance: admission.runtime_instance,
      model_fingerprint: admission.model_fingerprint };
    const mapped = mapSettledJobToCompletion(job, binding, { created: Math.floor(clock() / 1000) });
    if (!mapped.ok) return { http: mapped.error.http, body: mapped.error.body };
    return { http: 200, body: mapped.value };
  }

  async function handleModels() {
    const auth = await authorized();
    if (auth.denied) return { passthrough: auth.denied };
    if (auth.refusal) return auth.refusal;
    if (!db) return unavailable();
    let candidates;
    try {
      candidates = await candidateProvider({ db, principalId: auth.principal.principal_id, nowMs: clock() });
    } catch {
      return unavailable();
    }
    const entries = [];
    for (const c of Array.isArray(candidates) ? candidates : []) {
      if (!isObj(c) || !Array.isArray(c.modelIds)) continue;
      for (const model_id of c.modelIds) {
        entries.push({ model_id, usable: c.usable === true, liveness: c.liveness });
      }
    }
    return { http: 200, body: buildModelsList(entries) };
  }

  async function handleChat({ body, idempotencyKey } = {}) {
    const auth = await authorized();
    if (auth.denied) return { passthrough: auth.denied };
    if (auth.refusal) return auth.refusal;
    const { principal } = auth;
    const checked = validateChatCompletionRequest(body);
    if (!checked.ok) return checked.error;
    let store = null;
    try {
      store = await getStore(env, db);
    } catch { store = null; }
    if (!store) return unavailable();

    const nowMs = clock();
    let candidates;
    try {
      candidates = await candidateProvider({ db, principalId: principal.principal_id, nowMs, model: checked.value.model });
    } catch {
      return unavailable();
    }
    let selection;
    try {
      // The selector's clock is the route clock: without nowMs it would read
      // the wall clock and wrongly refuse a well-formed deadline in tests and
      // in any deployment whose request clock differs.
      selection = selectPlacement(candidates, { tenantId: principal.principal_id,
        ...(checked.value.model === null ? {} : { model: checked.value.model }),
        maxTokens: checked.value.max_tokens, deadlineMs: nowMs + maxWaitMs }, { nowMs });
    } catch {
      return { http: 400, body: openAIError(400, 'invalid_request', 'The placement request was malformed.', 'invalid_request_error').body };
    }
    if (!selection || !selection.selected) {
      const err = noEligibleWorker(checked.value.model);
      return { http: err.http, body: err.body };
    }
    const winner = (Array.isArray(candidates) ? candidates : [])
      .find((c) => isObj(c) && c.resourceId === selection.selected.resourceId);
    const advertised = isObj(winner) && Array.isArray(winner.modelIds) ? winner.modelIds.filter(isId) : [];
    const modelForAdmission = checked.value.model !== null ? checked.value.model : (advertised[0] ?? null);
    if (modelForAdmission === null) {
      const err = noEligibleWorker(null);
      return { http: err.http, body: err.body };
    }

    let admission;
    try {
      admission = await store.issueAdmission({ principal: { principal_id: principal.principal_id,
        tenant_id: principal.tenant_id }, resource_id: selection.selected.resourceId,
      model_id: modelForAdmission, max_tokens: checked.value.max_tokens,
      runtime_id: selection.selected.binding.runtimeId });
    } catch (err) {
      return issuanceError(err);
    }
    if (!isObj(admission) || typeof admission.admission_ref !== 'string') return unavailable();

    const resolved = resolveModel(checked.value.model, admission);
    if (!resolved.ok) return resolved.error;

    const key = typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY_RE.test(idempotencyKey)
      ? idempotencyKey : generateKey();
    if (!IDEMPOTENCY_KEY_RE.test(key)) return unavailable();
    const deadline_at = Math.min(nowMs + maxWaitMs, admission.expires_at, nowMs + MAX_DEADLINE_MS);
    if (!(deadline_at > nowMs)) {
      return { http: 504, body: openAIError(504, 'deadline_exceeded', 'The deadline passed before dispatch; nothing was dispatched.').body };
    }

    let dispatchBody;
    try {
      dispatchBody = buildDispatchRequest({ content: checked.value.content, max_tokens: checked.value.max_tokens },
        { admission_ref: admission.admission_ref, idempotency_key: key, deadline_at, model_id: resolved.value });
    } catch {
      return { http: 400, body: openAIError(400, 'invalid_request', 'The dispatch request was malformed.', 'invalid_request_error').body };
    }

    const coordinator = coordinatorFor(store, principal);
    const ctx = { route: 'fabric-openai' };
    const opKey = JSON.stringify([principal.principal_id, key]);
    const mapRecordedSettled = async (rec) => {
      if (!isObj(rec) || rec.status !== 'settled' || !isObj(rec.outcome) || rec.outcome.finish !== 'succeeded') {
        return mapDispatchResult(rec);
      }
      // The recorded view carries no content: re-verify the settled job row
      // from durable state before surfacing anything.
      const op = await store.getOperation({ op_key: opKey }).catch(() => null);
      const ref = op && isObj(op.binding) ? op.binding.admission_ref : null;
      if (typeof ref !== 'string' || !ref) return mapDispatchResult(rec);
      return mapSettled({ store, principal, admissionRef: ref, out: rec });
    };

    let out = await coordinator.submit(ctx, dispatchBody);
    // Replay of the same key never redispatches: a digest conflict means the
    // key already names a recorded operation, so reconcile that record
    // read-only instead of minting more work.
    if (isObj(out) && out.status === 'rejected' && out.code === 'IDEMPOTENCY_CONFLICT') {
      return mapRecordedSettled(await coordinator.reconcile(ctx, key));
    }
    // Replay of a settled key reconciles to the recorded operation: re-verify
    // and map it exactly like the poll path, never redispatching.
    if (isObj(out) && out.status === 'settled') {
      return mapSettled({ store, principal, admissionRef: admission.admission_ref, out });
    }
    if (!isObj(out) || out.status !== 'dispatched') return mapDispatchResult(out);

    // Bounded reconciliation: poll until terminal or the wait budget. The loop
    // never polls at or past the request deadline: reaching the budget while
    // still dispatched returns the honest 202 fabric receipt keyed for later
    // reconcile, never a completion, and never manufactures a deadline fault.
    // eslint-disable-next-line no-await-in-loop
    while (clock() < deadline_at) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline_at - clock())));
      if (clock() >= deadline_at) break;
      // eslint-disable-next-line no-await-in-loop
      out = await coordinator.reconcile(ctx, key);
      if (!isObj(out) || out.status !== 'dispatched') break;
    }
    if (!isObj(out) || out.status === 'dispatched') {
      return mapDispatchResult({ status: 'dispatched', op_id: out && out.op_id, job_id: out && out.job_id });
    }
    if (out.status === 'settled') {
      return mapSettled({ store, principal, admissionRef: admission.admission_ref, out });
    }
    return mapDispatchResult(out);
  }

  async function handleStatus({ idempotencyKey } = {}) {
    const auth = await authorized();
    if (auth.denied) return { passthrough: auth.denied };
    if (auth.refusal) return auth.refusal;
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return { http: 400, body: openAIError(400, 'invalid_request', 'A valid idempotency key is required.', 'invalid_request_error').body };
    }
    let store = null;
    try {
      store = await getStore(env, db);
    } catch { store = null; }
    if (!store) return unavailable();
    const coordinator = coordinatorFor(store, auth.principal);
    const out = await coordinator.reconcile({ route: 'fabric-openai' }, idempotencyKey);
    if (isObj(out) && out.status === 'settled' && isObj(out.outcome) && out.outcome.finish === 'succeeded') {
      // The recorded view carries no content: re-verify the settled job row
      // from durable state before surfacing anything.
      const op = await store.getOperation({ op_key: JSON.stringify([auth.principal.principal_id, idempotencyKey]) })
        .catch(() => null);
      const admissionRef = op && isObj(op.binding) ? op.binding.admission_ref : null;
      if (typeof admissionRef === 'string' && admissionRef) {
        return mapSettled({ store, principal: auth.principal, admissionRef, out });
      }
    }
    return mapDispatchResult(out);
  }

  return Object.freeze({ interface: FABRIC_OPENAI_ROUTE_INTERFACE, handleModels, handleChat, handleStatus });
}
