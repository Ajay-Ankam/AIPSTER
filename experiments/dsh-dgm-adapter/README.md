# DSH × DGM — experimental shadow adapter

A small, self-contained experiment: an **opt-in, shadow-only adapter** that turns a
`dsh-superagent`-shaped work proposal into a sealed evaluation request, runs a
deterministic acceptance gate over authored synthetic fixtures, and returns a
verdict with a repair brief and an archive receipt — while never applying,
promoting, merging, executing or writing anything.

This directory is the whole experiment. It has no dependencies, no build step,
no network calls and no connection to AIPSTER's worker, admin surface, DGM
preview route or to DeepSeek Harness.

## What this is not

- Not production code, and not wired into anything.
- Not a model experiment: no model is called, loaded or compared.
- Not a port of the upstream dsh-superagent code, and not a port of AIPSTER's
  Python DGM harness (`aipster/dgm/*`) — neither is imported, executed or
  copied.
- Not evidence that anything is "improved". It is a **gate comparison** on
  authored fixtures.

## Provenance

| Source | How it is used |
|---|---|
| `github.com/deepseek-ai/dsh-superagent-prototype` @ `6337fc823ce20251c8de8085948165c81aaa701e` | Read only, as untrusted reference. Its documented domain shapes (Ticket, Mandate, report state, accept mode) are mirrored. No code is copied or executed. |
| AIPSTER DGM fixture preview (`aipster.dgm.preview/v1`) | Its gate vocabulary and shadow-only posture informed this adapter's contract. Identifiers here are new and experiment-scoped (`aipster.dsh-dgm.*`); none are reused or redefined. |
| Muse `7a8acb04` operating harness | Its `{problem, change, verification}` proposal shape is accepted by `fromHarnessProposal`, so this adapter can sit behind the same proposal surface. Nothing from that worktree is imported, edited or duplicated. |

Naming note: the assignment said "GDM". No `GDM` module, document or identifier
exists in this repository; the only matching concept is **DGM**, AIPSTER's
bounded proposal/evaluation/selection/archive module. This experiment therefore
assumes GDM = DGM. See the evidence `ARCHITECTURE-FIT.md`.

## Run it

Node 20 or newer. No install step.

```bash
node --test "tests/*.test.mjs"     # 59 deterministic tests
node scripts/measure.mjs           # sweep -> artifacts/measurement.json
node scripts/measure.mjs --json    # print the report
node scripts/serve.mjs             # http://127.0.0.1:8099/?experiment=on
```

The server is loopback-only and refuses port 8090. The demo is off unless it is
explicitly enabled on the page (or via `?experiment=on`), mirroring
`DSH_DGM_EXPERIMENT_ENABLED`.

## Layout

```
index.html                 visible demo shell (AIPSTER palette)
styles.css
src/canonical.mjs          canonical JSON + SHA-256 + sealing (Node and browser)
src/contract.mjs           versioned identifiers, gates, limitations, refusals
src/checks.mjs             deterministic acceptance predicates
src/adapter.mjs            upstream-shaped record -> sealed evaluation request
src/evaluate.mjs           sealed verdict, six gates, receipt, replay
src/selection.mjs          bounded selection + explicit, unexecuted rollback
src/measure.mjs            two-policy sweep and reproducible metrics
src/view.mjs               pure report/verdict -> display model
src/demo.mjs               browser wiring for the demo
fixtures/work-items.mjs    seven authored synthetic work items
scripts/measure.mjs        measurement runner
scripts/serve.mjs          loopback static server
tests/*.test.mjs           deterministic test suite
```

## How a decision is produced

1. `buildRequest(workItem, { subject })` projects the ticket, checks eligibility
   (ended ticket, missing/weak mandate, blocked/failed/not-ready report) and
   seals a request binding the fixture, both artifacts and the criteria by
   SHA-256. A refusal is returned instead of a request when the input cannot
   support an evaluation.
2. `evaluate(workItem, request)` verifies the request seal, recomputes every
   identity, and refuses with `DGM_IDENTITY_MISMATCH` if the artifact changed
   after sealing. It then runs every acceptance predicate on the subject and the
   reference artifact.
3. Six gates decide: `target_bound`, `mandate_valid`, `artifact_well_formed`,
   `criteria_met`, `envelope_fits`, `archive_settled`. Status is one of
   `selected`, `rejected`, `unavailable`, `failed` — each with a code and a
   plain-language detail.
4. A sealed receipt is produced and verified; `archive_settled` reflects that
   verification. The verdict is then sealed (`verdict_sha256`).
5. `select(verdicts)` ranks passing verdicts deterministically, refuses an
   unbounded or tampered set, and attaches a rollback plan naming the revision
   it would restore. `requestRollback` produces a request with `executed: false`.

Every record carries `applied: false`, `authority: "shadow_only"` and the eight
honesty limitations.

## Measurement

Two policies over the same 14 artifacts (seven fixtures × baseline and repaired
candidate):

- **upstream-parse-only** — the status quo: an artifact that parses is admissible.
- **dgm-gate** — every predicate, identity check, envelope and receipt.

Current sweep (regenerate with `node scripts/measure.mjs`):

| Metric | parse-only | DGM gate |
|---|---|---|
| Defect admission | 100.0% | 0.0% |
| False rejection | 0.0% | 0.0% |
| Criteria coverage | 0.0% | 100.0% |
| Work units (total) | 14 | 280 |
| Repair items (total) | 0 | 8 |

The gate's failed-check identifiers match the authored labels exactly on 6/6
defective artifacts, leave 8/8 clean artifacts untouched, and every verdict
replays to the same digest. Latency is reported but **excluded from the report
digest**.

Limitations, stated on every verdict and in the UI: seven authored fixtures,
eight predicates, no model, policy comparison only, a lower work-unit count is
not improvement, and no number here generalises beyond these fixtures.

## Safety posture

- Owned entirely by this directory. No shared module, route, flag, migration,
  permission, worker or admin file is touched.
- No network, storage, filesystem write, clock or randomness in `src/` (a test
  asserts this).
- No live GitHub, webhook, org, account, credential or model access. Fixture text
  is untrusted display data and is rendered as text.
- Secret-shaped material is detected and never echoed; e.g. the token-shaped
  fixture value appears in no verdict.
- `apply`, `promote`, `execute`, `merge` and `open-pull-request` are declared
  disabled and have no code path.

## Deployment

There is no staging or preview environment in this repository, so this demo is
served locally (`scripts/serve.mjs`, 127.0.0.1). It is a static page plus ES
modules; any static host would serve it unchanged. Publishing it is a separate,
reviewed step and is not claimed here.
