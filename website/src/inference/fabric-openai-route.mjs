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
//   candidateProvider - default listReadinessSnapshots (this module: real
//               owner-scoped SQL over resources + node_capabilities, qualified
//               by model-readiness.mjs); tests inject fixed rows.
//   clock/sleep/generateKey/maxWaitMs/pollIntervalMs - injectable bounds.
//
// Model qualification uses ONLY worker-origin evidence (per-runtime model IDs
// inside node_capabilities, server-stamped freshness). capabilities_json
// labels and placement soft-scores are never model inventory. Capacity is
// enforced by admission pools, never invented here.
//
// Idempotency: the idempotency key is looked up BEFORE any placement or
// admission. A recorded key never allocates new admissions/budget: same
// payload reconciles read-only, changed payload keeps IDEMPOTENCY_CONFLICT.
// A supplied malformed key is 400 (never silently replaced); an absent key
// is server-generated for keyless OpenAI clients.
//
// Release: content surfaces only after the coordinator's release decision
// AND a fresh recheckRelease of current authority (post-revocation replays
// withhold). Withheld content never escapes.
//
// A 202 dispatch envelope is NEVER emitted: when the wait budget expires the
// route answers 409 operation_in_progress with correlation for the status
// route, so no SDK can mistake a receipt for a chat completion.
import {
  validateChatCompletionRequest, resolveModel, buildDispatchRequest, buildModelsList,
  noEligibleWorker, mapDispatchResult, mapSettledJobToCompletion, openAIError,
  IDEMPOTENCY_KEY_RE,
} from './fabric-openai.mjs';
import { createDispatchCoordinator, DISPATCH_COORDINATOR_INTERFACE, MAX_DEADLINE_MS } from './dispatch-coordinator.mjs';
import { digestJson } from '../fabric/canonical.mjs';
import { createWorkerTransport } from './worker-transport.mjs';
import { qualifySnapshot, selectModelCandidate, listAdvertisedModels } from './model-readiness.mjs';
import { getDispatchStore } from './dispatch-wiring.mjs';

export const FABRIC_OPENAI_ROUTE_INTERFACE = 'aipster-fabric-openai-route/2';
export const ROUTE_MAX_WAIT_MS = 55000;
export const ROUTE_POLL_MS = 2000;
export const ROUTE_CANDIDATE_LIMIT = 50;
export const ROUTE_MODEL_MAX = 256;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const unavailable = () => ({ http: 503,
  body: openAIError(503, 'dispatch_unavailable', 'Inference dispatch is not available on this deployment.').body });

const uncertain = (phase, code) => ({ http: 503,
  body: { error: { message: `An unknown outcome at phase ${phase} (${code}) was retained with holds; it was not retried automatically and the remote was not claimed stopped.`,
    type: 'server_error', code: code.toLowerCase() },
  automatic_retry: false, remote_stopped: false } });

/**
 * Real owner-scoped readiness snapshot listing. Only rows owned by the
 * verified principal are read (no caller machine/tenant override: the owner
 * id comes from the actor, never the request body). Model inventory comes
 * only from node_capabilities evidence, never capabilities_json labels.
 */
export async function listReadinessSnapshots({ db, principalId, nowMs } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const page = await db.prepare(
    `SELECT r.id, r.owner_id, r.usable, r.online, r.heartbeat_at, c.reported_at, c.runtimes_json
     FROM resources r LEFT JOIN node_capabilities c ON c.node_id = r.id
     WHERE r.owner_id = ? LIMIT ${ROUTE_CANDIDATE_LIMIT}`).bind(principalId).all();
  const rows = page && Array.isArray(page.results) ? page.results : [];
  return rows
    .filter((row) => isObj(row) && typeof row.id === 'string' && row.id)
    .map((row) => qualifySnapshot({
      resourceId: row.id, ownerId: row.owner_id, usable: Number(row.usable) === 1,
      online: Number(row.online) === 1, heartbeatAt: row.heartbeat_at ?? null,
      reportedAt: typeof row.reported_at === 'string' ? row.reported_at : null,
      runtimesJson: typeof row.runtimes_json === 'string' ? row.runtimes_json : null,
    }, { nowMs: now, tenantId: principalId }));
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

// Mirror of the coordinator's bindingOf (dispatch-coordinator.mjs): field for
// field, so the route can recompute the exact request digest for a recorded
// operation. Canonicalization sorts keys, so only values must match.
function bindingPreview(admission, principal, deadlineAt) {
  return {
    admission_ref: admission.admission_ref, principal_id: principal.principal_id, tenant_id: principal.tenant_id,
    grant_id: admission.grant_id, grant_revision: admission.grant_revision,
    resource_id: admission.resource_id, incarnation: admission.incarnation,
    node_id: admission.node_id, runtime_id: admission.runtime_id, runtime_instance: admission.runtime_instance,
    model_id: admission.model_id, model_fingerprint: admission.model_fingerprint,
    pools: admission.pools.map((p) => ({ pool_id: p.pool_id, amount: p.amount })),
    deadline_at: deadlineAt,
  };
}

export function createFabricOpenAIRoute({
  needAuthz, actor, db = null, env = null, getStore = getDispatchStore,
  candidateProvider = listReadinessSnapshots, clock = () => Date.now(),
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

  // Rebuild server-issued admission identity from the durable recorded
  // operation binding when the admission row was swept after expiry.
  // Revalidated with the store's own binding contract (principal/tenant
  // match, identity fields, pools); expires_at is conservatively the
  // recorded op deadline, which never exceeded admission expiry. Never
  // mints placement, budget, or spend — reconcile paths use it for digest
  // and settled-result identity only.
  function admissionFromRecordedBinding(store, principal, recorded) {
    const binding = isObj(recorded) ? recorded.binding : null;
    if (!store || typeof store.validateBinding !== 'function' || !isObj(binding)) return null;
    // The store contract returns strict boolean: false (not a throw) on any
    // rejection, so the return must be required true — not merely no-throw.
    let valid = false;
    try {
      valid = store.validateBinding(binding, principal.principal_id, principal.tenant_id);
    } catch { return null; }
    if (valid !== true) return null;
    return {
      admission_ref: binding.admission_ref, grant_id: binding.grant_id,
      grant_revision: binding.grant_revision, resource_id: binding.resource_id,
      incarnation: binding.incarnation, node_id: binding.node_id,
      runtime_id: binding.runtime_id, runtime_instance: binding.runtime_instance,
      model_id: binding.model_id, model_fingerprint: binding.model_fingerprint,
      pools: binding.pools, expires_at: binding.deadline_at,
    };
  }

  // Surface a settled success ONLY after the coordinator's release decision
  // and a fresh recheck of CURRENT release authority. Withheld or revoked
  // content never escapes, on any path (initial, status, replay, conflict).
  async function mapSettled({ store, principal, opKey, admissionRef, out }) {
    const outcome = isObj(out.outcome) ? out.outcome : {};
    if (outcome.finish !== 'succeeded') return mapDispatchResult(out);
    if (outcome.released === false || (typeof outcome.withheld_reason === 'string' && outcome.withheld_reason)) {
      return { http: 503, body: openAIError(503, 'release_withheld',
        outcome.withheld_reason ? `Settlement succeeded but release was withheld (${outcome.withheld_reason}); no completion is surfaced.`
          : 'Settlement succeeded but the result release was withheld; no completion is surfaced.').body };
    }
    let op = null;
    try {
      op = await store.getOperation({ op_key: opKey });
    } catch {
      return uncertain('release', 'RELEASE_UNKNOWN');
    }
    if (!isObj(op) || !isObj(op.binding)) {
      return { http: 503, body: openAIError(503, 'result_unavailable',
        'The job settled but its operation could not be re-read; no completion is surfaced.').body };
    }
    let recheck = null;
    try {
      recheck = await store.recheckRelease({ op_id: op.op_id, generation: op.generation });
    } catch {
      return uncertain('release', 'RELEASE_UNKNOWN');
    }
    if (!isObj(recheck) || recheck.ok !== true) {
      return { http: 503, body: openAIError(503, 'release_withheld',
        `The current release authority refused surfacing (${isObj(recheck) && typeof recheck.reason === 'string' ? recheck.reason : 'unknown'}); no completion is surfaced.`).body };
    }
    const ref = typeof admissionRef === 'string' && admissionRef
      ? admissionRef : (typeof op.binding.admission_ref === 'string' ? op.binding.admission_ref : null);
    let job = null;
    let admission = null;
    try {
      job = await store.readJob({ job_id: out.job_id });
      admission = ref ? await store.resolveAdmission({ principal: { principal_id: principal.principal_id,
        tenant_id: principal.tenant_id }, admission_ref: ref }) : null;
    } catch {
      return { http: 503, body: openAIError(503, 'result_unavailable',
        'The job settled but its row could not be re-read; no completion is surfaced.').body };
    }
    if (!isObj(admission) && isObj(op)) {
      // Admission row swept after expiry: identity from the durable recorded
      // operation binding (revalidated). Release recheck already passed above.
      admission = admissionFromRecordedBinding(store, principal, op);
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

  // Honest pending receipt: a typed error with correlation, never a 202 and
  // never anything an SDK could parse as a chat completion.
  function pendingReceipt({ opId, jobId, idempotencyKey }) {
    return { http: 409,
      body: { error: { message: 'The operation is still in progress; reconcile it by idempotency key. No completion is available.',
        type: 'invalid_request_error', code: 'operation_in_progress' },
      ...(opId ? { op_id: opId } : {}), ...(jobId ? { job_id: jobId } : {}),
      status_route: `/v1/operations/${idempotencyKey}`, automatic_retry: false } };
  }

  async function handleModels() {
    const auth = await authorized();
    if (auth.denied) return { passthrough: auth.denied };
    if (auth.refusal) return auth.refusal;
    if (!db) return unavailable();
    let snapshots;
    try {
      snapshots = await candidateProvider({ db, principalId: auth.principal.principal_id, nowMs: clock() });
    } catch {
      return unavailable();
    }
    return { http: 200, body: buildModelsList(listAdvertisedModels(snapshots)) };
  }

  async function handleChat({ body, idempotencyKey } = {}) {
    const auth = await authorized();
    if (auth.denied) return { passthrough: auth.denied };
    if (auth.refusal) return auth.refusal;
    const { principal } = auth;
    const checked = validateChatCompletionRequest(body);
    if (!checked.ok) return checked.error;
    // A supplied malformed key is refused, never silently replaced. An
    // absent key is server-generated for keyless OpenAI clients.
    if (idempotencyKey !== undefined && idempotencyKey !== null
      && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey))) {
      return { http: 400, body: openAIError(400, 'invalid_request',
        'Idempotency-Key must match [A-Za-z0-9][A-Za-z0-9._:-]{7,127}.', 'invalid_request_error').body };
    }
    const key = typeof idempotencyKey === 'string' ? idempotencyKey : generateKey();
    if (!IDEMPOTENCY_KEY_RE.test(key)) return unavailable();
    const opKey = JSON.stringify([principal.principal_id, key]);

    let store = null;
    try {
      store = await getStore(env, db);
    } catch { store = null; }
    if (!store) return unavailable();
    const coordinator = coordinatorFor(store, principal);
    const ctx = { route: 'fabric-openai' };

    // Idempotency FIRST: a recorded key never allocates new placement,
    // admissions, or budget. Same payload reconciles read-only; changed
    // payload keeps IDEMPOTENCY_CONFLICT.
    let recorded = null;
    try {
      recorded = await store.getOperation({ op_key: opKey });
    } catch {
      return uncertain('lookup', 'AUTHORITY_UNAVAILABLE');
    }
    // Reconcile against a RECORDED operation (replay, or the loser of a
    // concurrent first-request race on the same key). Never mints new
    // admissions, placement or spend; a changed payload stays a conflict.
    const replayRecorded = async (recorded) => {
      const storedRef = isObj(recorded.binding) && typeof recorded.binding.admission_ref === 'string'
        ? recorded.binding.admission_ref : null;
      let admission = null;
      try {
        admission = storedRef ? await store.resolveAdmission({ principal: { principal_id: principal.principal_id,
          tenant_id: principal.tenant_id }, admission_ref: storedRef }) : null;
      } catch {
        return uncertain('lookup', 'AUTHORITY_UNAVAILABLE');
      }
      if (!isObj(admission) && isObj(recorded)) {
        // Admission row swept after expiry: rebuild server-issued identity
        // from the durable recorded binding (revalidated). Digest, deadline,
        // and reconcile logic below are unchanged, so a replay can only
        // reconcile — never a new admission, spend, or job.
        admission = admissionFromRecordedBinding(store, principal, recorded);
      }
      if (!isObj(admission)) {
        return { http: 403, body: openAIError(403, 'admission_not_available',
          'The recorded admission is no longer available.', 'invalid_request_error').body };
      }
      const resolved = resolveModel(checked.value.model, admission);
      if (!resolved.ok) return resolved.error;
      const nowMs = clock();
      // Replay reuses the RECORDED deadline: a fresh deadline would change the
      // request digest and turn every same-payload retry into a conflict.
      const storedDeadline = isObj(recorded.binding) && Number.isSafeInteger(recorded.binding.deadline_at)
        ? recorded.binding.deadline_at : NaN;
      const deadline_at = Math.min(storedDeadline, admission.expires_at);
      let dispatchBody;
      try {
        dispatchBody = buildDispatchRequest({ content: checked.value.content, max_tokens: checked.value.max_tokens },
          { admission_ref: admission.admission_ref, idempotency_key: key, deadline_at, model_id: resolved.value });
      } catch {
        return { http: 400, body: openAIError(400, 'invalid_request', 'The dispatch request was malformed.', 'invalid_request_error').body };
      }
      // Payload binding holds even after the deadline: recompute the exact
      // request digest and compare it with the recorded operation BEFORE any
      // submit or reconcile. A changed payload keeps IDEMPOTENCY_CONFLICT
      // with zero new admissions; only a digest-equal replay may reconcile.
      let candidateDigest = null;
      try {
        candidateDigest = await digestJson({ v: DISPATCH_COORDINATOR_INTERFACE,
          binding: bindingPreview(admission, principal, deadline_at), body: dispatchBody });
      } catch {
        candidateDigest = null;
      }
      if (typeof recorded.request_digest !== 'string' || candidateDigest !== recorded.request_digest) {
        return mapDispatchResult({ status: 'rejected', code: 'IDEMPOTENCY_CONFLICT', http: 409, op_id: recorded.op_id });
      }
      if (!(storedDeadline > nowMs)) {
        // Same payload, expired deadline: read-only reconcile, never resubmit.
        const rec = await coordinator.reconcile(ctx, key);
        if (isObj(rec) && rec.status === 'settled') {
          return mapSettled({ store, principal, opKey, admissionRef: admission.admission_ref, out: rec });
        }
        return mapDispatchResult(rec);
      }
      const out = await coordinator.submit(ctx, dispatchBody);
      if (isObj(out) && out.status === 'settled') {
        return mapSettled({ store, principal, opKey, admissionRef: admission.admission_ref, out });
      }
      if (isObj(out) && out.status === 'dispatched') {
        return pollToTerminal({ store, principal, coordinator, ctx, key, opKey,
          admissionRef: admission.admission_ref, deadline_at, out });
      }
      return mapDispatchResult(out);
    };
    if (isObj(recorded)) return replayRecorded(recorded);
    // New operation: strict readiness selection FIRST, so unadvertised models
    // never reach issueAdmission (the owner issuance path does not validate
    // model residency; this layer is the residency gate).
    const nowMs = clock();
    let snapshots;
    try {
      snapshots = await candidateProvider({ db, principalId: principal.principal_id, nowMs });
    } catch {
      return unavailable();
    }
    let selection;
    try {
      selection = selectModelCandidate(snapshots, { tenantId: principal.principal_id,
        ...(checked.value.model === null ? {} : { model: checked.value.model }) });
    } catch {
      return { http: 400, body: openAIError(400, 'invalid_request', 'The placement request was malformed.', 'invalid_request_error').body };
    }
    if (!selection || !selection.selected) {
      if (selection && selection.code === 'MODEL_NOT_ADVERTISED') {
        return { http: 404, body: openAIError(404, 'model_not_found',
          selection.reason, 'invalid_request_error').body };
      }
      const err = noEligibleWorker(checked.value.model);
      return { http: err.http, body: err.body };
    }

    let admission;
    try {
      admission = await store.issueAdmission({ principal: { principal_id: principal.principal_id,
        tenant_id: principal.tenant_id }, resource_id: selection.selected.resourceId,
      model_id: selection.selected.modelId, max_tokens: checked.value.max_tokens,
      runtime_id: selection.selected.runtimeId });
    } catch (err) {
      return issuanceError(err);
    }
    if (!isObj(admission) || typeof admission.admission_ref !== 'string') return unavailable();

    const resolved = resolveModel(checked.value.model, admission);
    if (!resolved.ok) return resolved.error;

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

    const out = await coordinator.submit(ctx, dispatchBody);
    if (isObj(out) && out.status === 'settled') {
      return mapSettled({ store, principal, opKey, admissionRef: admission.admission_ref, out });
    }
    if (isObj(out) && out.status === 'rejected' && out.code === 'IDEMPOTENCY_CONFLICT') {
      // Concurrent first requests on one key: the lookup above saw nothing,
      // both minted an admission, and the other request's claim won. Re-read
      // the durable operation and reconcile against IT (its admission and
      // deadline); only a digest-equal payload reconciles, a changed one
      // keeps the conflict. This request's unclaimed admission carries no
      // hold or spend and ages out at its TTL.
      let raced = null;
      try {
        raced = await store.getOperation({ op_key: opKey });
      } catch {
        raced = null;
      }
      if (isObj(raced) && isObj(raced.binding) && raced.binding.admission_ref !== admission.admission_ref) {
        return replayRecorded(raced);
      }
      return mapDispatchResult(out);
    }
    if (!isObj(out) || out.status !== 'dispatched') return mapDispatchResult(out);
    return pollToTerminal({ store, principal, coordinator, ctx, key, opKey,
      admissionRef: admission.admission_ref, deadline_at, out });
  }

  async function pollToTerminal({ store, principal, coordinator, ctx, key, opKey, admissionRef, deadline_at, out }) {
    let current = out;
    // Bounded reconciliation that never polls at or past the request
    // deadline. Budget expiry answers 409 operation_in_progress with
    // correlation, never a 202 receipt.
    // eslint-disable-next-line no-await-in-loop
    while (clock() < deadline_at) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline_at - clock())));
      if (clock() >= deadline_at) break;
      // eslint-disable-next-line no-await-in-loop
      current = await coordinator.reconcile(ctx, key);
      if (!isObj(current) || current.status !== 'dispatched') break;
    }
    if (!isObj(current) || current.status === 'dispatched') {
      return pendingReceipt({ opId: current && current.op_id, jobId: current && current.job_id, idempotencyKey: key });
    }
    if (current.status === 'settled') {
      return mapSettled({ store, principal, opKey, admissionRef, out: current });
    }
    return mapDispatchResult(current);
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
    const opKey = JSON.stringify([auth.principal.principal_id, idempotencyKey]);
    const coordinator = coordinatorFor(store, auth.principal);
    const out = await coordinator.reconcile({ route: 'fabric-openai' }, idempotencyKey);
    if (isObj(out) && out.status === 'settled' && isObj(out.outcome) && out.outcome.finish === 'succeeded') {
      // The recorded view carries no content: re-verify the settled job row
      // AND current release authority from durable state before surfacing.
      const op = await store.getOperation({ op_key: opKey }).catch(() => null);
      const admissionRef = op && isObj(op.binding) ? op.binding.admission_ref : null;
      if (typeof admissionRef === 'string' && admissionRef) {
        return mapSettled({ store, principal: auth.principal, opKey, admissionRef, out });
      }
    }
    if (isObj(out) && out.status === 'dispatched') {
      return pendingReceipt({ opId: out.op_id, jobId: out.job_id, idempotencyKey });
    }
    return mapDispatchResult(out);
  }

  return Object.freeze({ interface: FABRIC_OPENAI_ROUTE_INTERFACE, handleModels, handleChat, handleStatus });
}
