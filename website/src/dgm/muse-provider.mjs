/* Built with Meta Muse. */
// DGM Muse provider adapter: bounded server-side path from the DGM preview
// slice to the Meta Model API Contributor model. Exactly one model
// (muse-spark-1.3-contributor), exactly one destination
// (https://api.meta.ai/v1/responses), no fallback, no retry, no tools.
//
// Verified 2026-11-02 against https://dev.meta.ai/docs/overview and
// /docs/models: base URL https://api.meta.ai/v1, Bearer MODEL_API_KEY,
// POST /v1/responses with {model, input}, Contributor model IDs
// muse-spark-1.3-contributor / muse-spark-1.2-contributor, plus the
// Responses / Chat Completions / Messages protocol surfaces. Full source
// list lives in the task evidence MODEL-SOURCES.md.
//
// Every provider call is bounded: input bytes, output tokens, response
// bytes, deadline, single fixed origin with redirects refused. Errors are
// sanitized typed failures; the key, headers and raw bodies never leave
// this module. fetchImpl is injectable so tests prove the boundary with
// zero network calls.
import { httpError } from '../lib/validate.js';
import { META_PRICES } from '../routing/adapters/meta.mjs';
import { FIXTURES } from './preview.mjs';

export const DGM_MUSE_MODEL = 'muse-spark-1.3-contributor';
export const DGM_MUSE_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
export const DGM_MUSE_RESPONSES_HOST = 'api.meta.ai';
export const DGM_MUSE_PROMPT_MAX_BYTES = 8 * 1024;
export const DGM_MUSE_OUTPUT_MAX_TOKENS = 512;
export const DGM_MUSE_RESPONSE_MAX = 64 * 1024;
export const DGM_MUSE_PROPOSAL_MAX_CHARS = 32 * 1024;
export const DGM_MUSE_DEADLINE_MS = 60 * 1000;
export const DGM_MUSE_SCHEMA = 'aipster.dgm.muse/v1';
// Provider-controlled strings are bounded before they reach any receipt:
// response ids are opaque and may be arbitrarily long, model/reason strings
// are echoed only as short redacted slices.
export const DGM_MUSE_ID_MAX = 128;
export const DGM_MUSE_META_MAX = 64;
// The only structure this slice accepts from delivered proposal text is one
// explicit allowlisted line naming a fixed evaluation input. Nothing else in
// the text is parsed, executed, or trusted.
export const DGM_MUSE_INPUT_PREFIX = 'fixture:';
export const DGM_MUSE_FIXTURE_INPUT_DEFAULT = 'good';

const INSTRUCTIONS = 'You are AIPSTER DGM test support. Draft one small synthetic software-test proposal '
  + 'from the prompt only. This is qualification text, never a production change: propose nothing that '
  + 'executes code, touches credentials, or leaves this evaluation. Keep the proposal under 2000 characters. '
  + `End with exactly one line "fixture: <name>" where name is one of ${FIXTURES.join(', ')}; that line `
  + 'selects one fixed evaluation input and is not code.';

function fail(status, message, code) {
  return httpError(status, message, code);
}

/** Live mode opens only with flag + bound DGM key. Demo sessions never qualify (checked by callers). */
export function museLiveEnabled(env) {
  if (!env || env.DGM_MUSE_LIVE !== '1') return false;
  return typeof env.DGM_MUSE_API_KEY === 'string' && env.DGM_MUSE_API_KEY.length > 0;
}

/** Operator-facing provider status: model, configured/not-configured, bounds. Never key material. */
export function museProviderStatus(env) {
  const configured = museLiveEnabled(env);
  return {
    schema: DGM_MUSE_SCHEMA,
    model: DGM_MUSE_MODEL,
    configured,
    evaluation: configured ? 'synthetic-live' : 'fixture',
    endpoint: { host: DGM_MUSE_RESPONSES_HOST, path: '/v1/responses' },
    bounds: {
      promptMaxBytes: DGM_MUSE_PROMPT_MAX_BYTES,
      outputMaxTokens: DGM_MUSE_OUTPUT_MAX_TOKENS,
      responseMaxBytes: DGM_MUSE_RESPONSE_MAX,
      deadlineMs: DGM_MUSE_DEADLINE_MS,
    },
  };
}

export const DGM_MUSE_REASONING_EFFORT = 'minimal';

// Contributor price reference (same table as the reviewed routing adapter;
// limits provisional and live verification required before production use).
export const DGM_MUSE_PRICE_REF = META_PRICES.contributor;
export const DGM_MUSE_PRICE_VERSION = META_PRICES.version;
export const DGM_MUSE_PRICE_SOURCE = META_PRICES.source;

/**
 * Rigorous input-token upper bound (not a prediction): every text token
 * spans at least one UTF-8 byte, so input tokens can never exceed the
 * request byte length. Measured over the FULL request JSON, so instructions
 * and protocol overhead are inside the bound. Labelled an estimate in
 * receipts because actual usage is usually far lower — the bound only ever
 * over-reserves, never under-reserves. Model pricing itself stays
 * provisional until re-verified before any production activation.
 */
export function estimateMuseInputTokens(prompt) {
  return new TextEncoder().encode(JSON.stringify(buildProposeRequest(typeof prompt === 'string' ? prompt : ''))).length;
}

/** Production spend cap in USD. Defaults to zero: live calls need explicit budget. */
export function museSpendCapUsd(env) {
  const raw = env ? env.DGM_MUSE_SPEND_CAP_USD : undefined;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** USD -> integer micro-USD, the unit of the durable aggregate ledger. */
export function museUsdToMicros(usd) {
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1e6) : 0;
}

/** The operator cap in the same integer unit the aggregate admission compares. */
export function museSpendCapMicros(env) {
  return museUsdToMicros(museSpendCapUsd(env));
}

/** Worst-case bounded cost of one generation: estimated input + full output budget. */
export function museWorstCaseSpendUsd(prompt) {
  const p = META_PRICES.contributor;
  return Number(((estimateMuseInputTokens(prompt) * p.inPer1M + DGM_MUSE_OUTPUT_MAX_TOKENS * p.outPer1M) / 1e6).toFixed(6));
}

export function museWorstCaseSpendMicros(prompt) {
  return museUsdToMicros(museWorstCaseSpendUsd(prompt));
}

/** Actual cost from reported usage; null when usage is unusable (never zero). */
export function museUsageSpendUsd(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)
      || usage.input_tokens < 0 || usage.output_tokens < 0) return null;
  const p = META_PRICES.contributor;
  return Number(((usage.input_tokens * p.inPer1M + usage.output_tokens * p.outPer1M) / 1e6).toFixed(6));
}

function signalTimeoutError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('DGM provider body read timed out.');
  err.name = 'TimeoutError';
  return err;
}

export function buildProposeRequest(prompt) {
  return {
    url: DGM_MUSE_RESPONSES_URL,
    body: {
      model: DGM_MUSE_MODEL,
      instructions: INSTRUCTIONS,
      input: prompt,
      // Documented Responses control (`reasoning.effort`, dev.meta.ai/docs/reasoning):
      // reasoning consumes the output budget, so the shortest pass keeps a
      // short deterministic proposal inside max_output_tokens.
      reasoning: { effort: DGM_MUSE_REASONING_EFFORT },
      max_output_tokens: DGM_MUSE_OUTPUT_MAX_TOKENS,
      store: false,
      stream: false,
    },
  };
}

async function readCapped(response, signal) {
  // The transport (or an injected stub) may ignore the deadline signal on
  // the body: enforce the single total deadline on the read itself, with
  // bounded owned-reader cleanup. Never waits past the provider deadline.
  const reader = response.body ? response.body.getReader() : null;
  let onAbort = null;
  const abort = new Promise((_, reject) => {
    if (!signal) return;
    // Reject FIRST, then clean up: cancelling the reader can settle the
    // pending read (some runtimes resolve it as done), which must never
    // win the race as an empty body.
    const fire = () => {
      reject(signalTimeoutError(signal));
      if (reader) { try { const p = reader.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* bounded cleanup */ } }
    };
    if (signal.aborted) { fire(); return; }
    onAbort = fire;
    signal.addEventListener('abort', fire, { once: true });
  });
  const release = () => {
    if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* gone */ } }
  };
  try {
    if (!reader) {
      const text = await Promise.race([response.text(), abort]);
      if (text.length > DGM_MUSE_RESPONSE_MAX) {
        throw fail(502, 'DGM provider response exceeded the size bound.', 'DGM_MUSE_RESPONSE_TOO_LARGE');
      }
      return text;
    }
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), abort]);
        if (done) break;
        total += value.byteLength;
        if (total > DGM_MUSE_RESPONSE_MAX) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw fail(502, 'DGM provider response exceeded the size bound.', 'DGM_MUSE_RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    } catch (e) {
      try { await reader.cancel(); } catch { /* bounded owned-reader cleanup */ }
      // A firing deadline wins deterministically over whatever the
      // cancelled read rejects with.
      if (signal && signal.aborted) throw signalTimeoutError(signal);
      throw e;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  } finally {
    release();
  }
}

function extractText(wire) {
  if (typeof wire.output_text === 'string' && wire.output_text) return wire.output_text;
  const parts = [];
  if (Array.isArray(wire.output)) {
    for (const item of wire.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.length ? parts.join('') : null;
}

function usageOf(wire) {
  const u = (wire && wire.usage) || {};
  const inp = Number.isSafeInteger(u.input_tokens) ? u.input_tokens : null;
  const out = Number.isSafeInteger(u.output_tokens) ? u.output_tokens : null;
  if (inp === null || out === null || inp < 0 || out < 0) return null;
  return { input_tokens: inp, output_tokens: out };
}

/**
 * Failure after the provider accepted the call (HTTP 2xx headers received,
 * or an ambiguous 5xx): the call counts as sent, so the outcome is unknown
 * and the tenant must quarantine, never silently retry. `accepted: true`
 * tells the ledger to block new keys until operator reconciliation.
 */
function acceptedFailure(status, message, code, httpStatus) {
  const err = fail(status, message, code);
  err.accepted = true;
  err.httpStatus = Number.isSafeInteger(httpStatus) ? httpStatus : null;
  return err;
}

/**
 * Definitive provider rejection (400/401/403/429/other 4xx): the provider
 * answered and refused, so no generation was accepted and nothing is
 * chargeable. The caller still sees a 502 (the upstream is unusable, not the
 * caller's request), while `httpStatus` preserves what the provider actually
 * answered — request status and provider status are different facts.
 */
function rejectedFailure(httpStatus, message, code, apiStatus = 502) {
  const err = fail(apiStatus, message, code);
  err.httpStatus = Number.isSafeInteger(httpStatus) ? httpStatus : null;
  return err;
}

/**
 * Bounded, redacted provider-controlled text. Returns the value and whether
 * it was cut, so a receipt can say "truncated" instead of silently echoing an
 * unbounded string.
 */
export function boundProviderText(value, max = DGM_MUSE_META_MAX) {
  if (typeof value !== 'string') return null;
  const redacted = redactMuseText(value);
  return redacted.length > max
    ? { value: redacted.slice(0, max), truncated: true }
    : { value: redacted, truncated: false };
}

export function boundProviderId(value) {
  return boundProviderText(value, DGM_MUSE_ID_MAX);
}

/**
 * Safe, bounded failure metadata: primitive values only, with the names of
 * any fields that had to be cut. Provider text is redacted before it is
 * stored, and nothing unbounded leaves this module.
 */
function detailFor({ status, incompleteReason, model, observedModel, responseId, usage }) {
  const truncated = [];
  const put = (key, raw, max) => {
    const b = boundProviderText(raw, max);
    if (b === null) return null;
    if (b.truncated) truncated.push(key);
    return b.value;
  };
  return {
    status: put('status', status, 32),
    incompleteReason: put('incompleteReason', incompleteReason, DGM_MUSE_META_MAX),
    model: put('model', model, DGM_MUSE_META_MAX),
    observedModel: put('observedModel', observedModel, DGM_MUSE_META_MAX),
    responseId: put('responseId', responseId, DGM_MUSE_ID_MAX),
    usage: usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
      ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : null,
    truncated,
  };
}

/**
 * The one accepted structure in delivered proposal text: an explicit
 * allowlisted `fixture: <name>` line selecting a fixed evaluation input.
 * Ambiguous or unknown directives yield null (no input), never a guess.
 * Nothing here executes or evaluates provider text.
 */
export function extractProposalFixtureInput(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*fixture:\s*([A-Za-z][A-Za-z-]*)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (!FIXTURES.includes(name)) return null;
    if (found !== null && found !== name) return null;
    found = name;
  }
  return found;
}

/**
 * One bounded proposal call. Throws typed DGM_MUSE_* failures; never leaks
 * the key, headers, or raw provider body. No retry: callers map lost
 * responses to `uncertain` and require a fresh key to retry.
 */
export async function proposeLive({ fetchImpl = fetch, apiKey, prompt, deadlineMs = DGM_MUSE_DEADLINE_MS } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw fail(503, 'DGM Muse provider is not configured.', 'DGM_MUSE_NOT_CONFIGURED');
  }
  // UTF-8 byte length via TextEncoder: no node:buffer import, so the module
  // runs under the existing Worker compatibility (nodejs_als only).
  if (typeof prompt !== 'string' || prompt.length === 0 || new TextEncoder().encode(prompt).length > DGM_MUSE_PROMPT_MAX_BYTES) {
    throw fail(400, `DGM proposal prompt must be 1..${DGM_MUSE_PROMPT_MAX_BYTES} bytes.`, 'DGM_MUSE_BAD_PROMPT');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > DGM_MUSE_DEADLINE_MS) {
    throw fail(500, 'DGM provider deadline is out of bounds.', 'DGM_MUSE_BAD_DEADLINE');
  }
  const { url, body } = buildProposeRequest(prompt);
  // Single total deadline for connect + headers + body: the same signal
  // bounds the fetch and the body read (readCapped enforces it even when
  // the transport ignores it on the stream).
  const signal = AbortSignal.timeout(deadlineMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw fail(504, 'DGM provider call timed out.', 'DGM_MUSE_TIMEOUT');
    }
    throw fail(502, 'DGM provider unreachable.', 'DGM_MUSE_UNREACHABLE');
  }
  if (response.status === 429) throw rejectedFailure(429, 'DGM provider is rate limited. No retry was sent.', 'DGM_MUSE_RATE_LIMITED', 503);
  if (response.status === 401 || response.status === 403) {
    throw rejectedFailure(response.status, 'DGM provider rejected credentials.', 'DGM_MUSE_AUTH');
  }
  if (response.status === 400) throw rejectedFailure(400, 'DGM provider rejected the request shape.', 'DGM_MUSE_REJECTED');
  if (response.status < 200 || response.status >= 300) {
    // 5xx acceptance is ambiguous (the generation may have run and billed):
    // quarantine rather than record a clean failure. 429/4xx are definitive
    // rejections — nothing was accepted.
    if (response.status >= 500) {
      throw acceptedFailure(502, 'DGM provider errored; acceptance unknown, no duplicate was sent.', 'DGM_MUSE_UPSTREAM', response.status);
    }
    throw rejectedFailure(response.status, 'DGM provider errored.', 'DGM_MUSE_UPSTREAM');
  }
  let bodyText;
  try {
    bodyText = await readCapped(response, signal);
  } catch (e) {
    if (e && e.code === 'DGM_MUSE_RESPONSE_TOO_LARGE') {
      e.accepted = true;
      e.httpStatus = response.status;
      throw e;
    }
    // The deadline can fire while the body is still streaming, and the
    // stream itself can reset mid-body: both mean an accepted call with no
    // usable output, never a malformed rejection. A deadline AFTER observed
    // 2xx headers is distinct from a deadline before any response: the
    // request reached the provider and may have consumed generation.
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const err = fail(504, 'DGM provider body read timed out.', 'DGM_MUSE_TIMEOUT');
      err.accepted = true;
      err.httpStatus = response.status;
      throw err;
    }
    throw acceptedFailure(502, 'DGM provider response body unreadable; acceptance unknown, no duplicate was sent.', 'DGM_MUSE_UNREADABLE', response.status);
  }
  // Parsing is separate from transport: unparsable 2xx output is malformed
  // (but still an accepted call — the provider ran), never "unreadable".
  let wire;
  try {
    wire = JSON.parse(bodyText);
  } catch {
    throw acceptedFailure(502, 'DGM provider returned malformed output; acceptance unknown, no duplicate was sent.', 'DGM_MUSE_MALFORMED', response.status);
  }
  // Anything past the 2xx header is an accepted call: unusable output
  // quarantines the tenant instead of failing clean and admitting a
  // second chargeable call on a new key.
  if (!wire || typeof wire !== 'object') {
    throw acceptedFailure(502, 'DGM provider returned malformed output; acceptance unknown, no duplicate was sent.', 'DGM_MUSE_MALFORMED', response.status);
  }
  if (wire.status === 'incomplete' || wire.incomplete_details) {
    // Terminal known-truncated (HTTP 2xx with an incomplete marker): the
    // exchange was accepted by the provider, so this is NOT a clean
    // unaccepted failure — a new key must not duplicate a possibly
    // chargeable generation. Keep exactly the safe metadata — terminal
    // status, incomplete reason, model, request ID, usage — bounded and
    // redacted, never raw body, reasoning, or key. Unknown transport
    // outcomes carry no detail, so the two cases stay distinguishable.
    const err = acceptedFailure(502, 'DGM provider response was truncated; nothing delivered and no duplicate was sent.', 'DGM_MUSE_TRUNCATED', response.status);
    err.detail = detailFor({
      status: wire.status,
      incompleteReason: wire.incomplete_details && wire.incomplete_details.reason,
      model: wire.model,
      responseId: wire.id,
      usage: usageOf(wire),
    });
    throw err;
  }
  if (typeof wire.model === 'string' && wire.model !== DGM_MUSE_MODEL) {
    // Provider-controlled text reaches the caller only redacted and sliced;
    // unbounded provider metadata is never reflected verbatim. A 2xx naming
    // another model was still accepted at the transport layer, so it
    // quarantines like every other unusable 2xx body.
    const observed = boundProviderText(wire.model, DGM_MUSE_META_MAX);
    const err = acceptedFailure(502, `DGM provider answered with an unexpected model (${JSON.stringify(observed.value)}); expected the pinned model.`, 'DGM_MUSE_WRONG_MODEL', response.status);
    err.detail = detailFor({ observedModel: wire.model, responseId: wire.id, usage: usageOf(wire) });
    throw err;
  }
  const text = extractText(wire);
  if (typeof text !== 'string' || text.length === 0 || text.length > DGM_MUSE_PROPOSAL_MAX_CHARS) {
    throw acceptedFailure(502, 'DGM provider returned no usable proposal text; acceptance unknown, no duplicate was sent.', 'DGM_MUSE_MALFORMED', response.status);
  }
  const responseId = boundProviderId(wire.id);
  const model = typeof wire.model === 'string' && wire.model !== ''
    ? boundProviderText(wire.model, DGM_MUSE_META_MAX) : null;
  return {
    proposal: text,
    usage: usageOf(wire),
    // Observed identity only: a missing wire.model records null, never a
    // fabricated fallback to the pinned model. Both fields are bounded.
    responseId: responseId ? responseId.value : null,
    responseIdTruncated: responseId ? responseId.truncated : false,
    model: model ? model.value : null,
    modelTruncated: model ? model.truncated : false,
  };
}

// Redaction before anything provider-shaped is persisted or echoed:
// Bearer [REDACTED] and e-mail addresses are scrubbed (mirrors the DGM preview
// label advisory). Counts pass through untouched.
const BEARER_PATTERN = /bearer\s+[A-Za-z0-9\-._~+/=]+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactMuseText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(BEARER_PATTERN, '[redacted]').replace(EMAIL_PATTERN, '[redacted]');
}

/**
 * Deterministic fixture proposal: honest placeholder while the provider is
 * not configured. Same prompt always yields the same text. Free, instant,
 * offline, and always labeled evaluation 'fixture'.
 */
export function runFixtureProposal(prompt) {
  const clean = redactMuseText(String(prompt || '').trim().slice(0, 400));
  return `Fixture DGM test proposal (no live provider call). Synthetic task noted (${clean.length} chars shown: ${clean.slice(0, 120)}). `
    + 'Suggested: one deterministic unit check with fixed input, one boundary input, one malformed-input refusal. '
    + 'No code was executed and no production state changed.\n'
    + `${DGM_MUSE_INPUT_PREFIX} ${DGM_MUSE_FIXTURE_INPUT_DEFAULT}`;
}
