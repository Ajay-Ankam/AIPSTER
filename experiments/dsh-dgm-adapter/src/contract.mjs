// Versioned contract for the AIPSTER DSH x DGM experiment.
//
// These identifiers are deliberately NEW and experiment-scoped. They do not
// reuse or re-declare any identifier owned by another lane:
//   - the DGM fixture preview owns  aipster.dgm.preview/v1, dgm-fixture-table/v1,
//     admin.dgm.preview, DGM_PREVIEW_ENABLED;
//   - the offline artifact import owns aipster.dgm.evaluation-request/v1 and
//     aipster.dgm.evaluation-result/v1.
// This module evaluates *upstream dsh-superagent work proposals*, a different
// seam, and says so on every surface.

export const ADAPTER_SCHEMA = 'aipster.dsh-dgm.adapter/v1';
export const REQUEST_SCHEMA = 'aipster.dsh-dgm.evaluation-request/v1';
export const VERDICT_SCHEMA = 'aipster.dsh-dgm.evaluation-verdict/v1';
export const SELECTION_SCHEMA = 'aipster.dsh-dgm.selection/v1';
export const RECEIPT_SCHEMA = 'aipster.dsh-dgm.receipt/v1';
export const WORK_ITEM_SCHEMA = 'aipster.dsh-dgm.work-item/v1';

export const MODULE_ID = 'aipster.dsh-dgm.adapter';
export const MODULE_VERSION = '1.0.0';

// The only way this experiment is turned on. Client-side, default off, and
// never read from a URL or a request body by anything outside this demo.
export const OPT_IN_FLAG = 'DSH_DGM_EXPERIMENT_ENABLED';

export const EVALUATION_KIND = 'synthetic-fixture';
export const AUTHORITY = 'shadow_only';

export const SELECTED = 'selected';
export const REJECTED = 'rejected';
export const FAILED = 'failed';
export const UNAVAILABLE = 'unavailable';
export const DISABLED = 'disabled';

export const VERDICT_STATUSES = [SELECTED, REJECTED, FAILED, UNAVAILABLE];

// Gate names are stable vocabulary. `mandate_valid` and `artifact_well_formed`
// are adapter-specific; the other four mirror the DGM preview slice's gate
// names without reusing its contract.
export const GATES = [
  'target_bound',
  'mandate_valid',
  'artifact_well_formed',
  'criteria_met',
  'envelope_fits',
  'archive_settled'
];

// Nothing in this experiment can apply a proposal. These names exist so the
// UI can render them as permanently unavailable, not as buttons that fail.
export const DISABLED_ACTIONS = Object.freeze({
  apply: 'application is disabled; this adapter produces a verdict only',
  promote: 'promotion is disabled; no code path enables it',
  execute: 'execution is disabled; no code path enables it',
  'open-pull-request': 'external GitHub writes are out of scope',
  merge: 'merging is out of scope'
});

export const MAX_LIMITATIONS = 16;
export const MAX_TEXT = 4096;
export const MAX_WORK_UNITS = 512;

// Browser-supplied keys that would smuggle authority into a request. This is
// the adapter's analogue of the preview slice's override table: a caller may
// choose a work item and (at most) a fixture revision, never an identity,
// digest, budget, gate result or verdict.
export const FORBIDDEN_INPUT_KEYS = Object.freeze([
  'request_sha256', 'verdict_sha256', 'receipt_sha256', 'selection_sha256',
  'run_id', 'tenant_id', 'actor_id', 'module', 'target', 'snapshot',
  'baseline', 'candidate', 'metrics', 'constraints', 'bounds', 'gates',
  'checks', 'status', 'verdict', 'selection', 'score', 'scores', 'budget',
  'budgets', 'seed', 'protocol', 'protocol_id', 'receipt', 'archive',
  'applied', 'authority', 'evaluation', 'work_units', 'repair_brief'
]);

export const LIMITATIONS = Object.freeze([
  'No model runs in this experiment; every check is a deterministic predicate over fixture data.',
  'The fixture set is authored and small; pass rates describe these fixtures, not general model quality.',
  'Baseline comparison is a policy comparison (parse-only admission vs DGM gate), not an agent capability measurement.',
  'Latency is reported as observed wall time and is excluded from every digest; it is not reproducible evidence of speed.',
  'Work units count deterministic predicate evaluations, not tokens, tool calls or money.',
  'The adapter maps synthetic dsh-superagent-shaped records; it does not execute dsh-superagent or DeepSeek Harness.',
  'No verdict applies, promotes, executes, merges or writes to GitHub, even when a proposal is selected.',
  'Scores are fixture check pass rates in parts per million, not upstream or DGM harness scores.'
]);

/**
 * A refusal is an honest non-result: no verdict, no score, no receipt. Every
 * refusal carries a machine code so a caller can tell "disabled" apart from
 * "not eligible" apart from "tampered".
 */
export function refusal(code, detail = '') {
  return { ok: false, code, detail };
}

export function isRefusal(value) {
  return Boolean(value) && typeof value === 'object' && value.ok === false && typeof value.code === 'string';
}

export function gate(name, passed, reason, detail = '') {
  if (!GATES.includes(name)) throw new RangeError(`unknown gate ${name}`);
  return { name, passed: Boolean(passed), reason, detail };
}

const BEARER = /bearer\s+[A-Za-z0-9\-._~+/=]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

/**
 * Text redaction for anything rendered or archived. Deliberately narrow
 * (bearer tokens, e-mail addresses, well-known token shapes) like the preview
 * slice; it is not a general PII scrubber.
 */
export function redactText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(BEARER, '[redacted]')
    .replace(EMAIL, '[redacted]')
    .replace(KNOWN_TOKEN, '[redacted]');
}

/** Deep redaction for display copies; counts and booleans pass through. */
export function redactDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = key === 'sha256' || key.endsWith('_sha256') ? inner : redactDeep(inner);
    }
    return out;
  }
  return value;
}

export function containsSecretMaterial(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /bearer\s|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i.test(text);
}
