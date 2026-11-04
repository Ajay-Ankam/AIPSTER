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
  model evidence shaping; network- and credential-free). Stdlib only.
- Tests: `website/tests/fabric-openai067.test.mjs` (36),
  `website/tests/model-readiness067.test.mjs` (13),
  `website/tests/fabric-openai-route067.test.mjs` (21),
  `website/tests/fabric-openai-d1-integration067.test.mjs` (7, REAL
  disposable D1 store + real route + real loader + labeled synthetic worker),
  `local-worker/test_fabric_openai_proxy.py` (17),
  `local-worker/test_model_readiness.py` (4),
  `local-worker/test_inference_worker.py` finish delta (3 new + mirror) — all green.
- Narrow owned deltas (R3): `local-worker/inference_worker.py` +
  `website/src/inference/dispatch-store.mjs` (finish-reason propagation
  only; see runner section). `worker.js`, `pairing.py` NOT touched.
- R3 follow-up, sole owner: `website/src/inference/worker-transport.mjs`
  finish_reason allowlist ONLY (the exact intake patch below); `worker.js`
  route wiring unchanged.

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

## Execution runner: narrow owned delta + one identified follow-up

This lane owns the narrow finish-reason delta in
`local-worker/inference_worker.py` (applied: `complete()` returns validated
upstream `finish_reason` from `FINISH_REASONS = {stop, length,
content_filter}`; anything else fails the job with `FINISH_UNSUPPORTED`;
`_handle` posts the key only when evidenced) and in
`website/src/inference/dispatch-store.mjs` (applied: `SUCCEEDED_KEYS` gains
`finish_reason` with the same allowlist; legacy results without the key stay
acceptable at the store layer). Model gating needed no change:
`inference_worker.py:861-869` already refuses unlisted models
(`MODEL_UNAVAILABLE`) pre-completion.

Follow-up APPLIED (sole owner for this patch): the HTTP intake validator
`website/src/inference/worker-transport.mjs::validSucceededResult` now
permits optional stop/length/content_filter and refuses anything else,
exactly matching the store normalizer and runner. HTTP-posted finish
evidence therefore travels intake → store → OpenAI response with no gap;
legacy results without the key stay acceptable everywhere and surface as
`finish_unavailable` (never an invented stop). Proven by
`website/tests/worker-result-finish067.test.mjs` against the real exported
validator (worker.js itself cannot load in this lane — better-auth absent —
so this is the real intake boundary; the route wiring is unchanged owner
code). The python mirror in `test_inference_worker.py` was updated as a
directly affected test.

## Authority and guardrails the insertion keeps

- `needAuthz('inference')` + session CSRF inside the handler, exactly like the
  admissions route. Heartbeat-scoped keys authorize nothing (existing check).
- Tenant/owner binding (SQL `WHERE r.owner_id = ?` on the verified actor id),
  budgets, deadlines, cancel/retry, idempotency, start authority, resource
  freshness, no-cross-user-grant bypass: inherited from admission +
  coordinator. Grant-shared models (CLAUDE135 G3): a recipient also sees
  models of a resource named by a LIVE `fg_` fabric share with explicit
  `route: 'internal'` consent, while BOTH `FEDERATION_ENABLED` and
  `INFERENCE_ENABLED` are '1'. Shared rows are qualified against the grant's
  recorded exporter (tenant check kept), restricted to the grant's models
  (exact id match with worker evidence), listed by model id only, selected
  only when no owned candidate serves, and admitted with the grant named.
  Authority is re-derived at issuance, submit, lease and release. App grants
  (`g_*`) are not bridged here.
- Release is rechecked from current authority on every surfacing; revoked or
  refused releases withhold with reasons, never leak.
- Flag-off pause (F1): switching `FEDERATION_ENABLED` off refuses new share
  starts and withholds in-flight releases, but queued share jobs stay
  `queued` — they are never expired solely because the flag is off. After
  the flag is restored a paused job leases only if its grant is still
  authorized and its deadline still ahead; a revoke or expiry that lands
  while paused settles it terminal `expired` (`authority_lost`) with the
  reservation charged, so stale authority never revives.
- Pre-existing shares (F5): every `fabric_grants` row committed before the
  explicit-route fix carries `route = 'fixture'` and cannot admit or
  execute. Such shares need a new grant with explicit `route: 'internal'`
  consent; there is no migration that flips old rows to live execution.
- Tracked, not in this lane (F2/F3): per-request ceiling misses stop at the
  first shared tuple without trying the next share, and discovery may list
  a share that issuance then refuses on demo parity or spend headroom.
  Both fail closed; no extra share is admitted.
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
