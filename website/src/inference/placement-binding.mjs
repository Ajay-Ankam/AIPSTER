// Opt-in placement/binding validation for admitted dispatch (offline slice).
//
// Narrowly callable server-side helpers. Pure functions only: no I/O, no D1,
// no fetch, no grants, no admissions, no transport. Nothing here executes,
// authorizes, reserves, or dispatches; the caller (today: nobody — worker.js
// wiring is reserved to the separate integrator) must still mint an admission
// through the existing authority (`POST /api/inference/admissions`) and drive
// the coordinator. Selecting or validating a binding is never execution.
//
// Contract grounding (all at baseline, read — never redefined here):
// - Bound placement is CPU-only: `encodeBoundCpuTask` accepts exactly
//   `{device: 'cpu', nodeId, runtimeId}` (eif-task-contract.mjs). There is no
//   qualified GPU bound path, so a GPU (or any non-cpu) device is refused
//   with DEVICE_UNSUPPORTED, never silently fallen back to cpu.
// - Runtime allowlist is exactly `ganglion | llama-server`
//   (dispatch-store.mjs INFERENCE_RUNTIME_IDS; worker.js admissions route
//   refuses anything else with BAD_RUNTIME before the store is consulted).
// - Freshness is heartbeat freshness: `resourceLiveness` over STALE_AFTER_MS
//   (lib/status.mjs). Admission itself requires `online`; this module applies
//   the same bar to selection so a stale/unknown row can never be picked.
// - Model compatibility is ALWAYS 'unverified' (routing/eligibility.mjs):
//   an exact capability-token match is a labeled scoring signal, never proof
//   of compatibility and never an exclusion. The selection receipt carries
//   `modelCompat: 'unverified'` so it cannot be mistaken for readiness proof.
// - Scoring weights mirror routing/policy.mjs route/v1 (EXACT_TOKEN 50,
//   ONLINE 30, FRESHNESS_MAX 20, OWNED 10, HEADROOM 5). Tie-break is plain
//   resourceId order (deterministic); it differs deliberately from the
//   router's numeric-aware alias compare because it orders resource ids, and
//   it is pinned under a distinct PLACEMENT_SELECTOR_VERSION so a selection
//   can never be confused with a route/v1 routing decision.
import { STALE_AFTER_MS } from '../lib/status.mjs';

export const PLACEMENT_BINDING_INTERFACE = 'aipster-placement-binding/1';
export const PLACEMENT_SELECTOR_VERSION = 'placement/v1';
export const PLACEMENT_DEVICES = Object.freeze(['cpu']);
export const PLACEMENT_RUNTIMES = Object.freeze(['ganglion', 'llama-server']);
export const DEFAULT_PLACEMENT_RUNTIME_ID = 'ganglion';
export const PLACEMENT_MAX_TOKENS = 4096;

const SCORE = Object.freeze({ EXACT_TOKEN: 50, ONLINE: 30, FRESHNESS_MAX: 20, OWNED: 10, HEADROOM: 5 });
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_RE = /^.{1,256}$/s;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isId = (x) => typeof x === 'string' && ID_RE.test(x);

const denied = (code, reason, http) => ({ ok: false, code, reason, http });

/**
 * Validate one explicit placement binding against fresh evidence.
 *
 * @param {{device:string,nodeId:string,runtimeId:string,modelId?:string}} binding
 * @param {{liveness:string,lastSeenAgeMs?:number|null,usable?:boolean,tenantMatch?:boolean}} evidence
 * @returns {{ok:true,value:object}|{ok:false,code:string,reason:string,http:number}}
 */
export function validatePlacementBinding(binding, evidence) {
  if (!isObj(binding) || !isObj(evidence)) {
    return denied('INVALID_BINDING_SHAPE', 'Binding and evidence must be objects.', 400);
  }
  // No silent fallback: anything that is not exactly cpu has no qualified
  // bound path today (GPU included).
  if (binding.device !== 'cpu') {
    return denied('DEVICE_UNSUPPORTED',
      `Device ${JSON.stringify(binding.device)} has no qualified bound path; only "cpu" is supported. No fallback was applied.`, 400);
  }
  if (!PLACEMENT_RUNTIMES.includes(binding.runtimeId)) {
    return denied('RUNTIME_UNSUPPORTED',
      `Runtime ${JSON.stringify(binding.runtimeId)} is not one of: ${PLACEMENT_RUNTIMES.join(', ')}.`, 400);
  }
  if (!isId(binding.nodeId)) return denied('INVALID_BINDING_ID', 'nodeId must be an id-shaped string.', 400);
  if (binding.modelId !== undefined && !(typeof binding.modelId === 'string' && MODEL_RE.test(binding.modelId))) {
    return denied('INVALID_BINDING_ID', 'modelId must be a non-empty string of at most 256 characters.', 400);
  }
  // Fail closed: tenant scope must be positively evidenced, never assumed.
  if (evidence.tenantMatch !== true) {
    return denied('TENANT_MISMATCH', 'Tenant scope was not evidenced for this binding.', 403);
  }
  if (evidence.usable !== true) {
    return denied('RESOURCE_NOT_USABLE', 'The bound resource is not marked usable.', 409);
  }
  if (evidence.liveness === 'stale') {
    return denied('STALE_BINDING', 'The bound resource heartbeat is stale; no binding was issued.', 409);
  }
  if (evidence.liveness !== 'online') {
    return denied('UNREACHABLE_BINDING', 'The bound resource is not online; no binding was issued.', 409);
  }
  // Evidence disagreement fails closed: an "online" label older than the
  // freshness window is treated as stale regardless of the label.
  if (Number.isFinite(evidence.lastSeenAgeMs) && evidence.lastSeenAgeMs > STALE_AFTER_MS) {
    return denied('STALE_BINDING', 'Heartbeat age exceeds the freshness window; no binding was issued.', 409);
  }
  return {
    ok: true,
    value: {
      interface: PLACEMENT_BINDING_INTERFACE,
      device: 'cpu',
      nodeId: binding.nodeId,
      runtimeId: binding.runtimeId,
      ...(binding.modelId === undefined ? {} : { modelId: binding.modelId }),
      evidence: {
        liveness: 'online',
        lastSeenAgeMs: Number.isFinite(evidence.lastSeenAgeMs) ? evidence.lastSeenAgeMs : null,
        modelCompat: 'unverified',
      },
    },
  };
}

function scoreCandidate(c, maxTokens) {
  const contributions = [];
  const give = (feature, points, detail) => contributions.push({ feature, points, detail });
  give('exactTokenMatch', c.exactTokenMatch === true ? SCORE.EXACT_TOKEN : 0,
    c.exactTokenMatch === true ? 'model string equals a capability token (soft signal only)' : 'no exact token match');
  give('online', c.liveness === 'online' ? SCORE.ONLINE : 0, `liveness=${c.liveness}`);
  const fresh = c.lastSeenAgeMs === null || c.lastSeenAgeMs === undefined ? 0
    : Math.max(0, SCORE.FRESHNESS_MAX - Math.floor(c.lastSeenAgeMs / 60000));
  give('freshness', fresh,
    c.lastSeenAgeMs === null || c.lastSeenAgeMs === undefined ? 'no heartbeat age' : `heartbeat age ${c.lastSeenAgeMs}ms`);
  const owned = !!(c.via && c.via.owned);
  give('owned', owned ? SCORE.OWNED : 0, owned ? 'owner-direct, no grant hop' : 'via grant');
  const remaining = c.capacity ? Number(c.capacity.tokensRemaining) : null;
  const headroom = Number.isSafeInteger(remaining) && Number.isSafeInteger(maxTokens) && maxTokens > 0
    && remaining >= 2 * maxTokens;
  give('headroom', headroom ? SCORE.HEADROOM : 0,
    remaining === null ? 'capacity unknown' : `tokensRemaining=${remaining}`);
  return { score: contributions.reduce((s, x) => s + x.points, 0), contributions };
}

function exclude(candidates, code, reason) {
  return {
    interface: PLACEMENT_BINDING_INTERFACE,
    version: PLACEMENT_SELECTOR_VERSION,
    code,
    reason,
    selected: null,
    examined: candidates.length,
    excluded: candidates.map((c) => ({
      resourceId: c && typeof c.resourceId === 'string' ? c.resourceId : null,
      reason: code,
    })),
  };
}

/**
 * Deterministically select one placement from caller-supplied, already
 * authorized candidate descriptors (routing `buildDescriptor` shape).
 * Opt-in and advisory: the result carries no authority and must still pass
 * admission + coordinator before anything executes.
 *
 * @param {object[]} candidates
 * @param {{tenantId:string,model?:string|null,maxTokens?:number|null,device?:string,runtimeId?:string,deadlineMs?:number|null}} request
 * @param {{nowMs?:number}} opts
 */
export function selectPlacement(candidates, request, opts = {}) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array.');
  if (!isObj(request) || typeof request.tenantId !== 'string' || request.tenantId.length === 0) {
    throw new Error('request.tenantId is required.');
  }
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const device = request.device === undefined ? 'cpu' : request.device;
  const runtimeId = request.runtimeId === undefined ? DEFAULT_PLACEMENT_RUNTIME_ID : request.runtimeId;
  const maxTokens = request.maxTokens === undefined || request.maxTokens === null ? null : request.maxTokens;
  if (maxTokens !== null && !(Number.isSafeInteger(maxTokens) && maxTokens >= 1 && maxTokens <= PLACEMENT_MAX_TOKENS)) {
    throw new Error('request.maxTokens must be an integer in 1..4096.');
  }
  // Device/runtime gates first: never evaluate candidates past an
  // unsupported placement, and never fall back to a different one.
  if (device !== 'cpu') {
    return exclude(candidates, 'DEVICE_UNSUPPORTED',
      `Device ${JSON.stringify(device)} has no qualified bound path; only "cpu" is supported. No fallback was applied.`);
  }
  if (!PLACEMENT_RUNTIMES.includes(runtimeId)) {
    return exclude(candidates, 'RUNTIME_UNSUPPORTED',
      `Runtime ${JSON.stringify(runtimeId)} is not one of: ${PLACEMENT_RUNTIMES.join(', ')}.`);
  }
  if (Number.isSafeInteger(request.deadlineMs) && nowMs >= request.deadlineMs) {
    return exclude(candidates, 'DEADLINE_EXCEEDED', 'The selection deadline passed; nothing was selected and nothing was held.');
  }

  const eligible = [];
  const excluded = [];
  for (const c of candidates) {
    if (!isObj(c) || typeof c.resourceId !== 'string' || c.resourceId.length === 0) {
      excluded.push({ resourceId: null, reason: 'MALFORMED_ROW' });
      continue;
    }
    // Owned rows re-pin tenant scope here; granted rows were authorized
    // upstream via their grant and carry no tenant field to re-check, so
    // they are recorded as-is instead of being re-verified into a refusal.
    if (c.via && c.via.owned === true && c.ownerId !== request.tenantId) {
      excluded.push({ resourceId: c.resourceId, reason: 'TENANT_MISMATCH' });
      continue;
    }
    if (c.liveness !== 'online' && c.liveness !== 'stale') {
      excluded.push({ resourceId: c.resourceId, reason: 'UNREACHABLE' });
      continue;
    }
    if (c.liveness === 'stale') {
      excluded.push({ resourceId: c.resourceId, reason: 'STALE_TELEMETRY' });
      continue;
    }
    if (c.usable !== true) {
      excluded.push({ resourceId: c.resourceId, reason: 'NOT_USABLE' });
      continue;
    }
    if (maxTokens !== null && c.capacity) {
      const remaining = Number(c.capacity.tokensRemaining);
      if (Number.isSafeInteger(remaining) && maxTokens > remaining) {
        excluded.push({ resourceId: c.resourceId, reason: 'CAPACITY_INSUFFICIENT' });
        continue;
      }
    }
    // Model token match is scoring-only (soft signal): it never excludes and
    // compat stays 'unverified' even for an exact match.
    const { score, contributions } = scoreCandidate(c, maxTokens);
    eligible.push({ candidate: c, score, contributions });
  }
  eligible.sort((a, b) => (b.score - a.score)
    || (a.candidate.resourceId < b.candidate.resourceId ? -1 : a.candidate.resourceId > b.candidate.resourceId ? 1 : 0));

  if (eligible.length === 0) {
    return {
      interface: PLACEMENT_BINDING_INTERFACE,
      version: PLACEMENT_SELECTOR_VERSION,
      code: 'NO_ELIGIBLE_NODE',
      reason: 'No candidate survived binding validation.',
      selected: null,
      examined: candidates.length,
      excluded,
    };
  }
  const winner = eligible[0];
  return {
    interface: PLACEMENT_BINDING_INTERFACE,
    version: PLACEMENT_SELECTOR_VERSION,
    code: 'SELECTED',
    selected: {
      resourceId: winner.candidate.resourceId,
      score: winner.score,
      contributions: winner.contributions,
      binding: { device: 'cpu', nodeId: winner.candidate.resourceId, runtimeId },
      evidence: {
        liveness: winner.candidate.liveness,
        lastSeenAgeMs: Number.isFinite(winner.candidate.lastSeenAgeMs) ? winner.candidate.lastSeenAgeMs : null,
        modelCompat: 'unverified',
      },
    },
    examined: candidates.length,
    excluded,
    receipt: {
      version: PLACEMENT_SELECTOR_VERSION,
      tenantId: request.tenantId,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(maxTokens === null ? {} : { maxTokens }),
      device: 'cpu',
      runtimeId,
      ...(Number.isSafeInteger(request.deadlineMs) ? { deadlineMs: request.deadlineMs } : {}),
      executable: false,
      note: 'Advisory selection only: no admission, hold, or dispatch was performed.',
    },
  };
}
