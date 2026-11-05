/* Built with Meta Muse. Meta-qualification lane (meta-qual). */
/* Shared constants: flags, catalog, provider bounds. Pure, no I/O. */

export const QUAL_SCHEMA = 'qualification/v1';
export const QUAL_CATALOG_VERSION = 'qual-catalog-v1';
export const QUAL_PROMPT_VERSION = 'qual-prompt-v1';

export const QUAL_BENCHMARK_CATALOG = Object.freeze(['completion-smoke-v1']);
export const QUAL_UNSUPPORTED = 'unsupported';

export const BENCH_MAX_TOKENS = 32;
export const BENCH_DEADLINE_MS = 15 * 1000;
/* Queue freshness: an assignment unclaimed this long goes stale (uncertain),
   never silently leased. Separate from the execution deadline set at lease. */
export const QUAL_CLAIM_BY_MS = 60 * 60 * 1000;
/* Transit grace after the execution deadline for the result POST. */
export const QUAL_RESULT_GRACE_MS = 30 * 1000;
export const BENCH_PROMPT = 'Summarize in one short sentence: the local benchmark is running.';
export const BENCH_RUNTIMES = Object.freeze(['ganglion', 'llama-server']);

export const QUAL_BODY_MAX = 4 * 1024;
export const QUAL_RECEIPT_MAX = 4096;

export const QUAL_MODEL = 'muse-spark-1.3';
export const QUAL_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
export const QUAL_OUTPUT_MAX_TOKENS = 512;
export const QUAL_INPUT_BOUND_BYTES = 6000;
export const QUAL_DEADLINE_MS = 30 * 1000;
export const QUAL_RESPONSE_MAX = 64 * 1024;
export const QUAL_PRICE_IN_PER_M = 1.25;
export const QUAL_PRICE_OUT_PER_M = 4.25;
/* Minimal reasoning effort, mirroring the verified DGM provider shape: keeps
   short outputs inside the fixed budget instead of truncating into them. */
export const QUAL_REASONING_EFFORT = 'minimal';

/* Spend is tracked in integer micro-USD so aggregate admission is exact. */
export const USD_MICRO = 1_000_000;
export function spendMicroUsd(inputTokens, outputTokens) {
  return Math.ceil((inputTokens * QUAL_PRICE_IN_PER_M + outputTokens * QUAL_PRICE_OUT_PER_M) / 1e6 * USD_MICRO);
}
/* Worst-case reservation for one call: the full UTF-8 input byte bound as
   tokens (never the chars/4 estimate) plus the full output maximum. */
export function worstCaseSpendMicroUsd() {
  return spendMicroUsd(QUAL_INPUT_BOUND_BYTES, QUAL_OUTPUT_MAX_TOKENS);
}

/** Feature gate: off by default, explicit flag only. */
export function qualificationEnabled(env) {
  return !!env && env.QUALIFICATION_ENABLED === '1';
}

/** Live provider opens only with flag + bound server key + non-demo session. */
export function qualificationLiveEnabled(env, { demo = false } = {}) {
  if (demo) return false;
  if (!env || env.QUALIFICATION_LIVE !== '1') return false;
  return typeof env.MODEL_API_KEY === 'string' && env.MODEL_API_KEY.length > 0;
}
