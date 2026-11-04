# FABRIC067 review packet — fabric-routed OpenAI compatibility (author turn)

## 1. ACK and worktree (actual, not planned)

- Worktree: `task-4/lanes/muse-fabric-openai067-20261104`
- Branch: `muse/fabric-openai067-20261104`, from `d9e693c` (readiness060)
  with `06feab7` (Mac fix lineage / inference release runbook) merged —
  file-disjoint, no conflicts. No other worktrees touched.
- Ownership respected: `website/src/worker.js`, `local-worker/pairing.py`,
  native packaging/icons/controllers untouched. No monitoring changes.
  No push/merge/deploy; no production flags/DDL/grants/host installs.

## 2. Concrete architecture (verified against code, 2026-11-04)

Client (OpenAI base URL) -> NEW `local-worker/fabric_openai_proxy.py`
(loopback :8089; validates bounds; fixed-origin forward; user key via
`AIPSTER_FABRIC_API_KEY` header only) -> trusted fabric entrypoint
`POST /v1/chat/completions` + `GET /v1/models` (WEB066 applies the
idle-patch from `docs/fabric-openai067-integration-contract.md`) ->
NEW `website/src/inference/fabric-openai.mjs` (pure validate/map) ->
EXISTING `store.issueAdmission` (worker.js admissions shape) ->
EXISTING `dispatchCoordinator.submit` -> EXISTING `createWorkerTransport`
(enqueueJob) -> worker pull `GET /api/worker/jobs/next` ->
EXISTING `inference_worker.py serve-jobs` (bound envelope, one local
completion, EIF result) -> `POST .../result` -> `store.completeJob` ->
reconcile/settle -> adapter maps to `chat.completion` with machine
provenance, or a truthful typed error. Poll loop is bounded (2 s, <=60 s).

Exact missing boundary found: **no `/v1/*` route exists anywhere in
`website/src`** (Select-String over all sources: zero hits) and the live
JJP worker answers `GET /v1/models` on 8090 with **404** (probed 2026-11-04;
metadata only, no generation). New modules fill exactly that gap.

## 3. File ownership (this turn)

| Item | Owner | Touched |
|---|---|---|
| NEW `website/src/inference/fabric-openai.mjs` | FABRIC067 (me) | created |
| NEW `local-worker/fabric_openai_proxy.py` | FABRIC067 (me) | created |
| Focused tests (both suites) | FABRIC067 (me) | created |
| `website/src/worker.js` route wiring | WEB066 | contract only, NOT edited |
| `local-worker/pairing.py`, serve-jobs runner | existing owners | not edited (verified no change needed) |
| `inference_worker.py` upstream client | existing owner | not edited (reused as-is) |

## 4. Auth boundary (read, not changed)

- User authority is the existing session/inference-key boundary:
  `needAuthz('inference')` (worker.js:793) + session CSRF. Heartbeat keys
  fail it with `KEY_SCOPE`; worker-pull endpoints additionally require a
  resource-bound heartbeat key (`workerScope`, worker.js:819) — sessions and
  inference keys authorize no worker job. The proxy mirrors this split: it
  never imports pairing and 401s without a user key.
- Tenant/owner binding, budgets, deadlines, cancel/retry, idempotency, start
  authority, freshness, no-cross-user-grant bypass: all inherited from the
  admission + coordinator path; the adapter mints nothing.

## 5. Compat and honesty rules implemented

- Bounded model/messages/tokens; roles validated (system/user/assistant/tool),
  rendered with explicit labels — never silently flattened.
- `stream`/`tools`/`tool_choice`/sampling params refused pre-dispatch with
  `unsupported_stream` / `unsupported_tools` / `unsupported_parameter`.
- Unknown/unready/absent worker -> typed errors (`model_not_found`,
  `no_eligible_worker`, `result_rejected`); fabric down -> 503, never a
  direct-runtime fallback. Unknown outcomes -> 503, `automatic_retry: false`,
  `remote_stopped: false`. Tool calling: no auto-execution, separate
  qualification stated in both modules.

## 6. Test evidence (observed this session)

- `node --test tests/fabric-openai067.test.mjs` → **32 pass / 0 fail** (~80 ms).
- `python -m unittest test_fabric_openai_proxy` → **10 pass / OK** (~3.4 s,
  real loopback HTTP against a fixture fabric origin; no model contacted).
- Authored failing-first: the suites caught 2 of my own expectation errors
  plus 1 real mapping gap (withheld-release now returns `release_withheld`).
- Neighboring suites: `dispatch-coordinator` pure tests + `eif-task-contract`
  pass; `inference-routes` and 1 coordinator test fail identically with and
  without this change (`better-auth` not installed — `website/node_modules`
  absent in both lanes); `test_attach_usable` fails identically on the
  untouched base lane (missing built worker package + `dendrite` module).
  All pre-existing environmental, none caused by this additive-only change
  (4 new files + 2 docs; zero edits to existing files outside the 6fe merge).

## 7. Real e2e (planned, NOT executed)

`docs/fabric-openai067-e2e-plan.md`: one bounded request (<=64 tokens,
<=60 s) capturing request/job ID, selected machine/model, output, usage —
gated on controller budget/target reconciliation. No generation ran this turn.

## 8. Production approvals needed (nothing activated)

`INFERENCE_ENABLED` stays off in production; DGM off / cap zero / paused
monitor / #84 hold unchanged. WEB066 applies the idle contract; controller
owns deployment + budget reconciliation + the e2e go-ahead.

## 9. Commit

Files: `website/src/inference/fabric-openai.mjs`,
`local-worker/fabric_openai_proxy.py`,
`website/tests/fabric-openai067.test.mjs`,
`local-worker/test_fabric_openai_proxy.py`,
`docs/fabric-openai067-integration-contract.md`,
`docs/fabric-openai067-e2e-plan.md`, this packet.
