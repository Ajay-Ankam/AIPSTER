/* DGM lane: bounded live-capable Meta proposal adapter (injected fetch for tests).
 *
 * Mirrors the true existing criteria in website/src/dgm/muse-provider.mjs
 * (single fixed origin, redirects refused via `redirect: 'manual'`, sanitized
 * typed failures, accepted-vs-rejected failure accounting, bounded+redacted
 * provider metadata, key as caller arg, no retry) and the failure taxonomy in
 * website/src/dgm/muse-router.mjs (providerContact / acceptance / billing).
 *
 * Credential rule: the key arrives ONLY as a caller argument (ephemeral value
 * injected at the CLI edge). This module performs no filesystem or host
 * environment reads and never persists credentials. No product request is ever sent by this lane's
 * own code paths — live execution needs the explicit CLI consent + budget
 * gate in live-run.mjs, and no call is made in tests.
 */
import {
  PROPOSAL_MODEL,
  PROPOSAL_MAX_OUTPUT_TOKENS,
  PROPOSAL_DEADLINE_MS,
  PROPOSAL_MAX_TEXT_CHARS,
} from './contract.mjs';
import { validateCandidate, isRefusal, WEIGHT_ALLOWLIST } from './candidate-schema.mjs';
import { META_PRICES } from '../../website/src/routing/adapters/meta.mjs';

export const ROUTING_PROPOSAL_URL = 'https://api.meta.ai/v1/responses';
export const ROUTING_PROPOSAL_HOST = 'api.meta.ai';
export const ROUTING_PROMPT_MAX_BYTES = 8 * 1024;
export const ROUTING_REQUEST_MAX_BYTES = 32 * 1024;
export const ROUTING_RESPONSE_MAX_BYTES = 64 * 1024;
export const ROUTING_PROPOSAL_MAX_CHARS = 32 * 1024;
export const ROUTING_META_MAX = 64;
export const ROUTING_ID_MAX = 128;

const byteLen = (s) => new TextEncoder().encode(s).length;

function fail(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Failure after the provider accepted the call (2xx headers seen, ambiguous
 * 5xx, refused redirect, or unreadable/truncated 2xx body): outcome unknown,
 * must quarantine, never silently retry. Mirrors acceptedFailure in the DGM
 * Muse provider.
 */
function acceptedFailure(status, message, code, httpStatus) {
  const err = fail(status, message, code);
  err.accepted = true;
  err.httpStatus = Number.isSafeInteger(httpStatus) ? httpStatus : null;
  return err;
}

/**
 * Definitive provider rejection (400/401/403/429): answered and refused, so
 * nothing was accepted and nothing is chargeable. Mirrors rejectedFailure.
 */
function rejectedFailure(httpStatus, message, code, apiStatus = 502) {
  const err = fail(apiStatus, message, code);
  err.httpStatus = Number.isSafeInteger(httpStatus) ? httpStatus : null;
  return err;
}

/**
 * Transport/acceptance/billing accounting for a thrown adapter failure.
 * Mirrors classifyError in website/src/dgm/muse-router.mjs: three different
 * facts, never conflated, never claimed as a bill.
 */
export function classifyRoutingFailure(e) {
  const httpStatus = e && Number.isSafeInteger(e.httpStatus) ? e.httpStatus : null;
  if (e && e.accepted === true) {
    const saw2xx = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    return saw2xx
      ? { providerContact: 'sent', acceptance: 'accepted', billing: 'possibly-chargeable' }
      : { providerContact: 'sent', acceptance: 'unknown', billing: 'unknown' };
  }
  if (e && (e.code === 'DGM_ROUTING_TIMEOUT' || e.code === 'DGM_ROUTING_UNREACHABLE')) {
    return { providerContact: 'unknown', acceptance: 'unknown', billing: 'unknown' };
  }
  return { providerContact: 'sent', acceptance: 'not-accepted', billing: 'not-chargeable' };
}

const BEARER_PATTERN = /bearer\s+[A-Za-z0-9\-._~+/=]+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactRoutingText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(BEARER_PATTERN, '[redacted]').replace(EMAIL_PATTERN, '[redacted]');
}

function boundText(value, max) {
  if (typeof value !== 'string') return null;
  const redacted = redactRoutingText(value);
  return redacted.length > max
    ? { value: redacted.slice(0, max), truncated: true }
    : { value: redacted, truncated: false };
}

/**
 * Fixed live prompt: strict JSON contract. The reply must be exactly one raw
 * JSON object {"weights":{...}} — no fences, no prose, no other keys. Values
 * come strictly from the finite enums below (same allowlist the validator
 * enforces). Synthetic routing weights only; no workload, train, held-out,
 * oracle, or fabric data is included or requested.
 */
export function buildLivePrompt() {
  const lines = Object.entries(WEIGHT_ALLOWLIST).map(([k, vs]) => `- ${k}: one of ${vs.join(', ')}`);
  return [
    'Propose one bounded routing-weight experiment. Reply with exactly one raw JSON object and nothing else:',
    '{"weights":{...}}',
    'No code, no credentials, no execution, no further experiments, no prose, no fences.',
    'Allowed weights (every key required, values strictly from its list):',
    ...lines,
    'Baseline for reference: {"EXACT_TOKEN":50,"ONLINE":30,"FRESHNESS_MAX":20,"OWNED":10,"HEADROOM":5}.',
  ].join('\n');
}

export function buildProposalRequest(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0 || byteLen(prompt) > ROUTING_PROMPT_MAX_BYTES) {
    throw fail(400, `prompt must be 1..${ROUTING_PROMPT_MAX_BYTES} bytes`, 'DGM_ROUTING_BAD_PROMPT');
  }
  return {
    url: ROUTING_PROPOSAL_URL,
    deadlineMs: PROPOSAL_DEADLINE_MS,
    body: {
      model: PROPOSAL_MODEL,
      instructions: 'Propose one bounded routing-weight experiment as strict JSON only. No code, no credentials, no execution.',
      input: prompt,
      // Minimal reasoning (same control as the existing DGM Muse adapter):
      // reasoning consumes the output budget, so the shortest pass keeps a
      // short strict-JSON proposal inside max_output_tokens.
      reasoning: { effort: 'minimal' },
      max_output_tokens: PROPOSAL_MAX_OUTPUT_TOKENS,
      store: false,
    },
  };
}

/**
 * Upper-bound spend estimate (not a prediction): input tokens can never exceed
 * the full request byte length. Mirrors estimateMuseInputTokens.
 */
export function estimateProposalSpend(prompt) {
  const requestBytes = byteLen(JSON.stringify(buildProposalRequest(prompt)));
  const p = META_PRICES.contributor;
  const worstCaseSpendUsd = Number(((requestBytes * p.inPer1M + PROPOSAL_MAX_OUTPUT_TOKENS * p.outPer1M) / 1e6).toFixed(6));
  return { requestBytes, estInputTokens: requestBytes, worstCaseSpendUsd };
}

/**
 * Preflight without any network: validates prompt shape, request byte budget
 * and caller spend budget. Throws before any call on violation.
 */
export function preflightProposal(prompt, maxSpendUsd) {
  const est = estimateProposalSpend(prompt);
  if (est.requestBytes > ROUTING_REQUEST_MAX_BYTES) {
    throw fail(400, 'proposal request exceeds the byte budget; no call sent', 'DGM_ROUTING_REQUEST_TOO_LARGE');
  }
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) {
    throw fail(400, 'an explicit positive spend budget is required; no call sent', 'DGM_ROUTING_NO_BUDGET');
  }
  if (est.worstCaseSpendUsd > maxSpendUsd) {
    throw fail(402, `worst-case spend $${est.worstCaseSpendUsd} exceeds budget $${maxSpendUsd}; no call sent`, 'DGM_ROUTING_OVER_BUDGET');
  }
  return est;
}

function usageOf(wire) {
  const u = (wire && wire.usage) || {};
  const inp = Number.isSafeInteger(u.input_tokens) ? u.input_tokens : null;
  const out = Number.isSafeInteger(u.output_tokens) ? u.output_tokens : null;
  if (inp === null || out === null || inp < 0 || out < 0) return null;
  return { input_tokens: inp, output_tokens: out };
}

function extractWireText(wire) {
  const outputs = (wire && Array.isArray(wire.output)) ? wire.output : [];
  const parts = [];
  for (const out of outputs) {
    const contents = (out && Array.isArray(out.content)) ? out.content : [];
    for (const c of contents) {
      if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.length ? parts.join('') : null;
}

function abortError() {
  const err = new Error('proposal body read stalled past the total deadline');
  err.name = 'AbortError';
  return err;
}

function raceWithSignal(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbortEvent);
    };
    const onAbortEvent = () => {
      cleanup();
      try { onAbort && onAbort(); } catch { /* best effort */ }
      reject(abortError());
    };
    signal.addEventListener('abort', onAbortEvent, { once: true });
    promise.then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); },
    );
  });
}

/**
 * Bounded body read raced against the total-deadline signal: a stalled
 * stream (injected or real) cannot outlive the deadline by relying on the
 * transport to reject. On abort the reader is cancelled. The text() fallback
 * path is raced the same way and byte-counted after resolve.
 */
async function readCapped(response, signal) {
  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader() : null;
  if (!reader) {
    const text = await raceWithSignal(response.text(), signal, null);
    if (text.length > ROUTING_RESPONSE_MAX_BYTES) {
      throw fail(502, 'proposal response exceeded the size bound', 'DGM_ROUTING_RESPONSE_TOO_LARGE');
    }
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const next = await raceWithSignal(reader.read(), signal, () => reader.cancel());
    const { done, value } = next;
    if (done) break;
    total += value.byteLength;
    if (total > ROUTING_RESPONSE_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw fail(502, 'proposal response exceeded the size bound', 'DGM_ROUTING_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * One bounded live proposal call. fetchImpl is injectable so tests prove the
 * boundary with zero network. Throws typed DGM_ROUTING_* failures carrying
 * accepted/httpStatus for failure accounting; never leaks the key, headers,
 * or raw provider body. No retry, no redirects, no tools.
 */
export async function proposeLiveRouting({ fetchImpl = globalThis.fetch, apiKey, prompt, deadlineMs = PROPOSAL_DEADLINE_MS, maxSpendUsd } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw fail(503, 'routing proposal provider is not configured (server-side caller key required)', 'DGM_ROUTING_NOT_CONFIGURED');
  }
  const est = preflightProposal(prompt, maxSpendUsd);
  void est;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > PROPOSAL_DEADLINE_MS) {
    throw fail(500, 'proposal deadline is out of bounds (1..60000 ms)', 'DGM_ROUTING_BAD_DEADLINE');
  }
  const { url, body } = buildProposalRequest(prompt);
  // Single total deadline for connect + headers + body.
  const signal = AbortSignal.timeout(deadlineMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      // Refuse redirects: auth is only ever sent to the fixed host; a
      // Location is never followed and the Bearer [REDACTED] never forwarded.
      redirect: 'manual',
      signal,
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw fail(504, 'proposal call timed out', 'DGM_ROUTING_TIMEOUT');
    }
    throw fail(502, 'proposal provider unreachable', 'DGM_ROUTING_UNREACHABLE');
  }
  // Redirect (or opaque status 0): reached the host but outcome unknown —
  // quarantine, never duplicate.
  if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw acceptedFailure(502, 'provider answered with a refused redirect; acceptance unknown, no duplicate was sent', 'DGM_ROUTING_REDIRECT_REFUSED', response.status);
  }
  if (response.status === 429) throw rejectedFailure(429, 'provider rate limited; no retry was sent', 'DGM_ROUTING_RATE_LIMITED', 503);
  if (response.status === 401 || response.status === 403) {
    throw rejectedFailure(response.status, 'provider rejected credentials', 'DGM_ROUTING_AUTH');
  }
  if (response.status === 400) throw rejectedFailure(400, 'provider rejected the request shape', 'DGM_ROUTING_REJECTED');
  if (response.status < 200 || response.status >= 300) {
    if (response.status >= 500) {
      throw acceptedFailure(502, 'provider errored; acceptance unknown, no duplicate was sent', 'DGM_ROUTING_UPSTREAM', response.status);
    }
    throw rejectedFailure(response.status, 'provider errored', 'DGM_ROUTING_UPSTREAM');
  }
  let bodyText;
  try {
    bodyText = await readCapped(response, signal);
  } catch (e) {
    if (e && e.code === 'DGM_ROUTING_RESPONSE_TOO_LARGE') {
      e.accepted = true;
      e.httpStatus = response.status;
      throw e;
    }
    // Deadline or reset mid-body after observed 2xx: accepted call, no output.
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const err = fail(504, 'proposal body read timed out', 'DGM_ROUTING_TIMEOUT');
      err.accepted = true;
      err.httpStatus = response.status;
      throw err;
    }
    throw acceptedFailure(502, 'proposal body unreadable; acceptance unknown, no duplicate was sent', 'DGM_ROUTING_UNREADABLE', response.status);
  }
  let wire;
  try {
    wire = JSON.parse(bodyText);
  } catch {
    throw acceptedFailure(502, 'provider returned malformed output; acceptance unknown, no duplicate was sent', 'DGM_ROUTING_MALFORMED', response.status);
  }
  if (!wire || typeof wire !== 'object') {
    throw acceptedFailure(502, 'provider returned malformed output; acceptance unknown, no duplicate was sent', 'DGM_ROUTING_MALFORMED', response.status);
  }
  if (wire.status === 'incomplete' || wire.incomplete_details) {
    const err = acceptedFailure(502, 'provider response truncated; nothing delivered and no duplicate was sent', 'DGM_ROUTING_TRUNCATED', response.status);
    err.detail = {
      status: typeof wire.status === 'string' ? wire.status.slice(0, 32) : null,
      responseId: boundText(wire.id, ROUTING_ID_MAX)?.value ?? null,
      usage: usageOf(wire),
    };
    throw err;
  }
  if (typeof wire.model === 'string' && wire.model !== PROPOSAL_MODEL) {
    const observed = boundText(wire.model, ROUTING_META_MAX);
    const err = acceptedFailure(502, `provider answered with an unexpected model (${JSON.stringify(observed.value)}); expected the pinned model`, 'DGM_ROUTING_WRONG_MODEL', response.status);
    err.detail = { observedModel: observed.value, responseId: boundText(wire.id, ROUTING_ID_MAX)?.value ?? null, usage: usageOf(wire) };
    throw err;
  }
  const text = extractWireText(wire);
  if (typeof text !== 'string' || text.length === 0 || text.length > ROUTING_PROPOSAL_MAX_CHARS) {
    throw acceptedFailure(502, 'provider returned no usable proposal text; acceptance unknown, no duplicate was sent', 'DGM_ROUTING_MALFORMED', response.status);
  }
  const responseId = boundText(wire.id, ROUTING_ID_MAX);
  const model = typeof wire.model === 'string' && wire.model !== '' ? boundText(wire.model, ROUTING_META_MAX) : null;
  return {
    proposal: text,
    usage: usageOf(wire),
    // Observed identity only: a missing wire.model records null, never a
    // fabricated fallback to the pinned model.
    responseId: responseId ? responseId.value : null,
    responseIdTruncated: responseId ? responseId.truncated : false,
    model: model ? model.value : null,
    modelTruncated: model ? model.truncated : false,
  };
}

/**
 * Shared strict parse: the whole trimmed reply must be exactly one JSON
 * object matching the candidate schema (finite weight enums enforced by
 * validateCandidate). One consistent contract end to end — the prompt demands
 * raw JSON, and this accepts nothing else. Provider text is untrusted: only
 * the parsed candidate is kept; raw text is never persisted, never executed.
 */
export function acceptProposalText(text, provenanceBase) {
  if (typeof text !== 'string' || text.length === 0 || text.length > PROPOSAL_MAX_TEXT_CHARS) {
    return { refused: true, reason: 'DGM_PROPOSAL_BAD_RESPONSE', detail: `proposal text must be 1..${PROPOSAL_MAX_TEXT_CHARS} chars` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { refused: true, reason: 'DGM_PROPOSAL_NOT_JSON', detail: 'proposal text must be exactly one raw JSON object {"weights":{...}}' };
  }
  const checked = validateCandidate(parsed);
  if (isRefusal(checked)) return { refused: true, reason: checked.reason, detail: checked.detail };
  return { refused: false, candidate: checked.candidate, provenance: { ...provenanceBase } };
}

/**
 * Accept an injected (offline, untrusted) provider response for contract use.
 * Provenance is explicit: evaluation 'injected-offline', no product call made.
 */
export function acceptInjectedProposal(injected) {
  const text = injected && typeof injected.text === 'string' ? injected.text : null;
  if (text === null) {
    return { refused: true, reason: 'DGM_PROPOSAL_BAD_RESPONSE', detail: 'injected response needs a text string' };
  }
  // Injected input is caller-supplied, never observed on a wire: the model
  // label is preserved for context but modelVerified is ALWAYS false. Only a
  // live exact-model echo can verify.
  const injectedModel = (injected && typeof injected.model === 'string') ? injected.model.slice(0, ROUTING_META_MAX) : null;
  return acceptProposalText(text, {
    evaluation: 'injected-offline',
    model: injectedModel,
    modelVerified: false,
    responseId: (injected && typeof injected.responseId === 'string') ? injected.responseId.slice(0, ROUTING_ID_MAX) : null,
    usage: injected && typeof injected.usage === 'object' ? injected.usage : null,
    note: 'offline injected response; no product API call was made',
  });
}

/**
 * Accept a live adapter result. Observed model/responseId come from the wire
 * only (null when absent, never fabricated); usage counts pass through.
 */
export function acceptLiveProposal(result) {
  if (!result || typeof result.proposal !== 'string') {
    return { refused: true, reason: 'DGM_PROPOSAL_BAD_RESPONSE', detail: 'live result carries no proposal text' };
  }
  // Observed model only: null when the wire omitted it, never the pinned
  // model as a fabricated fallback. Verified only on an exact echo of the
  // pinned model — any other string, or a missing one, is not verifiable.
  const observedModel = typeof result.model === 'string' ? result.model : null;
  return acceptProposalText(result.proposal, {
    evaluation: 'live',
    model: observedModel,
    modelVerified: observedModel === PROPOSAL_MODEL,
    responseId: typeof result.responseId === 'string' ? result.responseId : null,
    usage: result.usage ?? null,
  });
}
