# FABRIC067 integration contract — for WEB066 (worker.js) + controller at idle

Status: **NOT APPLIED**. This file is the exact minimal insertion the
worker.js owner applies at idle. This author turn did not edit
`website/src/worker.js`, `local-worker/pairing.py`, native packaging, icons,
or controllers.

## What this lane ships (new files only, all owned by FABRIC067)

- `website/src/inference/fabric-openai.mjs` — pure adapter (bounded
  single-user-message validation, model resolution, coordinator-body builder,
  models-list builder, outcome mapper). No I/O, no authority.
- `website/src/inference/fabric-openai-route.mjs` — REAL handler:
  `createFabricOpenAIRoute({ needAuthz, actor, db, env })` using the existing
  scoped inventory SQL, `selectPlacement`, `store.issueAdmission`, the real
  dispatch coordinator + worker transport, and bounded reconcile. Tested
  against deterministic fixture stores (15 route tests, green).
- `local-worker/fabric_openai_proxy.py` — loopback proxy to ONE configured
  trusted fabric origin with the deliberate caller contract (loopback Host +
  serving port, caller Authorization, no ambient credential, no redirects,
  bounded logs, honest errors). Never touches 8090/8124/8471, never falls back.
- Tests: `website/tests/fabric-openai067.test.mjs` (34),
  `website/tests/fabric-openai-route067.test.mjs` (15),
  `local-worker/test_fabric_openai_proxy.py` (15) — all green.

## Exact minimal insertion for the worker.js owner (idle apply)

1. One import next to the existing inference imports (~line 26):

```js
import { createFabricOpenAIRoute } from './inference/fabric-openai-route.mjs';
```

2. One block between the admissions block and the jobs block (~line 3053),
gated by `inferenceEnabled(env)` so production (flag off) keeps its exact
501/404 behavior. `needAuthz`, `actor`, `db`, `env`, `readJson`, `json` are
the surrounding closure's own bindings — no new authority is introduced:

```js
// ---- fabric OpenAI entrypoint (FABRIC067; flag-gated, default off) ----
if (inferenceEnabled(env) && ((path === '/v1/models' && method === 'GET')
  || (path === '/v1/chat/completions' && method === 'POST'))) {
  if (actor.kind === 'session') { const c = needCsrf(); if (c) return deny(c); }
  const route = createFabricOpenAIRoute({ needAuthz, actor, db, env });
  let out;
  if (path === '/v1/models') {
    out = await route.handleModels();
  } else {
    const chatBody = await readJson(request, 262144);
    out = await route.handleChat({ body: chatBody, idempotencyKey: request.headers.get('Idempotency-Key') });
  }
  if (out && out.passthrough) return out.passthrough;
  return json(out.http, out.body);
}
```

Optional status-by-key route (same gate; reconciles read-only, never
redispatches) is a follow-up the owner may add identically via
`route.handleStatus({ idempotencyKey })`; the proxy's wait budget already
returns a keyed 202 receipt without it.

## Authority and guardrails the insertion keeps

- `needAuthz('inference')` + session CSRF inside the handler, exactly like the
  admissions route. Heartbeat-scoped keys authorize nothing (existing check).
- Tenant/owner binding (SQL `WHERE owner_id = ?` on the verified actor id),
  budgets, deadlines, cancel/retry, idempotency, start authority, resource
  freshness, no-cross-user-grant bypass: all inherited from the admission +
  coordinator path. Grant-shared resources are honestly 409 (selector
  excludes non-owned provenance) until a follow-up wires them.
- No new keys minted/rotated/stored; no key values logged/returned.
- No new DDL: reuse migrations 0024/0025/0029. The owner verifies they are
  applied on the target deployment (read-only check).
- No activation now: `INFERENCE_ENABLED` stays unset in production; the
  controller reconciles budget/target before any real request (see e2e plan).

## Job-runner integration prerequisite (verified, no change needed)

`local-worker/inference_worker.py serve-jobs` already leases, validates the
bound CPU envelope, runs once on the local upstream, and posts the EIF
result. The OpenAI path reuses that exact envelope and settlement. Runner
prerequisite for the bounded e2e run: `serve-jobs` explicitly
operator-started on the chosen worker host with the target model listed on
its upstream `/v1/models`; no runtime reload, no new model, no paid provider.
