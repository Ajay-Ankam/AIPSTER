/* Built with Meta Muse. */
// Hub metadata adapter: read-only model discovery/detail against the public
// Hugging Face Hub API, plus a deterministic fixture mode for tests, demo
// browsing, and offline development. This adapter NEVER downloads weights:
// it calls the JSON metadata API only, and every outbound call is counted
// so AC01 can assert zero weight transfers. Browsing must not change a
// worker, run inference, or exfiltrate tokens (T2/T3).
import { FIXTURE_MODELS } from './fixtures.mjs';

// SSRF policy (T2): exact-host allowlist, https only, no ports/userinfo/IP
// literals, manual redirect following capped to the same allowlist.
export const HUB_API_HOST = 'huggingface.co';
export const HUB_HOSTS = new Set([HUB_API_HOST, 'cdn-lfs.huggingface.co', 'cdn-lfs.hf.co']);
const MAX_REDIRECTS = 3;
const HUB_TIMEOUT_MS = 8000;
const HUB_PAGE_LIMIT = 50;

export function assertHubUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw hubError(400, 'BAD_HUB_URL', `Unparseable Hub URL: ${String(raw).slice(0, 120)}`);
  }
  if (url.protocol !== 'https:') throw hubError(400, 'BAD_HUB_URL', 'Hub URLs must be https.');
  if (url.port || url.username || url.password) throw hubError(400, 'BAD_HUB_URL', 'Hub URLs carry no port or credentials.');
  if (!HUB_HOSTS.has(url.hostname)) throw hubError(400, 'BAD_HUB_URL', `Hub host not allowlisted: ${url.hostname}.`);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':')) {
    throw hubError(400, 'BAD_HUB_URL', 'IP-literal Hub hosts are refused.');
  }
  return url;
}

export function hubError(status, code, error, extra = {}) {
  return Object.assign(new Error(error), { status, code, hub: true, ...extra });
}

function isRepoId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,96}\/[A-Za-z0-9_.-]{1,96}$/.test(value);
}

// Normalize one Hub API model object to the catalog AssetVersion shape.
// Display labels (id, tags, card) are untrusted content; digests stay null
// until a full pinned resolve — the siblings list proves nothing about bytes.
export function normalizeHubModel(raw) {
  if (!raw || typeof raw !== 'object' || !isRepoId(raw.id)) {
    throw hubError(502, 'HUB_BAD_SHAPE', 'Hub returned an unparseable model object.');
  }
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 100) : [];
  const license = tags.filter((t) => t.startsWith('license:')).map((t) => t.slice('license:'.length));
  const siblings = Array.isArray(raw.siblings) ? raw.siblings.slice(0, 500).map((s) => ({
    relpath: String((s && s.rfilename) || '').slice(0, 256),
    bytes: Number.isSafeInteger(s && s.size) && s.size >= 0 ? s.size : 0,
    sha256: null,
  })) : [];
  const totalBytes = siblings.reduce((n, f) => n + f.bytes, 0);
  const format = inferFormat(siblings);
  // A GGUF repo usually ships one file per quantization; each is a separate
  // deployable artifact, so sizes and quant are tracked per variant rather
  // than summed across the repo (totalBytes keeps its whole-repo meaning).
  const variants = format === 'gguf' ? ggufVariants(siblings) : [];
  return {
    id: `hub:${raw.id}`,
    source: 'hub',
    repo: raw.id,
    revision: typeof raw.sha === 'string' && /^[a-f0-9]{40}$/.test(raw.sha) ? raw.sha : '',
    kind: tags.includes('peft') || tags.includes('lora') ? 'adapter' : 'model',
    task: typeof raw.pipeline_tag === 'string' ? raw.pipeline_tag.slice(0, 64) : 'unknown',
    arch: 'unknown',
    format,
    // One variant: its quant. Several: no single honest label (the old
    // first-regex-match picked an arbitrary file); filters match variants.
    quant: variants.length === 1 ? variants[0].quant : variants.length > 1 ? 'unknown' : inferQuant(raw.id, siblings),
    variants,
    license: { tags: license, evidence: 'hub-tag', note: 'A license tag is evidence to review, not a legal conclusion.' },
    gated: raw.gated === true || raw.gated === 'manual' || raw.gated === 'auto' ? (raw.gated === true ? 'manual' : raw.gated) : false,
    card: typeof raw.cardData === 'string' ? raw.cardData.slice(0, 20000) : (typeof raw.card === 'string' ? raw.card.slice(0, 20000) : ''),
    files: siblings,
    totalBytes,
    freshnessAt: new Date().toISOString(),
    likes: Number.isSafeInteger(raw.likes) ? raw.likes : 0,
    fixture: false,
  };
}

function inferFormat(siblings) {
  const names = siblings.map((f) => f.relpath.toLowerCase());
  if (names.some((n) => n.endsWith('.gguf'))) return 'gguf';
  if (names.some((n) => n.endsWith('.safetensors'))) return 'safetensors';
  if (names.some((n) => n.endsWith('.bin'))) return 'pytorch-bin';
  if (names.some((n) => n.endsWith('.onnx'))) return 'onnx';
  return 'unknown';
}

// GGUF quant from a file name: the LAST quant token before `.gguf`, so model
// names that happen to contain a token never win. Unknown stays unknown.
// FP16 is spelled both ways on the Hub: `-f16` and `-fp16`. Only F16 used to
// be listed, so `model-fp16.gguf` parsed as unknown, and an unknown quant
// skips the node's quantization restriction entirely.
const GGUF_QUANT_TOKEN = /(IQ\d_(?:XXS|XS|NL|S|M|L)|Q\d_K_(?:XL|S|M|L)|Q\d_K|Q\d_\d(?:_\d_\d)?|BF16|FP16|F16|F32)(?![A-Z0-9])/gi;
export function ggufQuant(relpath) {
  const name = String(relpath).split('/').pop().replace(/(-\d{5}-of-\d{5})?\.gguf$/i, '');
  const all = name.match(GGUF_QUANT_TOKEN);
  return all ? all[all.length - 1].toUpperCase() : 'unknown';
}

// Split GGUF shards (`name-00001-of-00003.gguf`) form one variant. A variant
// whose files lack sizes, or whose shard set is incomplete, reports
// bytes 0 = unknown: the estimator must never treat a missing size as small.
const GGUF_SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
export const MAX_GGUF_VARIANTS = 64;
export function ggufVariants(files) {
  const groups = new Map();
  for (const f of files) {
    if (!/\.gguf$/i.test(f.relpath)) continue;
    const shard = GGUF_SHARD.exec(f.relpath);
    const name = shard ? f.relpath.replace(GGUF_SHARD, '.gguf') : f.relpath;
    // A standalone file and a split set can share a base name. Key them apart
    // so the split group never absorbs the standalone artifact: merged, the
    // group holds three members against an expected count of one or two, so
    // its size collapses to unknown and even an explicitly selected, fully
    // sized standalone file stops planning.
    const key = `${shard ? 'split' : 'single'}:${name}`;
    const g = groups.get(key) || { name, split: Boolean(shard), relpaths: [], bytes: 0, sized: true, expected: shard ? Number(shard[2]) : 1 };
    g.relpaths.push(f.relpath);
    g.bytes += f.bytes;
    if (!(f.bytes > 0)) g.sized = false;
    groups.set(key, g);
  }
  const list = [...groups.values()];
  const standalone = new Set(list.filter((g) => !g.split).map((g) => g.name));
  const preferred = list.slice(0, MAX_GGUF_VARIANTS).map((g) => {
    // Keep the synthesized base name as the selector unless a standalone file
    // already owns that name; then select the split set by its real first
    // shard, so the two remain distinct and both name a file that exists.
    const file = g.split && standalone.has(g.name)
      ? (g.relpaths.find((p) => /-00001-of-\d{5}\.gguf$/i.test(p)) || g.relpaths[0])
      : g.name;
    return { g, file };
  });
  // Two different sets can still prefer the same `file`: a nested
  // `-00001-of-NNNNN` set's base name may equal another set's renamed first
  // shard. A shared `file` makes exact-match selection ambiguous (`.find`
  // silently takes the first), and can leave a whole set unreachable, so
  // disambiguate: the entry that names one of its own files keeps it; any
  // other claimant moves to its own lowest-numbered unclaimed shard. A set
  // with no unclaimed shard is dropped from the emitted variants — its
  // artifact was unreachable by an unambiguous name, the shared selector
  // keeps resolving to the owning entry, and no duplicate is ever emitted.
  const groupKey = (p) => `${p.g.split ? 'split' : 'single'}:${p.g.name}`;
  const byFile = new Map();
  for (const p of preferred) {
    const claimants = byFile.get(p.file);
    if (claimants) claimants.push(p);
    else byFile.set(p.file, [p]);
  }
  const taken = new Set(preferred.map((p) => p.file));
  const resolved = new Map(preferred.map((p) => [p, p.file]));
  const dropped = new Set();
  for (const claimants of byFile.values()) {
    if (claimants.length < 2) continue;
    const ordered = [...claimants].sort((a, b) => {
      const own = (p) => (p.g.relpaths.includes(p.file) ? 0 : 1);
      if (own(a) !== own(b)) return own(a) - own(b);
      const ka = groupKey(a);
      const kb = groupKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    for (const loser of ordered.slice(1)) {
      const spare = [...loser.g.relpaths].sort().find((p) => !taken.has(p));
      if (spare === undefined) {
        dropped.add(loser);
        continue;
      }
      taken.add(spare);
      resolved.set(loser, spare);
    }
  }
  return preferred.filter((p) => !dropped.has(p)).map((p) => {
    const file = resolved.get(p);
    return {
      file,
      quant: ggufQuant(file),
      bytes: !(p.g.sized && p.g.relpaths.length === p.g.expected) ? 0 : p.g.bytes,
      shards: p.g.relpaths.length,
    };
  });
}

function inferQuant(repo, siblings) {
  const hay = `${repo} ${siblings.map((f) => f.relpath).join(' ')}`;
  const m = /Q\d_[A-Z0-9_]+|Q\dK_M|fp16|bf16|int8|int4|awq|gptq/i.exec(hay);
  return m ? m[0].toUpperCase() : 'unknown';
}

function normalizeFixtureModel(raw) {
  const asset = normalizeHubModel({ ...raw, card: raw.card });
  asset.fixture = true;
  asset.revision = raw.sha;
  asset.freshnessAt = raw.lastModified;
  if (raw.adapter_config) {
    asset.adapter = {
      baseRepo: raw.adapter_config.base_model_name_or_path,
      baseRevision: raw.adapter_config.base_revision,
      peftType: raw.adapter_config.peft_type,
      rank: raw.adapter_config.r,
      targetModules: raw.adapter_config.target_modules,
      tokenizer: raw.adapter_config.tokenizer,
    };
  }
  return asset;
}

function matchFilters(asset, f) {
  if (f.task && asset.task !== f.task) return false;
  if (f.format && asset.format !== f.format) return false;
  if (f.quant && asset.quant !== f.quant
    && !(Array.isArray(asset.variants) && asset.variants.some((v) => v.quant === f.quant))) return false;
  if (f.license && !asset.license.tags.includes(f.license)) return false;
  if (f.kind && asset.kind !== f.kind) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!asset.repo.toLowerCase().includes(q) && !asset.task.toLowerCase().includes(q)) return false;
  }
  return true;
}

export function fixtureSearch(params = {}) {
  const f = {
    q: typeof params.q === 'string' ? params.q.slice(0, 128) : '',
    task: params.task || '', format: params.format || '', quant: params.quant || '',
    license: params.license || '', kind: params.kind || '',
  };
  const items = FIXTURE_MODELS.map(normalizeFixtureModel).filter((a) => matchFilters(a, f));
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), HUB_PAGE_LIMIT);
  const offset = Math.max(Number(params.offset) || 0, 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset, upstream: 'fixture', calls: { metadata: 1, weights: 0 } };
}

export function fixtureDetail(repo) {
  const raw = FIXTURE_MODELS.find((m) => m.id === repo);
  if (!raw) return null;
  return { ...normalizeFixtureModel(raw), upstream: 'fixture', calls: { metadata: 1, weights: 0 } };
}

async function hubFetch(url, { token } = {}) {
  // Manual redirects: each hop re-validates the allowlist, so a Hub
  // redirect can never bounce the Worker to an attacker host (T2).
  let current = assertHubUrl(url).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = { Accept: 'application/json', 'User-Agent': 'AIPSTER-catalog/1.0' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HUB_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw hubError(502, 'HUB_UNREACHABLE', 'The model Hub is unreachable; showing no cached copy without a freshness stamp.', { retryable: true });
    }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      if (!loc || hop === MAX_REDIRECTS) throw hubError(502, 'HUB_BAD_REDIRECT', 'Hub redirect missing or excessive.');
      current = assertHubUrl(new URL(loc, current).toString()).toString();
      continue;
    }
    return res;
  }
  throw hubError(502, 'HUB_BAD_REDIRECT', 'Hub redirect missing or excessive.');
}

function hubQuery(params) {
  const q = new URLSearchParams();
  q.set('limit', String(Math.min(Math.max(Number(params.limit) || 20, 1), HUB_PAGE_LIMIT)));
  if (params.q) q.set('search', String(params.q).slice(0, 128));
  const filters = [];
  if (params.task) filters.push(params.task);
  if (params.license) filters.push(`license:${params.license}`);
  for (const f of filters.slice(0, 5)) q.append('filter', String(f).slice(0, 64));
  if (params.sort === 'likes') { q.set('sort', 'likes'); q.set('direction', '-1'); }
  return q.toString();
}

// Live search follows Hub `Link: next` pages (bounded) to honor offset
// without inventing results. Returns items + total-when-known.
export async function hubSearch(params = {}, { token, admit } = {}) {
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), HUB_PAGE_LIMIT);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const want = offset + limit;
  const items = [];
  let url = `https://${HUB_API_HOST}/api/models?${hubQuery({ ...params, limit: Math.min(want, 100) })}`;
  let calls = 0;
  let total = null;
  // Outbound admission (R2): every search pages the Hub, so the caller
  // admits the principal before the first fetch; a spent budget 429s
  // with zero upstream calls.
  if (admit) await admit();
  for (; calls < 5 && items.length < want; calls++) {
    const res = await hubFetch(url, { token });
    if (res.status === 429) throw hubError(502, 'HUB_RATE_LIMITED', 'The model Hub rate-limited this search; retry shortly.', { retryable: true });
    if (res.status === 401 || res.status === 403) throw hubError(502, 'HUB_FORBIDDEN', 'The model Hub refused this search.', { retryable: false });
    if (!res.ok) throw hubError(502, 'HUB_ERROR', `The model Hub returned ${res.status}; no results invented.`, { retryable: res.status >= 500 });
    const page = await res.json().catch(() => null);
    if (!Array.isArray(page)) throw hubError(502, 'HUB_BAD_SHAPE', 'Hub returned an unparseable search page.');
    for (const raw of page) {
      try {
        const asset = normalizeHubModel(raw);
        if (matchFilters(asset, params)) items.push(asset);
      } catch { /* skip unparseable entries, never fail the page */ }
    }
    const link = res.headers.get('Link') || '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    if (!next) break;
    url = next[1];
  }
  return { items: items.slice(offset, offset + limit), total, limit, offset, upstream: 'hub', calls: { metadata: calls, weights: 0 } };
}

// Hub metadata TTL cache (Codex-sec-P2): hubDetail backs compat decisions
// whose own cache is keyed on Hub-supplied revision - so every compat
// request, hit or miss, fetched Hub first, and one tenant replaying
// identical requests burned unbounded shared outbound quota with no D1
// write to charge. A small per-isolate TTL cache bounds Hub resolution
// without any write, so compat cache hits stay read-only. Keyed by repo +
// token identity (a token must never see another token's gated view); only
// successful, gated, and 404 responses are cached, never errors. Cached
// hits report zero upstream calls. 60s TTL bounds the staleness of the
// revision pins feeding compat fingerprints.
const HUB_META_TTL_MS = 60 * 1000;
const HUB_META_MAX = 200;
const hubMetaCache = new Map();
export function __resetHubMetaCache() { hubMetaCache.clear(); }
async function hubCacheKey(repo, token) {
  if (!token) return `anon\n${repo}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`aipster-hub-scope/v1:${token}`));
  return `${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}\n${repo}`;
}
function hubCacheStore(key, value) {
  if (hubMetaCache.size >= HUB_META_MAX) {
    hubMetaCache.delete(hubMetaCache.keys().next().value);
  }
  hubMetaCache.set(key, { at: Date.now(), value });
}

export async function hubDetail(repo, { token, admit } = {}) {
  if (!isRepoId(repo)) throw hubError(400, 'BAD_REPO', 'Repository must look like org/name.');
  const cacheKey = await hubCacheKey(repo, token);
  const cached = hubMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HUB_META_TTL_MS) {
    if (cached.value === null) return null;
    return { ...cached.value, calls: { metadata: 0, weights: 0 } };
  }
  // Outbound admission (R2): cache hits return free above, but a miss
  // fetches - so the caller admits the principal first. The admission
  // covers whatever the fetch returns (metadata, cached 404, cached
  // 401/403, or an uncached error that re-admits on retry); a spent
  // budget 429s with zero upstream calls.
  if (admit) await admit();
  // blobs=true: without it the Hub omits every sibling `size`, so all
  // weights read as 0 bytes and the estimator under-counts (verified live
  // 2026-11-03 against /api/models/<repo>). Same single metadata call.
  const res = await hubFetch(`https://${HUB_API_HOST}/api/models/${repo}?blobs=true`, { token });
  if (res.status === 404) {
    hubCacheStore(cacheKey, null);
    return null;
  }
  if (res.status === 429) throw hubError(502, 'HUB_RATE_LIMITED', 'The model Hub rate-limited this lookup; retry shortly.', { retryable: true });
  if (res.status === 401 || res.status === 403) {
    // Gated repo without (or with insufficient) authorization: report the
    // gate honestly instead of inventing metadata or leaking existence.
    const gated = { gated: true, repo, upstream: 'hub', calls: { metadata: 1, weights: 0 } };
    hubCacheStore(cacheKey, gated);
    return gated;
  }
  if (!res.ok) throw hubError(502, 'HUB_ERROR', `The model Hub returned ${res.status}.`, { retryable: res.status >= 500 });
  const raw = await res.json().catch(() => null);
  const asset = normalizeHubModel(raw);
  const out = { ...asset, upstream: 'hub', calls: { metadata: 1, weights: 0 } };
  hubCacheStore(cacheKey, out);
  return out;
}

export function isFixtureEnv(env) {
  return env && env.CATALOG_FIXTURES === '1';
}

export function validateRepoId(repo) {
  return isRepoId(repo);
}
