# Release HOLD + review-evidence policy (code, not settings)

Owner: safeguards lane. Pure policy module `release-hold.mjs` + focused
suite `tests/release-hold.test.mjs` (auto-run by the existing `npm test`
glob; no workflow change). This code enforces nothing in the GitHub UI by
itself — enforcement needs the proposed settings below, which are NOT
applied here. Production stays held until Peter resolves PR84.

## Semantics

- Exact head: every verdict names one full 40-hex SHA. New head ⇒ old
  evidence is stale ⇒ re-review. Missing/ambiguous metadata fails closed.
- Blocking findings must be fixed and re-reviewed at the exact new head.
  Tracked notes need explicit disposition + evidence (accepted residuals
  stay visible, never silent).
- AI-review evidence states model, reviewer id, a SEPARATE author, exact
  SHA, report, and a unanimous test run. Quota/error outcomes never count;
  AI evidence can never assert native GitHub human approval.
- Release additionally requires explicit maintainer acceptance of that
  exact-head evidence (both auto and manual paths — no manual bypass).
  One maintainer suffices; no second-human lockout is added.
- HOLD is cumulative over ancestry: a hold on H covers H and descendants,
  so a later unrelated main commit cannot bypass it. Unknown ancestry ⇒
  covered. Only a listed maintainer with a reason can clear; anything else
  is refused and the hold stands.
- Irreversible step rechecks authoritative data (main SHA, ancestry,
  checks) first; the residual race (main moves between evaluation and
  deploy) is documented in every receipt — the deploy step re-verifies
  the SHA itself, as the workflow already does with rev-parse.

## Evidence registry format (proposed convention, committed file)

`website/release-evidence.json` (to be created by the maintainer, not
here): `{ "<sha>": { reviewers: [{model, reviewerId, report, tests:
{passed, total}, status, findings: [{id, severity, disposition:
{decision, evidence, by}}]}], maintainerAcceptance: {by, sha, at},
hold: {active, reason, setBy} } }`. Absent entry ⇒ fail closed.

## Proposed settings payloads (for controller approval — NOT applied)

1. Branch ruleset for `main` (replace `RULESET_ID` after creation):
   `{ "name": "aipster-release-gate", "target": "branch", "conditions":
   {"ref_name": {"include": ["refs/heads/main"]}}, "rules": [
   {"type": "required_status_checks", "parameters": {"required_status_checks":
   [{"context": "release-gate", "integration_id": null}],
   "strict_required_status_checks_policy": true}},
   {"type": "pull_request", "parameters": {"required_approving_review_count": 0,
   "dismiss_stale_pull_request_approvals_on_push": true}} ] }`.
   Limitation: `release-gate` check does not exist yet; a follow-up
   workflow must compute `deploymentDecision` on trusted base code and
   report it. Until then, UI merges are NOT enforced by local code.
2. Environment `production`: required reviewers `["synchronic1"]`,
   no auto-merge. Already exists per workflow (`environment: production`);
   confirm single-maintainer reviewer, do not add a second human.
3. Hold storage: the registry file above (auditable, survives merges).
   Alternative (rejected for now): a repo variable — writable via API by
   anyone with the token, no history. File keeps hold changes reviewable.
4. Security-sensitive note: any privileged gate workflow must use
   `persist-credentials: false`, read-only `GITHUB_TOKEN`, pinned action
   SHAs, no `pull_request_target` checkout of fork code, no
   issue-comment commands. Current deploy workflow already follows this
   for its gate steps; the future `release-gate` workflow must copy it.

## Fork safety (inspected, current code)

- Auto path: event gate rejects non-push, non-main, fork repos, and
  unknown suites BEFORE checkout; preflight re-verifies SHA, main
  equality, canonical repo, merged-PR-to-main, and applicable checks.
- Manual path: `reviewed_sha` is maintainer-supplied; checkout uses
  `persist-credentials: false`, and `npm ci/test/build` run with no
  secret envs (Cloudflare token only in the deploy step env). Residual:
  a malicious SHA would execute its scripts pre-validation without
  secrets — acceptable only because dispatch itself is the maintainer's
  explicit act; the proposed `release-gate` check closes this by
  validating evidence BEFORE any checkout runs untrusted code.
- `GITHUB_TOKEN` stays read-only (`contents: read, checks: read,
  pull-requests: read`); no PAT/App/secret added here.

## Preserved behavior

Green-main workflow behavior, cumulative migration hold, exact CI
provenance (`rev-parse HEAD`, never event fields), duplicate-deploy
suppression (already-live receipt validation), serialized releases
(`public-site-production` concurrency, no cancel), live-off flags
(`INFERENCE_ENABLED` default-off), postdeploy smoke (`verify:live`).
No automatic rollback and no unknown migrations — deliberately absent.

## Bootstrap / rollback preserving the current hold

1. Confirm live receipt (`deployment.json`): known-good revision is
   `git_commit 8bcd4c7` (brief-provided; re-read live before acting).
2. Record it: `knownGoodReceipt({receipt, expectedCommit: '8bcd4c7…'})`
   must pass — deterministic shape check, no fetch inside.
3. To roll back: manual `workflow_dispatch` with `reviewed_sha` =
   the known-good full SHA, after maintainer acceptance is recorded;
   the deploy path re-verifies SHA + receipt field-by-field
   (already-live semantics), never byte-compares across runs.
4. To roll forward later: new exact-head evidence + acceptance + no
   covering hold, then dispatch. The PR84 hold stays active until Peter
   resolves it — clearing it early is refused by `clearHold` unless a
   listed maintainer records a reason.
