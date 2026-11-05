# Fabric demo operator runbook (DRAFT)

**Status: DRAFT. Not a readiness claim.** Public inference on aipster.net is
not activated and remains unproven. Nothing here authorizes activation,
migration, deployment, flag changes, key creation or any live call. Source
basis: `main` at
[`0e6b608`](https://github.com/synchronic1/AIPSTER/tree/0e6b60890c736207664d122c62e39d8c4affd2fa).
Historical documents cited below are records of past checks, not a live
inventory. Every unfilled evidence item is **PENDING**.

## 0. Current coordinator context (reported, not re-verified here)

- Real installed workers, authenticated control-panel usage, and separate DGM
  Meta-provider work have been reported by the coordinator. DGM stays OFF with
  cap zero and is out of scope for this demo.
- A real local fabric Qwen generation was recorded on candidate `d7eeafa`
  with isolated fixture auth/users/D1 and same-host loopback
  ([plan](https://github.com/synchronic1/AIPSTER/blob/0e6b60890c736207664d122c62e39d8c4affd2fa/docs/fabric-openai067-e2e-plan.md)).
  It does **not** count as the public proof below.
- The earlier #84 hold was assigned an authorized review/fix resolution owned
  elsewhere; this runbook does not treat its historical wording as a current
  blocker and does not track it.

## 1. What counts as the primary proof

One request from an **actual macOS client** to the **authenticated public
AIPSTER OpenAI-compatible route** (`POST /v1/chat/completions` on the public
origin), where the **server** places it on an eligible paired **JJP**
resource running the requested **Qwen** model, returns **real output**, and
is durably correlated across admission → job → lease → runtime request →
result → settlement.

Does **not** count:

- direct calls to the gateway or runtime (`llama-server`, `/v1/*` on the
  worker host), bypassing the public route;
- same-host loopback runs, fixture auth/users/D1, mock workers, or
  `simulated` results;
- footage or screenshots not tied to a receipt below.

## 2. Contract rules the operator follows

**Auth (current supported contract).** The route is behind
`needAuthz('inference')`
([contract](https://github.com/synchronic1/AIPSTER/blob/0e6b60890c736207664d122c62e39d8c4affd2fa/docs/fabric-openai067-integration-contract.md)).
Use one of the two existing caller paths, never mixed:

- (a) the caller's **existing** authorized per-user inference key as
  `Authorization: Bearer`, via `local-worker/fabric_openai_proxy.py`, which forwards only
  that header and `Idempotency-Key` to the fixed origin; or
- (b) a same-origin signed-in browser request (session + CSRF), no proxy.

Do not create, extract or infer credentials. Heartbeat-scoped keys authorize
nothing. Never show a key, cookie or token on screen or in a receipt; record
a redacted fingerprint only.

**Model and placement.** The request names an explicit model id (not
`auto`). The client never names a resource; placement is server-side.
Evidence that JJP was selected comes from the server's records, not from the
request.

**Idempotency.** The operator mints one explicit `Idempotency-Key` per
operation, matching `[A-Za-z0-9][A-Za-z0-9._:-]{7,127}`, and records it
*before* sending. In source
([`fabric-openai-route.mjs`](https://github.com/synchronic1/AIPSTER/blob/0e6b60890c736207664d122c62e39d8c4affd2fa/website/src/inference/fabric-openai-route.mjs)):

| Condition | Behaviour | Demo meaning |
|---|---|---|
| No auth | `401 auth_required` | Expected negative control |
| Auth present, key **missing** | Not rejected; the server mints its own key | Run does **not** count: the operator cannot prove bounded reconciliation for a key it did not hold |
| Key malformed | `400 invalid_request_error` | Fix the key; nothing was admitted |
| Same key, same payload | Read-only reconcile of the recorded operation; no new placement | Expected on reconcile |
| Same key, changed payload | `409 IDEMPOTENCY_CONFLICT` | Stop; do not reuse the key |

**Unknown outcome (timeout, 5xx, in-progress `409` receipt with
`status_route`, `automatic_retry: false`).** Do **not** send a fresh request
and do not mint a new key. Reconcile the *same* operation only via
`GET /v1/operations/<key>`, at most **3** reads spaced at least **15 s**
apart within the request's deadline (an operator bound chosen by this draft,
not a server limit). If still unresolved, stop and record
the operation as UNRESOLVED; that run is not a proof.

**Finish reasons.** Accept any supported value from the allowlist
`stop | length | content_filter`. `FINISH_UNSUPPORTED`, a missing finish
reported as `finish_unavailable`, or any simulated result fails the run. For
the demo, `stop` or `length` with non-empty output is a pass;
`content_filter` is valid but shows no output, so record it and note it.

## 3. Prerequisite checklist (references only; grants nothing)

Each line must point to an existing receipt produced by its owner. This
runbook does not enumerate a migration list and gives no permission to apply
anything.

| # | Prerequisite | Owner | Receipt link / id |
|---|---|---|---|
| P1 | Deployed public build SHA = reviewed candidate; `deployment.json` capture | Release owner | PENDING |
| P2 | Dispatch schema present per the release owner's read-only journal receipt | Release owner | PENDING |
| P3 | Inference activation approval and caps recorded; `INFERENCE_ENABLED` state at demo time | Release owner / project owner | PENDING (currently not activated) |
| P4 | Public route `/v1/chat/completions` and `/v1/operations/<key>` present in the deployed build | Release owner | PENDING |
| P5 | JJP worker consumer running (`serve-jobs`), paired, fresh, eligible; resident upstream lists the model | Host owner (JJP) | PENDING |
| P6 | macOS client build/commit and its existing authorized per-user inference key (fingerprint only) | Client/onboarding owner | PENDING |
| P7 | Authenticated mapping from fabric job/lease to the runtime request id on JJP | Host owner | PENDING |

If any of P1–P7 is PENDING at demo time, run the fallback (section 6).

## 4. Five-minute operator sequence (primary path)

| Time | Step | Capture |
|---|---|---|
| 0:00–0:30 | Show public `deployment.json`; read the SHA aloud | R1 |
| 0:30–1:00 | Signed-in control panel: the paired JJP resource shown as eligible (no secrets on screen) | R2 |
| 1:00–1:20 | Negative control: same request with no auth → `401` | R3 |
| 1:20–2:30 | On the Mac: send one non-stream request with an explicit model and the pre-recorded `Idempotency-Key` | R4, R5 |
| 2:30–3:15 | `GET /v1/operations/<key>`: same completion, no new placement | R6 |
| 3:15–4:15 | Control panel or owner-supplied records: admission → job → lease → runtime request → result → settlement for this key | R7 |
| 4:15–5:00 | Close: state what was shown and what was not (federation is a separate proof; DGM off) | — |

Abort on: credential visible, simulated result, identity or model mismatch,
unsupported finish, or an unknown outcome not resolved within the
reconciliation bound in section 2.

## 5. Receipt template (blank)

```text
Demo run id ............................ PENDING
Operator / date (UTC) .................. PENDING
Acceptance profile ..................... PENDING
R1  Public origin ...................... PENDING
    deployment.json git_commit ......... PENDING
R2  Resource shown (id, owner, state) .. PENDING
R3  No-auth status/code ................ PENDING  (expect 401 auth_required)
R4  macOS version / client commit ...... PENDING
    Caller path (a proxy | b browser) .. PENDING
    Credential fingerprint (redacted) .. PENDING
    Idempotency-Key (recorded pre-send)  PENDING
    Requested model id (explicit) ...... PENDING
    Request time (UTC) ................. PENDING
R5  HTTP status ........................ PENDING
    finish_reason (allowlisted) ........ PENDING
    Output excerpt (non-empty?) ........ PENDING
    usage (prompt/completion/total) .... PENDING
    op_id / job_id ..................... PENDING
R6  Reconcile reads (count, times) ..... PENDING  (max 3)
    Same completion? ................... PENDING
    Fresh retry sent? .................. PENDING  (must be "no")
R7  admission_ref ...................... PENDING
    selected resource_id (= JJP?) ...... PENDING
    lease id / incarnation ............. PENDING
    runtime request id (via mapping) ... PENDING
    mapping source (authenticated) ..... PENDING
    result record ...................... PENDING
    settlement record .................. PENDING
Auth/users/D1 were production (not fixture)? PENDING
Gateway/runtime direct or loopback used?    PENDING  (must be "no")
Prerequisite receipts P1–P7 linked? ........ PENDING
Verdict (PASS / FAIL / UNRESOLVED) ......... PENDING
```

## 6. Fallback demo (honest, labelled)

Use this whenever any prerequisite is PENDING. Every slide or screen is
captioned with its label.

1. **UI (live, current build):** landing page and "What's in this build"
   table; `/app` sign-in and, if an authorized identity is available, the
   signed-in control panel. Label: "Live UI; public inference not activated."
2. **Architecture:** the fabric path diagram and the route and idempotency
   rules from section 2. Label: "Architecture — not a live run."
3. **Historical local receipt:** the `d7eeafa` local generation as a static
   slide. Label: "Historical local receipt: loopback, fixture auth/users/D1;
   not public, not production."
4. **Federation:** the UI as currently deployed. Label it exactly as the
   deployed build labels it.

Never narrate fixtures, mock output, or historical receipts as live.

## 7. Separate proof: cross-owner federation

Kept apart from sections 4–5; it shares no request, key or job with them.
Model:
[`F0-architecture.md`](https://github.com/synchronic1/AIPSTER/blob/0e6b60890c736207664d122c62e39d8c4affd2fa/docs/federation/F0-architecture.md).
Whether separate human people, two executors, or a production-only
environment are required depends on the selected acceptance profile; this
runbook does not mandate them.

| # | Evidence | Value |
|---|---|---|
| X1 | Acceptance profile and environment | PENDING |
| X2 | Exporter principal and recipient principal, independently controlled (distinct identities and credentials) | PENDING |
| X3 | Exported resource id, owned by the exporter | PENDING |
| X4 | Grant id and revision binding exporter → recipient → resource, in an enforced state | PENDING |
| X5 | Recipient request served on the exporter's resource: status, result, op/job ids | PENDING |
| X6 | Negative isolation: a non-granted principal, or a non-granted resource, is refused (status/code) | PENDING |
| X7 | Imported resource not re-exportable by the recipient (status/code) | PENDING |
| X8 | Revoke by the exporter, then the recipient's next request is refused (times, status/code) | PENDING |
| X9 | No cross-owner data in the recipient's view beyond the grant | PENDING |
| X10 | Verdict (PASS / FAIL / UNRESOLVED) | PENDING |

## 8. Out of scope

Hackathon or submission rules and outcomes, DGM activation, billing, and
streaming or tool-call qualification. This draft records no result.
