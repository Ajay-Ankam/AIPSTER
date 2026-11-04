// FABRIC067: OpenAI-compatible adapter over admitted fabric dispatch.
//
// Pure server-side helpers only: no I/O, no D1, no fetch, no grants, no
// admissions, no transport. Nothing here authorizes, reserves, places, or
// dispatches. The deployed handler (fabric-openai-route.mjs, called by the
// worker.js owner) must still resolve the principal through the existing
// session/API-key boundary, build candidates from fresh authorized
// inventory, select placement server-side, mint an admission, and drive the
// coordinator; every outcome maps through this module.
//
// Initial-route compatibility (explicit, not silent): this route accepts
// EXACTLY ONE user text message. Multi-message and multi-role conversations
// are refused with `limited_compatibility`: the underlying EIF task contract
// carries a single prompt string, and wrapping roles in caller-visible XML
// is not role-preserving chat. Tool calling and coding-agent use are NOT
// claimed; they are a separate qualification.
//
// A requested logical model (or 'auto') only constrains selection; the
// central fabric chooses the worker. Unknown, unready, or absent workers
// yield truthful typed OpenAI errors, never a silent fallback to a direct
// local runtime (8090/8124/8471 are never referenced here by design).
//
// Streaming is refused with an explicit typed error BEFORE dispatch, never
// faked with a token stream. `stream: false` is an ordinary explicit
// non-streaming request and is accepted.
//
// Usage and finish evidence are honest: token counts pass through ONLY when
// the worker reported real numbers, otherwise usage is null (unknown is not
// zero); finish_reason is 'unknown' because the EIF result carries no stop/
// length evidence.
import { CONTRACT_VERSION, MAX_DEADLINE_MS } from './dispatch-coordinator.mjs';
import { decodeCpuTask } from './eif-task-contract.mjs';

export const FABRIC_OPENAI_INTERFACE = 'aipster-fabric-openai/1';
export const FABRIC_OPENAI_VERSION = 'fabric-openai/2';

export const OPENAI_MODEL_MAX = 256;
export const OPENAI_MESSAGE_CONTENT_MAX = 65536;
export const OPENAI_MAX_TOKENS_CEILING = 4096;
export const OPENAI_DEFAULT_MAX_TOKENS = 64;

// Bounds shared with the dispatch store result normalizer so the HTTP
// validator and the durable store accept exactly the same completions.
export const OPENAI_CONTENT_MAX = 65536;

// Mirrors the coordinator's key/reference shapes so generated keys reconcile.
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const ADMISSION_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ALLOWED_REQUEST_FIELDS = new Set(['model', 'messages', 'max_tokens', 'stream']);
const ALLOWED_MESSAGE_FIELDS = new Set(['role', 'content']);
// Refused before dispatch with their own honest codes (never stripped).
const TOOL_FIELDS = new Set(['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls',
  'stream_options']);
const SAMPLING_FIELDS = new Set(['temperature', 'top_p', 'top_k', 'seed', 'stop',
  'n', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs',
  'top_logprobs', 'response_format', 'user']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= OPENAI_MODEL_MAX;

/** Typed OpenAI-style error envelope. */
export function openAIError(http, code, message, type = 'server_error') {
  return { http, body: { error: { message: String(message), type, code: String(code) } } };
}

/**
 * Validate an OpenAI chat-completions request body with bounded fields.
 * Initial-route rule: exactly one `{role:'user', content}` message. Anything
 * wider is refused with `limited_compatibility`, never squeezed into the
 * single-prompt contract silently.
 * @returns {{ok:true,value:{model:string|null,content:string,max_tokens:number}}|{ok:false,error:object}}
 */
export function validateChatCompletionRequest(body) {
  if (!isObj(body)) return { ok: false, error: openAIError(400, 'invalid_request', 'A JSON object is required.', 'invalid_request_error') };
  for (const k of Object.keys(body)) {
    if (k === 'stream') {
      if (body.stream === false) continue; // ordinary explicit non-streaming client
      return { ok: false, error: openAIError(400, 'unsupported_stream',
        'Streaming is not supported by the fabric transport; the request was not dispatched.', 'invalid_request_error') };
    }
    if (TOOL_FIELDS.has(k)) {
      return { ok: false, error: openAIError(400, 'unsupported_tools',
        'Tool calling is a separate qualification and is not enabled; the request was not dispatched.', 'invalid_request_error') };
    }
    if (SAMPLING_FIELDS.has(k)) {
      return { ok: false, error: openAIError(400, 'unsupported_parameter',
        `Parameter ${JSON.stringify(k)} is not supported; the request was not dispatched.`, 'invalid_request_error') };
    }
    if (!ALLOWED_REQUEST_FIELDS.has(k)) {
      return { ok: false, error: openAIError(400, 'unsupported_field',
        'Only model, messages, max_tokens and stream:false are accepted.', 'invalid_request_error') };
    }
  }
  const rawModel = body.model === undefined ? 'auto' : body.model;
  if (typeof rawModel !== 'string' || rawModel.length === 0 || rawModel.length > OPENAI_MODEL_MAX) {
    return { ok: false, error: openAIError(400, 'invalid_model', 'model must be a non-empty string of at most 256 characters.', 'invalid_request_error') };
  }
  // 'auto' (or omitted) constrains nothing: eligibility/placement stays
  // server-side. Any other string is a constraint the admission must match.
  const model = rawModel === 'auto' ? null : rawModel;
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    return { ok: false, error: openAIError(400, 'limited_compatibility',
      'This initial route accepts exactly one user text message; multi-message conversations are not supported and were not dispatched.', 'invalid_request_error') };
  }
  const m = body.messages[0];
  if (!isObj(m) || Object.keys(m).some((k) => !ALLOWED_MESSAGE_FIELDS.has(k))) {
    return { ok: false, error: openAIError(400, 'invalid_message', 'messages[0] must contain only role and content.', 'invalid_request_error') };
  }
  if (m.role !== 'user') {
    return { ok: false, error: openAIError(400, 'limited_compatibility',
      `messages[0].role ${JSON.stringify(m.role)} is not servable: this initial route accepts exactly one user text message. Roles are never re-labelled silently.`, 'invalid_request_error') };
  }
  if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > OPENAI_MESSAGE_CONTENT_MAX) {
    return { ok: false, error: openAIError(400, 'invalid_message',
      `messages[0].content must be non-empty text of at most ${OPENAI_MESSAGE_CONTENT_MAX} characters.`, 'invalid_request_error') };
  }
  const maxTokens = body.max_tokens === undefined ? OPENAI_DEFAULT_MAX_TOKENS : body.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > OPENAI_MAX_TOKENS_CEILING) {
    return { ok: false, error: openAIError(400, 'invalid_max_tokens',
      `max_tokens must be an integer in 1..${OPENAI_MAX_TOKENS_CEILING}.`, 'invalid_request_error') };
  }
  return { ok: true, value: { model, content: m.content, max_tokens: maxTokens } };
}

/**
 * Resolve the requested model against the server-issued admission. 'auto'
 * takes the admitted model; an explicit model must equal it, otherwise the
 * request targets a different binding and is refused (no silent substitution).
 */
export function resolveModel(requestedModel, admission) {
  const admitted = admission && typeof admission.model_id === 'string' ? admission.model_id : null;
  if (!admitted) {
    return { ok: false, error: openAIError(403, 'admission_not_available', 'No admission covers this request.', 'invalid_request_error') };
  }
  if (requestedModel === null) return { ok: true, value: admitted };
  if (requestedModel !== admitted) {
    return { ok: false, error: openAIError(404, 'model_not_found',
      `Model ${JSON.stringify(requestedModel)} is not admitted for this request; no substitution was applied.`, 'invalid_request_error') };
  }
  return { ok: true, value: admitted };
}

/**
 * Build the coordinator submit body from a validated request. The single
 * user content passes through VERBATIM as the task prompt: no role framing,
 * no caller machine/tenant/placement fields. The target comes only from the
 * server-side admission record resolved inside the coordinator.
 */
export function buildDispatchRequest(valid, { admission_ref, idempotency_key, deadline_at, model_id }) {
  if (typeof admission_ref !== 'string' || !ADMISSION_REF_RE.test(admission_ref)) throw new Error('INVALID_ADMISSION_REF');
  if (typeof idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotency_key)) throw new Error('INVALID_IDEMPOTENCY_KEY');
  if (!Number.isSafeInteger(deadline_at) || !isId(model_id)) throw new Error('INVALID_DISPATCH_TARGET');
  if (!Number.isInteger(valid.max_tokens) || valid.max_tokens < 1 || valid.max_tokens > OPENAI_MAX_TOKENS_CEILING) {
    throw new Error('INVALID_MAX_TOKENS');
  }
  if (typeof valid.content !== 'string' || !valid.content.trim() || valid.content.length > OPENAI_CONTENT_MAX) {
    throw new Error('INVALID_PROMPT');
  }
  return {
    contract_version: CONTRACT_VERSION,
    admission_ref,
    idempotency_key,
    model_id,
    prompt: valid.content,
    max_tokens: valid.max_tokens,
    deadline_at,
  };
}

/**
 * Build an OpenAI models list from fresh AUTHORIZED inventory entries only.
 * Each entry is {model_id, usable, liveness}: anything not positively
 * usable+online is excluded, so only real authorized models are advertised.
 */
export function buildModelsList(entries) {
  const ids = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isObj(e) || !isId(e.model_id)) continue;
    if (e.usable !== true || e.liveness !== 'online') continue;
    ids.add(e.model_id);
  }
  const data = [...ids].sort().map((id) => ({ id, object: 'model', created: 0, owned_by: 'fabric' }));
  return { object: 'list', data };
}

/** No eligible worker: truthful typed error, never a direct-runtime fallback. */
export function noEligibleWorker(requestedModel) {
  return openAIError(409, 'no_eligible_worker',
    requestedModel
      ? `No eligible worker can serve model ${JSON.stringify(requestedModel)}; the request was not dispatched.`
      : 'No eligible worker is available; the request was not dispatched.',
    'server_error');
}

const knownCount = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Pass worker-reported token counts through ONLY when every value is real.
 * Unknown stays null: unmeasured usage is never fabricated as zero.
 */
export function coerceUsage(usage) {
  const u = isObj(usage) ? usage : {};
  const prompt = knownCount(u.prompt_tokens ?? u.prompt ?? u.input_tokens);
  const completion = knownCount(u.completion_tokens ?? u.completion ?? u.output_tokens);
  let total = knownCount(u.total_tokens ?? u.total);
  if (total === null && prompt !== null && completion !== null) total = prompt + completion;
  if (prompt === null || completion === null || total === null) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function chatCompletion({ jobId, model, content, usage, provenance, created }) {
  return {
    id: `chatcmpl-${jobId}`,
    object: 'chat.completion',
    created: Number.isSafeInteger(created) ? created : Math.floor(Date.now() / 1000),
    model,
    // The EIF result carries no stop/length evidence: 'unknown' is the only
    // honest finish_reason. Usage is null when the worker reported no real
    // counts (unknown is not zero).
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'unknown' }],
    usage: coerceUsage(usage),
    // Proof of the fabric path: the chosen machine correlated with job/output.
    provenance: {
      path: 'fabric',
      job_id: jobId,
      node_id: provenance.node_id,
      runtime_id: provenance.runtime_id,
      model_id: provenance.model_id,
      runtime_instance: provenance.runtime_instance,
      model_fingerprint: provenance.model_fingerprint,
      simulated: false,
    },
  };
}

/**
 * Validate a settled worker result against the EXACT job/binding identity and
 * map it to an OpenAI chat completion. Wrong-owner/wrong-node/wrong-model,
 * simulated, empty, or oversized results are rejected, never surfaced.
 */
export function mapSettledJobToCompletion(job, binding, { created } = {}) {
  const expected = { id: job && job.id, node_id: binding && binding.node_id,
    runtime_id: binding && binding.runtime_id, model_id: binding && binding.model_id };
  let decoded;
  try {
    decoded = decodeCpuTask(job, expected);
  } catch {
    return { ok: false, error: openAIError(502, 'result_rejected',
      'The worker result failed identity or shape validation and was not surfaced.', 'server_error') };
  }
  if (decoded.status !== 'succeeded') {
    const code = decoded.status === 'expired' ? 'job_expired' : 'worker_failed';
    const http = decoded.status === 'expired' ? 504 : 502;
    return { ok: false, error: openAIError(http, code, `The job finished with status ${decoded.status}; no completion is surfaced.`, 'server_error') };
  }
  if (job.result.runtime_instance !== binding.runtime_instance
    || job.result.model_fingerprint !== binding.model_fingerprint) {
    return { ok: false, error: openAIError(502, 'result_rejected',
      'The worker result failed instance/fingerprint binding validation.', 'server_error') };
  }
  return { ok: true, value: chatCompletion({ jobId: expected.id, model: expected.model_id,
    content: decoded.content, usage: job.result.usage,
    provenance: { node_id: expected.node_id, runtime_id: expected.runtime_id, model_id: expected.model_id,
      runtime_instance: binding.runtime_instance, model_fingerprint: binding.model_fingerprint }, created }) };
}

/**
 * Map any coordinator outcome (submit/reconcile/cancel/viewOf) onto an HTTP
 * response. Interim states use an explicit fabric envelope; ONLY a verified
 * settled success becomes an OpenAI chat.completion, and a 202 dispatch
 * envelope is NEVER presented as one. Unknown outcomes are never retried
 * automatically and never claimed as remote-stopped.
 */
export function mapDispatchResult(out, { job = null, binding = null, created } = {}) {
  if (!isObj(out) || typeof out.status !== 'string') {
    return { http: 503, body: openAIError(503, 'outcome_uncertain', 'An unknown dispatch outcome was retained; it was not retried.', 'server_error').body };
  }
  const err = (http, code, message, type = 'server_error') => ({ http, body: openAIError(http, code, message, type).body });
  switch (out.status) {
    case 'dispatched':
      return { http: 202, body: { object: 'aipster.fabric.dispatch', status: 'dispatched',
        op_id: out.op_id, job_id: out.job_id,
        note: 'Poll the operation to reconcile; only a settled success returns a chat.completion.' } };
    case 'pending':
      return err(409, 'operation_in_progress', 'The operation is still in progress; reconcile by idempotency key.', 'invalid_request_error');
    case 'released':
      return err(409, 'not_admitted', 'The operation was released before admission; nothing was dispatched.', 'invalid_request_error');
    case 'settled': {
      const outcome = isObj(out.outcome) ? out.outcome : {};
      if (outcome.finish === 'succeeded' && typeof outcome.content === 'string' && job && binding) {
        const mapped = mapSettledJobToCompletion(job, binding, { created });
        return mapped.ok ? { http: 200, body: mapped.value } : { http: mapped.error.http, body: mapped.error.body };
      }
      if (outcome.finish === 'succeeded' && typeof outcome.content === 'string') {
        // Settled success whose release was withheld (or polled without the
        // job row): content exists but release was not authorized.
        return err(503, 'release_withheld',
          outcome.withheld_reason ? `Settlement succeeded but release was withheld (${outcome.withheld_reason}); no completion is surfaced.`
            : 'Settlement succeeded but the result release was not authorized; no completion is surfaced.');
      }
      if (outcome.finish === 'failed') return err(502, 'worker_failed', 'The worker reported failure; no completion is surfaced.');
      if (outcome.finish === 'expired') return err(504, 'job_expired', 'The job expired; no completion is surfaced.');
      if (typeof outcome.withheld_reason === 'string' && outcome.withheld_reason) {
        return err(503, 'release_withheld',
          `Settlement succeeded but the result release was withheld (${outcome.withheld_reason}); no completion is surfaced.`);
      }
      return err(503, 'settlement_unknown', 'The settlement outcome is unknown; it was not retried.');
    }
    case 'cancelled_before_start':
      return { http: 200, body: { object: 'aipster.fabric.dispatch', status: 'cancelled_before_start',
        op_id: out.op_id, code: 'CANCELLED' } };
    case 'expired_before_start':
      return err(504, 'deadline_exceeded', 'The deadline passed before start; nothing was dispatched.');
    case 'rejected': {
      const code = typeof out.code === 'string' ? out.code : 'dispatch_rejected';
      const http = Number.isSafeInteger(out.http) && out.http >= 100 && out.http <= 599 ? out.http : 400;
      const type = http >= 500 ? 'server_error' : 'invalid_request_error';
      return err(http, code.toLowerCase(), `Fabric dispatch refused the request (${code}); nothing was dispatched.`, type);
    }
    case 'uncertain':
    default: {
      const phase = typeof out.phase === 'string' ? out.phase : 'unknown';
      const code = typeof out.code === 'string' ? out.code : 'OUTCOME_UNCERTAIN';
      return { http: 503,
        body: { error: { message: `An unknown outcome at phase ${phase} (${code}) was retained with holds; it was not retried automatically and the remote was not claimed stopped.`,
          type: 'server_error', code: code.toLowerCase() },
        automatic_retry: false, remote_stopped: false, ...(out.op_id ? { op_id: out.op_id } : {}),
        ...(out.job_id ? { job_id: out.job_id } : {}) } };
    }
  }
}

export { MAX_DEADLINE_MS };
