/* Built with Meta Muse. Meta-qual lane: focused panel tests (no live calls). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAdvisory, renderDetected, renderMeasured, renderQualificationReport } from '../src/qualification/panel.mjs';

test('panel: three sections stay separate', () => {
  const html = renderQualificationReport({
    nodeId: 'res1',
    detected: { profile: { os: 'linux', arch: 'x86_64', runtimes: [{ name: 'ganglion' }], memTotalBytes: 8 * 1024 ** 3, gpuCount: 0 } },
    advisory: { advice: { summary: 'Looks fine.', suggestions: [], rationale: '', unknowns: [], benchmarkCatalogId: 'unsupported' } },
    measured: { state: 'unsupported', result: {} },
  });
  assert.ok(html.includes('Detected (worker-reported inventory'));
  assert.ok(html.includes('Advisory (Meta recommendation)'));
  assert.ok(html.includes('Measured (benchmark result)'));
  assert.ok(html.includes('ganglion'));
});

test('panel: stale measurements separate from current profile', () => {
  const html = renderQualificationReport({
    nodeId: 'res1', detected: null,
    advisory: { profile_digest: 'new', advice: { summary: 'S.', suggestions: [], rationale: '', unknowns: [], benchmarkCatalogId: 'unsupported' } },
    measured: { profile_digest: 'old', state: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 5 } },
  });
  assert.ok(html.includes('Stale measurement'));
  const fresh = renderQualificationReport({
    nodeId: 'res1', detected: null,
    advisory: { profile_digest: 'same', advice: { summary: 'S.', suggestions: [], rationale: '', unknowns: [], benchmarkCatalogId: 'unsupported' } },
    measured: { profile_digest: 'same', state: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 5 } },
  });
  assert.ok(!fresh.includes('Stale measurement'));
});

test('panel: honest empty and disabled states', () => {
  assert.ok(renderDetected(null).includes('must report inventory first'));
  assert.ok(renderAdvisory(null).includes('No recommendation yet'));
  assert.ok(renderMeasured(null).includes('No benchmark has run'));
  assert.ok(renderQualificationReport({ disabled: 'Qualification is disabled on this deployment.' }).includes('disabled'));
  assert.ok(renderMeasured({ state: 'uncertain' }).includes('never automatically rerun'));
});

test('panel: TPS only from coherent native pairs', () => {
  const good = renderMeasured({ state: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 1000, completionTokens: 32, nativeTimings: { promptN: 10, promptMs: 500, predictedN: 32, predictedMs: 1000 } } });
  assert.ok(good.includes('32.0 tokens/s generation'));
  assert.ok(good.includes('20.0 tokens/s prefill'));
  const bad = renderMeasured({ state: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 1000, completionTokens: 32 } });
  assert.ok(bad.includes('not shown'));
  assert.ok(!bad.includes('tokens/s generation'));
});

test('panel: provenance renders honestly, never as placement proof', () => {
  const unknown = renderMeasured({ state: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', servedModelId: 'm-up', placementProvenance: 'unknown', elapsedMs: 5 } });
  assert.ok(unknown.includes('served as m-up'));
  assert.ok(unknown.includes('Placement</dt><dd>unknown'));
  assert.ok(unknown.includes('certifies no placement and no GPU'));
  const declared = renderMeasured({ state: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', placementProvenance: 'operator-declared', elapsedMs: 5 } });
  assert.ok(declared.includes('operator-declared (config pin; not independently measured)'));
  const legacy = renderMeasured({ state: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 5 } });
  assert.ok(!legacy.includes('Placement</dt>'), 'no provenance invented when absent');
});

test('panel: escapes untrusted strings', () => {
  const html = renderQualificationReport({
    nodeId: '<img src=x>',
    detected: { profile: { os: '<b>', arch: 'x', runtimes: [], memTotalBytes: 0, gpuCount: 0 } },
    advisory: null, measured: null,
  });
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('<b>'));
});
