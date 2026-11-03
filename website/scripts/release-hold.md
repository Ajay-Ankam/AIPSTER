# Release HOLD + review-evidence policy (code, not settings)

Owner: safeguards lane. Pure policy modules (`release-hold.mjs`:
evidence/HOLD/decision primitives; `release-gate.mjs`: trusted GitHub
metadata reader + merge/auto/manual decisions) with focused suites
(`tests/release-hold.test.mjs`, `tests/release-gate.test.mjs`,
auto-run by the existing `npm test` glob; no existing workflow edited).
`release-gate.yml` is NEW and advisory until installed below. This code
enforces nothing in the GitHub UI by itself. Production stays held until
Peter resolves PR84.

## Semantics

- Exact head: every verdict names one full 40-hex SHA. New head ⇒ old
  evidence is stale ⇒ re-review. Missing/ambiguous metadata fails closed.
- Blocking findings must be fixed and re-reviewed at the exact new head.
  Tracked notes need explicit disposition + evidence.
- AI-review evidence states model, reviewer id, a SEPARATE author, exact
  SHA, report, and a unanimous test run. Quota/error outcomes never count;
  AI evidence can never assert native GitHub human approval.
- Release additionally requires explicit maintainer acceptance of that
  exact-head evidence (both auto and manual paths — no manual bypass).
  One maintainer suffices; no second-human lockout is added.
- HOLD is cumulative over ancestry: a hold on H covers H and descendants
  for DEPLOY, so a later unrelated main commit cannot bypass it. Unknown
  ancestry ⇒ covered. Only a listed maintainer with a reason can clear;
  anything else is refused and the hold stands. For MERGE, holds block
  only the exact held head (targeted do-not-merge), so release holds do
  not freeze merging.
- Irreversible step rechecks authoritative data first; the residual race
  (main moves between evaluation and deploy) is documented in every
  receipt — the deploy step re-verifies the SHA itself.

## Identity without extra permissions (fork-safe)

Holder/acceptor standing is resolved as: pinned verified owner
(`synchronic1`, live-confirmed sole collaborator) or OWNER association
⇒ sufficient; otherwise the `collaborators/{user}/permission` endpoint
(supported read permission only — no invented scopes) must report
admin/maintain. Inaccessible endpoints and read/triage relationships fail
closed (except the pinned owner); stale relationships never qualify.
One-maintainer self-authored PR acceptance stays possible via the
SHA-bound `RELEASE-ACCEPT` marker. Caller strings and PR-author prose
never suffice; association alone authorizes nothing.
`prevent_self_review` is consciously NOT relied on: the gate reads review
authorship itself, so GitHub's self-approval counting can never lock the
sole maintainer out of their own PRs. Author≠reviewer is enforced only
for independent-review evidence; a maintainer may explicitly accept
(including self-authored work) through the marker, and that acceptance is
recorded distinctly from independent review.

## Gate wiring (implemented, advisory until installed)

- `.github/workflows/release-gate.yml`: enforcement job `release-gate`
  runs ONLY on `pull_request_target` (base workflow version — a PR cannot
  alter these steps). NO review triggers and NO shared job names exist in
  this file: review-version YAML is PR-controlled, so any required check
  reachable from it would be forgeable by rename-back, and no rename can
  fix that. The file checks out the base ref explicitly and evaluates the
  head from API metadata only. Stale evidence blocks are skipped
  (superseded without deleting history); malformed data fails closed.
  Worker-applicable heads additionally require worker + installer CI at
  the PR head. Residual liveness gap: a review submitted after the last
  target run stays unevaluated until the next wake-up (see publish draft
  and deploy-time backstop below) — documented, not claimed away.
- `.github/workflows/release-gate-publish.yml` (DRAFT, INERT until
  activated): trusted-base/default evaluator emitting explicit exact-head
  commit statuses under the DISTINCT context
  `aipster-release-gate/head` (never a native job name). Triggers:
  `pull_request_target` + 15-minute `schedule`; every run re-reads
  repository/PR/head/reviews/checks/holds fresh, emits
  pending → error/failure/success with a stale-head race re-check, and
  executes no untrusted code, artifacts, or caches. Activation requires
  ALL of: uncommenting the narrow `statuses: write` job permission,
  setting `vars.RELEASE_GATE_PUBLISH_ACTIVE=true`, and installing the
  ruleset for that context — each with explicit action-time confirmation.
  Until then it publishes nothing. No App, webhook, token, or service.
- Deploy workflow step (authorized current-workflow edit, one step):
  `public-site-production-deploy.yml` runs
  `website/scripts/release-deploy-gate.mjs` after preflight and before
  deploy. It inspects the ENTIRE first-parent live..target range: merges
  get evidence on each PR's own head + per-PR head CI (site always,
  worker/installer when that PR touches worker paths) + second-parent
  integration proof; REGULAR mainline commits (direct/squash/rebase) are
  refused outright — ancestry in a later branch proves nothing about
  review coverage, and this evaluator documents squash/rebase as
  unsupported without changing any remote merge method. Trusted holds
  file; merged-main CI covers site plus conditional worker only
  (installer at a merge target would deadlock every deploy: verified
  asymmetry, kept). Git exit codes are honest (exit 1 = proven
  non-ancestry; anything else throws). A refusal fails the job before
  deploy.
- Deploy workflow step (authorized current-workflow edit, one step):
  `public-site-production-deploy.yml` runs
  `website/scripts/release-deploy-gate.mjs` after preflight and before
  deploy. It inspects the ENTIRE first-parent live..target range: merges
  get evidence on each PR's own head + second-parent integration proof;
  regular (direct/squash/rebase) commits release only when contained in a
  merge's second-parent history, else fail closed (no merge method is
  disabled). Trusted holds file, merged-main CI (site + worker/installer
  conditionality) in both modes. Git exit codes are honest (exit 1 =
  proven non-ancestry; anything else throws). A refusal fails the job
  before deploy.
- `.github/release-holds.json` (new, seeded): versioned holds map read
  from the trusted release checkout. The seed carries the PR84 hold on
  `45c9eb7…` — seeded state requiring maintainer confirmation (RESULT).

## Environment required-human approval: NOT imposed (documented verdict)

Green-main automation is the requested default, so no environment
required-reviewer rule is proposed: it would pause every deploy on a
human click (including urgent recovery), with no added assurance beyond
the gate + ruleset + existing `production` environment scoping. Effect if
ever enabled: all automatic and manual releases wait for an explicit
approval, and an unavailable approver blocks recovery — keep it off
unless Peter orders otherwise.

## Evidence registry format (proposed convention)

`website/release-evidence.json` (maintainer-created, not here):
`{ "<sha>": { reviewers: [...], maintainerAcceptance: {by, sha, at},
hold: {...} } }`. A registry committed alongside a candidate can never
self-attest that candidate — the gate therefore binds evidence through
live API review objects (commit-bound, association-checked), not files.

## Proposed settings payloads (for controller approval — NOT applied)

Ruleset (real schema — field names verified against current REST docs;
re-verify `actor_id` at apply time):
`POST /repos/synchronic1/AIPSTER/rulesets`
```json
{
  "name": "aipster-release-gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
  "rules": [
    {"type": "required_status_checks", "parameters": {
      "required_status_checks": [{"context": "release-gate"}],
      "strict_required_status_checks_policy": true}},
    {"type": "pull_request", "parameters": {
      "required_approving_review_count": 0,
      "dismiss_stale_reviews_on_push": true,
      "require_code_owner_review": false,
      "require_last_push_approval": false,
      "required_review_thread_resolution": false}}
  ],
  "bypass_actors": []
}
```
Notes: `required_approving_review_count: 0` keeps the sole maintainer
recoverable (no lockout) with no bypass inventiveness — no `actor_id`
is proposed here because the docs do not pin role IDs; resolve the admin
role live at apply time (`GET` the ruleset suite / role endpoints first)
and record the exact value in the apply receipt. Never paste an
unverified numeric ID. Bootstrap order (no nonexistent check required):
merge the gate workflow → let `release-gate` run once on a PR so the
context exists (confirm it attaches to the PR head — unresolved live
check, see RESULT) → then install the ruleset.
Environment `production`: confirm single-maintainer reviewer, no second
human. Security-sensitive hygiene for any privileged gate change:
`persist-credentials: false`, read-only token, pinned SHAs, no
`pull_request_target` fork checkout, no issue-comment commands.

## Fork safety (inspected)

Auto path: event gate rejects non-push/non-main/fork repos before
checkout; preflight re-verifies SHA, main equality, canonical repo,
merged-PR association, applicable checks. Gate workflow: base checkout
only, metadata JSON only, read-only token — fork heads appear solely as
SHA strings. Manual path: dispatch is the maintainer's explicit act;
reviewed SHA must equal the rechecked main tip inside the gate (no older
SHA, no fork commit).

## Preserved behavior

Green-main workflow behavior, cumulative migration hold, exact CI
provenance, duplicate-deploy suppression, serialized releases, live-off
flags, postdeploy smoke. No automatic rollback, no unknown migrations.

## Bootstrap / rollback preserving the current hold (CORRECTED)

Earlier instructions to dispatch an older known-good SHA were wrong:
`release-preflight` requires target == current main, so that path
cannot deploy. The supported explicit recovery:

1. Confirm live receipt (`deployment.json`): known-good revision is
   `git_commit 8bcd4c7` (brief-provided; re-read live before acting).
   `knownGoodReceipt` checks the shape deterministically (no fetch inside).
2. To recover: open a PR that restores the known-good tree, pass the full
   gate (fresh exact-head evidence + acceptance + no covering hold), merge,
   then release the NEW head normally (auto or manual dispatch).
   Limits: recovery takes a full review cycle; nothing auto-opens; the
   PR84 hold stays active until Peter resolves it.
3. To roll forward later: same gate, then dispatch. Rollback-by-dispatch
   of an old SHA is unsupported and will fail closed — do not attempt it.
