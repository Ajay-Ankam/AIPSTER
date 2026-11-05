/* Built with Meta Muse. Meta-qualification lane (meta-qual). */
/* Owner-dashboard qualification panel: detected vs advisory vs measured. */
/* Pure render helpers (HTML strings, escaped); no fetch, no secrets. */
import { promptTpsOf, tpsOf } from './validate.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Render the qualification report for one node. The three sections stay
 * visibly separate: detected facts, advisory recommendation, measured
 * benchmark. Honest empty/disabled/error/unsupported states; never a
 * live-looking fixture.
 */
export function renderQualificationReport({ nodeId, detected, advisory, measured, disabled = null } = {}) {
  const id = esc(nodeId || 'unknown node');
  if (disabled) {
    return `<section class="card panel" aria-labelledby="qual-h"><h2 id="qual-h">Hardware qualification</h2>`
      + `<p class="muted">${esc(disabled)}</p></section>`;
  }
  const stale = advisory?.profile_digest && measured?.profile_digest && advisory.profile_digest !== measured.profile_digest
    ? '<p class="muted">Stale measurement — the node profile changed since this run; it is kept for history, not current.</p>' : '';
  return `<section class="card panel" aria-labelledby="qual-h-${id}"><h2 id="qual-h-${id}">Hardware qualification — ${id}</h2>`
    + `<h3>Detected (worker-reported inventory, not independently attested)</h3>${renderDetected(detected)}`
    + `<h3>Advisory (Meta recommendation)</h3>${renderAdvisory(advisory)}`
    + `<h3>Measured (benchmark result)</h3>${stale}${renderMeasured(measured)}</section>`;
}

export function renderDetected(detected) {
  if (!detected) return '<p class="muted">No capability snapshot yet. The worker must report inventory first.</p>';
  const p = detected.profile || detected;
  const runtimes = Array.isArray(p.runtimes) && p.runtimes.length
    ? `<ul>${p.runtimes.map((r) => `<li>${esc(r.name)}${r.version ? ` ${esc(r.version)}` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">No runtimes reported (unknown).</p>';
  const mem = p.memTotalBytes ? `${(p.memTotalBytes / 1024 ** 3).toFixed(1)} GiB total` : 'memory unknown';
  return `<dl><dt>OS/arch</dt><dd>${esc(p.os || 'unknown')} / ${esc(p.arch || 'unknown')}</dd>`
    + `<dt>Memory</dt><dd>${esc(mem)}</dd>`
    + `<dt>GPU inventory</dt><dd>${p.gpuCount ? `${esc(String(p.gpuCount))} device(s) reported (display only; smoke results certify no placement and no GPU)` : 'none reported'}</dd></dl>${runtimes}`;
}

export function renderAdvisory(advisory) {
  if (!advisory) return '<p class="muted">No recommendation yet.</p>';
  if (advisory.state && advisory.state !== 'delivered') {
    return `<p class="muted">Recommendation state: ${esc(advisory.state)}. Retained for reconciliation; no automatic retry.</p>`;
  }
  const a = advisory.advice || advisory;
  if (!a || typeof a.summary !== 'string') return '<p class="muted">Recommendation unavailable.</p>';
  const catalog = esc(a.benchmarkCatalogId || 'unsupported');
  const sug = Array.isArray(a.suggestions) && a.suggestions.length
    ? `<ul>${a.suggestions.map((s) => `<li><strong>${esc(s.label)}</strong> — ${esc(s.detail)}</li>`).join('')}</ul>`
    : '<p class="muted">No supported benchmark (unsupported).</p>';
  const unk = Array.isArray(a.unknowns) && a.unknowns.length
    ? `<p class="muted">Unknowns: ${esc(a.unknowns.join('; '))}</p>` : '';
  const mode = advisory.mode && advisory.mode !== 'live' ? ' <span class="pill">fixture (not live evidence)</span>' : '';
  return `<p>${esc(a.summary)}${mode}</p><p>Catalog: <code>${catalog}</code></p>${sug}${unk}`;
}

export function renderMeasured(measured) {
  if (!measured) return '<p class="muted">No benchmark has run for this profile.</p>';
  const state = esc(measured.state || 'unknown');
  if (measured.state === 'uncertain') return `<p class="muted">Benchmark outcome uncertain (state: ${state}). Retained; never automatically rerun.</p>`;
  if (measured.state !== 'succeeded') {
    return `<p class="muted">Benchmark state: ${state}. ${measured.state === 'unsupported' ? 'This profile is not supported; readiness is reported honestly.' : 'No performance numbers to show.'}</p>`;
  }
  const r = measured.result || {};
  const tps = tpsOf(r);
  const prefill = promptTpsOf(r);
  const tpsLine = tps == null
    ? '<p class="muted">Throughput: not shown (no coherent native backend timings).</p>'
    : `<p>Throughput: ${esc(tps.toFixed(1))} tokens/s generation`
      + (prefill == null ? '' : ` · ${esc(prefill.toFixed(1))} tokens/s prefill`)
      + ' (native backend timings).</p>';
  const servedId = typeof r.servedModelId === 'string' && r.servedModelId ? esc(r.servedModelId) : '';
  const servedNote = servedId ? ` · served as ${servedId}` : '';
  const provenance = r.placementProvenance === 'operator-declared'
    ? `<dt>Placement</dt><dd>operator-declared (config pin; not independently measured)${servedNote}</dd>`
    : r.placementProvenance === 'unknown'
      ? `<dt>Placement</dt><dd>unknown — this smoke test certifies no placement and no GPU${servedNote}</dd>`
      : (servedId ? `<dt>Served identity</dt><dd>${servedId}</dd>` : '');
  return `<dl><dt>Runtime/model</dt><dd>${esc(r.runtimeId || 'unknown')} / ${esc(r.modelId || 'unknown')}</dd>`
    + `<dt>Elapsed</dt><dd>${esc(String(r.elapsedMs ?? 'unknown'))} ms (wall clock; not a throughput source)</dd>${provenance}</dl>${tpsLine}`;
}
