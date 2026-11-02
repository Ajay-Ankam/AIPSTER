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

export const DGM_MUSE_MODEL = 'muse-spark-1.3-contributor';
export const DGM_MUSE_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
export const DGM_MUSE_RESPONSES_HOST = 'api.meta.ai';
export const DGM_MUSE_PROMPT_MAX_BYTES = 8 * 1024;
export const DGM_MUSE_OUTPUT_MAX_TOKENS = 512;
export const DGM_MUSE_RESPONSE_MAX = 64 * 1024;
export const DGM_MUSE_PROPOSAL_MAX_CHARS = 32 * 1024;
export const DGM_MUSE_DEADLINE_MS = 60 * 1000;
export const DGM_MUSE_SCHEMA = 'aipster.dgm.muse/v1';

const INSTRUCTIONS = 'You are AIPSTER DGM test support. Draft one small synthetic software-test proposal '
  + 'from the prompt only. This is qualification text, never a production change: propose nothing that '
  + 'executes code, touches credentials, or leaves this evaluation. Keep the proposal under 2000 characters.';

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

async function readCapped(response) {
  const reader = response.body ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    if (text.length > DGM_MUSE_RESPONSE_MAX) {
      throw fail(502, 'DGM provider response exceeded the size bound.', 'DGM_MUSE_RESPONSE_TOO_LARGE');
    }
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > DGM_MUSE_RESPONSE_MAX) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw fail(502, 'DGM provider response exceeded the size bound.', 'DGM_MUSE_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged);
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
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(deadlineMs),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw fail(504, 'DGM provider call timed out.', 'DGM_MUSE_TIMEOUT');
    }
    throw fail(502, 'DGM provider unreachable.', 'DGM_MUSE_UNREACHABLE');
  }
  if (response.status === 429) throw fail(503, 'DGM provider is rate limited. No retry was sent.', 'DGM_MUSE_RATE_LIMITED');
  if (response.status === 401 || response.status === 403) {
    throw fail(502, 'DGM provider rejected credentials.', 'DGM_MUSE_AUTH');
  }
  if (response.status === 400) throw fail(502, 'DGM provider rejected the request shape.', 'DGM_MUSE_REJECTED');
  if (response.status < 200 || response.status >= 300) {
    throw fail(502, 'DGM provider errored.', 'DGM_MUSE_UPSTREAM');
  }
  let wire;
  try {
    wire = JSON.parse(await readCapped(response));
  } catch (e) {
    if (e && e.code === 'DGM_MUSE_RESPONSE_TOO_LARGE') throw e;
    throw fail(502, 'DGM provider returned malformed output.', 'DGM_MUSE_MALFORMED');
  }
  if (!wire || typeof wire !== 'object') throw fail(502, 'DGM provider returned malformed output.', 'DGM_MUSE_MALFORMED');
  if (wire.status === 'incomplete' || wire.incomplete_details) {
    // Terminal known-truncated (HTTP 2xx with an incomplete marker): keep
    // exactly the safe metadata — terminal status, incomplete reason, model,
    // request ID, usage — never raw body, reasoning, or key. Unknown
    // outcomes (timeout/unreachable) carry no detail, so the two cases stay
    // distinguishable downstream.
    const err = fail(502, 'DGM provider response was truncated; nothing delivered.', 'DGM_MUSE_TRUNCATED');
    err.detail = {
      status: typeof wire.status === 'string' ? wire.status : null,
      incompleteReason: wire.incomplete_details && typeof wire.incomplete_details.reason === 'string'
        ? wire.incomplete_details.reason : null,
      model: typeof wire.model === 'string' ? wire.model : null,
      responseId: typeof wire.id === 'string' ? wire.id : null,
      usage: usageOf(wire),
    };
    throw err;
  }
  if (typeof wire.model === 'string' && wire.model !== DGM_MUSE_MODEL) {
    throw fail(502, `DGM provider answered as ${JSON.stringify(wire.model)}, not the pinned model.`, 'DGM_MUSE_WRONG_MODEL');
  }
  const text = extractText(wire);
  if (typeof text !== 'string' || text.length === 0 || text.length > DGM_MUSE_PROPOSAL_MAX_CHARS) {
    throw fail(502, 'DGM provider returned no usable proposal text.', 'DGM_MUSE_MALFORMED');
  }
  return {
    proposal: text,
    usage: usageOf(wire),
    responseId: typeof wire.id === 'string' ? wire.id : null,
    model: typeof wire.model === 'string' ? wire.model : DGM_MUSE_MODEL,
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
    + 'No code was executed and no production state changed.';
}
