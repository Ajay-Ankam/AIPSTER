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
  Evidence binds only on a dual match: the platform review object's
  `commit_id` AND the body's `sha` must both equal the target head — a
  body sha never overwrites its object's placement, and records with
  missing/malformed placement never count as a current match. Proven
  other-head history is filtered before any trust/parsing decision, so
  it can neither supply evidence nor wedge the current head.
- Blocking findings must be fixed and re-reviewed at the exact new head.
  Tracked notes need explicit disposition + evidence.
- AI-review evidence states model, reviewing-agent id, attested
  source-author agent id, a SEPARATE author, exact SHA, report, and a
  unanimous test run. Quota/error outcomes never count; AI evidence can
  never assert native GitHub human approval. String fields and report
  paths alone authenticate nothing: a structured body binds only when
  posted by a proven-trusted publisher (pinned owner, OWNER
  association, or endpoint-proven admin/maintain, resolved fresh —
  including marker-less reporters). A proved outsider's body is ignored
  entirely (no evidence, no wedge); unknown standing fails closed.
  Independence is attested agent-to-agent: reviewer and source-author
  must be different agent identities even when the PR GitHub author
  login differs, and the GitHub poster is recorded as publisher but
  never substituted as the source agent. This is maintainer-attested
  report provenance, NOT cryptographic proof of model execution:
  production receipts must carry actual known agent IDs (fixtures use
  explicit distinct fake IDs).
- Release additionally requires explicit maintainer acceptance of that
  exact-head evidence (both auto and manual paths — no manual bypass).
  One maintainer suffices; no second-human lockout is added.
- Acceptance never erases blocking. Same-head review records resolve
  deterministically per author, oldest to latest (`submitted_at`, then
  review id), with native state and structured evidence kept distinct:
  a native CHANGES_REQUESTED blocks until a later same-author APPROVED
  clears it or that exact review object is dismissed — dismissal is the
  current state of one object, so a DISMISSED record never clears a
  different still-unresolved object, even a newer one by the same
  publisher. A plain COMMENTED never resolves, and a different
  publisher's PASS never erases another author's block. Native state
  (APPROVED/COMMENTED/CHANGES_REQUESTED/DISMISSED) resolves blocking as
  above; structured evidence (PASS/HOLD blocks) additionally
  authenticates through the publisher before it is even parsed — a
  proved outsider's structured body is ignored, unknown standing fails
  closed. A structured HOLD block stops the gate until a later
  same-reviewer APPROVED carrying a valid structured PASS
  (report/model/tests bound to this head, reviewer distinct from the
  attested author) supersedes it — native approval alone never erases
  a HOLD or revives an older PASS, and publisher identity alone is
  never re-review evidence (one maintainer may post several agents'
  reports). Stale other-head records neither block nor pass.
  Proven-absent outsiders have no blocking power; unknown standing,
  unattributable signals, and ambiguous order fail closed.
- Tracked nonblocking limitation (structured-HOLD wedge, narrowed):
  proved-outsider HOLD/malformed bodies are now ignored entirely (no
  wedge — fixed above, no permissions-scheme expansion). What remains
  is unknown-standing publishers: a well-formed HOLD block whose
  standing cannot be proven still fails closed and wedges that head's
  gate — a safe-direction refusal only, never a release. Recovery
  limits, honestly: the same commenter posts a superseding clean
  APPROVED, or the head moves (stale records go inert), or a maintainer
  dismisses that exact review object on GitHub (direct dismissal clears
  it). There is no owner override clearing another reviewer's
  unresolved block. Related honest limits: old probes and reports using
  author-less evidence blocks now fail closed by design (the `author:`
  attestation is required); the custom context string alone does not
  authenticate its publisher — trust rests on status-write holders plus
  the one-time canary, both unproven live.
- HOLD is cumulative over ancestry: a hold on H covers H and descendants
  for DEPLOY, so a later unrelated main commit cannot bypass it. Unknown
  ancestry ⇒ covered. Only a listed maintainer with a reason can clear;
  anything else is refused and the hold stands. For MERGE, targeted
  holds block only the exact held head — but an ACTIVE GLOBAL
  (`blockMerges: true`) hold refuses EVERY ordinary merge: the PR84
  directive is all-merges-and-deployments, so no relation pretense is
  needed for global coverage. Inactive or non-global records behave as
  targeted holds.
- The hold registry (`.github/release-holds.json`) can never authorize
  its own clearance: any ordinary evaluated PR touching that file —
  modify, remove, or replace — fails closed. Clearance is a separately
  approved owner-only operation (explicit maintainer decision recorded
  out of band, applied with action-time confirmation); there is no
  auto-clear marker. History is preserved by refusing, never by
  rewriting it.
- Irreversible step rechecks authoritative data first; the residual race
  (main moves between evaluation and deploy) is documented in every
  receipt — the deploy step re-verifies the SHA itself. That
  deploy-time re-evaluation is a backstop, not atomic prevention of a
  merge: a merge that lands between evaluation and deploy is caught
  before production, not prevented.
- Honest staleness limits: during a GitHub API outage every evaluation
  throws before publishing success (fail closed), but no failure status
  can be posted mid-outage either — an old successful status can remain
  visible and mergeable until the publisher refreshes it. Stale success
  becoming impossible is NOT claimed.

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

- `.github/workflows/release-gate.yml`: ADVISORY job
  `release-gate-advisory` (renamed so it can never be mistaken for
  enforcement — it must NEVER be a required check) runs ONLY on
  `pull_request_target` (base workflow version — a PR cannot alter
  these steps). It is a thin caller of the tested `runGateEvaluation`
  orchestration: fresh reads, worker applicability from changed files,
  verdict, stale-head race check. NO review triggers exist in this
  file. Residual liveness gap: a review submitted after the last
  target run stays unevaluated until the next wake-up (see publish
  draft and deploy-time backstop below) — documented, not claimed away.
- `.github/workflows/release-gate-publish.yml` (DRAFT, INERT until
  activated): trusted-base/default evaluator emitting explicit exact-head
  commit statuses under the single DISTINCT context
  `aipster-release-gate/head` (constant `PUBLISH_CONTEXT`, used across
  source, workflow, docs, and the ruleset proposal — never a native job
  name). Thin caller of tested `listOpenPRs` + `publishEvaluation`:
  pending first (a pending-write failure ABORTS before evaluation),
  then evaluation, then success — or failure + the refusal on refusal.
  A failed failure-write throws; nothing exits silent. Publication is
  `POST statuses/{sha}`; a post-verdict head re-read refuses stale
  success with an error status. Listing paginates and fails LOUDLY past
  the cap instead of truncating. Triggers: `pull_request_target` +
  15-minute `schedule`; every run re-reads
  repository/PR/head/reviews/checks/holds fresh and executes no
  untrusted code, artifacts, or caches. Activation requires ALL of:
  uncommenting the narrow `statuses: write` job permission, setting
  `vars.RELEASE_GATE_PUBLISH_ACTIVE=true`, and installing the ruleset
  for that context — each with explicit action-time confirmation.
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
  unsupported without changing any remote merge method. Fresh endpoint
  standing is re-read per PR (fresh reads win over caller maps); the
  range touching the hold registry fails closed; fresh trusted holds —
  including any active GLOBAL hold — govern before any production step,
  so a descendant with an unchanged registry stays held. Merged-main CI
  covers site plus conditional worker only (installer at a merge target
  would deadlock every deploy: verified asymmetry, kept). Every
  required check additionally binds its producer: the passing run must
  belong to its expected workflow file at that head, joined by
  check-suite id (`SITE/WORKER/INSTALLER_WORKFLOW_FILE` — the actual
  repository paths holding those jobs), so a same-named passing job
  from any other workflow, including a PR-controlled spoof on a
  same-repo branch, never substitutes. The suite join uses the
  supported Actions workflow-runs listing; unknown/failed listings
  fail closed. Reading it needs `actions: read` added to the existing
  top-level `permissions:` block of each gate-touching workflow —
  `release-gate.yml`, `release-gate-publish.yml`, and
  `public-site-production-deploy.yml` (single `deploy` job; there is no
  step-level permission to change) — an UNAPPLIED approval-gated
  proposal (all three blocks currently pin contents/checks/
  pull-requests read only); until granted, producer checks fail
  closed. The check-suite join itself remains a
  live-unverified residual until the first real canary run. The legacy
  preflight path still matches CI by name only (out of scope, no
  redesign); this gate's refusal stands in front of production
  regardless. Git exit codes are honest (exit 1 = proven
  non-ancestry; anything else throws). A refusal fails the job before
  deploy.
- `.github/release-holds.json` (new, seeded): versioned holds map read
  from the trusted release checkout. The seed carries the PR84
  all-merges-and-deployments hold on `45c9eb7…` with `blockMerges: true`
  — seeded state requiring maintainer confirmation (RESULT).

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
      "required_status_checks": [{"context": "aipster-release-gate/head"}],
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
Notes: the required context is the single `PUBLISH_CONTEXT`
`aipster-release-gate/head` — the advisory `release-gate-advisory`
native job is NEVER a required check. `required_approving_review_count:
0` only avoids a second-human requirement: it does NOT guarantee
recovery from a required-status or global-hold deadlock. Recovery from
a wedged publisher or an active hold needs explicit owner
intervention — the User bypass OPTION below and/or an explicit
owner-recorded hold resolution — each with action-time confirmation.
Emergency-bypass design OPTION (not applied, needs action-time
confirmation): a User bypass actor for verified `synchronic1`
(ID 135072919) so the sole maintainer can recover if the publisher
itself wedges a PR; default is no bypass. Never paste an unverified
numeric ID — re-resolve the actor ID live at apply time and record the
exact value in the apply receipt. Bootstrap order (no nonexistent check
required): merge the publisher draft (still inert) → activate publishing
→ run the explicit-head commit-status canary on a PR head
(`assertCanaryClean`: the `POST statuses/{sha}` context present and
passing ON the head, no competing legacy `release-gate` run) → then
install the ruleset. The canary proves explicit-head STATUS attachment
via the API — not native `pull_request_target` job attachment, which is
a separate unresolved live check until run — see RESULT; nothing is
installed beforehand.
Narrowly scoped `statuses: write` on the publisher job and
`vars.RELEASE_GATE_PUBLISH_ACTIVE=true` are likewise confirmation-gated.
No production-environment reviewer rule is proposed (see the NOT-imposed
verdict above). Security-sensitive hygiene for any privileged gate change:
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
