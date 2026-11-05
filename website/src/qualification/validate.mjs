/* Built with Meta Muse. Meta-qualification lane (meta-qual). */
/* Strict contracts: owner body, provider advice, assignment, worker result. */
import { httpError, isId } from '../lib/validate.js';
import { BENCH_DEADLINE_MS, BENCH_MAX_TOKENS, BENCH_RUNTIMES, QUAL_BENCHMARK_CATALOG, QUAL_RESULT_GRACE_MS, QUAL_UNSUPPORTED } from './constants.mjs';

const badReq = (message, code = 'BAD_QUALIFICATION_REQUEST') => httpError(400, message, code);
const badAdvice = (message) => httpError(502, message, 'BAD_QUALIFICATION_ADVICE');

/** Owner POST body: optional idempotency key only. */
export function checkQualificationBody(body) {
  if (body === undefined || body === null) return { opKey: null };
  if (typeof body !== 'object' || Array.isArray(body)) throw badReq('JSON object required.');
  for (const k of Object.keys(body)) {
    if (k !== 'opKey') throw badReq(`Unknown field: ${k}.`);
  }
  if (body.opKey === undefined || body.opKey === null) return { opKey: null };
  if (!isId(body.opKey)) throw badReq('opKey must be 1..64 id chars.', 'BAD_IDEMPOTENCY');
  return { opKey: body.opKey };
}

function checkStr(v, name, min, max, fail) {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw fail(`${name} must be ${min}..${max} chars.`);
  return v;
}

function checkKeys(obj, allowed, fail, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw fail(`Invalid ${where}.`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw fail(`Unknown field in ${where}: ${k}.`);
  }
}

/**
 * Validate untrusted provider JSON. Accepts exactly
 * {summary, suggestions, rationale, unknowns, benchmarkCatalogId}.
 */
export function validateProviderAdvice(obj) {
  checkKeys(obj, ['summary', 'suggestions', 'rationale', 'unknowns', 'benchmarkCatalogId'], badAdvice, 'advice');
  checkStr(obj.summary, 'summary', 1, 1000, badAdvice);
  if (!Array.isArray(obj.suggestions) || obj.suggestions.length > 3) throw badAdvice('suggestions holds at most 3 entries.');
  for (const s of obj.suggestions) {
    checkKeys(s, ['label', 'detail'], badAdvice, 'suggestion');
    checkStr(s.label, 'suggestion.label', 1, 120, badAdvice);
    checkStr(s.detail, 'suggestion.detail', 1, 500, badAdvice);
  }
  if (typeof obj.rationale !== 'string' || obj.rationale.length > 1000) throw badAdvice('rationale must be at most 1000 chars.');
  if (!Array.isArray(obj.unknowns) || obj.unknowns.length > 8) throw badAdvice('unknowns holds at most 8 entries.');
  for (const u of obj.unknowns) checkStr(u, 'unknowns[]', 1, 200, badAdvice);
  if (obj.benchmarkCatalogId !== QUAL_UNSUPPORTED && !QUAL_BENCHMARK_CATALOG.includes(obj.benchmarkCatalogId)) {
    throw badAdvice('benchmarkCatalogId must be completion-smoke-v1 or unsupported.');
  }
  return obj;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Immutable benchmark assignment binding. */
export function validateAssignment(a) {
  checkKeys(a, ['runId', 'nodeId', 'profileDigest', 'catalogVersion', 'catalogId', 'leaseId', 'deadlineAt', 'runtimeAllowlist', 'maxTokens'], badReq, 'assignment');
  for (const f of ['runId', 'nodeId', 'leaseId']) {
    if (typeof a[f] !== 'string' || !ID_RE.test(a[f])) throw badReq(`${f} must be a valid id.`);
  }
  if (typeof a.profileDigest !== 'string' || !/^[0-9a-f]{64}$/.test(a.profileDigest)) throw badReq('profileDigest must be sha256 hex.');
  if (typeof a.catalogVersion !== 'string' || !a.catalogVersion || a.catalogVersion.length > 64) throw badReq('catalogVersion invalid.');
  if (!QUAL_BENCHMARK_CATALOG.includes(a.catalogId)) throw badReq('catalogId not eligible.');
  if (Number.isNaN(Date.parse(a.deadlineAt))) throw badReq('deadlineAt must be ISO time.');
  if (!Array.isArray(a.runtimeAllowlist) || a.runtimeAllowlist.length < 1 || a.runtimeAllowlist.some((r) => !BENCH_RUNTIMES.includes(r))) {
    throw badReq('runtimeAllowlist must be a non-empty subset of the CPU transport set.');
  }
  if (a.maxTokens !== BENCH_MAX_TOKENS) throw badReq(`maxTokens must be ${BENCH_MAX_TOKENS}.`);
  return a;
}

export const WORKER_RESULT_MAX_BYTES = 64 * 1024;
const RESULT_STATUS = ['succeeded', 'failed', 'timed_out', 'unsupported', 'uncertain'];
const FINISH_REASONS = ['stop', 'length', 'content_filter'];

const PLACEMENT_PROVENANCE = ['unknown', 'operator-declared'];

function validSucceeded(result) {
  const allowed = ['runtimeId', 'modelId', 'servedModelId', 'placementProvenance', 'elapsedMs', 'promptTokens', 'completionTokens', 'nativeTimings', 'finishReason'];
  if (Object.keys(result).some((k) => !allowed.includes(k))) return false;
  if (!BENCH_RUNTIMES.includes(result.runtimeId)) return false;
  if (typeof result.modelId !== 'string' || !result.modelId || result.modelId.length > 256) return false;
  // Native served identity + placement provenance: optional, strictly
  // bounded, and neither certifies hardware placement.
  if (result.servedModelId !== undefined && (typeof result.servedModelId !== 'string' || !result.servedModelId || result.servedModelId.length > 256)) return false;
  if (result.placementProvenance !== undefined && !PLACEMENT_PROVENANCE.includes(result.placementProvenance)) return false;
  if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 || result.elapsedMs > BENCH_DEADLINE_MS + 5000) return false;
  // Catalog bounds: at most 32 generated tokens; the fixed prompt is short,
  // so prompt tokens stay at catalog scale too (never the old 1024 window).
  if (result.promptTokens !== undefined && (!Number.isSafeInteger(result.promptTokens) || result.promptTokens < 0 || result.promptTokens > 128)) return false;
  if (result.completionTokens !== undefined && (!Number.isSafeInteger(result.completionTokens) || result.completionTokens < 0 || result.completionTokens > BENCH_MAX_TOKENS)) return false;
  if (result.finishReason !== undefined && (typeof result.finishReason !== 'string' || !FINISH_REASONS.includes(result.finishReason))) return false;
  if (result.nativeTimings !== undefined && !validNativeTimings(result.nativeTimings)) return false;
  return true;
}

/**
 * Native timing pairs from the backend (prompt_n/prompt_ms prefill and
 * predicted_n/predicted_ms generation). Raw pairs only: throughput is
 * derived by tpsOf, never shipped by the worker.
 */
export function validNativeTimings(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (Object.keys(t).some((k) => !['promptN', 'promptMs', 'predictedN', 'predictedMs'].includes(k))) return false;
  for (const f of ['promptN', 'promptMs', 'predictedN', 'predictedMs']) {
    if (typeof t[f] !== 'number' || !Number.isFinite(t[f]) || t[f] < 0) return false;
  }
  if (t.promptMs <= 0 || t.predictedMs <= 0) return false;
  if (!Number.isInteger(t.predictedN) || t.predictedN <= 0 || t.predictedN > BENCH_MAX_TOKENS) return false;
  if (!Number.isInteger(t.promptN)) return false;
  return true;
}

/** Strict worker result report: {leaseId, status, result}. No worker-supplied TPS. */
export function validateWorkerResultReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badReq('A JSON object is required.', 'INVALID_RESULT');
  const keys = Object.keys(body);
  if (keys.length !== 3 || keys.some((k) => !['leaseId', 'status', 'result'].includes(k))) {
    throw badReq('The report must contain only leaseId, status and result.', 'INVALID_RESULT');
  }
  if (typeof body.leaseId !== 'string' || !ID_RE.test(body.leaseId)) throw badReq('leaseId must be a valid lease id.', 'INVALID_RESULT');
  if (!RESULT_STATUS.includes(body.status)) throw badReq('status is not a supported terminal state.', 'INVALID_RESULT');
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > WORKER_RESULT_MAX_BYTES) {
    throw httpError(413, 'The worker result exceeds the size bound.', 'BODY_TOO_LARGE');
  }
  const r = body.result;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw badReq('result must be an object.', 'INVALID_RESULT');
  if (body.status === 'succeeded' && !validSucceeded(r)) throw badReq('A succeeded result must carry bound runtime/model identity and bounded measurements.', 'INVALID_RESULT');
  if (body.status !== 'succeeded') {
    if (Object.keys(r).some((k) => !['reason', 'detail', 'elapsedMs'].includes(k))) throw badReq('Non-success results carry only reason/detail/elapsedMs.', 'INVALID_RESULT');
    if (typeof r.reason !== 'string' || !r.reason || r.reason.length > 128) throw badReq('reason must be 1..128 chars.', 'INVALID_RESULT');
    if (r.detail !== undefined && (typeof r.detail !== 'string' || r.detail.length > 500)) throw badReq('detail must be at most 500 chars.', 'INVALID_RESULT');
    if (r.elapsedMs !== undefined && (!Number.isFinite(r.elapsedMs) || r.elapsedMs < 0 || r.elapsedMs > BENCH_DEADLINE_MS + QUAL_RESULT_GRACE_MS)) throw badReq('elapsedMs must be within the execution window plus grace.', 'INVALID_RESULT');
  }
  return body;
}

/**
 * Generation tokens-per-second from the coherent native predicted pair
 * only. Returns a number or null (never derived from wall-clock elapsedMs,
 * never a worker-claimed rate). Cross-checks the pair against the reported
 * completion count when both are present: inconsistent counts yield null.
 */
export function tpsOf(result) {
  const t = result?.nativeTimings;
  if (!validNativeTimings(t)) return null;
  if (result.completionTokens !== undefined
    && Number.isSafeInteger(result.completionTokens)
    && result.completionTokens !== t.predictedN) return null;
  return (t.predictedN / t.predictedMs) * 1000;
}

/** Prefill tokens-per-second from the coherent native prompt pair, else null. */
export function promptTpsOf(result) {
  const t = result?.nativeTimings;
  if (!validNativeTimings(t)) return null;
  return (t.promptN / t.promptMs) * 1000;
}
