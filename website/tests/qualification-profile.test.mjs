/* Built with Meta Muse. Meta-qual lane: focused profile tests (no live calls). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProfileDigest, digestInput, eligibleCatalog, normalizeProfile } from '../src/qualification/profile.mjs';

function caps(over = {}) {
  return {
    os: 'linux', arch: 'x86_64',
    runtimes_json: JSON.stringify([{ name: 'ganglion', version: '1.2', formats: ['gguf'] }]),
    mem_json: JSON.stringify({ ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 3 * 1024 ** 3 }),
    disk_json: JSON.stringify({ totalBytes: 100 * 1024 ** 3, availBytes: 40 * 1024 ** 3 }),
    workload_json: JSON.stringify({ load: 9.5 }),
    reported_at: '2026-11-05T00:00:00.000Z',
    ...over,
  };
}

test('profile: strips arbitrary strings to unknown', () => {
  const p = normalizeProfile(caps({ os: 'host-01.internal/path', arch: '' }));
  assert.equal(p.os, 'unknown');
  assert.equal(p.arch, 'unknown');
});

test('profile: omits volatile facts, keeps stable totals', () => {
  const p = normalizeProfile(caps());
  assert.equal(p.memTotalBytes, 8 * 1024 ** 3);
  assert.ok(!('ramAvailBytes' in p));
  assert.ok(!('reported_at' in p));
  assert.ok(!('load' in p));
  assert.equal(p.runtimes.length, 1);
});

test('profile: missing facts become unknown, never fabricated', () => {
  const p = normalizeProfile({});
  assert.equal(p.os, 'unknown');
  assert.equal(p.memTotalBytes, 0);
  assert.deepEqual(p.runtimes, []);
  assert.deepEqual(eligibleCatalog(p), []);
});

test('profile: digest stable across volatile changes', async () => {
  const a = normalizeProfile(caps());
  const b = normalizeProfile(caps({
    mem_json: JSON.stringify({ ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 7 * 1024 ** 3 }),
    reported_at: '2026-11-06T00:00:00.000Z',
    workload_json: JSON.stringify({ load: 0.1 }),
  }));
  const id = { nodeId: 'res1', mode: 'fixture' };
  assert.equal(await canonicalProfileDigest(a, id), await canonicalProfileDigest(b, id));
  const c = normalizeProfile(caps({ mem_json: JSON.stringify({ ramTotalBytes: 16 * 1024 ** 3, ramAvailBytes: 1 }) }));
  assert.notEqual(await canonicalProfileDigest(a, id), await canonicalProfileDigest(c, id));
});

test('profile: digest binds node and mode; fixture never equals live', async () => {
  const p = normalizeProfile(caps());
  const f = await canonicalProfileDigest(p, { nodeId: 'res1', mode: 'fixture' });
  assert.notEqual(f, await canonicalProfileDigest(p, { nodeId: 'res2', mode: 'fixture' }));
  assert.notEqual(f, await canonicalProfileDigest(p, { nodeId: 'res1', mode: 'live' }));
  await assert.rejects(canonicalProfileDigest(p, {}), /node id/);
  await assert.rejects(canonicalProfileDigest(p, { nodeId: 'res1', mode: 'demo' }), /live or fixture/);
});

test('profile: digest input carries only profile + versions', () => {
  const p = normalizeProfile(caps());
  const text = digestInput(p, { nodeId: 'res1', mode: 'fixture' });
  for (const leak of ['reported_at', 'ramAvailBytes', 'load', 'host-01']) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(text.includes('qual-catalog-v1'));
  assert.ok(text.includes('qual-prompt-v1'));
  assert.ok(text.includes('res1'));
});

test('profile: eligible catalog is CPU smoke only', () => {
  assert.deepEqual(eligibleCatalog(normalizeProfile(caps())), ['completion-smoke-v1']);
  assert.deepEqual(eligibleCatalog(normalizeProfile(caps({ mem_json: '{}' }))), []);
});

test('profile: configured identity binds the digest, readiness stays out', async () => {
  // P2-1 split: the stable CONFIGURED set binds identity; volatile ready
  // `models` are checked at lease/result time, never digested here.
  const withEntry = (entry) => normalizeProfile(caps({ runtimes_json: JSON.stringify([entry]) }));
  const a = withEntry({ name: 'llama-server', mode: 'managed', configured: ['m'] });
  assert.deepEqual(a.models, { 'llama-server': ['m'] });
  const id = { nodeId: 'res1', mode: 'fixture' };
  assert.notEqual(await canonicalProfileDigest(a, id),
    await canonicalProfileDigest(withEntry({ name: 'llama-server', mode: 'managed', configured: ['m', 'm2'] }), id));
  assert.notEqual(await canonicalProfileDigest(a, id),
    await canonicalProfileDigest(withEntry({ name: 'llama-server', mode: 'managed' }), id));
  // Ready-only evidence never enters configured identity or the digest.
  const readyOnly = withEntry({ name: 'llama-server', mode: 'managed', models: ['m'] });
  assert.deepEqual(readyOnly.models, {});
  assert.equal(await canonicalProfileDigest(readyOnly, id),
    await canonicalProfileDigest(withEntry({ name: 'llama-server', mode: 'managed', models: ['other'] }), id));
  // Hostile strings never enter identity.
  assert.deepEqual(withEntry({ name: 'llama-server', mode: 'managed', configured: ['<img>', 'm'] }).models, { 'llama-server': ['m'] });
  assert.deepEqual(withEntry({ name: 'llama-server', mode: 'managed', configured: 'not-a-list' }).models, {});
});

test('profile: mixed (name, mode) entries merge configured sets, nothing dropped', async () => {
  const mixed = normalizeProfile(caps({ runtimes_json: JSON.stringify([
    { name: 'llama-server', mode: 'attach', configured: ['a'] },
    { name: 'llama-server', mode: 'managed', configured: ['m'] },
  ]) }));
  assert.deepEqual(mixed.models, { 'llama-server': ['a', 'm'] });
  assert.equal(mixed.runtimes.length, 2, 'both transports stay in the profile');
  const id = { nodeId: 'res1', mode: 'fixture' };
  const base = await canonicalProfileDigest(mixed, id);
  for (const variant of [
    [{ name: 'llama-server', mode: 'attach', configured: ['a', 'a2'] },
     { name: 'llama-server', mode: 'managed', configured: ['m'] }],
    [{ name: 'llama-server', mode: 'attach', configured: ['a'] },
     { name: 'llama-server', mode: 'managed', configured: ['m', 'm2'] }],
  ]) {
    const other = normalizeProfile(caps({ runtimes_json: JSON.stringify(variant) }));
    assert.notEqual(await canonicalProfileDigest(other, id), base, 'either transport change invalidates');
  }
});
