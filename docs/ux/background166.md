# BACKGROUND166: control-panel decorative graph background

## Provenance

Visual reference: the public https://heurchain.com/ homepage as retrieved
2026-11-04 (saved outside this repo at
`goose-evidence/worker-priority-20261103/background166-reference/heurchain-home.html`).
Observed mechanism only: a fixed, aria-hidden, pointer-events-none 2D canvas
with slowly drifting/twinkling stars, teal/blue/cyan glowing nodes, proximity
edges, small dots travelling on edges, rare amber pulse rings and soft radial
gradients, plus a reduced-motion static frame. Reference constants (220
stars, 44 nodes, 18 streams, 185px edges) were not copied; AIPSTER uses
smaller viewport-scaled budgets. No HeurChain code, fonts, tracking scripts,
identity labels or analytics were copied. Parent-supplied screenshots were
not locally accessible and were never claimed to have been inspected.

## What changed

New, namespaced, dependency-free assets (control-panel shell only):

- `website/public/app/background166.js` — vanilla 2D canvas module.
  Injects one `#aipster-bg166` canvas (`aria-hidden`, unfocusable,
  `pointer-events: none` via CSS), draws stars, a sparse drifting graph,
  proximity edges and edge-travelling dots on elapsed-time frames.
  Single-instance guard (`window.__aipsterBg166`), one rAF chain, DPR capped
  at 1.5, counts bounded (<=120 stars, <=30 nodes, <=8 streams), edge distance
  130px narrow / 170px wide. Honors `prefers-reduced-motion` at start and on
  change (single static frame, no scheduled frames), pauses on
  `document.hidden`, resumes on visible, tears down and rebuilds cleanly on
  resize/orientation (`destroy()` removes every listener, canvas and frame).
  Falls back to a static CSS wash when canvas 2d is unavailable. Exposes
  `window.AipsterBackground166.state()` / `.stats()` for inspection.
  `?bg166=static` forces the reduced path for fixture previews.
- `website/public/app/background166.css` — canvas layer (fixed, behind
  content, no pointer interception) plus the no-canvas static gradient wash
  in light/dark/narrow variants. No remote content.
- `website/public/app/index.html` — two-line hook only: stylesheet link and
  one classic script tag after `/app/app.js`. No edits to `app.js` or any
  operational markup, and no new pointer, keyboard or focus behavior.
- `website/scripts/check.mjs` — allowlists the two new assets and permits
  exactly one extra post-entry script on `app/index.html` only
  (`APPROVED_EXTRA_SCRIPTS`); every other shell and every other second
  script still fails. `website/scripts/check.test.mjs` count 50 -> 52.
- `website/tests/background166.test.mjs` — 13 focused tests (shell hook,
  gate allowlist, single canvas/loop, bounds, reduced-motion start/change,
  hidden pause/resume, resize, destroy/re-init, no-context fallback,
  no-branding/tracking/network/pointer-hooks).

## Readability and identity

Content surfaces keep their opaque Switchboard surfaces; the canvas paints at
`z-index: -1` behind everything and never intercepts input. Palette is
AIPSTER-driven (deep teal / steel blue / cyan nodes, copper reserved for the
rare pulse ring) in light and dark schemes. No moving labels behind text.

## Validation (local, this lane)

- `node --test website/tests/background166.test.mjs` — 13/13 pass.
- `node website/scripts/check.mjs` — pass, 52 files.
- `node --test website/scripts/check.test.mjs` — 61/61 pass.
- Browser renders (desktop, narrow mobile, forced-static) with console,
  lifecycle and frame-time notes: see BACKGROUND166-RESULT.md in the
  originating evidence directory.

## Limits

- Decorative only; it must never be read as worker, grant or inference state.
- Reduced-motion and hidden-tab behavior verified against the real code paths
  with a stub DOM and a live page; no native profiler numbers are claimed.
- Shared-file deltas (`app/index.html`, `scripts/check.mjs`,
  `scripts/check.test.mjs`) need the coordinator's independent review; the
  `app.js`/onboarding lane (PR108) was not touched.
