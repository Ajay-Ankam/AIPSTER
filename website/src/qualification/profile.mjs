/* Built with Meta Muse. Meta-qualification lane (meta-qual). */
/* Stable hardware/runtime profile: allowlisted facts only. Pure functions. */
/* Timestamps, load, free/available-memory fluctuations never enter the digest. */
import { QUAL_CATALOG_VERSION, QUAL_MODEL, QUAL_PROMPT_VERSION } from './constants.mjs';

const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SHORT_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MODEL_RE = /^[A-Za-z0-9._:-]{1,256}$/;

function cleanToken(v) {
  if (typeof v !== 'string') return 'unknown';
  const t = v.trim();
  if (!t) return 'unknown';
  return TOKEN_RE.test(t) ? t : 'unknown';
}

function cleanShort(v) {
  if (typeof v !== 'string') return 'unknown';
  const t = v.trim();
  if (!t) return 'unknown';
  return SHORT_RE.test(t) ? t : 'unknown';
}

const bytesOk = (v) => Number.isSafeInteger(v) && v >= 0;

function parseJsonField(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return fallback;
  try {
    const v = JSON.parse(raw);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Normalize a node_capabilities row (or capability body shape) to stable
 * facts. Missing facts become 'unknown'/0 — never fabricated. Volatile
 * fields (reported_at, avail bytes, workload, load) are dropped.
 */
export function normalizeProfile(row) {
  const r = row && typeof row === 'object' ? row : {};
  const os = cleanToken(r.os);
  const arch = cleanToken(r.arch);
  const runtimesRaw = parseJsonField(r.runtimes_json ?? r.runtimes, []);
  const runtimes = [];
  if (Array.isArray(runtimesRaw)) {
    const seen = new Set();
    for (const e of runtimesRaw) {
      if (runtimes.length >= 16) break;
      if (!e || typeof e !== 'object') continue;
      const name = cleanToken(e.name ?? e.runtime_id);
      const mode = e.mode === 'attach' || e.mode === 'managed' ? e.mode : null;
      if (name === 'unknown' || seen.has(name + '\x00' + mode)) continue;
      seen.add(name + '\x00' + mode);
      const out = { name };
      if (mode) out.mode = mode;
      if (e.version !== undefined) out.version = cleanShort(e.version);
      for (const f of ['formats', 'quants', 'adapters']) {
        if (e[f] === undefined) continue;
        if (!Array.isArray(e[f])) continue;
        const list = [...new Set(e[f].filter((v) => typeof v === 'string' && SHORT_RE.test(v.trim())))].slice(0, 32).sort();
        if (list.length) out[f] = list;
      }
      runtimes.push(out);
    }
  }
  runtimes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Stable CONFIGURED model identity per runtime, bounded and sanitized:
  // the digest binds it immutably, so an operator config change invalidates
  // pending assignments. Readiness (`models`, volatile unload/reload state)
  // is deliberately excluded here and checked separately at lease and
  // result time. Entries without a configured list contribute nothing.
  // Mixed (name, mode) entries merge under one name: per-mode configured
  // sets all invalidate the digest, and no transport's set is silently
  // dropped. (Ready-model lookup stays per-mode in snapshotReadyModels.)
  const models = {};
  if (Array.isArray(runtimesRaw)) {
    for (const e of runtimesRaw) {
      if (!e || typeof e !== 'object' || !Array.isArray(e.configured) || !e.configured.length) continue;
      const name = cleanToken(e.name ?? e.runtime_id);
      if (name === 'unknown') continue;
      const ids = models[name] || [];
      for (const m of e.configured) {
        if (ids.length >= 32) break;
        if (typeof m === 'string' && MODEL_RE.test(m.trim())) ids.push(m.trim());
      }
      if (ids.length) models[name] = [...new Set(ids)].sort();
    }
  }
  const mem = parseJsonField(r.mem_json ?? r.mem, {});
  const disk = parseJsonField(r.disk_json ?? r.disk, {});
  const memTotalBytes = bytesOk(mem.ramTotalBytes) ? mem.ramTotalBytes : 0;
  const diskTotalBytes = bytesOk(disk.totalBytes) ? disk.totalBytes : 0;
  let gpuCount = 0;
  let gpuVramTotalBytes = 0;
  if (Array.isArray(mem.gpu)) {
    gpuCount = Math.min(mem.gpu.length, 16);
    for (const g of mem.gpu.slice(0, 16)) {
      if (g && typeof g === 'object' && bytesOk(g.vramTotalBytes)) gpuVramTotalBytes += g.vramTotalBytes;
    }
  }
  return { os, arch, runtimes, models, memTotalBytes, diskTotalBytes, gpuCount, gpuVramTotalBytes };
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

/**
 * Canonical digest input: stable profile + node + catalog/prompt versions +
 * provider mode + model. The node binding stops a same-hardware key from
 * cross-replaying on another node; the mode binding stops a fixture row
 * from ever satisfying a live lookup and vice versa.
 */
export function digestInput(profile, { nodeId = null, catalogVersion = QUAL_CATALOG_VERSION, promptVersion = QUAL_PROMPT_VERSION, mode = 'fixture', model = QUAL_MODEL } = {}) {
  if (typeof nodeId !== 'string' || !nodeId) throw new Error('digestInput requires the node id.');
  if (mode !== 'live' && mode !== 'fixture') throw new Error('digestInput requires live or fixture mode.');
  return canonicalJson({ profile, nodeId, catalogVersion, promptVersion, mode, model });
}

/** SHA-256 hex over the canonical input (SubtleCrypto; works in Workers + Node 24). */
export async function canonicalProfileDigest(profile, versions) {
  const bytes = new TextEncoder().encode(digestInput(profile, versions));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Worker transports and their snapshot bindings. `ganglion` is the attach
 * transport (any reporter kind-name in attach mode); `llama-server` is the
 * managed transport for the llama_cpp kind. Modes never merge: an attach
 * entry never satisfies a managed claim and vice versa. Entries without a
 * mode keep the legacy name mapping.
 */
export function transportForEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.mode === 'attach') return 'ganglion';
  if (entry.mode === 'managed') return entry.name === 'llama-server' ? 'llama-server' : null;
  if (entry.name === 'ganglion' || entry.name === 'llama-server') return entry.name;
  return null;
}

/** Eligible catalog ids for this profile (first slice: CPU smoke only). */
export function eligibleCatalog(profile) {
  const runtimes = Array.isArray(profile?.runtimes) ? profile.runtimes : [];
  const supported = runtimes.some((r) => transportForEntry(r) !== null);
  if (supported && (profile?.memTotalBytes || 0) > 0) return ['completion-smoke-v1'];
  return [];
}
