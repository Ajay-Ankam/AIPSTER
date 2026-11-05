# AIPSTER Meta qualification and DGM completion PRD

Status: implementation contract draft, 2026-11-05. Baseline: `f5b4572`.
Submission grace cutoff: 2026-11-05 08:10 UTC. Main and the submission tag remain unchanged until an explicitly approved release.

## Product outcome

Each paired worker reports detected hardware to the hosted AIPSTER application. The server asks Meta what inference that node may support and which supported benchmark to run. The worker executes only a fixed, bounded benchmark implementation and returns measurements to the owning user's dashboard. The dashboard keeps detected facts, model recommendations, and measured performance visibly separate.

The separate DGM feature uses Meta to propose bounded improvements to inference routing across connected fabrics, executes an isolated evaluation, and compares candidate routing results against a frozen baseline. A proposal or passing fixture is not evidence of autonomous harness improvement. Promotion is an explicit human decision; no generated code executes in the production Worker.

## Existing foundation

- Worker pairing and heartbeat identity already exist. `pairing.py` periodically posts RAM, disk and runtime capability reports to `/api/resources/:id/capabilities` using the resource-bound heartbeat key. Server-side ownership, revocation, strict schema and quota checks already exist.
- The hosted adviser already calls `muse-spark-1.3` through `POST https://api.meta.ai/v1/responses`, with a server-only `MODEL_API_KEY`, structured output and admission controls. Its current snapshot omits hardware metrics and its receipt does not persist the advice output.
- DGM already has a bounded `muse-spark-1.3-contributor` adapter, proposal operations, spend accounting and fixed fixture evaluation. Historical provider success exists, but the old receipt could infer a missing model echo; it does not qualify the current hosted flow.
- Existing CPU inference workers have pinned runtime/model identity, leases, deadlines and result reporting. They are not a generic benchmark protocol. Native timing data can yield throughput; wall-clock duration alone cannot.

## Hardware qualification flow

1. An owner enables qualification for their node. New or materially changed inventory becomes eligible; a routine heartbeat does not itself cause another Meta call.
2. The hosted server resolves the node and latest capability report using authoritative ownership. It creates a canonical profile digest from stable hardware/runtime facts and the catalog/prompt versions. Available-memory fluctuations, timestamps and load do not invalidate the recommendation cache. Available resources are checked again before execution.
3. The server sends only allowlisted hardware facts and eligible catalog choices to Meta. No hostname, address, file path, user identity, heartbeat credential, API key, repository secrets or arbitrary worker text enters the prompt. Missing hardware remains unknown.
4. Meta returns strict JSON: summary, supported inference suggestions, rationale, unknowns, and a benchmark catalog ID or `unsupported`. Suggestions never mutate resource usability or claim compatibility was measured.
5. The server validates and persists the recommendation and safe provider receipt. It exposes a typed benchmark assignment bound to node, owner, inventory digest, catalog version and a unique run ID.
6. The worker validates the assignment, local readiness and resource bounds, executes the fixed benchmark, and returns a bounded result. Unknown outcomes are retained and never automatically rerun.
7. An owner-only dashboard endpoint returns the node report, recommendation and benchmark status/results. An ownership transfer, revocation or materially changed inventory invalidates pending work and hides the previous owner's report.

## First supported benchmark

Catalog ID: `completion-smoke-v1`. Use a fixed synthetic prompt, temperature zero, at most 32 generated tokens, a 15-second execution deadline, one concurrent benchmark per worker, and an already configured ready CPU model under a supported local runtime. No installs, model downloads, arbitrary commands, model-generated prompts, URLs, shell invocation or GPU placement in this first slice.

The catalog determines execution parameters; Meta selects an eligible ID only. The worker may refuse for load, insufficient memory, missing runtime/model, changed identity or unsupported placement. It records `unsupported`, `failed`, `timed_out` or `uncertain` explicitly. A completed result includes observed runtime/model identity, elapsed time, token counts when reported and native timing measurements when valid. Tokens per second is shown only from coherent native backend timings, never invented from elapsed time.

GPU inventory and recommendations may be displayed, but a CPU result does not certify GPU performance. CPU memory and compute characteristics do not establish that an uninstalled model will run.

## Hosted contract and controls

Proposed owner routes: `GET /api/qualifications` and session/CSRF-protected `POST /api/resources/:id/qualification`. Worker assignment/result routes reuse the existing resource-bound heartbeat identity, with a dedicated typed benchmark protocol. The exact transport contract is frozen before implementation; existing inference admission is not bypassed.

Persist recommendation and benchmark records separately from existing adviser receipts, including owner/node binding, canonical profile digest, version, lifecycle state, provider model echo, response ID, usage, timestamps, immutable assignment and measured receipt. Use atomic admission, claim and result transitions. Duplicate requests replay the existing state and do not spend or rerun. Retain uncertain operations for reconciliation.

Feature is off by default. A missing server key or budget returns a clear disabled state and never a live-looking fixture. No API key is distributed to workers or browser assets. Credential provisioning, production enablement and deployment require their concrete action-time approvals.

## Meta call and token budget

- One compact structured recommendation per materially changed node profile, catalog and prompt version; cache safely within the owning account. Concurrent duplicates share one operation.
- Default generation ceiling: one attempt, at most 512 output tokens, bounded input bytes and 30-second total deadline. No tools, search, automatic retries or fallback model.
- Reserve worst-case token cost atomically before sending; enforce a per-owner daily and global deployment cap. Unknown/accepted-but-unusable outcomes retain reservations until reconciled. An explicit refresh is separately rate-limited and budgeted.
- Hardware qualification uses Standard `muse-spark-1.3` unless a different mode is explicitly approved. Official pricing checked 2026-11-05: $1.25/M input and $4.25/M output tokens. Contributor pricing is $0.10/M input and $0.20/M output and permits training on supplied content; existing DGM uses that mode. Rates: https://dev.meta.ai/docs/pricing-rate-limits.
- The earlier standalone smoke proposals do not authorize ongoing service credentials, automatic calls, DGM experiment budgets or production settings.

## DGM bounded experiment flow

Reuse the existing DGM operation/provider contracts, but do not present the existing hardcoded preview verdicts as measured evaluations. The initial demonstrable scope is one explicit routing experiment: pinned baseline routing policy, one Meta proposal selecting a restricted declarative candidate, fixed synthetic training and held-out workloads, actual execution of baseline/candidate routing decisions, and a persisted comparison receipt. No arbitrary production code evaluation, auto-merge, auto-deploy or recursively expanding research loop.

Acceptance metrics must come from the authoritative DGM specification where available. The DGM owner will cite those definitions. Where absent, proposed criteria are: zero violations of ownership, capability, resource, budget and freshness constraints; no regression on the held-out baseline cases; and an actual improvement in a declared routing objective such as eligible dispatch success or workload completion cost. Synthetic scenario metrics are labeled synthetic, not live fabric latency. Candidate changes are finite policy values rather than executable generated code. A reviewed promotion artifact must identify candidate, baseline and evaluation hashes and require explicit human application.

Cache by baseline/candidate context and evaluation version. Budget one Meta proposal attempt per explicitly started experiment, at most 512 output tokens and the existing 60-second adapter deadline. Reuse the proposal during deterministic evaluation; tests do not call Meta. A failed or uncertain provider operation stops the experiment. Any future improvement claim must identify an actual candidate delta, repeated comparable test evidence and retained regressions; selecting a fixture alone is labeled fixture evaluation.

## Parallel ownership

| Lane | Exclusive scope | First deliverable |
| --- | --- | --- |
| Muse qualification | Worker benchmark, hosted qualification modules/routes/migration, dashboard panel and related tests | Complete bounded node qualification and benchmark flow |
| Muse DGM | `experiments/dgm-routing`, DGM modules and DGM-specific tests | Actual routing experiment with held-out evaluation and controlled promotion artifact |
| Muse verification | Independent evidence and separately owned review tests | Authentication, replay, timing, isolation and combined-contract verification |
| Coordinator | PRD, shared contract, integration/release evidence | Combined candidate, targeted/full validation and approval packet |

Three actual Muse agents started on JJP at 04:11 UTC: qualification `f133039a-31a6-46e6-a921-c46dd540d9c5`; DGM `aca55e0e-6905-4a35-be9a-7b8aa6314c32`; verification `69a58d15-16aa-4876-97c7-43b6ddc37c1d`. Model: `muse-spark-1.3-contributor`, existing configured high-effort profile. Each session stays linear, with no nested agents because of the documented shared-connection failure. No parallel writer edits another lane's files. Existing owners and evidence are reused; no paid Claude Cloud session or follow-up is started. A final local Claude Code review is required on the immutable combined change before publication is proposed.

All implementation and testing remain in the isolated local JJP checkout. No intermediate PRs or pushes. One consolidated PR is prepared only after integration and review, and published only on concrete final authorization.

## Acceptance evidence and release decision

Required live proof: paired worker identity and measured inventory -> hosted authenticated request -> exact Meta model echo/response ID/usage -> validated catalog assignment -> actual local benchmark -> persisted owner-only dashboard report. Preserve safe IDs, timestamps, source SHA and measurement provenance. Cross-owner access, revoked workers, malformed provider output, duplicate operations, stale inventory and uncertain-result replay must fail safely.

DGM proof separately requires exact provider receipt, validated proposal/candidate, isolated evaluator result and honest comparison. Mocks prove contracts only. Local provider success does not prove hosted activation, and a dashboard screenshot does not prove execution.

Run focused repros and affected tests first, then the required combined integration suite and release checks once. Before 08:10 UTC, prefer a complete supported CPU path over broad unsupported hardware claims. If hosted credentials, deployment approval, signed-in owner access, a ready local model or release checks are unavailable, report HOLD with the exact missing link; do not rush an unverified production push.

## As-built addendum (qualification lane, 2026-11-05; supersedes CPU-only wording above)

The requester asked for actual hardware inference measurement; the CPU-only
framing was this lane's engineering slice, not a requester requirement. The
shipped slice is a generic local-native `completion-smoke-v1`: fixed
synthetic prompt, temperature zero, at most 32 tokens, 15-second shared
deadline, loopback only, heartbeat-bound lease safety unchanged.

- Attach transport only. Listing, request and served-echo comparison speak
  the config `upstream_model` native identity; the result reports the
  configured `modelId` plus the actually-served `servedModelId`.
- Placement is never certified. Results carry `placementProvenance`
  (`unknown` or `operator-declared`): an attach `gpu_layers` pin neither
  controls nor observes the external server's offload, so it gates nothing
  and labels only. Dashboards state unknown placement explicitly; no result
  is shown as a CPU measurement and no smoke result certifies GPU.
- Managed execution is explicitly deferred (`MANAGED_DEFERRED` /
  unsupported): a worker-spawned engine serves a native alias the runner
  cannot yet map to the configured id. Server-side `llama-server` result
  acceptance is unchanged; only the runner declines managed work until
  alias binding is proven. No claim is made that all benchmark paths work.
- Reporter de-duplicates runtime entries by (name, mode), so a mixed
  attach+managed config of one kind reports both transports; digest merges
  per-mode configured sets so no transport's identity is silently dropped.
- GET lists cap at 50 recommendations/runs/cache rows and 100 nodes;
  owners above those limits paginate in a follow-up — current states may
  read "changed profile / none" past the caps.

## Addendum: DGM routing-activity view (DGM lane scope only)

User-facing requirement: the admin console shows one coherent, read-only
account of routing-improvement work — what the harness pursues, current
experiments and their states, measured before/after metrics, accepted,
rejected and promoted history, blockers, and budget facts. Existing preview
panels show fragments; this view joins them without inventing activity.

Scope, binding on this view:

- Read-only over already-authorized, already-persisted receipts (preview
  status/runs/details, Muse proposal ops/status). No new hosted endpoint, no new
  data exposure, no cross-owner aggregation, no prompts, payloads, or secrets.
- Every metric carries source, unit, and a synthetic flag. Fixture-table ppm
  scores are labeled hardcoded, never measured. The synthetic top-1 proxy is
  labeled a proxy, never fabric quality. Empty renders as empty, never as
  running. Promotion history is stated from records: website promote/execute
  answer 501, so no promotion history exists.
- Local dry-run reports are not served by the hosted API and appear only
  through the local harness; the view never invents them. No model calls, no
  production promotion, no autonomous loop.
- Machine-readable shape for agents is the same view model over the same
  endpoints (an `admin.dgm.preview` grant fetches them); no separate API.

Local integration: the JJP-only harness adds authenticated read-only
`GET /_local/dgm-activity` for bounded, hash-verified, allowlisted local
report projections. This is not a hosted endpoint. The admin view marks it
not connected wherever the local hook is absent. The latest local evaluation
is a synthetic 20/24 baseline versus 20/24 candidate tie, archived and
ineligible for promotion; it is not a real-fabric improvement.
