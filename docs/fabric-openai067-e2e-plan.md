# FABRIC067 bounded real end-to-end plan — NOT EXECUTED this turn

One real resident-model request through the actual fabric adapter + runner,
to prove chosen machine and correlated job/output. **Do not execute until
the controller reconciles the existing budget/target**; the user authorizes
functional wiring but production holds remain.

## Preconditions (all verified before the request)

1. Controller confirms budget headroom and the target deployment + model.
2. Target deployment has `INFERENCE_ENABLED=1` on a NON-production route
   (staging/preview) with migrations 0024/0025/0029 applied (read-only check).
3. The FABRIC067 worker.js routes from the integration contract are applied
   by WEB066 at idle and deployed to that route only.
4. `serve-jobs` is explicitly operator-started on the chosen worker host with
   its resident upstream listing the target model on `/v1/models`.
5. Local proxy running: `python fabric_openai_proxy.py --fabric-origin
   <staging-origin> --port 8089`. The caller sends its existing per-user
   inference key in the `Authorization` header (heartbeat key never
   qualifies; the proxy holds no ambient credential).

## The single request (<=64 output tokens, <=60 s)

Send a caller idempotency key (the proxy forwards `Idempotency-Key` end to
end; retries reconcile instead of redispatching). A pending outcome is HTTP
409 `operation_in_progress` with `status_route`, never a 202 and never a
completion: reconcile it read-only via that route; never resubmit.

```powershell
$headers = @{ 'Idempotency-Key' = '<client-generated-key>'; 'Authorization' = 'Bearer <existing-user-key>' }
Invoke-WebRequest -Uri 'http://127.0.0.1:8089/v1/chat/completions' -Method POST `
  -ContentType 'application/json' -Headers $headers -TimeoutSec 60 `
  -Body '{"model":"auto","messages":[{"role":"user","content":"Reply with exactly: fabric-ok"}],"max_tokens":64}'
```

## Capture (all five required)

- Request identifier: idempotency key sent (record the value used).
- Job ID: `job_id` from the 202 interim envelope.
- Selected machine/model: `provenance.node_id` / `runtime_id` / `model_id`
  (+ `runtime_instance`, `model_fingerprint`) from the final `chat.completion`.
- Output: `choices[0].message.content`.
- Usage: `usage.{prompt_tokens,completion_tokens,total_tokens}`.

## Rules of the run

- No retry on unknown outcomes: an uncertain/503 response is reconciled
  read-only by idempotency key (`GET /api/jobs/<key>`); never resubmitted.
- Any stream/tool attempt stays out of this run (separate qualification).
- No runtime reload, no new model, no paid provider, no security change.
- Abort and report on: non-`stop` finish, simulated result, identity mismatch,
  withheld release, or any credential appearing in logs/URLs.
