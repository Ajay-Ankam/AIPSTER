// FABRIC067: strict server-side model readiness validation and selection.
//
// The fabric routes only to models a worker actually serves. Worker-origin
// evidence arrives as per-runtime `models` arrays inside the existing
// node_capabilities rows (runtimes_json), server-stamped with reported_at.
// capabilities_json labels and placement soft-scores are NEVER model
// inventory and are not consulted here.
//
// Purity: no I/O, no D1, no fetch. The caller loads rows (owner-scoped SQL
// lives in fabric-openai-route.mjs) and selects here. Capacity is NOT
// invented: admission pools enforce it; selection excludes nothing on
// capacity. Unknown models are explicitly excluded (MODEL_NOT_ADVERTISED),
// never defaulted to an invented runtime. Only the qualified CPU transport
// set (ganglion | llama-server) can be selected: no native GPU path exists.
import { resourceLiveness } from '../lib/status.mjs';

export const MODEL_READINESS_VERSION = 'model-readiness/1';
// Worker model evidence piggybacks the ~240s capability cadence: two missed
// reports plus margin. Older evidence is stale, never trusted.
export const MODEL_EVIDENCE_FRESH_MS = 600000;
export const MODEL_RUNTIME_IDS = Object.freeze(['ganglion', 'llama-server']);
export const MODEL_ID_MAX = 256;
export const MODELS_PER_RUNTIME_MAX = 32;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= MODEL_ID_MAX;

const excluded = (resourceId, code, reason) => ({ resourceId, excluded: { code, reason }, tuples: [] });

function runtimeTuples(runtime) {
  // One runtimes[] entry -> validated model tuples, or a skip reason.
  // A foreign runtime name is skipped (never mapped); a malformed models
  // array fails the whole report (fail-closed: the worker must fix it).
  if (!isObj(runtime) || typeof runtime.name !== 'string') return { skip: 'MALFORMED_RUNTIME' };
  if (!MODEL_RUNTIME_IDS.includes(runtime.name)) return { skip: 'RUNTIME_FOREIGN' };
  if (runtime.models === undefined) return { tuples: [] }; // old reporter: no evidence, not an error
  if (!Array.isArray(runtime.models) || runtime.models.length > MODELS_PER_RUNTIME_MAX
    || runtime.models.some((m) => !isId(m))) {
    return { invalid: true };
  }
  return { tuples: [...new Set(runtime.models)].map((model_id) => ({ runtime_id: runtime.name, model_id })) };
}

/**
 * Qualify one worker-origin snapshot row. Rows are shaped by the loader:
 * {resourceId, ownerId, usable, online, heartbeatAt, reportedAt, runtimesJson}.
 * Freshness uses the SERVER-stamped reported_at, never a worker timestamp.
 */
export function qualifySnapshot(row, { nowMs, freshMs = MODEL_EVIDENCE_FRESH_MS, tenantId = null } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const id = row && typeof row.resourceId === 'string' ? row.resourceId : null;
  if (!isObj(row) || !id) return excluded(null, 'MALFORMED_ROW', 'The snapshot row is malformed.');
  if (tenantId !== null && row.ownerId !== tenantId) {
    return excluded(id, 'TENANT_MISMATCH', 'Tenant scope was not evidenced for this resource.');
  }
  if (row.usable !== true) return excluded(id, 'NOT_USABLE', 'The resource is not marked usable.');
  const liveness = resourceLiveness({ online: row.online === true, heartbeatAt: row.heartbeatAt ?? null }, now);
  if (liveness !== 'online') {
    return excluded(id, liveness === 'stale' ? 'STALE_HEARTBEAT' : 'UNREACHABLE',
      liveness === 'stale' ? 'The resource heartbeat is stale.' : 'The resource is not online.');
  }
  const seen = typeof row.reportedAt === 'string' ? Date.parse(row.reportedAt) : NaN;
  if (!Number.isFinite(seen)) return excluded(id, 'NO_EVIDENCE', 'No worker model evidence was reported.');
  const ageMs = Math.max(0, now - seen);
  if (ageMs > freshMs) {
    return excluded(id, 'STALE_EVIDENCE', 'The worker model evidence is older than the freshness window.');
  }
  let runtimes;
  try {
    runtimes = JSON.parse(row.runtimesJson);
  } catch {
    return excluded(id, 'INVALID_EVIDENCE', 'The capability snapshot is unparseable.');
  }
  if (!Array.isArray(runtimes)) return excluded(id, 'INVALID_EVIDENCE', 'The capability snapshot is malformed.');
  const tuples = [];
  for (const r of runtimes) {
    const parsed = runtimeTuples(r);
    if (parsed.invalid) return excluded(id, 'INVALID_EVIDENCE', 'A runtime models array is malformed.');
    if (parsed.skip) continue;
    for (const t of parsed.tuples) tuples.push({ ...t, evidenceAgeMs: ageMs });
  }
  if (tuples.length === 0) return excluded(id, 'NO_EVIDENCE', 'No runtime reported servable models.');
  return { resourceId: id, ownerId: row.ownerId ?? null, excluded: null, tuples };
}

function pickDeterministic(tuples) {
  const sorted = [...tuples].sort((a, b) => (a.evidenceAgeMs - b.evidenceAgeMs)
    || (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0)
    || (a.runtime_id < b.runtime_id ? -1 : a.runtime_id > b.runtime_id ? 1 : 0)
    || (a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0));
  return sorted[0];
}

/**
 * Select one qualified (resource, runtime, model) tuple.
 * @param {object[]} qualified - qualifySnapshot outputs.
 * @param {{tenantId:string, model?:string|null}} request - model null = auto.
 */
export function selectModelCandidate(qualified, request) {
  const rows = Array.isArray(qualified) ? qualified : [];
  if (!isObj(request) || typeof request.tenantId !== 'string' || !request.tenantId) {
    throw new Error('request.tenantId is required.');
  }
  const model = request.model === undefined ? null : request.model;
  if (model !== null && !isId(model)) throw new Error('request.model must be a model id or null.');
  const excludedRows = [];
  const tuples = [];
  for (const q of rows) {
    if (!isObj(q) || q.excluded) {
      excludedRows.push({ resourceId: isObj(q) ? q.resourceId : null,
        reason: isObj(q) && q.excluded ? q.excluded.code : 'MALFORMED_ROW' });
      continue;
    }
    const mine = (q.tuples || []).map((t) => ({ ...t, resourceId: q.resourceId }));
    if (model !== null) {
      const match = mine.filter((t) => t.model_id === model);
      if (match.length === 0) {
        excludedRows.push({ resourceId: q.resourceId, reason: 'MODEL_NOT_ADVERTISED' });
        continue;
      }
      tuples.push(...match);
    } else {
      tuples.push(...mine);
    }
  }
  const base = { interface: MODEL_READINESS_VERSION, examined: rows.length, excluded: excludedRows };
  if (tuples.length === 0) {
    return { ...base, code: model !== null ? 'MODEL_NOT_ADVERTISED' : 'NO_ELIGIBLE_NODE',
      reason: model !== null
        ? `Model ${JSON.stringify(model)} is not evidenced as servable by any eligible worker; nothing was admitted.`
        : 'No eligible worker evidenced a servable model; nothing was admitted.',
      selected: null };
  }
  const winner = pickDeterministic(tuples);
  return { ...base, code: 'SELECTED',
    selected: { resourceId: winner.resourceId, runtimeId: winner.runtime_id,
      modelId: winner.model_id, evidenceAgeMs: winner.evidenceAgeMs } };
}

/** Entries for buildModelsList: only evidenced servable models, nothing else. */
export function listAdvertisedModels(qualified) {
  const entries = [];
  for (const q of Array.isArray(qualified) ? qualified : []) {
    if (!isObj(q) || q.excluded) continue;
    for (const t of q.tuples || []) {
      entries.push({ model_id: t.model_id, usable: true, liveness: 'online' });
    }
  }
  return entries;
}
