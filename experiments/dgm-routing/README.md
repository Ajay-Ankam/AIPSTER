# DGM bounded local routing experiment (lane: dgm-routing)

Local-only, synthetic, honest scope. No network, no credentials, no `eval`, no
shell, no production writes. The website preview `execute`/`promote` routes
stay `501` fail-closed; the only promotion artifact here is a reviewable local
JSON that a human applies by hand.

## What it does

One experiment = frozen `route/v1` baseline vs one allowlisted declarative
candidate over a fixed synthetic train/held-out workload, with real routing
decisions executed on both sides:

- Baseline: the authoritative `scoreCandidates` in
  `website/src/routing/policy.mjs`, pinned by `baseline.mjs` on version +
  weights + scorer source content hash (refuses on drift; source identity
  flows into every report).
- Candidate: `scoreWithWeights` (`runner.mjs`) with weights from the finite
  allowlist in `candidate-schema.mjs`. A test pins the mirror equal to the
  authoritative scorer at frozen weights.
- Workload (`workload.mjs`): 24 train + 24 held-out synthetic items, fixed seed
  `20261105`. Oracle-best comes from a fixed weight-independent rule — a NEW
  synthetic metric (top-1 hit rate, mean rank), NOT a production claim.
- Meta adapter (`meta-adapter.mjs`): strict raw-JSON candidate contract end to
  end (prompt demands it, parser accepts nothing else); minimal reasoning,
  512 output tokens, 60 s total deadline raced against the body read,
  redirects refused, no retry/tools, sanitized accepted/unknown failure
  accounting. Identity rule: injected model labels are caller-supplied and
  always `modelVerified: false`; live is verified only on an exact echo of
  the pinned model, null otherwise — never a fabricated fallback.
- Report (`report.mjs`): canonical-JSON immutable report + SHA-256 digest.
- Promotion (`promotion.mjs`): `approved:false`, manual-human-only, local-only.
  The artifact's `eligible` flag is never trusted and caller workloads are
  refused: application re-verifies the bound report digest and workload
  identity, then recomputes the deterministic evaluation on the artifact's
  weights over the internally built canonical workload — a hand-flipped flag
  or a crafted split cannot apply.
- Live path (`live-run.mjs` + `meta-adapter.mjs` `proposeLiveRouting`): bounded
  live-capable adapter with injected fetch for tests. Fixed endpoint/model,
  caller key only, request byte + spend budgets, 512 output tokens, 60 s total
  deadline, redirects refused, no retry/tools, sanitized accepted/unknown
  failure accounting. Dry-run is the default; live needs explicit consent +
  budget + ephemeral env key. No call is made by lane code.

## Run

```sh
node experiments/dgm-routing/run-local.mjs --candidate experiments/dgm-routing/fixtures/valid-candidate.json
node experiments/dgm-routing/run-local.mjs --candidate experiments/dgm-routing/fixtures/valid-candidate.json --injected experiments/dgm-routing/fixtures/injected-response.json --source-sha <sha>
```

Live (concrete later approved smoke only; NOT run by lane code):

```sh
DGM_ROUTING_API_KEY=<ephemeral> node experiments/dgm-routing/run-local.mjs --live --consent YES-LIVE-SPEND --max-spend-usd 0.05 --source-sha <sha>
```

Spend-once semantics (`attempts.mjs`): the attempt identity (baseline,
workload, model, prompt hash, per-call budget, label) is atomically claimed
before any network contact; an unchanged rerun replays the persisted receipt
without spending; uncertain, invalid-candidate, AND post-provider evaluator /
report / promotion failures persist with the safe provider receipt and
sanitized accounting; no automatic retry — a deliberate fresh experiment needs
`--fresh-label <name>`. Budgets are per-call only; no aggregate ledger exists
in this slice. The default store is `artifacts/attempts/` (ignored tree,
never committed). No credential file (including `hc.txt`) is ever read; the
key never enters artifacts. Outputs land in `experiments/dgm-routing/artifacts/`
(local only).

## Search-space ceiling (no paid proposal over a tie-only space)

The allowlist is finite (162 weight vectors, one of them the baseline) and the
evaluator is deterministic, so `ceiling.mjs` enumerates every candidate offline
and reports the best achievable outcome:

```sh
node experiments/dgm-routing/run-local.mjs --ceiling
```

On the canonical workload the ceiling is `tie-archived`: 0 improvements, 54
ties, 107 regressions; the best candidate ties the baseline at 20/24 held-out.
`runLiveExperiment` therefore refuses with `DGM_CEILING_NO_IMPROVEMENT` before
claiming an attempt or contacting the provider. A deliberate tie-accepting
transport smoke passes `--accept-tie-ceiling` (`ceilingOverride:
'ACCEPT-TIE-CEILING'`), which skips enumeration. An already-claimed attempt identity skips the gate and
keeps its existing replay/uncertain semantics. The ceiling is synthetic like
every number here. To get a reachable improvement, widen the search space; a
different prompt cannot help.

## Outcome rule (stated objective, no tie-as-improvement)

- `improvement`: strict synthetic held-out top-1 gain AND zero rank
  regressions on ANY held-out item AND all guardrails green. Only this is
  eligible. Synthetic only — never a real-fabric improvement claim.
- `tie-archived`: equal top-1 with zero rank regressions. Archived as
  evidence, NEVER called an improvement, never eligible.
- `regression`: everything else, including any guardrail failure.

## Guardrails

G1 permutation integrity, G2 replay determinism, G3 allowlist conformance,
G4 split independence (held-out repeats no train item; distinct RNG streams).
Ineligible or unapproved artifacts refuse to apply. Nothing auto-promotes.

## Claim boundary (read before quoting any number)

- The top-1 oracle is a PROPOSED SYNTHETIC PROXY: a fixed weight-independent
  preference over synthetic descriptors. It is not a preexisting acceptance
  metric, not the stack evaluator's criteria (adherence/leakage/neutral/p95
  paired statistics are a different, personalization-specific instrument and
  are not relabeled here), and not real-fabric quality proof.
- The public deterministic held-out is a REGRESSION SPLIT, not secret
  untouched audit data. It is visible in this repository, and repeated
  development can tune to it. No sealed final audit is claimed, and this is
  not a full DGM process implementation.
- Lifecycle is REPORT_ONLY with human review: frozen finalist (candidate hash
  recorded at run time), attempt-before-dispatch, persisted uncertainty, no
  automatic deployment. Rollback means a human re-applying a prior local
  config through the same approved path — no production state is touched.
- No private source or held-out data is copied into this repository or into
  provider prompts; the workload is authored synthetic fixtures only.

## Daily self-test (Worker cron, not a local process)

The daily self-test runs INSIDE the site's Cloudflare Worker on a cron
trigger (`15 3 * * *`, 03:15 UTC daily), not as a local process. There is
no local runner script, no scheduled-task registration, and no history
jsonl file: history lives in the Worker's D1 table `dgm_self_tests`
(migration `website/migrations/0031_dgm_self_test.sql`, newest 400 rows
retained). Each run stores two independent parts:

- `snapshot_json`: the deterministic policy check from
  `website/src/dgm/eval-core.mjs` (`computeSelfTestSnapshot`, no I/O, no
  model calls, no network): the live route/v1 weights against every
  allowlisted alternative on the fixed synthetic workload. It is a pure
  function of the source code, so it changes only when the routing policy
  or the workload changes: a regression detector, not a trend. A guardrail
  failure is stored as `failed` with the guardrail verdicts only.
- `routing_json`: the sanitized aggregate of real routing decisions in the
  24 h before the run (`website/src/dgm/telemetry.mjs`, read from
  `routing_ops.ranking_json.metrics`): decisions by source, advice attempts
  and failures, agreement with the deterministic first choice, cache hit
  rate, decision-time percentiles, estimated advice spend. This is the part
  that moves day to day. Zero traffic is recorded as zero decisions; a
  telemetry read failure is recorded as `{state:'failed', code}` beside a
  completed evaluation, never as zeros.

Opt-in: the cron runs only when `DGM_SELF_TEST_ENABLED` is exactly `1`
(set in `wrangler.jsonc` vars; wrangler vars overwrite dashboard values on
every deploy). Migration 0031 must ship with the release; until it is
applied the cron skips as `store-not-migrated`. One run needs roughly
15–25 ms of CPU, above the Workers Free plan limit (10 ms): on Free the
run is killed before it writes a row, which the panel reports as "a run was
expected at … but none was recorded".

The admin "DGM daily self-test" panel reads `GET /api/admin/v1/dgm/self-test`
(`admin.dgm.preview` grant, GET-only) and shows, in plain language: a
verdict pill (healthy / policy regressed / policy improved / better weights
available / failed), the live routing figures for the window, the current
weights beside the best alternative tried, and the run history with changes
against the previous completed run.

Claim boundary: the policy check measures the SYNTHETIC proxy only — the
same proposed top-1 metric as above, not real-fabric quality. The routing
aggregate counts real decisions, but with dispatch disabled they are
ranking decisions, not completed inference.
