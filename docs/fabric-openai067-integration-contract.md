# FABRIC067 integration contract — for WEB066 (worker.js) + controller at idle

Status: **NOT APPLIED**. This file is the small integration patch/contract the
worker.js owner applies at idle. This author turn did not edit
`website/src/worker.js`, `local-worker/pairing.py`, native packaging, icons,
or controllers.

## What this lane ships (new files only, all owned by FABRIC067)

- `website/src/inference/fabric-openai.mjs` — pure adapter: OpenAI request
  validation, model resolution, coordinator-body builder, models-list builder,
  dispatch-outcome mapper. No I/O, no authority.
- `local-worker/fabric_openai_proxy.py` — loopback proxy to ONE configured
  trusted fabric origin. Never touches 8090/8124/8471, never falls back.
- `website/tests/fabric-openai067.test.mjs` — 32 tests, green.
- `local-worker/test_fabric_openai_proxy.py` — 10 tests, green.

## Exact insertion for the worker.js owner (idle apply)

1. Add imports next to the existing inference imports (~line 26):

```js
import { validateChatCompletionRequest, resolveModel, buildDispatchRequest,
  buildModelsList, noEligibleWorker, mapDispatchResult, mapSettledJobToCompletion } from './inference/fabric-openai.mjs';
import { selectPlacement } from './inference/placement-binding.mjs';
```

2. Insert the two routes between the admissions block and the jobs block
(~line 3053), both gated by `inferenceEnabled(env)` so production (flag off)
keeps its exact 501/404 behavior:

```js
// ---- fabric OpenAI entrypoint (FABRIC067; flag-gated, default off) ----
if (inferenceEnabled(env) && path === '/v1/models' && method === 'GET') {
  const d = needAuthz('inference'); if (d) return deny(d);
  const store = await getDispatchStore(env, db);
  if (!store) return json(503, { error: { message: 'Inference dispatch is not available on this deployment.', type: 'server_error', code: 'dispatch_unavailable' } });
  // Fresh authorized inventory: owner rows plus live-grant rows, online by
  // resourceLiveness, mapped to { model_id, usable, liveness }.
  const entries = await listAuthorizedModelEntries(db, me()); // owner implements
  return json(200, buildModelsList(entries));
}
if (inferenceEnabled(env) && path === '/v1/chat/completions' && method === 'POST') {
  const d = needAuthz('inference'); if (d) return deny(d);
  if (actor.kind === 'session') { const c = needCsrf(); if (c) return deny(c); }
  const body = await readJson(request, 262144);
  const checked = validateChatCompletionRequest(body);
  if (!checked.ok) return json(checked.error.http, checked.error.body);
  const store = await getDispatchStore(env, db);
  if (!store) return json(503, { error: { message: 'Inference dispatch is not available.', type: 'server_error', code: 'dispatch_unavailable' } });
  // 1. Candidates from fresh authorized inventory (owner-owned or live
  //    grant, online). 2. selectPlacement with model constraint (null for
  //    auto). 3. store.issueAdmission for the selected resource. 4. submit
  //    via dispatchCoordinator(store) with the X-Idempotency-Key header (or a
  //    server-generated key), deadline_at = min(now+60s, admission expiry).
  // 5. Bounded reconcile poll (2s, <=60s): settled/failed/expired/rejected
  //    map via mapDispatchResult; uncertain returns 503 immediately, never
  //    auto-retried. 6. Settled success: re-read the job row
  //    (store.readJob), rebuild binding identity from the ADMISSION record,
  //    and surface only through mapSettledJobToCompletion.
}
```

## Authority and guardrails the route must keep

- `needAuthz('inference')` + session CSRF, exactly like the admissions route.
  Heartbeat-scoped keys authorize nothing here (existing `needAuthz` already
  refuses them with `KEY_SCOPE`).
- Tenant/owner binding, budgets, deadlines, cancel/retry, idempotency, start
  authority, resource freshness, and no-cross-user-grant bypass all stay in
  the existing admission + coordinator path. The adapter adds no authority.
- No new keys minted/rotated/stored; no key values logged/returned.
- No new DDL: reuse migrations 0024/0025/0029 (dispatch store). The owner
  verifies they are applied on the target deployment (read-only check).
- No activation now: `INFERENCE_ENABLED` stays unset in production; the
  controller reconciles budget/target before any real request (see e2e plan).

## Job-runner integration (verified: no change needed)

`local-worker/inference_worker.py serve-jobs` already leases, validates the
bound CPU envelope, runs once on the local upstream, and posts the EIF result.
The OpenAI path reuses that exact envelope and settlement — no runner edit.
