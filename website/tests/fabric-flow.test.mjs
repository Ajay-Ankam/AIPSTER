/* Built with Meta Muse. */
// Tests for the read-only Fabric flow view-model (website/src/lib/fabric-flow.mjs).
// Provenance: EIF labels adapted (not copied) from upstream
// elastic-inference-fabric branch review/optimizations @3eb46cdd509a73c5cbc55c8b55c5a6cb7bbd5d7f
// (FabricTopology.tsx flow/legend, bench/BenchDiagram.tsx throughput bench).
// AIPSTER base: worktree muse/fabric-dashboard-20261102 @974a345. No EIF
// authentication, endpoints, sample identities, or fixture metrics are reused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFabricFlow, emptyFlow, flowNode } from '../src/lib/fabric-flow.mjs';
import { STALE_AFTER_MS } from '../src/lib/status.mjs';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const statusOf = (items, extra = {}) => ({
  schema: 'aipster.status/1',
  generatedAt: iso(NOW),
  demo: false,
  source: 'declared-resources',
  telemetry: 'unavailable',
  summary: { total: items.length, online: 0, stale: 0, offline: 0, unknown: 0 },
  total: items.length,
  itemsTruncated: false,
  sharedWithMe: 0,
  items,
  ...extra,
});

test('flowNode keeps honest liveness: absent telemetry stays unknown, never online', () => {
  assert.equal(flowNode({ id: 'r_1', name: 'lab', kind: 'local', liveness: 'online', lastSeenAt: iso(NOW - 1000), lastSeenAgeMs: 1000, usable: true }).liveness, 'online');
  assert.equal(flowNode({ id: 'r_2', name: 'flag-only', kind: 'local', liveness: 'unknown', lastSeenAt: null, lastSeenAgeMs: null, usable: null }).liveness, 'unknown');
  assert.equal(flowNode({ id: 'r_3', name: 'off', kind: 'local', liveness: 'offline', lastSeenAt: iso(NOW - 1000), lastSeenAgeMs: 1000 }).lastSeenAt, null);
  assert.equal(flowNode(null), null);
  assert.equal(flowNode({ id: '../evil', name: 'x', kind: 'local', liveness: 'online' }), null);
  assert.equal(flowNode({ id: 'r_4', name: 'x', kind: 'local', liveness: 'ready' }), null);
});

test('units are milliseconds or null: never seconds, never zero-filled gaps', () => {
  const out = buildFabricFlow({
    status: statusOf([
      { id: 'r_on', name: 'fresh', kind: 'local', liveness: 'online', lastSeenAt: iso(NOW - 1500), lastSeenAgeMs: 1500, usable: true, demoFixture: false },
      { id: 'r_un', name: 'flag-no-telemetry', kind: 'local', liveness: 'unknown', lastSeenAt: null, lastSeenAgeMs: null, usable: null, demoFixture: false },
    ]),
    usage: null,
    nowMs: NOW,
  });
  assert.equal(out.staleAfterMs, STALE_AFTER_MS);
  assert.equal(out.nodes[0].lastSeenAgeMs, 1500);
  assert.equal(out.nodes[1].lastSeenAgeMs, null);
  assert.equal(out.nodes[1].lastSeenAt, null);
});

test('stale timestamps keep their age; usable=false never renders as ready', () => {
  const out = buildFabricFlow({
    status: statusOf([
      { id: 'r_st', name: 'old', kind: 'cluster', liveness: 'stale', lastSeenAt: iso(NOW - STALE_AFTER_MS - 1), lastSeenAgeMs: STALE_AFTER_MS + 1, usable: true, demoFixture: false },
      { id: 'r_nr', name: 'willing-but-waiting', kind: 'local', liveness: 'online', lastSeenAt: iso(NOW - 500), lastSeenAgeMs: 500, usable: false, demoFixture: false },
    ]),
    usage: null,
    nowMs: NOW,
  });
  assert.equal(out.nodes[0].liveness, 'stale');
  assert.equal(out.nodes[0].lastSeenAgeMs, STALE_AFTER_MS + 1);
  assert.equal(out.nodes[1].usable, false);
  assert.equal(out.edges.heartbeat.state, 'live');
});

test('throughput is always unavailable: usage totals never become tokens/sec', () => {
  const out = buildFabricFlow({
    status: statusOf([
      { id: 'r_on', name: 'fresh', kind: 'local', liveness: 'online', lastSeenAt: iso(NOW - 1000), lastSeenAgeMs: 1000, usable: true, demoFixture: false },
    ]),
    usage: { totals: { requests: 12, tokensIn: 300, tokensOut: 150, modelCostUsd: null, executionCostUsd: null } },
    nowMs: NOW,
  });
  assert.equal(out.throughput.state, 'unavailable');
  assert.equal(out.throughput.tokensPerSec, null);
  assert.match(out.throughput.note, /never measured tokens\/sec/);
  assert.deepEqual(
    ((u) => [u.requests, u.tokensIn, u.tokensOut, u.modelCostUsd, u.executionCostUsd])(out.usageTotals),
    [12, 300, 150, null, null],
  );
});

test('request/result edges are architectural labels, never live connections', () => {
  const out = buildFabricFlow({ status: statusOf([]), usage: null, nowMs: NOW });
  assert.equal(out.edges.request.state, 'architectural');
  assert.match(out.edges.request.label, /dispatch is disabled/);
  assert.equal(out.edges.result.state, 'unavailable');
  assert.ok(out.legend.some((e) => e.key === 'resident' && e.state === 'unsupported'));
  assert.ok(out.legend.some((e) => e.key === 'heartbeat' && e.state === 'live'));
});

test('denied shells carry no resource data', () => {
  const out = emptyFlow({ reason: 'denied', detail: 'Owner 403: this key cannot read inventory.' });
  assert.equal(out.state, 'denied');
  assert.deepEqual(out.nodes, []);
  assert.equal(out.usageTotals, null);
  assert.equal(out.throughput.tokensPerSec, null);
});

test('loading and error shells are distinct and bounded', () => {
  assert.equal(emptyFlow({ reason: 'loading' }).state, 'loading');
  const err = emptyFlow({ reason: 'error', detail: 'x'.repeat(500) });
  assert.equal(err.state, 'error');
  assert.ok(err.detail.length <= 300);
  assert.equal(emptyFlow({ reason: 'bogus' }).state, 'error');
});

test('mapper emits data only: hostile names pass through raw for the esc() boundary', () => {
  const evil = '<img src=x onerror=alert(1)>&"\'';
  const out = buildFabricFlow({
    status: statusOf([
      { id: 'r_evil', name: evil, kind: 'local', liveness: 'online', lastSeenAt: iso(NOW - 10), lastSeenAgeMs: 10, usable: true, demoFixture: false },
    ]),
    usage: null,
    nowMs: NOW,
  });
  // Raw passthrough is intentional: the deferred DOM wiring must render
  // through the existing esc() helper. No markup is generated here.
  assert.equal(out.nodes[0].name, evil);
  assert.ok(!JSON.stringify(out).includes('<div'));
});

test('module has no DOM dependency (responsive/keyboard wiring stays deferred)', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof buildFabricFlow, 'function');
  assert.equal(typeof emptyFlow, 'function');
});
