# Private inference-demo harness (TEST ONLY — never shipped)

Loopback-only functional rehearsal for the single-user explicit-resource
dispatch demo. Serves the ACTUAL candidate UI bytes + the ACTUAL worker
fetch handlers (incl. real Better Auth session validation) with an
ephemeral synthetic TEST identity in an isolated temp DB. Default upstream
is offline synthetic with conspicuous labels. This harness proves the
browser button→admission→jobs→poll→result path through the real handlers;
it is NOT GitHub OAuth, production, or deployment qualification.

## Non-goals / boundaries

- No production contact, no prod DB copy, no real cookies/keys, no DDL
  outside the temp DB, no credential/grant/flag changes, no runtime/model/
  process changes, no publication/deploy. Production, PR84, tray, and da1a
  holds stay in force.
- `worker.js`, dispatch store/coordinator, fabric grants, migrations, auth
  production code, and deployment workflows are NOT touched here
  (federation milestone is owned exclusively by `e41156be`).
- Real-mode execution is proposal-gated and author-unexecuted (below).

## Prerequisites (test-runner setup, no installs)

- Node 24 (`node:sqlite`, `node:test`, global `fetch`/`WebSocket`).
- Pinned `better-auth@1.7.14` resolvable under `website/node_modules`
  (the worker imports it). Reuse the existing pinned lane copy WITHOUT
  installing — from an elevated-or-developer-mode PowerShell:
  `New-Item -ItemType Junction -Path website\node_modules -Target
  <existing-pinned-lane>\website\node_modules`
  The harness fails closed with a clear message when unresolvable.
- Chromium headless shell for the browser suite (existing install):
  `...\ms-playwright\chromium_headless_shell-1248\chrome-headless-shell-win64\chrome-headless-shell.exe`,
  driven via the read-only `cdp-preview.mjs` dependency-free CDP driver
  (never edited; HARNESS-prefixed failures).

## Ports (owned, loopback-only)

- HTTP `127.0.0.1:18731` (default `--port`), CDP `127.0.0.1:19333`
  (distinct from the reviewer's 19322). The server binds 127.0.0.1 only,
  rejects any other Host/Origin with 403, and refuses to start on an
  occupied port (never steals; never 8090 — model servers preserved).

## Quick start

- `node website/scripts/private-inference-demo.mjs serve [--port P]
  [--db path | --memory] [--owner-tokens N] [--receipt-dir D]`
  Prints base URL, TEST identity/resource ids, receipt path. Ctrl-C stops
  and writes the receipt (tokens/secrets never recorded).
- Focused suites (explicit; NOT in the repo's broad globs):
  `node --test website/scripts/private-inference-demo.test.mjs`
  `node --test website/scripts/private-inference-demo-realmode.test.mjs`
  `node --test website/scripts/private-inference-demo-browser.test.mjs`

## Honesty design (read before citing any run)

- Identity/transport are synthetic and labelled TEST everywhere (user
  name, resource/key names, receipt, screenshots). Session cookies are
  minted by the test runner via the existing Better Auth test helpers
  (`signSessionCookie` + seeded session rows, same as `d1-shim.mjs` and
  the `4d939aab` proof pattern) and handed to the browser over CDP —
  never through a production route, never GitHub OAuth.
- Fake upstream completes through the REAL result path, so per contract
  it posts `simulated:false` (the store rejects anything else). The
  fixture nature is carried by: content prefix
  `[SYNTHETIC TEST FIXTURE — no model executed]`, `elapsed_ms: 0`,
  `usage: {synthetic:true}` (no fabricated metrics), TEST identity/
  resource names, and the run receipt. Never cite a synthetic settled
  result as model execution.
- One dispatch per run: the fake player completes at most one job then
  stops (`one-dispatch-limit`); idempotency conflicts and uncertain
  outcomes never resubmit (tested).
- A harness-issued request merely read by the UI is NOT a browser
  end-to-end request. The browser suite clicks the real Submit button
  and asserts the full admission→jobs→poll→result UI path at desktop
  (1440) and mobile (390) viewports.

## Real-mode preflight / proposal (APPROVAL-GATED, not executed here)

A future approved run may use ONLY the pinned assets from
`CPU-ASSET-PREFLIGHT-20261104.json` (llama-server path+bytes+SHA256,
SmolLM2 GGUF path+bytes+SHA256; embedded as `PINNED_ASSETS` with
provenance — any asset change needs a code change + review). Bounds:
max 32 output tokens, one single-line prompt (≤500 chars), request
deadline 30 or 60s (UI-expressible within the ≤60s bound), ≤300s
owned-process lifetime, loopback endpoint only, exact argv
`-m <gguf> --port <endpoint-port> --alias <model> --n-gpu-layers 0`
(no other flags exist). The worker half runs the ACTUAL candidate
local-worker CLIs (`pairing.py pair` + `heartbeat-once`, then
`inference_worker.py --once`) against a private temp store — the
worker validates the envelope/binding, runs its real runtime adapter,
and posts its own result; the harness NEVER synthesizes a worker
result in real mode. This task authorizes exactly one BROWSER-ISSUED
dispatch when approved (differs from `CPU-PROOF-RUNTIME-HANDOFF.md`
§PROPOSAL UI-observe-only — both need explicit approval; neither runs
here).

- `propose-real --model … --runtime ganglion|llama-server --endpoint
  http://127.0.0.1:PORT --max-tokens N --deadline-s 30|60 --prompt P
  --max-lifetime-s L --engine-path P --engine-argv-json F --gguf-path G
  --out proposal.json` Strict validation (exact fields, pinned
  path+bytes+hash for both binaries, exact argv, cross-checked
  alias/port/model). Writes `{proposal, sha256}`; executes nothing.
- `run-real --proposal F --confirm-sha256 H [--port P] [--marker M]
  [--assembly-root R]` refuses unless: file intact, operator restates
  its sha256, every field revalidates against pins, tree equals the
  pinned candidate rev AND is clean (`git status --porcelain`: no
  tracked changes, no untracked files under routed source dirs),
  attempt marker absent. Then: marker created
  atomically (`wx`) BEFORE invocation → worker provenance (candidate
  script hashes, interpreter identity, dendrite import-path pinned to
  `local-worker/vendor/eif` — a stale venv Dendrite refuses) → owned
  engine child (pinned argv only) → `/health` + `/v1/models`-lists-
  alias checks (bounded) → harness (real-pairing world: operator only,
  no harness-held worker credential) → REAL pairing CLI against the
  private temp store → ONE browser-issued admission/job via real CDP
  click (paired resource entered explicitly, every field read back;
  browser STAYS ALIVE) → wait for the queued job matching this key
  (the key line precedes completed admission/job creation; unqueued
  aborts with no worker call) → REAL `inference_worker.py --once` → reconcile
  by READING the dispatch rows (never the settle API — the browser's
  own poll must settle and release, or the UI would show withheld) →
  live browser must display the settled content EXACTLY matching the
  worker-posted row + screenshot → worker started-ledger must show
  exactly this job → shred temp worker store → sanitized
  argv/hash/provenance receipt (success AND failure receipts retained).
  Any fault aborts with cleanup; unknown outcomes post NOTHING and
  never retry; a malformed/foreign result is an anomaly, never
  retried. Implemented + tested through injected fake process/HTTP/
  browser seams; AUTHOR-UNEXECUTED against real assets (no engine/
  model/Python/real call made here).
- Operator prerequisite: run from a checkout at the pinned candidate
  rev WITH `local-worker/` present (`--assembly-root` override
  available); the sparse harness worktree alone refuses honestly with
  `candidate file missing`.

## Evidence & rollback

- Per-run receipt `<receipt-dir>/receipt.json` (candidate rev, UI file
  SHAs, ledger; never secrets). Curated evidence + screenshots go to
  `goose-evidence/worker-priority-20261103/` at commit freeze.
  Browser evidence keeps the viewport form shots plus result-visible
  settled captures (`private-demo-desktop-1440-settled.png` at
  1440x1000, `private-demo-mobile-390-settled.png` at 390x844).
- Rollback preserves evidence: stop handles, keep receipts + temp DB
  for review; no auto-delete. No external state is created in fake mode.
