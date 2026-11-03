// GGUF variants: a Hub GGUF repo ships one file per quantization, so memory
// fit and quant are evaluated for ONE selected file. Regressions covered:
// - live /api/models/<repo> omits sibling sizes unless ?blobs=true, which
//   made every Hub model 0 bytes and let any model "fit" (fail-open);
// - with sizes, the whole-repo sum (all quants) inflated weights ~20x;
// - the quant label was the first regex match across all file names.
// Hub-shaped payloads mirror the live response shape (2026-11-03); sizes
// are synthetic. No network, no inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { fixtureSnapshot } from '../src/lib/catalog/fixtures.mjs';
import { evaluateCompatibility, selectVariant } from '../src/lib/catalog/estimate.mjs';
import { ggufQuant, ggufVariants, hubDetail, normalizeHubModel, __resetHubMetaCache } from '../src/lib/catalog/hub.mjs';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const REV = 'c'.repeat(40);
const QUANT_FILES = [
  ['IQ3_M', 627 * MiB], ['IQ4_XS', 709 * MiB], ['Q3_K_L', 698 * MiB], ['Q3_K_XL', 759 * MiB],
  ['Q4_0', 737 * MiB], ['Q4_0_4_4', 735 * MiB], ['Q4_K_L', 830 * MiB], ['Q4_K_M', 770 * MiB],
  ['Q4_K_S', 739 * MiB], ['Q5_K_M', 869 * MiB], ['Q6_K', 975 * MiB], ['Q8_0', 1260 * MiB], ['f16', 2364 * MiB],
];
function liveShaped({ sizes = true } = {}) {
  const siblings = [
    { rfilename: '.gitattributes', size: 2400 },
    { rfilename: 'README.md', size: 9000 },
    ...QUANT_FILES.map(([q, bytes]) => ({ rfilename: `Llama-3.2-1B-Instruct-${q}.gguf`, size: bytes })),
  ];
  return {
    id: 'bartowski/Llama-3.2-1B-Instruct-GGUF', sha: REV, tags: ['gguf', 'license:llama3.2'], likes: 1,
    pipeline_tag: 'text-generation',
    siblings: sizes ? siblings : siblings.map(({ rfilename }) => ({ rfilename })),
  };
}
// One node, fresh telemetry, fixture runtime reporting only Q4_K_M.
function node({ ramAvail = 6 * GiB, quants = ['Q4_K_M'] } = {}) {
  const s = fixtureSnapshot();
  s.runtimes = [{ ...s.runtimes[0], quants }];
  s.mem = { ramTotalBytes: 8 * GiB, ramAvailBytes: ramAvail };
  s.workload = {};
  return s;
}
function evaluate(asset, file, snapshot = node()) {
  return evaluateCompatibility({
    asset, settings: { context: 2048, concurrency: 1, runtime: 'fixture-llama', file },
    snapshot, snapshotAgeMs: 1000, snapshotAt: new Date().toISOString(), nodeId: 'r_node', principal: 'u', nowMs: Date.now(),
  });
}
const codes = (d) => [...d.blocking, ...d.unknown].map((r) => r.code);

test('quant comes from each file name, last token wins', () => {
  const cases = {
    'Llama-3.2-1B-Instruct-IQ3_M.gguf': 'IQ3_M', 'm-IQ4_XS.gguf': 'IQ4_XS', 'm-Q3_K_XL.gguf': 'Q3_K_XL',
    'm-Q4_K_M.gguf': 'Q4_K_M', 'm-q4_k_m.gguf': 'Q4_K_M', 'm-Q6_K.gguf': 'Q6_K', 'm-Q8_0.gguf': 'Q8_0',
    'm-Q4_0_4_4.gguf': 'Q4_0_4_4', 'm-f16.gguf': 'F16', 'm-BF16.gguf': 'BF16',
    'Q8_0-distill-Q4_K_M.gguf': 'Q4_K_M', 'big-Q5_K_M-00002-of-00003.gguf': 'Q5_K_M',
    'sub/dir/m-Q2_K.gguf': 'Q2_K', 'model.gguf': 'unknown',
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(ggufQuant(name), want, name);
});

test('variants: one per file, split shards summed, missing or partial sizes are unknown (0)', () => {
  const v = ggufVariants([
    { relpath: 'a-Q4_K_M.gguf', bytes: 100 },
    { relpath: 'big-Q8_0-00001-of-00002.gguf', bytes: 300 },
    { relpath: 'big-Q8_0-00002-of-00002.gguf', bytes: 200 },
    { relpath: 'part-Q6_K-00001-of-00003.gguf', bytes: 50 },
    { relpath: 'nosize-Q5_K_M.gguf', bytes: 0 },
    { relpath: 'README.md', bytes: 7 },
  ]);
  const by = Object.fromEntries(v.map((x) => [x.file, x]));
  assert.deepEqual(Object.keys(by).sort(), ['a-Q4_K_M.gguf', 'big-Q8_0.gguf', 'nosize-Q5_K_M.gguf', 'part-Q6_K.gguf']);
  assert.deepEqual(by['big-Q8_0.gguf'], { file: 'big-Q8_0.gguf', quant: 'Q8_0', bytes: 500, shards: 2 });
  assert.equal(by['part-Q6_K.gguf'].bytes, 0, 'incomplete shard set is unknown, not small');
  assert.equal(by['nosize-Q5_K_M.gguf'].bytes, 0);
});

test('normalize: a multi-quant repo lists every variant and claims no single quant', () => {
  const a = normalizeHubModel(liveShaped());
  assert.equal(a.format, 'gguf');
  assert.equal(a.variants.length, QUANT_FILES.length);
  assert.equal(a.quant, 'unknown', 'no arbitrary first-match label');
  const q4 = a.variants.find((v) => v.quant === 'Q4_K_M');
  assert.equal(q4.bytes, 770 * MiB);
  assert.equal(a.totalBytes, QUANT_FILES.reduce((n, [, b]) => n + b, 0) + 2400 + 9000, 'totalBytes keeps its whole-repo meaning');
});

test('hub detail asks the Hub for file sizes (blobs=true)', async () => {
  __resetHubMetaCache();
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { status: 200, ok: true, headers: new Headers(), json: async () => liveShaped() };
  };
  try {
    const a = await hubDetail('bartowski/Llama-3.2-1B-Instruct-GGUF', {});
    assert.equal(urls.length, 1);
    assert.equal(new URL(urls[0]).searchParams.get('blobs'), 'true');
    assert.equal(a.variants.find((v) => v.quant === 'Q8_0').bytes, 1260 * MiB);
  } finally {
    globalThis.fetch = realFetch;
    __resetHubMetaCache();
  }
});

test('fail-closed: a model without file sizes never fits (was: 0 bytes, any model fit)', () => {
  const sizeless = normalizeHubModel(liveShaped({ sizes: false }));
  const d = evaluate(sizeless, 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', node({ ramAvail: 7 * GiB }));
  assert.equal(d.state, 'unknown');
  assert.deepEqual(codes(d), ['WEIGHTS_SIZE_UNKNOWN']);
  // Legacy plain assets with no size fail closed the same way.
  const plain = evaluate({ id: 'hub:x/y', revision: REV, format: 'gguf', quant: 'Q4_K_M', totalBytes: 0 }, '');
  assert.ok(codes(plain).includes('WEIGHTS_SIZE_UNKNOWN'), JSON.stringify(codes(plain)));
});

test('several variants and no file is unknown, never a silent first pick', () => {
  const d = evaluate(normalizeHubModel(liveShaped()), '');
  assert.equal(d.state, 'unknown');
  assert.deepEqual(codes(d), ['VARIANT_UNSELECTED']);
  assert.equal(d.variant, null);
});

test('the selected file drives weights (not the whole-repo sum) and fits a small node', () => {
  const asset = normalizeHubModel(liveShaped());
  const d = evaluate(asset, 'Llama-3.2-1B-Instruct-Q4_K_M.gguf');
  assert.equal(d.state, 'estimated-compatible', JSON.stringify(codes(d)));
  assert.equal(d.estimate.weightsBytes, 770 * MiB);
  assert.deepEqual(d.variant, { file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', quant: 'Q4_K_M', bytes: 770 * MiB });
  assert.equal(d.fingerprint.file, 'Llama-3.2-1B-Instruct-Q4_K_M.gguf');
  // The same node with the whole-repo sum as weights would have blocked.
  const summed = evaluate({ ...asset, variants: [], quant: 'Q4_K_M' }, '');
  assert.equal(summed.state, 'blocked');
  assert.ok(codes(summed).includes('INSUFFICIENT_RAM'));
});

test('quant checks use the selected file, not a repo-wide label', () => {
  const asset = normalizeHubModel(liveShaped());
  const d = evaluate(asset, 'Llama-3.2-1B-Instruct-Q8_0.gguf'); // node reports Q4_K_M only
  assert.equal(d.state, 'blocked');
  assert.ok(codes(d).includes('QUANT_NOT_REPORTED'), JSON.stringify(codes(d)));
});

test('a file that is not a variant of the model blocks', () => {
  const d = evaluate(normalizeHubModel(liveShaped()), 'other-model-Q4_K_M.gguf');
  assert.equal(d.state, 'blocked');
  assert.ok(codes(d).includes('VARIANT_NOT_FOUND'));
  assert.deepEqual(selectVariant({ variants: [] }, 'x.gguf').block.code, 'VARIANT_NOT_FOUND');
});

test('different files get different fingerprints (no cross-variant cache reuse)', () => {
  const asset = normalizeHubModel(liveShaped());
  const a = evaluate(asset, 'Llama-3.2-1B-Instruct-Q4_K_M.gguf');
  const b = evaluate(asset, 'Llama-3.2-1B-Instruct-Q4_K_S.gguf', node({ quants: ['Q4_K_S'] }));
  assert.notEqual(JSON.stringify(a.fingerprint), JSON.stringify(b.fingerprint));
});

test('API: compat accepts an optional file, echoes the variant, and bounds bad input', async () => {
  const t = await createTestEnv({ CATALOG_FIXTURES: '1' });
  const reg = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'box', kind: 'local' },
  }));
  const snap = fixtureSnapshot();
  await t.DB.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .bind(reg.json.id, new Date().toISOString(), snap.os, snap.arch, JSON.stringify(snap.runtimes), JSON.stringify(snap.mem), JSON.stringify(snap.disk), JSON.stringify(snap.workload)).run();
  const call = async (body) => readJson(await t.call('/api/catalog/compat', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { repo: 'fixture-org/tiny-instruct-gguf', nodeId: reg.json.id, runtime: 'fixture-llama', context: 4096, concurrency: 1, ...body } }));
  const plain = await call({});
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.json.variant.file, 'tiny-instruct-Q4_K_M.gguf', 'a single-variant repo selects itself');
  const picked = await call({ file: 'tiny-instruct-Q4_K_M.gguf' });
  assert.equal(picked.status, 200, picked.text);
  assert.equal(picked.json.state, plain.json.state);
  const missing = await call({ file: 'not-in-this-repo-Q8_0.gguf' });
  assert.equal(missing.status, 200, missing.text);
  assert.equal(missing.json.state, 'blocked');
  for (const bad of ['weights.safetensors', 'x'.repeat(300) + '.gguf', 42, 'a\nb.gguf']) {
    const res = await call({ file: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} -> ${res.text}`);
    assert.equal(res.json.code, 'BAD_FILE');
  }
});

test('API: plan signs the selected file and deploy re-evaluates the same file', async () => {
  const t = await createTestEnv({ CATALOG_FIXTURES: '1' });
  const sess = { ...t.as(t.alice), ...t.csrf };
  const reg = await readJson(await t.call('/api/inventory', { method: 'POST', headers: sess, body: { name: 'box', kind: 'local' } }));
  const snap = fixtureSnapshot();
  await t.DB.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .bind(reg.json.id, new Date().toISOString(), snap.os, snap.arch, JSON.stringify(snap.runtimes), JSON.stringify(snap.mem), JSON.stringify(snap.disk), JSON.stringify(snap.workload)).run();
  const plan = async (extra) => readJson(await t.call('/api/catalog/plans', { method: 'POST', headers: sess,
    body: { assetRef: 'fixture-org/tiny-instruct-gguf', nodeId: reg.json.id, runtime: 'fixture-llama', context: 2048, concurrency: 1,
      fixtureScript: [{ status: 'staging' }, { status: 'ready' }], ...extra } }));
  const withFile = await plan({ file: 'tiny-instruct-Q4_K_M.gguf' });
  assert.equal(withFile.status, 201, withFile.text);
  const without = await plan({});
  assert.equal(without.status, 201, without.text);
  assert.notEqual(withFile.json.plan.planFingerprint, without.json.plan.planFingerprint, 'the file is part of the signed plan');
  const wrong = await plan({ file: 'not-in-this-repo-Q8_0.gguf' });
  assert.equal(wrong.status, 422, wrong.text);
  assert.ok(wrong.json.decision.blocking.some((r) => r.code === 'VARIANT_NOT_FOUND'));
  const run = await readJson(await t.call('/api/catalog/deployments', { method: 'POST', headers: sess,
    body: { idempotencyKey: 'gguf-variant-plan-1', planToken: withFile.json.planToken } }));
  assert.equal(run.status, 202, run.text);
  const bad = await plan({ file: 'weights.bin' });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json.code, 'BAD_FILE');
});

// --- regressions for the unresolved PR83 review findings ---

test('regression: the fp16 spelling is recognized, not unknown', () => {
  // `model-fp16.gguf` used to parse as unknown while `-f16` parsed as F16.
  assert.equal(ggufQuant('model-fp16.gguf'), 'FP16');
  assert.equal(ggufQuant('model-FP16.gguf'), 'FP16');
  assert.equal(ggufQuant('m-f16.gguf'), 'F16', 'the F16 spelling still works');
  assert.equal(ggufQuant('m-BF16.gguf'), 'BF16');
  assert.equal(ggufQuant('model.gguf'), 'unknown');
});

test('regression: an FP16 file is blocked by a node that only reports Q4_K_M', () => {
  // An unknown quant skips the node's quantization restriction entirely, so
  // the parser gap above silently bypassed QUANT_NOT_REPORTED.
  const asset = {
    id: 'fixture-org/fp16-only', revision: REV, format: 'gguf', quant: 'unknown',
    totalBytes: 2364 * MiB,
    variants: ggufVariants([{ relpath: 'model-fp16.gguf', bytes: 2364 * MiB }]),
  };
  assert.equal(asset.variants[0].quant, 'FP16');
  const d = evaluate(asset);
  assert.ok(codes(d).includes('QUANT_NOT_REPORTED'), JSON.stringify(codes(d)));
  assert.equal(d.state, 'blocked');
});

test('regression: a standalone file and a split set with one base name stay distinct', () => {
  // Merged under one group key, three members against an expected two made
  // bytes 0, so even the explicitly selected, fully sized standalone file
  // reported WEIGHTS_SIZE_UNKNOWN.
  const v = ggufVariants([
    { relpath: 'm-Q4_K_M.gguf', bytes: 700 },
    { relpath: 'm-Q4_K_M-00001-of-00002.gguf', bytes: 300 },
    { relpath: 'm-Q4_K_M-00002-of-00002.gguf', bytes: 200 },
  ]);
  assert.equal(v.length, 2, 'one variant per artifact, not one merged group');
  const single = v.find((x) => x.shards === 1);
  const split = v.find((x) => x.shards === 2);
  assert.equal(single.file, 'm-Q4_K_M.gguf');
  assert.equal(single.bytes, 700, 'the standalone file keeps its real size');
  assert.equal(split.file, 'm-Q4_K_M-00001-of-00002.gguf', 'the split set is named by its real first shard');
  assert.equal(split.bytes, 500);
  assert.equal(split.quant, 'Q4_K_M');

  const asset = { id: 'org/mixed', revision: REV, format: 'gguf', quant: 'unknown', totalBytes: 1200, variants: v };
  const d = evaluate(asset, 'm-Q4_K_M.gguf');
  assert.ok(!codes(d).includes('WEIGHTS_SIZE_UNKNOWN'), JSON.stringify(codes(d)));
});

test('regression: an unresolved selector is part of the fingerprint', () => {
  // Without the requested selector in the key, a no-file request and a bad
  // selector fingerprint identically while their decisions differ.
  const asset = { id: 'org/multi', revision: REV, format: 'gguf', quant: 'unknown', totalBytes: 1000, variants: [
    { file: 'a-Q4_K_M.gguf', quant: 'Q4_K_M', bytes: 400 },
    { file: 'a-Q8_0.gguf', quant: 'Q8_0', bytes: 600 },
  ] };
  const unselected = evaluate(asset);
  const missing = evaluate(asset, 'missing.gguf');
  assert.equal(unselected.fingerprint.file, null);
  assert.equal(missing.fingerprint.file, 'missing.gguf');
  assert.notEqual(JSON.stringify(unselected.fingerprint), JSON.stringify(missing.fingerprint));
  assert.ok(codes(missing).includes('VARIANT_NOT_FOUND'));
  assert.ok(!codes(unselected).includes('VARIANT_NOT_FOUND'));
});

// --- regressions for the nested-shard selector collision (delta review) ---
// A nested `-00001-of-NNNNN` set's base name can equal another set's renamed
// first shard, which used to emit the same `file` twice: exact-match
// selection silently took the first and the outer set was unreachable.

function nestedMembers() {
  return [
    { relpath: 'm-Q4_K_M.gguf', bytes: 700 },
    { relpath: 'm-Q4_K_M-00001-of-00002.gguf', bytes: 300 },
    { relpath: 'm-Q4_K_M-00002-of-00002.gguf', bytes: 200 },
    { relpath: 'm-Q4_K_M-00001-of-00002-00001-of-00002.gguf', bytes: 150 },
    { relpath: 'm-Q4_K_M-00001-of-00002-00002-of-00002.gguf', bytes: 150 },
  ];
}

test('regression: a nested split set keeps a unique exactly-selectable file', () => {
  const v = ggufVariants(nestedMembers());
  assert.equal(v.length, 3, 'one variant per artifact, no merged or duplicated group');
  const files = v.map((x) => x.file);
  assert.equal(new Set(files).size, 3, 'every variant is exactly selectable');
  const by = Object.fromEntries(v.map((x) => [x.file, x]));
  assert.equal(by['m-Q4_K_M.gguf'].bytes, 700);
  assert.equal(by['m-Q4_K_M-00001-of-00002.gguf'].bytes, 500, 'the entry naming a real shard keeps it');
  assert.equal(by['m-Q4_K_M-00001-of-00002-00001-of-00002.gguf'].bytes, 300, 'the nested set moves to its own real shard');
  assert.ok(v.every((x) => x.quant === 'Q4_K_M'), 'quant still reads from the base name');
  const asset = { id: 'org/nested', revision: REV, format: 'gguf', quant: 'unknown', totalBytes: 1500, variants: v };
  for (const f of files) {
    const got = selectVariant(asset, f);
    assert.equal(got.variant && got.variant.file, f, `selector ${f} resolves to its own artifact`);
  }
  const d = evaluate(asset, 'm-Q4_K_M-00001-of-00002-00001-of-00002.gguf');
  assert.ok(!codes(d).includes('WEIGHTS_SIZE_UNKNOWN'), JSON.stringify(codes(d)));
  assert.equal(d.variant.file, 'm-Q4_K_M-00001-of-00002-00001-of-00002.gguf');
});

test('regression: nested grouping is independent of manifest order', () => {
  const members = nestedMembers();
  const orders = [members, [...members].reverse(), [members[2], members[0], members[4], members[1], members[3]]];
  const key = (v) => JSON.stringify(v.map((x) => [x.file, x.bytes, x.shards, x.quant]).sort());
  const first = key(ggufVariants(orders[0]));
  for (const o of orders.slice(1)) assert.equal(key(ggufVariants(o)), first, 'same artifacts whatever order the Hub lists them');
});

test('regression: an incomplete nested set fails closed without breaking siblings', () => {
  const v = ggufVariants([
    { relpath: 'm-Q4_K_M.gguf', bytes: 700 },
    { relpath: 'm-Q4_K_M-00001-of-00002.gguf', bytes: 300 },
    { relpath: 'm-Q4_K_M-00002-of-00002.gguf', bytes: 200 },
    { relpath: 'm-Q4_K_M-00001-of-00002-00002-of-00002.gguf', bytes: 150 },
  ]);
  const by = Object.fromEntries(v.map((x) => [x.file, x]));
  assert.equal(Object.keys(by).length, 3, 'names stay unique even when a set is partial');
  assert.equal(by['m-Q4_K_M-00001-of-00002-00002-of-00002.gguf'].bytes, 0, 'one member against an expected two is unknown, not small');
  assert.equal(by['m-Q4_K_M-00001-of-00002.gguf'].bytes, 500, 'the complete sibling keeps its real size');
});

test('regression: a no-spare nested collision emits no duplicate selector', () => {
  // Depth-3 nesting where the loser's only shard is another partial group's
  // synthetic selector: no unclaimed spare exists. Emitting the shared name
  // twice would make exact-match selection order-dependent, so the
  // unresolvable entry is dropped and every emitted selector stays unique.
  const members = [
    { relpath: 'm-Q4_K_M.gguf', bytes: 700 },
    { relpath: 'm-Q4_K_M-00001-of-00002.gguf', bytes: 300 },
    { relpath: 'm-Q4_K_M-00001-of-00002-00001-of-00002.gguf', bytes: 150 },
    { relpath: 'm-Q4_K_M-00001-of-00002-00001-of-00002-00001-of-00002.gguf', bytes: 150 },
  ];
  const orders = [members, [...members].reverse(), [members[3], members[0], members[2], members[1]]];
  const key = (v) => JSON.stringify(v.map((x) => [x.file, x.bytes, x.shards, x.quant]).sort());
  const first = ggufVariants(orders[0]);
  assert.equal(new Set(first.map((x) => x.file)).size, first.length, 'no duplicate selectors');
  for (const o of orders.slice(1)) assert.equal(key(ggufVariants(o)), key(first), 'same resolved set whatever order the Hub lists them');
  assert.equal(first.length, 3, 'four groups, one unresolvable entry dropped');
  const asset = { id: 'org/nospare-nest', revision: REV, format: 'gguf', quant: 'unknown', totalBytes: 1300, variants: first };
  const got = selectVariant(asset, 'm-Q4_K_M-00001-of-00002.gguf');
  assert.equal(got.variant && got.variant.bytes, 0, 'the contested name resolves to the fail-closed entry, deterministically');
  const d = evaluate(asset, 'm-Q4_K_M-00001-of-00002.gguf');
  assert.ok(codes(d).includes('WEIGHTS_SIZE_UNKNOWN'), JSON.stringify(codes(d)));
});

test('regression: exact-duplicate manifest entries fail closed, not double-counted', () => {
  const v = ggufVariants([
    { relpath: 'big-Q8_0-00001-of-00002.gguf', bytes: 300 },
    { relpath: 'big-Q8_0-00002-of-00002.gguf', bytes: 200 },
    { relpath: 'big-Q8_0-00001-of-00002.gguf', bytes: 300 },
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].bytes, 0, 'three members against an expected two is unknown, not a bigger model');
  assert.equal(v[0].shards, 3);
});
