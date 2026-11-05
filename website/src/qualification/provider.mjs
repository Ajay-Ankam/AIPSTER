/* Built with Meta Muse. Meta-qualification lane (meta-qual). */
/* Meta provider boundary: fixtures are free; live is one bounded attempt. */
/* The live path never follows redirects, never outlives its total deadline
   (stream reads race the clock even when a stub ignores the abort signal),
   and treats every unvalidated byte as hostile. */
import { httpError } from '../lib/validate.js';
import { validateProviderAdvice } from './validate.mjs';
import {
  QUAL_INPUT_BOUND_BYTES, QUAL_MODEL, QUAL_OUTPUT_MAX_TOKENS,
  QUAL_PRICE_IN_PER_M, QUAL_PRICE_OUT_PER_M, QUAL_REASONING_EFFORT,
  QUAL_RESPONSE_MAX, QUAL_RESPONSES_URL, QUAL_DEADLINE_MS,
} from './constants.mjs';

export const QUAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences of hardware assessment.' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['label', 'detail'],
        additionalProperties: false,
      },
    },
    rationale: { type: 'string' },
    unknowns: { type: 'array', items: { type: 'string' } },
    benchmarkCatalogId: { type: 'string', enum: ['completion-smoke-v1', 'unsupported'] },
  },
  required: ['summary', 'suggestions', 'rationale', 'unknowns', 'benchmarkCatalogId'],
  additionalProperties: false,
};

const INSTRUCTIONS = 'You are AIPSTER hardware qualification. Assess only the hardware facts given. '
  + 'Never invent measurements, compatibility, or performance. '
  + 'Set benchmarkCatalogId to completion-smoke-v1 only when a CPU smoke benchmark is supportable; otherwise unsupported. '
  + 'Put every uncertainty in unknowns. Advisory text only; nothing here enables execution.';

export function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 4);
}

export function estimateSpendUsd(inputTokens, outputTokens) {
  return (inputTokens * QUAL_PRICE_IN_PER_M + outputTokens * QUAL_PRICE_OUT_PER_M) / 1e6;
}

export function buildLiveRequest(profileFacts, eligibleCatalog) {
  const body = {
    model: QUAL_MODEL,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: JSON.stringify({ profile: profileFacts, eligibleCatalog }) }],
    text: { format: { type: 'json_schema', name: 'aipster_qualification_v1', description: 'Bounded hardware qualification.', schema: QUAL_JSON_SCHEMA, strict: true } },
    max_output_tokens: QUAL_OUTPUT_MAX_TOKENS,
    reasoning: { effort: QUAL_REASONING_EFFORT },
    store: false,
    stream: false,
  };
  return { url: QUAL_RESPONSES_URL, body };
}

/** Deterministic fixture: never live-looking, mode stays 'fixture'. */
export function runFixture(profile, eligibleCatalog) {
  const names = new Set((profile?.runtimes || []).map((r) => r.name));
  const ready = names.has('ganglion') || names.has('llama-server');
  const memOk = (profile?.memTotalBytes || 0) >= 1024 ** 3;
  if (ready && memOk && eligibleCatalog.includes('completion-smoke-v1')) {
    return {
      summary: 'Fixture assessment: CPU smoke benchmark looks supportable; nothing was measured.',
      suggestions: [{ label: 'completion-smoke-v1', detail: 'Run the fixed 32-token CPU smoke benchmark to measure local inference.' }],
      rationale: 'Fixture path: known CPU runtime present with non-trivial memory.',
      unknowns: ['Actual model readiness and measured throughput are unknown until the benchmark runs.'],
      benchmarkCatalogId: 'completion-smoke-v1',
    };
  }
  return {
    summary: 'Fixture assessment: no supported benchmark for this profile.',
    suggestions: [],
    rationale: 'Fixture path: missing ready CPU runtime or memory facts.',
    unknowns: ['Hardware facts are missing or do not match the supported catalog.'],
    benchmarkCatalogId: 'unsupported',
  };
}

/**
 * Preflight: input bound + per-call spend cap, before any budget is touched.
 * Token reservation uses the full UTF-8 byte bound as the token upper bound
 * (never the chars/4 estimate) plus the full output maximum.
 */
export function preflightLiveRequest(profileFacts, eligibleCatalog, spendCapUsd) {
  const { body } = buildLiveRequest(profileFacts, eligibleCatalog);
  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (bytes > QUAL_INPUT_BOUND_BYTES) throw httpError(400, 'Qualification input exceeds the byte bound.', 'QUAL_INPUT_TOO_LARGE');
  const spend = estimateSpendUsd(bytes, QUAL_OUTPUT_MAX_TOKENS);
  if (!(spendCapUsd > 0) || spend > spendCapUsd) throw httpError(402, 'Qualification spend cap is not provisioned for this call.', 'QUAL_SPEND_CAP');
  return { inputTokens: bytes, spend };
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

function incomplete(wire) {
  if (wire.incomplete === true) return true;
  const st = typeof wire.status === 'string' ? wire.status : '';
  return st !== '' && st !== 'completed';
}

// Provider diagnostics are untrusted too. Retain only fixed enums and
// bounded numeric usage, never raw output, error messages or response ids.
function incompleteDiagnostic(wire) {
  const statuses = ['incomplete', 'in_progress', 'queued', 'failed', 'cancelled'];
  const reasons = ['max_output_tokens', 'content_filter'];
  const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
  return {
    httpStatus: 200,
    status: statuses.includes(wire.status) ? wire.status : 'unknown',
    reason: reasons.includes(wire.incomplete_details?.reason) ? wire.incomplete_details.reason : 'unknown',
    usage: { inputTokens: count(wire.usage?.input_tokens), outputTokens: count(wire.usage?.output_tokens) },
  };
}

class DeadlineError extends Error {}

/**
 * Read the wire body within the total deadline and the 64 KiB bound, even
 * when the fetch stub ignores the abort signal: the read itself races the
 * clock and cancels the reader on expiry.
 */
async function readBounded(response, deadlineMs) {
  const max = QUAL_RESPONSE_MAX;
  const finishAt = Date.now() + deadlineMs;
  const failAfter = (ms) => new Promise((_, rej) => {
    const t = setTimeout(() => rej(new DeadlineError('Qualification provider call exceeded its total deadline.')), Math.max(0, ms));
    if (typeof t.unref === 'function') t.unref();
  });
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const remaining = finishAt - Date.now();
        if (remaining <= 0) throw new DeadlineError('Qualification provider call exceeded its total deadline.');
        const step = await Promise.race([reader.read(), failAfter(remaining)]);
        if (step.done) break;
        total += step.value.length;
        if (total > max) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw httpError(502, 'Provider response exceeded the size bound.', 'PROVIDER_RESPONSE_TOO_LARGE');
        }
        chunks.push(step.value);
      }
    } catch (e) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw e;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  }
  const text = await Promise.race([response.text(), failAfter(finishAt - Date.now())]);
  if (new TextEncoder().encode(text).byteLength > max) {
    throw httpError(502, 'Provider response exceeded the size bound.', 'PROVIDER_RESPONSE_TOO_LARGE');
  }
  return text;
}

function unknownUsage() {
  return { inputTokens: null, outputTokens: null };
}

/**
 * One provider attempt under a total deadline. Redirects are refused
 * (Workers-compatible manual mode): a 3xx is a provider error, never
 * followed. The model echo must name exactly the requested model — a
 * missing or different echo fails closed instead of being inferred.
 * Usage is reported only when the wire carries valid non-negative counts;
 * anything else stays unknown, never invented.
 */
export async function runLive({ fetchImpl, key, profileFacts, eligibleCatalog, deadlineMs = QUAL_DEADLINE_MS }) {
  const { url, body } = buildLiveRequest(profileFacts, eligibleCatalog);
  // Single total deadline for connect + headers + body, mirroring the
  // verified DGM provider shape. 'manual' is the workerd-supported mode:
  // a 3xx is returned, never followed, and refused below.
  const signal = AbortSignal.timeout(deadlineMs);
  const startedAt = Date.now();
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw httpError(504, 'Qualification provider call timed out.', 'PROVIDER_TIMEOUT');
    throw httpError(502, 'Qualification provider call failed.', 'PROVIDER_ERROR');
  }
  if (!res) throw httpError(502, 'Qualification provider returned nothing.', 'PROVIDER_ERROR');
  const status = res.status ?? 0;
  if (status === 0) throw httpError(502, 'Qualification provider response was opaque; acceptance unknown, no duplicate was sent.', 'PROVIDER_OPAQUE');
  if (status >= 300 && status < 400) throw httpError(502, 'Qualification provider redirected; redirects are refused, acceptance unknown, no duplicate was sent.', 'PROVIDER_REDIRECT');
  if (status < 200 || status >= 300) throw httpError(502, 'Qualification provider refused the call.', 'PROVIDER_ERROR');
  const remaining = deadlineMs - (Date.now() - startedAt);
  if (remaining <= 0) throw httpError(504, 'Qualification provider call exceeded its total deadline.', 'PROVIDER_TIMEOUT');
  let text;
  try {
    text = await readBounded(res, remaining);
  } catch (e) {
    if (e instanceof DeadlineError) throw httpError(504, e.message, 'PROVIDER_TIMEOUT');
    throw e;
  }
  let wire;
  try {
    wire = JSON.parse(text);
  } catch {
    throw httpError(502, 'Provider returned non-JSON.', 'BAD_PROVIDER_JSON');
  }
  if (!wire || typeof wire !== 'object') throw httpError(502, 'Provider returned no usable envelope.', 'BAD_PROVIDER_JSON');
  if (incomplete(wire)) {
    const diagnostic = incompleteDiagnostic(wire);
    diagnostic.httpStatus = status;
    const detail = diagnostic.reason === 'max_output_tokens' ? ' Output token limit reached.'
      : diagnostic.reason === 'content_filter' ? ' Provider content filter reported.' : '';
    throw Object.assign(httpError(502, `Provider returned an incomplete response.${detail} No automatic retry.`, 'PROVIDER_INCOMPLETE'), { providerDiagnostic: diagnostic });
  }
  if (wire.model !== QUAL_MODEL) {
    throw httpError(502,
      wire.model === undefined || wire.model === null
        ? 'Provider returned no model echo.'
        : 'Provider model echo does not match the requested model.',
      'PROVIDER_MODEL_MISMATCH');
  }
  const raw = extractText(wire);
  if (!raw) throw httpError(502, 'Provider returned no text output.', 'BAD_PROVIDER_JSON');
  let advice;
  try {
    advice = JSON.parse(raw);
  } catch {
    throw httpError(502, 'Provider returned malformed advice JSON.', 'BAD_QUALIFICATION_ADVICE');
  }
  validateProviderAdvice(advice);
  const u = wire.usage && typeof wire.usage === 'object' ? wire.usage : null;
  const clean = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const inT = clean(u?.input_tokens);
  const outT = clean(u?.output_tokens);
  const usage = (inT === null || outT === null) ? unknownUsage() : { inputTokens: inT, outputTokens: outT };
  return {
    model: QUAL_MODEL,
    responseId: typeof wire.id === 'string' ? wire.id : null,
    usage,
    spendUsdEst: estimateSpendUsd(bytesOf(body), QUAL_OUTPUT_MAX_TOKENS),
    advice,
  };
}

function bytesOf(body) {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}
