// DGM routing evaluation core: pure, synchronous, Worker-safe.
//
// The single source for the synthetic routing workload, the weight-mirrored
// route/v1 scorer, the outcome rule, and the search-space ceiling. It runs in
// the Cloudflare Worker (daily cron self-test) and in Node (the local
// experiment lane re-exports from here), so it imports no node:* module and
// performs no I/O: no files, no network, no model calls, no clock reads.
//
// Baseline scoring delegates to the authoritative scoreCandidates in
// ../routing/policy.mjs with its live ROUTING_SCORE weights. Every snapshot
// re-proves that the weight mirror reproduces the authoritative order at
// those weights (mirror_fidelity guardrail), so a scorer change can never
// silently shift what the candidates are compared against. (The Node lane
// additionally pins the scorer's source hash; a Worker cannot read source.)
//
// Everything here is SYNTHETIC: a fixed weight-independent oracle over
// generated descriptors. Nothing measures real-fabric quality.
import { ROUTING_POLICY_VERSION, ROUTING_SCORE, scoreCandidates } from '../routing/policy.mjs';

export const SELF_TEST_SCHEMA = 'aipster.dgm.self-test/v1';
export const EVAL_VERSION = 'dgm-routing-eval/v1';

// ---- Synthetic workload (moved verbatim from experiments/dgm-routing/workload.mjs) ----

export const WORKLOAD_SEED = 20261105;
export const TRAIN_SIZE = 24;
export const HELDOUT_SIZE = 24;
export const WORKLOAD_VERSION = 'dgm-routing-workload/v1';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIVENESS = ['online', 'online', 'online', 'stale'];
const TOKEN_HEADROOMS = [0, 512, 1024, 4096];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Oracle rule (fixed, weight-independent): exact token match first, then
 * online liveness, then owner-direct, then larger token headroom, then alias.
 * This is a SYNTHETIC preference for measuring decision movement, not a
 * production quality signal.
 */
export function oracleBest(descriptors) {
  const rank = (d) => [
    d.exactTokenMatch ? 0 : 1,
    d.liveness === 'online' ? 0 : 1,
    d.via && d.via.owned ? 0 : 1,
    d.capacity ? -d.capacity.tokensRemaining : 0,
    d.alias,
  ];
  const sorted = [...descriptors].sort((a, b) => {
    const ra = rank(a); const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  });
  return sorted[0].alias;
}

function makeItem(rng, index, split) {
  const n = 4 + Math.floor(rng() * 3); // 4..6 candidates
  const maxTokens = pick(rng, [128, 256, 512]);
  const descriptors = [];
  for (let i = 0; i < n; i++) {
    const alias = `r${i}`;
    const liveness = pick(rng, LIVENESS);
    const exactTokenMatch = rng() < 0.4;
    const lastSeenAgeMs = liveness === 'online' ? Math.floor(rng() * 600000) : null;
    const owned = rng() < 0.5;
    const headroom = pick(rng, TOKEN_HEADROOMS);
    descriptors.push({
      alias,
      resourceId: `${split}-res-${index}-${i}`,
      ownerId: `owner-${Math.floor(rng() * 3)}`,
      kind: 'cpu',
      modelCompat: 'unverified',
      exactTokenMatch,
      caps: exactTokenMatch ? ['llama'] : ['other'],
      liveness,
      lastSeenAgeMs,
      usable: true,
      capacity: owned ? null : { jobsRemaining: 3, tokensRemaining: headroom },
      via: owned ? { owned: true } : { grantId: `grant-${index}-${i}` },
      provenance: { policyVersion: 'route/v1', evaluatedAt: 'synthetic' },
    });
  }
  return {
    id: `${split}-${index}`,
    features: { model: 'llama', maxTokens },
    descriptors,
    oracleBest: oracleBest(descriptors),
  };
}

function makeSplit(seed, size, split) {
  const rng = mulberry32(seed);
  const items = [];
  for (let i = 0; i < size; i++) items.push(makeItem(rng, i, split));
  return items;
}

export function buildWorkload() {
  return {
    version: WORKLOAD_VERSION,
    seed: WORKLOAD_SEED,
    train: makeSplit(WORKLOAD_SEED, TRAIN_SIZE, 'train'),
    heldout: makeSplit(WORKLOAD_SEED ^ 0x9e3779b9, HELDOUT_SIZE, 'heldout'),
  };
}

function serializeItem(item) {
  return JSON.stringify({ features: item.features, descriptors: item.descriptors });
}

/**
 * Independence check: the held-out split must not repeat train patterns.
 * Returns { disjoint, crossDuplicates, idCollisions }.
 */
export function assertSplitsIndependent(workload) {
  const train = workload.train || [];
  const heldout = workload.heldout || [];
  const trainSet = new Set(train.map(serializeItem));
  let crossDuplicates = 0;
  for (const item of heldout) {
    if (trainSet.has(serializeItem(item))) crossDuplicates += 1;
  }
  const ids = [...train, ...heldout].map((i) => i.id);
  const idCollisions = ids.length - new Set(ids).size;
  return { disjoint: crossDuplicates === 0 && idCollisions === 0, crossDuplicates, idCollisions };
}

// ---- Candidate space ----

export const WEIGHT_KEYS = Object.freeze(['EXACT_TOKEN', 'ONLINE', 'FRESHNESS_MAX', 'OWNED', 'HEADROOM']);

export const WEIGHT_ALLOWLIST = Object.freeze({
  EXACT_TOKEN: Object.freeze([40, 50, 60]),
  ONLINE: Object.freeze([20, 30, 40]),
  FRESHNESS_MAX: Object.freeze([10, 20]),
  OWNED: Object.freeze([5, 10, 15]),
  HEADROOM: Object.freeze([0, 5, 10]),
});

/** Canonical, order-fixed key for a weight vector (hash-free, Worker-safe). */
export function weightsKey(w) {
  return WEIGHT_KEYS.map((k) => `${k}=${w[k]}`).join(',');
}

/** Every weight vector the allowlist admits (including the baseline), in a fixed order. */
export function enumerateAllowlist() {
  const out = [];
  const walk = (i, cur) => {
    if (i === WEIGHT_KEYS.length) { out.push({ ...cur }); return; }
    for (const v of WEIGHT_ALLOWLIST[WEIGHT_KEYS[i]]) {
      cur[WEIGHT_KEYS[i]] = v;
      walk(i + 1, cur);
    }
  };
  walk(0, {});
  return out;
}

// ---- Scoring and measurement ----

function compareAlias(a, b) {
  const pa = /^([a-z]*)(\d+)$/.exec(a) || [null, a, ''];
  const pb = /^([a-z]*)(\d+)$/.exec(b) || [null, b, ''];
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return Number(pa[2] || 0) - Number(pb[2] || 0);
}

/**
 * Weight-parameterized scorer mirroring policy.mjs scoreCandidates exactly
 * (same contributions, same tie-break). Fidelity is re-proved per snapshot
 * (mirror_fidelity) and pinned by tests.
 */
export function scoreWithWeights(candidates, { model = null, maxTokens = null } = {}, weights) {
  const input = Array.isArray(candidates) ? candidates : [];
  const ranked = input.slice(0, 200).map((c) => {
    const contributions = [];
    const give = (feature, points, detail) => contributions.push({ feature, points, detail });
    give('exactTokenMatch', c.exactTokenMatch ? weights.EXACT_TOKEN : 0, '');
    give('online', c.liveness === 'online' ? weights.ONLINE : 0, '');
    const fresh = c.lastSeenAgeMs === null ? 0 : Math.max(0, weights.FRESHNESS_MAX - Math.floor(c.lastSeenAgeMs / 60000));
    give('freshness', fresh, '');
    const owned = !!(c.via && c.via.owned);
    give('owned', owned ? weights.OWNED : 0, '');
    const remaining = c.capacity ? c.capacity.tokensRemaining : null;
    const headroom = remaining !== null && Number.isSafeInteger(maxTokens) && maxTokens > 0 && remaining >= 2 * maxTokens;
    give('headroom', headroom ? weights.HEADROOM : 0, '');
    return {
      alias: c.alias,
      policyVersion: 'route/v1',
      score: contributions.reduce((s, x) => s + x.points, 0),
      contributions,
      candidate: c,
    };
  });
  ranked.sort((a, b) => (b.score - a.score) || compareAlias(a.alias, b.alias));
  return { policyVersion: 'route/v1', ranked, truncated: input.length > 200 };
}

function measure(items, scoreFn) {
  let top1 = 0;
  let rankSum = 0;
  const orders = [];
  const itemRanks = [];
  for (const item of items) {
    const order = scoreFn(item.descriptors, item.features).ranked.map((r) => r.alias);
    orders.push(order);
    const rank = order.indexOf(item.oracleBest) + 1;
    itemRanks.push(rank);
    if (rank === 1) top1 += 1;
    rankSum += rank;
  }
  return {
    n: items.length,
    top1Hits: top1,
    meanRankOfOracleBest: items.length ? rankSum / items.length : null,
    orders,
    itemRanks,
  };
}

function permutationsOk(items, orders) {
  return orders.every((order, i) => {
    const want = new Set(items[i].descriptors.map((d) => d.alias));
    return order.length === want.size && order.every((a) => want.has(a)) && new Set(order).size === order.length;
  });
}

/**
 * Outcome rule (identical to experiments/dgm-routing/runner.mjs):
 * 'improvement' = strict held-out top-1 gain AND zero per-item rank
 * regressions; 'tie-archived' = equal top-1, zero regressions; else
 * 'regression'.
 */
export function decideOutcome(heldBase, heldCand) {
  const worsened = heldBase.itemRanks.filter((r, i) => heldCand.itemRanks[i] > r).length;
  if (heldCand.top1Hits > heldBase.top1Hits && worsened === 0) return 'improvement';
  if (heldCand.top1Hits === heldBase.top1Hits && worsened === 0) return 'tie-archived';
  return 'regression';
}

const OUTCOME_ORDER = { improvement: 0, 'tie-archived': 1, regression: 2 };

/**
 * Total order over evaluated candidates: outcome class, then held-out top-1,
 * then held-out mean rank (lower is better), then train top-1, then the
 * canonical weights key. Shared with the Node lane so both name the same
 * best candidate. Entries need {outcome, heldoutTop1, heldoutMeanRank,
 * trainTop1, weightsKey}.
 */
export function candidateBetter(a, b) {
  if (OUTCOME_ORDER[a.outcome] !== OUTCOME_ORDER[b.outcome]) return OUTCOME_ORDER[a.outcome] < OUTCOME_ORDER[b.outcome];
  if (a.heldoutTop1 !== b.heldoutTop1) return a.heldoutTop1 > b.heldoutTop1;
  if (a.heldoutMeanRank !== b.heldoutMeanRank) return a.heldoutMeanRank < b.heldoutMeanRank;
  if (a.trainTop1 !== b.trainTop1) return a.trainTop1 > b.trainTop1;
  return a.weightsKey < b.weightsKey;
}

function evalFailure(message) {
  return Object.assign(new Error(message), { code: 'DGM_EVAL_FAILED' });
}

/**
 * One deterministic daily self-test snapshot: the authoritative baseline,
 * every allowlisted candidate, the ceiling, and per-weight movement of the
 * best candidate. Synchronous, no I/O. Throws DGM_EVAL_FAILED on any
 * internal inconsistency rather than returning a guessed result.
 */
export function computeSelfTestSnapshot() {
  const wl = buildWorkload();
  const baseWeights = {};
  for (const k of WEIGHT_KEYS) {
    if (!Number.isSafeInteger(ROUTING_SCORE[k])) throw evalFailure(`ROUTING_SCORE.${k} is not an integer`);
    baseWeights[k] = ROUTING_SCORE[k];
  }
  const authoritative = (d, f) => scoreCandidates(d, f);
  const baseTrain = measure(wl.train, authoritative);
  const baseTrain2 = measure(wl.train, authoritative);
  const baseHeld = measure(wl.heldout, authoritative);
  const mirrorTrain = measure(wl.train, (d, f) => scoreWithWeights(d, f, baseWeights));
  const mirrorHeld = measure(wl.heldout, (d, f) => scoreWithWeights(d, f, baseWeights));
  const splits = assertSplitsIndependent(wl);

  let candidatePermutationsOk = true;
  const counts = { improvement: 0, 'tie-archived': 0, regression: 0 };
  let evaluated = 0;
  let best = null;
  const baseKey = weightsKey(baseWeights);
  for (const weights of enumerateAllowlist()) {
    const key = weightsKey(weights);
    if (key === baseKey) continue; // the baseline is not a candidate (no delta)
    const fn = (d, f) => scoreWithWeights(d, f, weights);
    const train = measure(wl.train, fn);
    const held = measure(wl.heldout, fn);
    if (!permutationsOk(wl.train, train.orders) || !permutationsOk(wl.heldout, held.orders)) candidatePermutationsOk = false;
    const outcome = decideOutcome(baseHeld, held);
    counts[outcome] += 1;
    evaluated += 1;
    const entry = {
      outcome, weights: { ...weights }, weightsKey: key,
      heldoutTop1: held.top1Hits, trainTop1: train.top1Hits, heldoutMeanRank: held.meanRankOfOracleBest,
    };
    if (!best || candidateBetter(entry, best)) best = entry;
  }

  const guardrails = [
    { name: 'permutation_integrity', passed: permutationsOk(wl.train, baseTrain.orders) && permutationsOk(wl.heldout, baseHeld.orders) && candidatePermutationsOk },
    { name: 'replay_determinism', passed: JSON.stringify(baseTrain.orders) === JSON.stringify(baseTrain2.orders) },
    { name: 'mirror_fidelity', passed: JSON.stringify(mirrorTrain.orders) === JSON.stringify(baseTrain.orders) && JSON.stringify(mirrorHeld.orders) === JSON.stringify(baseHeld.orders) },
    { name: 'split_independence', passed: splits.disjoint },
  ];
  // A failed guardrail voids every improvement claim (runner.mjs rule).
  const guardsOk = guardrails.every((g) => g.passed);
  if (!guardsOk && counts.improvement > 0) {
    counts.regression += counts.improvement;
    counts.improvement = 0;
    if (best && best.outcome === 'improvement') best = { ...best, outcome: 'regression' };
  }

  return {
    schema: SELF_TEST_SCHEMA,
    evalVersion: EVAL_VERSION,
    policyVersion: ROUTING_POLICY_VERSION,
    synthetic: true,
    workload: { version: wl.version, seed: wl.seed, trainN: wl.train.length, heldoutN: wl.heldout.length },
    guardrails,
    baseline: { weights: baseWeights, heldoutTop1: baseHeld.top1Hits, trainTop1: baseTrain.top1Hits, heldoutMeanRank: baseHeld.meanRankOfOracleBest },
    ceiling: best ? best.outcome : 'empty',
    proposalCanImprove: counts.improvement > 0,
    evaluated,
    counts,
    best,
    variables: best ? WEIGHT_KEYS.map((k) => ({
      name: k,
      baseline: baseWeights[k],
      best: best.weights[k],
      direction: best.weights[k] > baseWeights[k] ? 'up' : best.weights[k] < baseWeights[k] ? 'down' : 'same',
    })) : [],
  };
}
