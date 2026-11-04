# FABRIC067 bounded real end-to-end plan — remote proof NOT EXECUTED

## What is already proven (do not re-prove)

At 07:02:13–07:02:22 UTC 2026-11-04, hostowner3a ran ONE real resident-model
generation through the local fabric on candidate `d7eeafa`
(`lanes/muse-fabric-site068-20261104`; see
`goose-evidence/worker-priority-20261103/FABRIC068-REAL-RESULT-VERIFIED.md`):
OpenAI-compatible POST through the actual `worker.fetch` handler on
loopback, explicit client-specified model, fabric-selected sole fresh
eligible paired resource (`r_85eff0d5` on JJP), idempotency key
`localproof068-4e55634b6f738c7f`, job `job_ee5f76f066255d8a5ebeb44020404182`,
exact `inference_worker.py --once` on resident `llama-server` loopback8124
(`qwen3.8-27b-atx-iq4_xs`), HTTP200 `\n\nok`, finish `stop`, usage 5/3/8,
independent status GET returning the same completion. Fixture
identity/isolated store is explicitly retained in that claim: authentication,
users and D1 were isolated fixtures. No retry, no second generation needed.

## What remains unexecuted

The authenticated Mac-to-aipster.net proof: the same contract against
`https://aipster.net` production. It has NOT run. Nothing below authorizes
it; the controller coordinates adoption and activation.

## Preconditions (all verified before any request)

1. Controller confirms budget headroom, the exact target, and the authorized
   model identifier (the d7 proof used an explicit client-specified model;
   keep that shape — do not switch to `auto` for the first remote proof).
2. Requested target is `https://aipster.net` production, currently HELD
   pending release/#84 plus scoped schema/activation/auth (see Rules below).
   An isolated cloud target is OPTIONAL and only if explicitly selected and
   verified — it is not an available or preconfigured default, and this plan
   does not mandate a staging route. Fact: `website/wrangler.jsonc` sets
   `"preview_urls": false`, so no preview deployment currently exists to
   assume.
3. Exact dispatch schema 0022/0024/0025/0029 confirmed present by journal
   inspection (read-only). Do NOT blindly apply all pending migrations, do
   NOT apply 0030 or DGM migrations for this minimal route, and do NOT
   create keys: the caller presents its existing per-user inference key
   (heartbeat key never qualifies; the proxy holds no ambient credential).
   The original `docs/release/inference-release-runbook.md` is a historical
   guide for the 0024 stage only, not the current full rollout command.
4. The FABRIC067 worker.js routes from the integration contract are applied
   by WEB066 at idle and deployed to that target only (WEB225 retains the
   integration branch; this lane does not hand off shared files).
5. `serve-jobs` is explicitly operator-started on the chosen worker host
   (hostowner3a owns any runner launch; do not duplicate it) with its
   resident upstream listing the target model on `/v1/models`.
6. Local proxy running: `python fabric_openai_proxy.py --fabric-origin
   https://aipster.net --port 8089` (after the held activation clears; an
   explicitly selected verified isolated origin may substitute). Two
   separate caller paths, never mixed: (a) the native proxy path, where
   the caller presents its existing authorized per-user inference key as
   `Authorization: Bearer` and the proxy forwards ONLY that Bearer header
   (plus `Idempotency-Key`) verbatim to the fixed origin — no browser
   cookies pass via the proxy and no CSRF is involved; (b) a direct
   same-origin signed-in browser request to the deployed route, which uses
   session+CSRF and no proxy. No cookie/token extraction is performed and
   no new credentials are created or inferred (heartbeat key never
   qualifies; the proxy holds no ambient credential).

## The single request (<=32 output tokens, <=60 s)

Matching the frozen 804 behavior and the d7 shape: explicit model, caller
idempotency key (the proxy forwards `Idempotency-Key` end to end; retries
reconcile instead of redispatching). A pending outcome is HTTP 409
`operation_in_progress` with `op_id`/`job_id` correlation and
`status_route` — never a 202 envelope and never a completion: reconcile it
read-only via `GET /v1/operations/<key>`; never resubmit.

```powershell
$headers = @{ 'Idempotency-Key' = '<client-generated-key>'; 'Authorization' = 'Bearer <existing-user-key>' }
Invoke-WebRequest -Uri 'http://127.0.0.1:8089/v1/chat/completions' -Method POST `
  -ContentType 'application/json' -Headers $headers -TimeoutSec 60 `
  -Body '{"model":"<authorized-model-id>","messages":[{"role":"user","content":"Reply with exactly: fabric-ok"}],"max_tokens":32}'
```

## Capture (all six required)

- Request identifier: idempotency key sent (record the value used).
- Pending correlation (if any): `op_id` / `job_id` from the 409
  `operation_in_progress` receipt (there is no 202 interim envelope in this
  contract), then the reconciled outcome from `GET /v1/operations/<key>`.
- Selected machine/model: `provenance.node_id` / `runtime_id` / `model_id`
  (+ `runtime_instance`, `model_fingerprint`) from the final `chat.completion`.
- Output: `choices[0].message.content`.
- Usage: `usage.{prompt_tokens,completion_tokens,total_tokens}` (upstream-
  reported; null when unmeasured, never zero-filled).
- Finish: `choices[0].finish_reason` (must be evidenced `stop`; anything
  else aborts the claim).

## Rules of the run

- No retry on unknown outcomes: an uncertain/503 response is reconciled
  read-only by idempotency key (`GET /v1/operations/<key>`); never resubmitted.
- Any stream/tool attempt stays out of this run (separate qualification).
- No runtime reload, no new model, no paid provider, no security change.
- Abort and report on: non-`stop` finish, simulated result, identity mismatch,
  withheld release, or any credential appearing in logs/URLs.
- Production/#84 hold stays in force; this plan clears nothing and fabricates
  no maintainer acceptance.
- Local evidence path note: the prior loopback verification runs used
  controller-local scratch harnesses only; they are not part of the public
  checkout and nothing in this plan ships them.
