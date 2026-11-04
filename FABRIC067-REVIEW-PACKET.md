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

## 9. Commits (this packet is the durable evidence log)

- `1bb6a47` — initial adapter + proxy + focused tests (evidence: sections 6-7).
- `224d5c5` — R1 HOLD work: caller contract, redirect refusal, bounded logs,
  honest errors, stream:false, single-message honesty, first route handler
  (evidence: section 10, now marked pending per R2 correction above).
- R2 commit (this turn) — see section 11.

## 11. R2 HOLD work (concrete R2 on 224d5c5; status: PENDING independent result)

All three reproduced failures are fixed against the probe's own fixture
setup, plus the readiness contract R2 requires. Prior sections are preserved
verbatim; nothing below rewrites them.

1. Release-authority bypass — `mapSettled` (route module) now honors the
   coordinator's own withheld decision AND rechecks CURRENT authority via
   `store.recheckRelease({op_id, generation})` on every surfacing (initial,
   status, settled replay, conflict-reconcile, post-revocation). Refused or
   unreadable authority withholds with reasons; withheld content never
   escapes. Regression: fixture `recheckRelease` forced to
   `{ok:false, reason:'synthetic_release_refused'}` yields 503
   `release_withheld` on both chat and status paths.
2. Idempotency — the key is looked up BEFORE any placement or admission. A
   recorded key allocates nothing: same payload reconciles read-only to the
   recorded operation (reusing the recorded deadline so retries match the
   digest); changed payload keeps 409 `IDEMPOTENCY_CONFLICT`. Supplied
   malformed keys are 400 (absent keys are server-generated for keyless
   clients); the proxy forwards valid caller `Idempotency-Key` end to end
   and 400s malformed ones. Unknown outcomes reconcile via the documented
   `GET /v1/operations/<key>` status route (exact insertion in the
   contract). Budget expiry answers 409 `operation_in_progress` with
   op/job correlation, `status_route`, and `automatic_retry: false` — no
   202 is ever emitted, so no SDK can parse a receipt as a completion.
3. Readiness contract — NEW `local-worker/model_readiness.py` builds typed
   per-runtime model evidence from the loopback upstream list (no ambient
   authority, no non-loopback, no foreign runtimes); NEW
   `website/src/inference/model-readiness.mjs` strictly validates
   worker-origin evidence (server-stamped freshness, allowlisted runtimes,
   explicit MODEL_NOT_ADVERTISED exclusion, deterministic auto pick, no
   invented capacity or GPU). The route selects ONLY from that evidence:
   `not-advertised` is 404 before issuance with zero admissions. Owner call
   site for `pairing.py` (attach ready-pairs into `runtimes[].models`) is in
   the contract with the intake-compatibility proof (unknown runtime keys
   already persist; zero worker.js change needed for transport). Managed
   runtimes report no models yet — stated gap, not silent mapping.
   Execution runner needs no owned change: `inference_worker.py:861-869`
   already refuses unlisted models pre-completion (precise citation).

Real-store proof — `website/tests/fabric-openai-d1-integration067.test.mjs`
(6 tests, green): REAL disposable D1 store (repo migrations over
node:sqlite) + REAL route with the DEFAULT candidate loader + a fixture
worker that leases and completes clearly labeled synthetic jobs (no model
call, no network). Two owner nodes with different resident models/runtimes
(auto picks freshest, explicit picks evidencing node), stale/unready never
win, unknown model excluded pre-admission, wrong owner dispatches nothing,
and post-settle ownership transfer withholds on the status path via the real
`recheckRelease`.

Test evidence this turn (all observed, synthetic local only): website
adapter 34/34, readiness 13/13, route 19/19, D1 integration 6/6; proxy
16/16, worker helper 6/6. `worker.js`, `pairing.py`, `inference_worker.py`,
native packaging/icons/controllers untouched; no DDL applied, no grants,
keys, credentials, installs, pushes, or production changes.

## 12. R3 focused corrections (on b3344eb; status: PENDING independent result)

Prior sections preserved verbatim. This lane additionally owns the narrow
finish-reason propagation delta in exactly two files (no other lane owns
them): `local-worker/inference_worker.py` (validated finish return +
conditional post + `FINISH_UNSUPPORTED` failure) and
`website/src/inference/dispatch-store.mjs` (`SUCCEEDED_KEYS` + allowlist
validation), plus directly affected tests (`test_inference_worker.py`
mirror/key-sets/finish cases; adapter/route/D1 finish cases). The
`worker-transport.mjs` intake patch is identified above in the contract but
NOT applied (different owner; fail-closed until applied).

1. Expired-deadline binding — the route recomputes the exact request digest
   (`digestJson` over a field-mirrored binding preview) and compares it with
   the recorded operation BEFORE any submit or reconcile. Changed payload
   after expiry keeps 409 `IDEMPOTENCY_CONFLICT` with zero admissions (exact
   R3 probe); same payload reconciles read-only. Regressions added.
2. Proxy status relay — authenticated `GET /v1/operations/<key>` with strict
   key/path checks, same no-redirect/no-secret-log rules; owner scoping and
   typed pending/error bodies (including `op_id`/`automatic_retry`
   correlation) relayed unchanged. Callers reconcile through their advertised
   base URL.
3. Collector removal — `model_readiness.collect_upstream_models` (unused by
   the pairing integration, bearer-taking) is deleted; the helper is now
   network- and credential-free (AST-guarded test). Report shaping kept.
4. Finish honesty — no `finish_reason: 'unknown'` anywhere: validated
   stop/length/content_filter repeat into the OpenAI response; legacy results
   without evidence are 503 `finish_unavailable`; anything else is rejected.
   Bounded fixtures prove the transport through the real store (tool_calls
   refused at `completeJob`, `length` accepted and surfaced). Legacy worker
   results stay store-acceptable (backwards compatible).
5. Subset explicitness — the route is a restricted single-user-message,
   non-streaming text-completion subset, NOT qualified coding-agent,
   tool-calling, or multiturn support (stated in the adapter header, the
   contract, and here). Owner-only auto placement preserved; no
   direct-runtime substitution. The six HTTP probe completions remain labeled
   synthetic-worker completions, not real generation.

## 13. R3 follow-up: intake allowlist + type guard (status: PENDING independent result)

Sole owner of `website/src/inference/worker-transport.mjs` for the
finish_reason allowlist ONLY, plus corresponding tests. The intake validator
now matches store/runner exactly (optional stop/length/content_filter;
legacy accepted; all else refused), proven by
`website/tests/worker-result-finish067.test.mjs` (8/8) against the real
exported validator — worker.js cannot load in this lane, so this is the real
intake boundary and the route wiring stays unchanged owner code. Robustness
correction in the same delta: `GanglionClient.complete` type-guards the
untrusted finish value, so a dict/list becomes typed `FINISH_UNSUPPORTED`
instead of a `TypeError` (regression added; targeted worker finish tests
green). No other files touched; prior sections preserved verbatim.

Files owned this turn: `website/src/inference/fabric-openai.mjs`,
`website/src/inference/model-readiness.mjs`,
`website/src/inference/fabric-openai-route.mjs`,
`local-worker/fabric_openai_proxy.py`,
`local-worker/model_readiness.py`,
`website/tests/fabric-openai067.test.mjs`,
`website/tests/model-readiness067.test.mjs`,
`website/tests/fabric-openai-route067.test.mjs`,
`website/tests/fabric-openai-d1-integration067.test.mjs`,
`local-worker/test_fabric_openai_proxy.py`,
`local-worker/test_model_readiness.py`,
`docs/fabric-openai067-integration-contract.md`,
`docs/fabric-openai067-e2e-plan.md`, this packet.

## 10. R1 HOLD work (independent review, head 1bb6a47 preserved) — intermediately superseded

CORRECTION (R2): this section's "resolved" claims are corrected to PENDING
independent result. The proxy corrections below were accepted as meaningful;
three handler failures remained and are fixed in section 11. The suite output
in sections 6-7 is preserved verbatim as the evidence for candidate
`1bb6a47` and was not rewritten.

All six reproduced defects are fixed and regression-tested; the suite output
above (sections 6-7) is retained as the evidence for candidate `1bb6a47` and
was not rewritten.

1. Caller contract: every proxy request now requires caller-supplied
   `Authorization` (forwarded verbatim; ambient env authority removed),
   exact loopback Host with serving port (robust authority parse), absent-or-
   self `Origin` (foreign origins 403), and `Content-Type: application/json`
   on POST (415). Unauthenticated callers get 401 with zero forwarding.
2. Redirects are never followed (refusing handler + no-proxy opener); a 3xx
   becomes 502 and the fixture sink proves no credential leaves the origin.
3. Logs are `status=N route=R corr=N` lines only: `log_request` emits
   nothing; no request line, URL, header, body, or exception text.
4. Upstream typed errors keep their status (bounded); transport failure —
   including a hung upstream after the POST — is 503 `fabric_uncertain`
   with `automatic_retry: false` and no undispatched claim; responses are
   1 MiB-bounded.
5. `stream: false` is accepted in both validators; `stream: true` and tools
   fail pre-dispatch.
6. Adapter honesty: the initial route accepts exactly one user text message
   (`limited_compatibility` otherwise — no XML role wrapping, no
   coding-agent/tool claims); usage is null when unmeasured; finish_reason is
   'unknown' (the EIF result carries no stop/length evidence).

Real integration is finished in the owned handler module
`website/src/inference/fabric-openai-route.mjs` (15 tests, green): fresh
owner-scoped candidates, server-side `selectPlacement` (route clock passed
explicitly), real `issueAdmission`, real coordinator submit, bounded
reconcile that never polls at/past the deadline, idempotent replay via
read-only reconcile, settled surfacing only from the re-verified durable job
row, and a 202 fabric receipt — never a chat completion — on budget expiry.
The worker.js insertion is now one import plus one gated block calling the
imported handler with the worker's own `needAuthz`/actor (exact text in the
integration contract). Runner prerequisite: explicit operator-started
`serve-jobs` on the chosen host; no code change needed there.
