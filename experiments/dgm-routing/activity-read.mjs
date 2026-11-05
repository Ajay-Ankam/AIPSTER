/* Built with Meta Muse. */
// DGM local-report reader: a narrow, read-only Node adapter over the ignored
// local artifacts tree. It reads ONLY files literally named
// `report-<16hex>.json` inside the lane artifacts directory — no arbitrary
// paths, no query input, no writes, no network, no model calls.
//
// Hardening (every read is untrusted input):
// - lstat (never stat): symlinks and reparse points are refused, so reads
//   stay inside the fixed artifacts directory.
// - Bounded single read of MAX+1 bytes: a file that grows between stat and
//   read cannot overflow the bound.
// - Digest verification plus filename binding: the filename digest must
//   equal the verified report digest prefix, so a renamed file refuses.
// - Allowlisted projection: a recomputable hash proves integrity, NOT a safe
//   schema. Only the returned projection leaves this module — verified
//   reports with injected extra fields (secrets, private prompts, raw
//   proposal text) have them stripped. Unknown nested fields are dropped.
// - `root` is test-only and internal: path segments of `..` refuse. The
//   verifier hook calls with no arguments (module directory). Nothing here
//   reads HTTP input.
//
// Route contract for the verifier-owned loopback hook (this module does NOT
// serve HTTP; the verifier owns transport and auth):
//   GET /_local/dgm-activity -> 200 {
//     schema: 'aipster.dgm.local-activity/v1',
//     generatedAt: <iso>,
//     reports: [<allowlisted projections>],
//     failures: [{kind:'local-report', code, detail}]
//   }
// Auth: authenticated local owner only (verifier-owned). The admin UI calls
// it only as a same-origin relative URL and labels any failure or absence
// as not-connected.
import { readdirSync, openSync, readSync, closeSync, lstatSync, fstatSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactsDir } from './paths.mjs';
import { verifyReport } from './report.mjs';
import { buildActivityView, ACTIVITY_SCHEMA } from '../../website/src/dgm/activity.mjs';
import { assertBaselinePinned } from './baseline.mjs';
import { computeSelfTestSnapshot } from '../../website/src/dgm/eval-core.mjs';

export const LOCAL_ACTIVITY_SCHEMA = 'aipster.dgm.local-activity/v1';
export const REPORT_FILENAME = /^report-([0-9a-f]{16})\.json$/;
export const MAX_LOCAL_REPORTS = 10;
export const MAX_REPORT_BYTES = 256 * 1024;
export const MAX_GUARDRAILS = 25;
const STR_MAX = 256;

const laneRoot = dirname(fileURLToPath(import.meta.url));

function readFailure(code, detail) {
  return { kind: 'local-report', code, detail };
}

const bstr = (v) => (typeof v === 'string' && v.length > 0 ? v.slice(0, STR_MAX) : null);
const bnum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bint = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

function weightsOf(w) {
  if (!w || typeof w !== 'object') return null;
  const out = {};
  for (const k of ['EXACT_TOKEN', 'ONLINE', 'FRESHNESS_MAX', 'OWNED', 'HEADROOM']) {
    if (!Number.isSafeInteger(w[k])) return null;
    out[k] = w[k];
  }
  return out;
}

function heldoutOf(h) {
  if (!h || typeof h !== 'object') return null;
  const n = bint(h.n);
  const top1Hits = bint(h.top1Hits);
  if (n === null || top1Hits === null || top1Hits > n) return null;
  return {
    n, top1Hits,
    top1Rate: typeof h.top1Rate === 'number' && h.top1Rate >= 0 && h.top1Rate <= 1 ? h.top1Rate : null,
    meanRankOfOracleBest: bnum(h.meanRankOfOracleBest),
  };
}

function guardrailsOf(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_GUARDRAILS).map((g) => ({
    name: bstr(g?.name) || 'unknown-gate',
    passed: g?.passed === true,
    evidence: bstr(g?.evidence),
  }));
}

function provenanceOf(p) {
  if (!p || typeof p !== 'object') return null;
  const usage = p.usage && typeof p.usage === 'object' ? p.usage : null;
  return {
    evaluation: bstr(p.evaluation),
    model: bstr(p.model),
    modelVerified: p.modelVerified === true,
    responseId: bstr(p.responseId),
    usage: usage && bint(usage.input_tokens) !== null && bint(usage.output_tokens) !== null
      ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
      : null,
  };
}

/**
 * Allowlisted projection of a verified report. Every field is re-validated;
 * anything not on this shape — extra secrets, private prompts, raw proposal
 * text, unknown nested objects — is dropped, never passed through.
 */
export function projectReport(report) {
  if (!report || typeof report !== 'object') return null;
  const baseline = report.baseline && typeof report.baseline === 'object' ? report.baseline : null;
  const candidate = report.candidate && typeof report.candidate === 'object' ? report.candidate : null;
  const bsrc = baseline?.source && typeof baseline.source === 'object' ? baseline.source : null;
  return {
    evalVersion: bstr(report.evalVersion),
    generatedAt: bstr(report.generatedAt),
    sourceSha: bstr(report.sourceSha),
    outcome: bstr(report.outcome),
    outcomeDetail: bstr(report.outcomeDetail),
    baseline: baseline ? {
      policyVersion: bstr(baseline.policyVersion),
      weights: weightsOf(baseline.weights),
      source: bsrc ? { file: bstr(bsrc.file), sha256: bstr(bsrc.sha256), blob: bstr(bsrc.blob) } : null,
      heldout: heldoutOf(baseline.heldout),
    } : null,
    candidate: candidate ? {
      weights: weightsOf(candidate.weights),
      hash: bstr(candidate.hash),
      heldout: heldoutOf(candidate.heldout),
    } : null,
    guardrails: guardrailsOf(report.guardrails),
    promotionEligible: report.promotionEligible === true,
    proposalsUsed: bint(report.proposalsUsed),
    proposalProvenance: provenanceOf(report.proposalProvenance),
  };
}

export function readBoundedBytes(path, expect = null) {
  // Lstat first (symlinks/reparse points refuse), then open, then fstat the
  // open fd and compare dev/ino: a path swapped for a link between the
  // checks refuses instead of reading the wrong file. Exactly ONE bounded
  // read of MAX+1 bytes follows, so growth cannot overflow the bound.
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, code: 'UNREADABLE', detail: 'cannot stat file' };
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    return { ok: false, code: 'NOT_A_FILE', detail: 'not a regular file or is a link; refused' };
  }
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const live = fstatSync(fd);
    if (expect && (live.dev !== expect.dev || live.ino !== expect.ino)) {
      return { ok: false, code: 'SWAPPED', detail: 'file changed between stat and open; refused' };
    }
    if (!live.isFile()) {
      return { ok: false, code: 'NOT_A_FILE', detail: 'open file is not a regular file; refused' };
    }
    const buf = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_REPORT_BYTES) {
        return { ok: false, code: 'OVERSIZE', detail: 'exceeds the byte bound; not read' };
      }
    }
    return { ok: true, text: buf.subarray(0, total).toString('utf8') };
  } catch {
    return { ok: false, code: 'UNREADABLE', detail: 'cannot read file' };
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

/**
 * Read verified local reports. Options: {root} (lane root override for
 * tests ONLY; refuses `..` segments — the verifier hook passes nothing).
 * Returns {reports, failures} where reports are allowlisted projections.
 */
export function readLocalReports({ root = laneRoot } = {}) {
  if (typeof root !== 'string' || root.split(/[\\/]/).includes('..')) {
    throw Object.assign(new Error('report root must be a plain directory without parent segments'), { code: 'DGM_READ_BAD_ROOT' });
  }
  const dir = artifactsDir(root);
  // The artifacts directory itself must be a real directory, never a link:
  // a swapped dir would redirect every read outside the fixed tree.
  try {
    const dst = lstatSync(dir);
    if (!dst.isDirectory() || dst.isSymbolicLink()) {
      return { reports: [], failures: [readFailure('DIR_UNSAFE', 'artifacts directory is missing, not a directory, or a link; refused')] };
    }
  } catch {
    return { reports: [], failures: [readFailure('NO_ARTIFACTS', 'no local report artifacts on this host')] };
  }
  let names;
  try {
    names = readdirSync(dir).filter((n) => REPORT_FILENAME.test(n)).sort();
  } catch {
    return { reports: [], failures: [readFailure('NO_ARTIFACTS', 'no local report artifacts on this host')] };
  }
  const reports = [];
  const failures = [];
  for (const name of names.slice(0, MAX_LOCAL_REPORTS)) {
    const expected = REPORT_FILENAME.exec(name)[1];
    const path = join(dir, name);
    let expect = null;
    try {
      const pre = lstatSync(path);
      expect = { dev: pre.dev, ino: pre.ino };
    } catch {
      failures.push(readFailure('UNREADABLE', `cannot stat ${name}`));
      continue;
    }
    const read = readBoundedBytes(path, expect);
    if (!read.ok) {
      failures.push(readFailure(read.code, `${name}: ${read.detail}`));
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      failures.push(readFailure('MALFORMED', `${name} is not valid JSON; not read`));
      continue;
    }
    const report = parsed && typeof parsed === 'object' ? parsed.report : null;
    const digest = parsed && typeof parsed === 'object' ? parsed.digest : null;
    if (!report || typeof digest !== 'string' || !verifyReport(report, digest)) {
      failures.push(readFailure('DIGEST_MISMATCH', `${name} digest does not recompute; dropped, never rendered`));
      continue;
    }
    if (digest.slice(0, 16) !== expected) {
      failures.push(readFailure('NAME_MISMATCH', `${name} digest does not agree with its filename; dropped`));
      continue;
    }
    const projected = projectReport(report);
    if (!projected || !projected.baseline || !projected.candidate) {
      failures.push(readFailure('BAD_SHAPE', `${name} verifies but lacks baseline/candidate; dropped`));
      continue;
    }
    reports.push(projected);
  }
  if (names.length > MAX_LOCAL_REPORTS) {
    failures.push(readFailure('TRUNCATED', `${names.length - MAX_LOCAL_REPORTS} further report file(s) not read`));
  }
  return { reports, failures };
}

/**
 * Build the activity view with verified, projected local reports merged in.
 * Same inputs as buildActivityView plus optional test-only {root}.
 */
export function buildLocalActivity({ root = laneRoot, ...inputs } = {}) {
  const { reports, failures } = readLocalReports({ root });
  const view = buildActivityView({ ...inputs, localReports: reports });
  // Hook failures are READ failures only (kind 'local-report'): guardrail,
  // gate and proposal rows live inside view.failures next to the reports
  // they describe and must never be relabeled as dropped unread reports.
  return {
    schema: LOCAL_ACTIVITY_SCHEMA,
    generatedAt: new Date().toISOString(),
    view,
    reports,
    failures,
    ceiling: localCeilingSummary(),
  };
}

// Search-space ceiling (additive, read-only): the same deterministic
// snapshot the site's cron self-test computes (eval-core.mjs, about 10 ms),
// projected to an allowlisted summary. The scorer source is pin-checked
// first; any refusal (e.g. baseline drift) renders 'unavailable' with its
// code, never a guessed ceiling. Nothing is written, no model is called.
let ceilingMemo = null;

export function localCeilingSummary() {
  let pinHash;
  try {
    pinHash = assertBaselinePinned().source.sha256;
  } catch (e) {
    return { state: 'unavailable', code: bstr((e && e.code) || 'DGM_CEILING_FAILED'), synthetic: true };
  }
  if (ceilingMemo && ceilingMemo.pinHash === pinHash) return ceilingMemo.summary;
  let s;
  try {
    s = computeSelfTestSnapshot();
    if (!s.guardrails.every((g) => g.passed)) throw Object.assign(new Error('guardrail failed'), { code: 'DGM_GUARDRAIL_FAILED' });
  } catch (e) {
    return { state: 'unavailable', code: bstr((e && e.code) || 'DGM_CEILING_FAILED'), synthetic: true };
  }
  const summary = {
    state: 'computed',
    synthetic: true,
    workload: { version: s.workload.version, seed: s.workload.seed },
    ceiling: s.ceiling,
    proposalCanImprove: s.proposalCanImprove,
    evaluated: s.evaluated,
    counts: { ...s.counts },
    baselineHeldoutTop1: s.baseline.heldoutTop1,
    heldoutN: s.workload.heldoutN,
    best: s.best ? {
      outcome: s.best.outcome,
      heldoutTop1: s.best.heldoutTop1,
      weightsKey: s.best.weightsKey,
      // Per-variable movement against the baseline: what the best
      // achievable candidate changes, and in which direction.
      variables: s.variables.map((v) => ({ ...v })),
    } : null,
  };
  ceilingMemo = { pinHash, summary };
  return summary;
}

export { ACTIVITY_SCHEMA };
