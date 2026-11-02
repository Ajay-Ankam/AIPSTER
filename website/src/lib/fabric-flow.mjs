/* Built with Meta Muse. */
// Read-only Fabric flow + throughput view-model boundary. Pure functions only:
// no I/O, no fetch, no dispatch, no simulated-then-reported telemetry.
//
// Shape reference (adapted, not copied): upstream elastic-inference-fabric
// FabricTopology.tsx (agent/harness -> authenticated MCP router -> worker
// cards, request/result/heartbeat legend) and bench/BenchDiagram.tsx
// (measured throughput bench), inspected read-only at upstream branch
// review/optimizations @3eb46cdd509a73c5cbc55c8b55c5a6cb7bbd5d7f. AIPSTER
// differs deliberately, see docs/fabric-dashboard-mapping.md:
// - there is no MCP router / placement plane here; request/result edges are
//   architectural labels only, never live connections.
// - worker cards carry liveness from GET /api/status (heartbeat freshness,
//   STALE_AFTER_MS) plus declared compute free-text from inventory cards;
//   measured CPU/GPU/memory/runtime/resident-model fields are unsupported.
// - throughput is always unavailable: GET /api/usage reports cumulative
//   requests/tokens/costs only, never tokens/sec. Missing metrics are
//   unavailable, never zero.
// - this module emits data only, never markup. The DOM wiring (deferred to
//   the designated integrator: app.js/index.html/styles.css are a shared
//   lane) must render every string through the existing esc() helper.
import { STALE_AFTER_MS } from './status.mjs';

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/**
 * Map one trusted status item into a flow node. Returns null for malformed
 * rows so the caller skips them (fail-closed per row, never fail the view).
 */
export function flowNode(item) {
  if (!item || typeof item !== 'object') return null;
  if (!isId(item.id)) return null;
  if (typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 80) return null;
  const liveness = item.liveness;
  if (liveness !== 'online' && liveness !== 'stale' && liveness !== 'offline' && liveness !== 'unknown') return null;
  const lastSeenAt = item.lastSeenAt === null || item.lastSeenAt === undefined ? null : String(item.lastSeenAt);
  const lastSeenAgeMs = item.lastSeenAgeMs === null || item.lastSeenAgeMs === undefined
    ? null
    : (Number.isSafeInteger(item.lastSeenAgeMs) && item.lastSeenAgeMs >= 0 ? item.lastSeenAgeMs : null);
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    liveness,
    lastSeenAt: (liveness === 'online' || liveness === 'stale') ? lastSeenAt : null,
    // Units: milliseconds since the heartbeat was written, or null when no
    // heartbeat exists. Never seconds, never zero-filled.
    lastSeenAgeMs: (liveness === 'online' || liveness === 'stale') ? lastSeenAgeMs : null,
    usable: item.usable === null || item.usable === undefined ? null : item.usable === true,
    demoFixture: item.demoFixture === true,
  };
}

/**
 * Build the flow view-model from already-authorized GET /api/status and
 * GET /api/usage payloads. Throughput is always reported unavailable: usage
 * carries cumulative counts, never measured rates.
 */
export function buildFabricFlow({ status, usage, nowMs }) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const items = status && Array.isArray(status.items) ? status.items : [];
  const nodes = [];
  for (const raw of items) {
    const node = flowNode(raw);
    if (node) nodes.push(node);
  }
  const summary = status && status.summary && typeof status.summary === 'object' ? status.summary : null;
  const counts = summary && ['online', 'stale', 'offline', 'unknown'].every((k) => isCount(summary[k]))
    ? { online: summary.online, stale: summary.stale, offline: summary.offline, unknown: summary.unknown }
    : nodes.reduce((t, n) => ({ ...t, [n.liveness]: t[n.liveness] + 1 }),
      { online: 0, stale: 0, offline: 0, unknown: 0 });
  const total = status && isCount(status.total) ? status.total : nodes.length;
  const totals = usage && usage.totals && typeof usage.totals === 'object' ? usage.totals : null;
  // Absent-vs-zero: costs stay null (unknown) unless every contributing row
  // carried a real number; the /api/usage contract guarantees this, so the
  // flow view repeats it instead of summing around gaps.
  const usageTotals = totals
    ? {
      requests: isCount(totals.requests) ? totals.requests : null,
      tokensIn: isCount(totals.tokensIn) ? totals.tokensIn : null,
      tokensOut: isCount(totals.tokensOut) ? totals.tokensOut : null,
      modelCostUsd: totals.modelCostUsd === null || totals.modelCostUsd === undefined
        ? null
        : (Number.isFinite(totals.modelCostUsd) ? totals.modelCostUsd : null),
      executionCostUsd: totals.executionCostUsd === null || totals.executionCostUsd === undefined
        ? null
        : (Number.isFinite(totals.executionCostUsd) ? totals.executionCostUsd : null),
    }
    : null;
  const anyHeartbeat = nodes.some((n) => n.lastSeenAt !== null);
  return {
    schema: 'aipster.fabric-flow/1',
    generatedAt: new Date(now).toISOString(),
    staleAfterMs: STALE_AFTER_MS,
    demo: status ? status.demo === true : false,
    source: status && status.demo === true ? 'demo-fixture' : 'declared-resources',
    edges: {
      // No dispatch plane exists in this build (/api/jobs is disabled), so
      // request/result lanes are architectural labels, never live state.
      request: { state: 'architectural', label: 'Request (architectural: dispatch is disabled)' },
      result: {
        state: usageTotals ? 'summarized' : 'unavailable',
        label: usageTotals
          ? 'Result (architectural: usage totals only, no streamed results)'
          : 'Result unavailable: no usage payload',
      },
      heartbeat: {
        state: anyHeartbeat ? 'live' : 'none',
        label: anyHeartbeat
          ? 'Heartbeat: reachability only, never inference acceptance'
          : 'No worker heartbeats seen',
      },
    },
    legend: [
      { key: 'request', state: 'architectural' },
      { key: 'result', state: 'architectural' },
      { key: 'heartbeat', state: 'live' },
      { key: 'resident', state: 'unsupported' },
      { key: 'cached', state: 'unsupported' },
      { key: 'unprovisioned', state: 'unsupported' },
    ],
    nodes,
    counts: { total, ...counts },
    sharedWithMe: status && isCount(status.sharedWithMe) ? status.sharedWithMe : 0,
    itemsTruncated: status ? status.itemsTruncated === true : false,
    throughput: {
      state: 'unavailable',
      tokensPerSec: null,
      note: 'Throughput is unavailable: /api/usage reports cumulative '
        + 'requests/tokens/costs only, never measured tokens/sec. '
        + 'Unmeasured values stay null (unknown), never zero.',
    },
    usageTotals,
  };
}

/**
 * Shell view-model for loading / unavailable / denied / error states.
 * Carries no resource data, so a denied shell cannot leak row contents.
 */
export function emptyFlow({ reason, detail }) {
  const ok = reason === 'loading' || reason === 'unavailable' || reason === 'denied' || reason === 'error';
  return {
    schema: 'aipster.fabric-flow/1',
    state: ok ? reason : 'error',
    detail: typeof detail === 'string' ? detail.slice(0, 300) : null,
    nodes: [],
    throughput: { state: 'unavailable', tokensPerSec: null, note: null },
    usageTotals: null,
  };
}
