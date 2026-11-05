// DGM lane: local experiment CLI. DRY-RUN IS THE DEFAULT and never touches
// the network. Live execution (--live) additionally requires an explicit
// consent string, an explicit spend budget, and an ephemeral key via the
// DGM_ROUTING_API_KEY environment variable. The key is used for the single
// bounded call only: it is never written to artifacts, never printed, and no
// credential file (including hc.txt) is ever read.
//
// Dry-run usage:
//   node run-local.mjs --candidate fixtures/valid-candidate.json
//   node run-local.mjs --candidate fixtures/valid-candidate.json --injected fixtures/injected-response.json --source-sha <sha>
// Search-space ceiling (offline, free, writes nothing):
//   node run-local.mjs --ceiling
// Live usage (NOT run by lane code; concrete later approved smoke only):
//   DGM_ROUTING_API_KEY=<ephemeral> node run-local.mjs --live --consent YES-LIVE-SPEND --max-spend-usd 0.05 --source-sha <sha>
// Live is refused (no call) while the ceiling shows no reachable
// improvement; --accept-tie-ceiling deliberately accepts a tie-only smoke.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkload, WORKLOAD_VERSION, WORKLOAD_SEED } from './workload.mjs';
import { runExperiment } from './runner.mjs';
import { acceptInjectedProposal } from './meta-adapter.mjs';
import { buildReport } from './report.mjs';
import { buildPromotionArtifact } from './promotion.mjs';
import { runLiveExperiment, LIVE_CONSENT } from './live-run.mjs';
import { artifactsDir, defaultStoreDir } from './paths.mjs';
import { searchCeiling, CEILING_ACCEPT_TIE } from './ceiling.mjs';

const root = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function flag(name) {
  return process.argv.includes(name);
}

function writeOutputs({ report, digest, promotion, experiment, proposalProvenance, extra = {} }) {
  const dir = artifactsDir(root);
  mkdirSync(dir, { recursive: true });
  const stem = `report-${digest.slice(0, 16)}`;
  writeFileSync(join(dir, `${stem}.json`), `${JSON.stringify({ report, digest }, null, 2)}\n`);
  writeFileSync(join(dir, `${stem}.sha256`), `${digest}\n`);
  writeFileSync(join(dir, `promotion-${digest.slice(0, 16)}.json`), `${JSON.stringify(promotion, null, 2)}\n`);
  console.log(JSON.stringify({
    mode: extra.mode || 'dry-run',
    digest,
    outcome: experiment.outcome,
    outcomeDetail: experiment.outcomeDetail,
    heldoutBaselineTop1: experiment.baseline.heldout.top1Hits,
    heldoutCandidateTop1: experiment.candidate.heldout.top1Hits,
    guardrails: experiment.guardrails.map((g) => `${g.name}=${g.passed ? 'pass' : 'FAIL'}`).join(','),
    promotionEligible: experiment.promotionEligible,
    files: [`artifacts/${stem}.json`, `artifacts/${stem}.sha256`, `artifacts/promotion-${digest.slice(0, 16)}.json`],
  }, null, 2));
}

const sourceSha = arg('--source-sha') || null;

if (flag('--ceiling')) {
  // Offline, free: enumerate the whole allowlist over the canonical workload
  // and print the best achievable synthetic outcome. Writes nothing.
  const c = searchCeiling(buildWorkload());
  console.log(JSON.stringify({ mode: 'ceiling', ...c }, null, 2));
} else if (flag('--live')) {
  const consent = arg('--consent') || '';
  const maxSpendUsd = arg('--max-spend-usd') === null ? NaN : Number(arg('--max-spend-usd'));
  // Ephemeral env key only: never a file, never printed, never persisted.
  const apiKey = process.env.DGM_ROUTING_API_KEY || '';
  const label = arg('--fresh-label') || 'default';
  if (consent !== LIVE_CONSENT || !Number.isFinite(maxSpendUsd) || apiKey.length === 0) {
    console.error('live execution refused: pass --live with the documented --consent string, a positive --max-spend-usd, and an ephemeral DGM_ROUTING_API_KEY env key. Dry-run is the default. A deliberate fresh experiment needs --fresh-label <name>; otherwise an unchanged request replays its receipt without spending.');
    process.exit(2);
  }
  // Attempt receipts live under the ignored artifacts/ tree: local-only
  // runtime state, never committed (see paths.mjs).
  const storeDir = defaultStoreDir(root);
  let out;
  try {
    const ceilingOverride = flag('--accept-tie-ceiling') ? CEILING_ACCEPT_TIE : null;
    out = await runLiveExperiment({ apiKey, consent, maxSpendUsd, sourceSha, label, storeDir, ceilingOverride });
  } catch (e) {
    if (e && e.code === 'DGM_CEILING_NO_IMPROVEMENT') {
      console.error(JSON.stringify({ mode: 'live', refused: e.code, spent: false, message: e.message, ceiling: { ceiling: e.ceiling.ceiling, counts: e.ceiling.counts, best: e.ceiling.best } }, null, 2));
    } else if (e && e.receipt) {
      console.error(JSON.stringify({ mode: 'live', attemptPersisted: true, code: e.code || null, receipt: e.receipt }, null, 2));
    } else {
      console.error(`live execution refused: ${(e && e.message) || e}`);
    }
    process.exit(2);
  }
  if (out.replayed) {
    console.log(JSON.stringify({ mode: 'live-replay', attemptId: out.attemptId, spent: false, receipt: out.receipt }, null, 2));
  } else {
    writeOutputs({ ...out, proposalProvenance: out.report.proposalProvenance, extra: { mode: 'live' } });
  }
} else {
  const candidatePath = arg('--candidate') || join(root, 'fixtures/valid-candidate.json');
  const injectedPath = arg('--injected');
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  let proposalsUsed = 0;
  let proposalProvenance = null;
  let effectiveCandidate = candidate;
  if (injectedPath) {
    const injected = JSON.parse(readFileSync(injectedPath, 'utf8'));
    const accepted = acceptInjectedProposal(injected);
    if (accepted.refused) {
      console.error(`injected proposal refused: ${accepted.reason} — ${accepted.detail}`);
      process.exit(2);
    }
    effectiveCandidate = accepted.candidate;
    proposalsUsed = 1;
    proposalProvenance = accepted.provenance;
  }
  const workload = buildWorkload();
  const experiment = runExperiment({ candidate: effectiveCandidate, workload, proposalsUsed });
  if (experiment.refused) {
    console.error(`experiment refused: ${experiment.reason} — ${experiment.detail}`);
    process.exit(2);
  }
  const generatedAt = new Date().toISOString();
  const { report, digest } = buildReport({
    experiment,
    workloadVersion: WORKLOAD_VERSION,
    workloadSeed: WORKLOAD_SEED,
    proposalProvenance,
    sourceSha,
    generatedAt,
  });
  const promotion = buildPromotionArtifact({
    candidateWeights: experiment.candidate.weights,
    report,
    reportDigest: digest,
    baseline: { policyVersion: report.baseline.policyVersion, sourceHash: report.baseline.source.sha256 },
    sourceSha,
  });
  writeOutputs({ report, digest, promotion, experiment, proposalProvenance });
}
