# FABRIC067 integration contract — for WEB066 (worker.js / pairing.py) + controller at idle

Status: **NOT APPLIED**. Exact minimal call sites the owners apply at idle.
This author turn did not edit `website/src/worker.js`,
`local-worker/pairing.py`, `local-worker/inference_worker.py`, native
packaging, icons, or controllers.

## What this lane ships (new files only, all owned by FABRIC067)

- `website/src/inference/fabric-openai.mjs` — pure adapter (bounded
  single-user-message validation, model resolution, coordinator-body builder,
  models-list builder, outcome mapper). No I/O, no authority.
- `website/src/inference/model-readiness.mjs` — strict server-side readiness
  validation + selection over worker-origin evidence. No I/O.
- `website/src/inference/fabric-openai-route.mjs` — REAL handler:
  `createFabricOpenAIRoute({ needAuthz, actor, db, env })`: op-first
  idempotency, readiness selection, real issuance, real coordinator submit,
  bounded reconcile, release recheck on every surfacing, 409 pending receipts.
- `local-worker/fabric_openai_proxy.py` — loopback proxy (caller contract,
  no ambient credential, no redirects, bounded logs, honest errors, caller
  `Idempotency-Key` forwarded end to end).
- `local-worker/model_readiness.py` — worker report helper (typed per-runtime
  model evidence from the loopback upstream list). Stdlib only.
- Tests: `website/tests/fabric-openai067.test.mjs` (34),
  `website/tests/model-readiness067.test.mjs` (13),
  `website/tests/fabric-openai-route067.test.mjs` (19),
  `website/tests/fabric-openai-d1-integration067.test.mjs` (6, REAL
  disposable D1 store + real route + real loader + labeled synthetic worker),
  `local-worker/test_fabric_openai_proxy.py` (16),
  `local-worker/test_model_readiness.py` (6) — all green.

## Call site 1: pairing.py — attach worker-origin model IDs (WEB066 applies)

In `local-worker/pairing.py::_reportable_runtimes`, the attach branch
already probes ready `(runtime_id, model_id)` pairs via `attach_readiness`.
Attach those IDs to the reported runtime entry with the new helper (same-dir
import, stdlib only, fail-closed to model-less reporting):

```python
    attached = None  # probed lazily, at most once per report
    ready_pairs = set()
    for runtime in getattr(config, "runtimes", []) or []:
        name = CAPABILITY_RUNTIME_NAMES.get(getattr(runtime, "kind", ""))
        if name is None:
            continue
        mode = getattr(runtime, "mode", "")
        if mode == "attach":
            if data_dir is None and not _worker_token(config, None):
                continue
            if attached is None:
                ready_pairs = attach_readiness(config, data_dir)[0]
                attached = {rid for rid, _ in ready_pairs}
            if runtime.id in attached and all(r["name"] != name for r in found):
                entry = {"name": name, "formats": list(CAPABILITY_FORMATS)}
                try:
                    from model_readiness import runtime_models_entry
                    entry.update(runtime_models_entry(
                        name, sorted({m for r, m in ready_pairs if r == runtime.id})[:32]))
                except Exception:
                    pass
                found.append(entry)
            continue
```

Notes the owner must keep: managed runtimes report no `models` until a
managed report path exists (they stay unselectable — honest gap, not silent
mapping); `runtime_models_entry` returns `{}` for foreign names; the helper
never mints keys or contacts non-loopback hosts. Server intake needs NO
change: `validateCapabilityBody` (worker.js) ignores unknown runtime keys,
so `models` persists verbatim inside `runtimes_json`.

## Call site 2: worker.js — no change needed for transport or intake

- Capability intake already stores `runtimes_json` verbatim; nothing to edit.
- Insert the entrypoint only (one import + one gated block; `needAuthz`,
  `actor`, `db`, `env`, `readJson`, `json`, `needCsrf`, `deny` are the
  surrounding closure's own bindings — no new authority):

```js
import { createFabricOpenAIRoute } from './inference/fabric-openai-route.mjs';

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
// Reachable status route for unknown/pending outcomes (same gate):
// GET /v1/operations/<key> where key matches [A-Za-z0-9][A-Za-z0-9._:-]{7,127}
if (inferenceEnabled(env) && method === 'GET') {
  const m = /^\/v1\/operations\/([A-Za-z0-9][A-Za-z0-9._:-]{7,127})$/.exec(path);
  if (m) {
    if (actor.kind === 'session') { const c = needCsrf(); if (c) return deny(c); }
    const out = await createFabricOpenAIRoute({ needAuthz, actor, db, env })
      .handleStatus({ idempotencyKey: m[1] });
    if (out && out.passthrough) return out.passthrough;
    return json(out.http, out.body);
  }
}
```

## Execution runner: no owned change needed (precise citation)

`local-worker/inference_worker.py:861-869` already refuses a model the
upstream does not list (`MODEL_UNAVAILABLE`) before any completion call, and
`models()` (same file) proxies the upstream `/v1/models` with loopback
guards. The advertisement gate (never admit/place unreported models) is the
new server `model-readiness.mjs` layer; the execution gate already exists.

## Authority and guardrails the insertion keeps

- `needAuthz('inference')` + session CSRF inside the handler, exactly like the
  admissions route. Heartbeat-scoped keys authorize nothing (existing check).
- Tenant/owner binding (SQL `WHERE r.owner_id = ?` on the verified actor id),
  budgets, deadlines, cancel/retry, idempotency, start authority, resource
  freshness, no-cross-user-grant bypass: inherited from admission +
  coordinator. Grant-shared models are honestly 409 until a follow-up wires
  grant-shared evidence.
- Release is rechecked from current authority on every surfacing; revoked or
  refused releases withhold with reasons, never leak.
- No new keys minted/rotated/stored; no key values logged/returned.
- No new DDL: reuse migrations 0022/0024/0025/0029 (node_capabilities +
  dispatch store). The owner verifies they are applied (read-only check).
- No activation now: `INFERENCE_ENABLED` stays unset in production; the
  controller reconciles budget/target before any real request (see e2e plan).

## Runner/lifecycle prerequisite for the bounded e2e run

`serve-jobs` explicitly operator-started on the chosen worker host with the
target model listed on its upstream `/v1/models`; no runtime reload, no new
model, no paid provider. Model-readiness evidence flows only after call site
1 is applied and at least one capability report lands (freshness window
600 s); until then the route honestly reports no eligible workers.
