# Fabric flow mapping: EIF → AIPSTER (bounded lane GOOSE-JJP-FABRIC-DASHBOARD-20261102)

Upstream inspected read-only at `elastic-inference-fabric`, branch
`review/optimizations @3eb46cdd`: `fabric/src/App.tsx:356-381` (brand +
connection header), `fabric/src/FabricTopology.tsx:40` (flow section),
`fabric/src/bench/BenchDiagram.tsx:254` (throughput bench),
`fabric/src/FabricCopilot.tsx:53` (chat — out of scope, not mapped),
`fabric/src/NodeIdentity.tsx:4` (demo labels — not reused).

No EIF authentication, endpoints, sample identities, or fixture metrics are
reused. Screenshots live in the parent conversation, not on JJP; no pixel
comparison is claimed.

## Entities

| EIF | AIPSTER | Provenance |
| --- | --- | --- |
| Agent / harness card | Signed-in owner session (browser) | Derived: no agent token plane exists here |
| Authenticated MCP router | None — architectural label only | Unsupported: never invent an MCP connection |
| Worker card (node) | Status item + inventory card | Sourced (`GET /api/status`, `GET /api/inventory`) |
| CPU / GPU / memory / runtime fields | Declared free-text compute (`cpu`, `gpu`), capabilities list | Sourced-but-declared: informational only, never measured |
| Resident model / readiness | Not mapped | Unsupported: heartbeats prove reachability only, never inference acceptance |
| Throughput bars (tok/s) | Always `unavailable` | Unsupported: `GET /api/usage` reports cumulative requests/tokens/costs only |

## Edges and legend

| EIF | AIPSTER |
| --- | --- |
| Request | Architectural label: dispatch is disabled (`POST /api/jobs` → `501`) |
| Result | Summarized-or-unavailable: cumulative usage totals, no streamed results |
| Heartbeat | Live: `heartbeat_at` freshness (`STALE_AFTER_MS` = 5 min); `unknown` when the flag claims online without telemetry |
| Resident / Cached / Unprovisioned | Unsupported legend entries, labeled as such |

## States

Loading, stale, unavailable, and denied follow existing Overview patterns
(`loading()` / `state()` shells, generation-fenced polling, `unknown`
liveness, 401/403 copy). `usable=false` renders as reachable-but-not-usable
attention, never ready. Missing metrics are `null` (unknown), never zero.

## Visual adaptation (EIF reference, exact source, no pixel originals)

Peter's screenshots (`Screenshot 2026-11-01 141724/141746.png`) are not
present on JJP; the adaptation below is mapped from the exact EIF source at
`review/optimizations @3eb46cdd` (`fabric/src/FabricTopology.tsx`,
`topology.css`, `bench/BenchBodies.tsx`, `bench.css`), never from assumed
pixels. Gap map, current versus reference:

- Current: vertical stacked section cards, vertical entry/control blocks,
  text-only edges, single-column node facts, key-value throughput panel.
- Reference: wide horizontal agent/harness → router/control → node map with
  deliberate edge rails (line + arrow + label), a return lane, a swatch
  legend footer, dense node cards (status dot, host line, two-column facts,
  model chips), and a bench with axis ticks plus measured-fill versus
  hatched-empty tracks with a "Not measured" word.
- Adapted, not copied: AIPSTER flat palette and type; no gradients, glow, or
  motion. The entry reads "Browser session" and the control stage reads
  "AIPSTER API" — never an authenticated MCP router, which does not exist
  here. Model chips become declared-capability chips plus an explicit
  "models not reported" line (no resident/cached states exist here).
  The bench keeps the axis + hatched-empty-track + "Not measured" pattern
  with cumulative totals and page coverage; no fills, bars, or rates.

## Permission boundary

Owner-confined reads (`needAuthz('read')`); heartbeat writes are
heartbeat-scoped-key-only and bound to one resource; demo telemetry stays
fixture-labeled; no grants, credentials, dispatch, or control APIs are added.
The DOM wiring lives in the three integrator-owned shared files recorded in
docs/fabric-dashboard-integrator-claim.md (sole-writer designation; W2's
branch preserved untouched). The view-model module emits data only; the
wiring renders every string through `esc()`.
