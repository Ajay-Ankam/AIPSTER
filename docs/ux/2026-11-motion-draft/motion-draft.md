# Motion and diagrams draft (KOPS-298 follow-up)

Drafted on `ux/website-motion-draft` (off the Switchboard redesign), then rebased onto synchronic1 `main` at `0e6b608` and revised on `ux/KOPS-298-website-motion` after Andrew's review calls on 2026-11-04.

The ask: "implement some of the newer react bits into the Design for this site and create new diagrams that actually blend with the site using some framework that matches react bits".

This change brings in six React Bits style effects and three new diagrams. It adds no React and no build step. Everything is plain CSS plus one small same-origin script, and the diagrams are inline SVG generated from one JSON file. Option B, real React Bits with React Flow islands, is costed at the end.

## Review calls (2026-11-04)

Andrew: "go with your recommendations".

- **Duplicate content removed.** The two flow diagrams stay. The four-step list under "How it would work" is gone, because the `how` diagram draws the same four steps with the same state labels. Fig. 1, the published IRB / DGM PNG (723 KB), is gone, because the `research` diagram draws the same pipeline; its PNG and SVG are removed from `website/public/assets/`. The repository copies in `assets/` stay for `README.md`. The model / LoRA figure is now Fig. 1 and sits full width, image beside caption.
- **Motion cut.** Count-up (console KPIs and the status tallies) and the section-heading blur reveal are removed from `motion.js` and `styles.css`. The tallies stay as static numbers, and a test now counts the matrix rows behind each one.
- **Kept.** Beams, spotlight, dot grid, the 6px magnet, the two-sweep sheen and decrypt on the two id labels.
- **README.** `README.md` keeps Fig. 1 from the repository copy in `assets/` and embeds the three new diagrams from `assets/diagrams/`, which the generator writes (see below).
- **Review fixes.** One-shot effects start only when an entry's `intersectionRatio` reaches the requested threshold, not on the first `isIntersecting` entry (Codex review; `tests/motion.test.mjs`). The landing CSP is pinned (see the policy section). Edges that meet at one point now draw one port, not a stack (four circles had been drawn at (520,80) in the `how` diagram). `release.json` moves to revision `2026-11-04.1`.

## Licence

React Bits (reactbits.dev, github.com/DavidHDev/react-bits) is MIT plus Commons Clause. No React Bits source was copied. Each effect was written from scratch in plain CSS or JS. The credit "Inspired by React Bits <ComponentName> (reactbits.dev)" is in comments at the top of `public/motion.js`, over the motion block in `public/styles.css`, and over the dot-grid rule, and it is repeated in the table below.

## The six effects

All of them are progressive enhancement:

- The final content is in the HTML. With JavaScript off, or with `prefers-reduced-motion: reduce`, the page is complete and still.
- The script only adds classes, CSS custom properties and `aria-hidden` overlays. It never replaces text that a screen reader reads.
- Every keyframe rule sits inside `@media (prefers-reduced-motion: no-preference)`. Under `reduce`, `motion.js` returns on its first line, so no `.js` class is set and nothing starts hidden.
- No timed loop runs longer than 5 seconds, which satisfies WCAG 2.2.2 (Pause, Stop, Hide). That is why the sheen, beams and pulses stop after two or three cycles instead of looping forever.

| # | Effect | Where | Inspired by (reactbits.dev) | Why it fits Switchboard | Under reduced motion / no JS |
|---|---|---|---|---|---|
| 1 | Sheen | Hero status line "Compute sharing is in development" | ShinyText | It draws the eye to the one caveat that matters most, using the text and muted tokens. CSS only: two 2.2s sweeps, then it ends muted, exactly as before. | Plain muted text. In forced-colours mode the gradient is turned off. |
| 2 | Decrypt | Console ids `r_demo_1` and "Seeded demo account" | DecryptedText | Identifiers resolving reads like a console coming online. It is shown only on ids, never on prose. | No scramble. The real text node is never changed: an `aria-hidden` overlay is drawn over it for 600ms and then removed. |
| 3 | Spotlight | The build matrix, the Fig. 1 card and the two flow diagrams | SpotlightCard | It is a soft copper wash at 9% `color-mix` of `--copper`, so it suits a hairline console. Only on `pointer: fine`. | No highlight. |
| 4 | Magnet | "Open the control panel" | Magnet | It gives the single primary CTA a physical feel. It drifts at most 6px when the pointer is within 80px, and springs back with `--dur-3` / `--ease-out`. Only on `pointer: fine`. | Static button. Keyboard focus never moves it. |
| 5 | Dot grid | Hero band behind the copy and console | DotGrid | It is the Gumloop / Mintlify canvas. The static grid is drawn with `--line-2` dots, and a second layer of `--copper` dots shows only inside a 10rem mask around the pointer. | Static grid (CSS only, no JS needed). |
| 6 | Beams | Diagram edges | Beams / FloatingLines | Flow is explained by motion along the real edges. Request and result edges carry a short copper pulse three times. Dashed edges (heartbeat, optional, architectural) flow three times. Online machines in "Your mesh" pulse three times. Everything starts when 35% of the figure is in view; an earlier `isIntersecting` entry below that ratio is ignored. | Static, finished diagram. There is no SMIL; `check.mjs` bans `<animate>`. |

One pointer handler serves effects 3, 4 and 5. It is passive and rAF-throttled, and in each frame it reads every rect before it writes any custom property, so there is no layout thrash. Each IntersectionObserver disconnects once all of its targets have fired, and no timers are left running. `motion.js` is 4.9 KB of readable source, about 3.5 KB with comments and whitespace removed, and 2.0 KB gzipped.

Motion is deliberately not used on mesh lanes. The caption says the lanes "are architectural, not live traffic", so travelling packets on them would contradict it. The lanes get only a slow dash drift. Heartbeat spokes from offline or unknown machines are drawn faint and do not flow.

## The diagram system

`website/diagrams/diagrams.json` → `website/scripts/diagrams.mjs` → inline SVG in `website/public/index.html`.

- **Source.** Three diagrams:
  - `how`: the four owner-controlled steps around the owner. It is the page's only telling of them.
  - `research`: the proposed IRB / DGM / JEV pipeline, labelled "Proposed design".
  - `mesh`: three personal meshes with state shapes.

  Each diagram has:
  - `title` and `desc`;
  - `lanes`;
  - `nodes`, with `id`, `label`, `sublabel`, `state`, `lane`, and for the steps a `stateLabel`;
  - `edges`, with `from`, `to`, `label` and `kind`, where kind is one of `request`, `heartbeat`, `result`, `optional` or `architectural`;
  - two layouts, `wide` and `narrow`. Node boxes or points are in grid units (`grid` px each), with optional per-edge route overrides (`from`/`to` side, label side, or `"label": "none"`).
- **Wording.**
  - The step labels are the headings of the former step list. The sublabels are shortened from its text.
  - The research labels come only from `README.md` and the text of the published figure `assets/IRB-DGM-JEV-component-flow.svg`: "selective reuse only", "external, trusted", "Karpathy-style", "frozen development protocol", "optional, advisory only", "ranking / abstain", "RunSpec", "dev evidence", "artifact", "held-out suite", "final audit", "human approval", "separate release action", "only after search stops".
  - The research caption keeps the figure's rule that no promotion or final-audit feedback returns to the same search campaign.
- **Generator** (`node scripts/diagrams.mjs`, or `npm run diagrams`). It has no dependencies. It writes both layouts per diagram between `<!-- diagram:<id>:start -->` and `<!-- diagram:<id>:end -->` markers.
  - Edges are orthogonal with rounded corners. A pair of edges in opposite directions is offset ±6px. Ports are drawn as dots and arrowheads as paths, so no `marker-end` is needed. Edges that share an endpoint draw one port there; `tests/diagrams.test.mjs` fails on a duplicate.
  - The generator refuses to write a layout in which:
    - a node leaves the canvas;
    - nodes overlap;
    - an edge label hits a node or leaves the canvas;
    - wrapped text does not fit its box.
  - It also writes `assets/diagrams/<id>.svg` at the repository root: the wide layout as a standalone light-theme SVG for `README.md`, with literal colours, `<title>` and `<desc>`, no script and no motion (beams and halos are left out).
  - `--check` exits 1 when `index.html` or any of those files is out of date.
- **SVG.**
  - Each SVG has `role="img"`, a `<title>` (`aria-labelledby`) and a `<desc>` (`aria-describedby`). Ids are unique per diagram and layout.
  - Text is real `<text>` with a `font-size` attribute. All strokes and fills come from CSS classes using tokens, so dark mode follows `prefers-color-scheme`.
  - The inactive layout is `display: none`, so only one SVG reaches assistive technology.
  - The figure is a size container. Flow diagrams switch to wide at 60rem and the mesh at 30rem. Wide layouts never scale up, which keeps the smallest rendered text at or above 12px: 12.5px at 360px (measured), and at least 12.0px at each switch point.
- **To edit a diagram:** change the JSON, run `npm run diagrams`, then `node --test tests/diagrams.test.mjs`. If the generator throws, it names the node or label that does not fit. Move it, or give the node more grid units.
- **Placement.**
  - `how` closes the "How it would work" section, in place of the former four-step list.
  - `research` is at the top of the research section, in place of the published IRB / DGM figure. The model / LoRA figure (now Fig. 1) and its caveat are unchanged below it.
  - `mesh` replaces the earlier story-section SVG. Its caption key now also shows the four state shapes, the heartbeat line and the owner hub.

## The policy change, in plain words

The landing now loads one script. That changes the rule that the landing page carries no JavaScript, so it is spelled out here:

1. **`website/scripts/check.mjs`.**
   - `'motion.js'` is added to the `publicFiles` allowlist.
   - `['index.html', '/motion.js']` is added to `APPROVED_PANEL_SCRIPTS`, with one comment line.
   - Nothing is renamed and no rule is relaxed. The existing script rule still requires every `<script>` to have exactly one attribute, `src`, equal to that page's approved path, with no inline body and exactly one script per approved page.
   - The script is a classic IIFE (`<script src="/motion.js"></script>`, the last element of `body`) and not `type="module"`. A module tag would carry a second attribute and need the rule changed. A classic script at the end of the body also needs no `defer`, because by then the DOM it touches is already parsed.
2. **`website/public/_headers`.** A `Content-Security-Policy` is added to the existing `/*` rule:

   ```
   default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
   ```

   - **Why `/*` and not `/` plus `/404.html`.** Cloudflare's assets layer answers an unknown path with `404.html` under the requested path, and matches `_headers` against that path. A `/404.html` rule therefore never reaches a real 404. Checked locally: `/nope` had no CSP with a `/404.html` rule, and `/404.html` itself redirects to `/404`. Cloudflare also appends every matching rule, so separate `/` and `/*` rules would send two CSP headers. A single rule on `/*` avoids both problems.
   - **The panels are unaffected.** `src/worker.js` (`serveApp`) `set`s, and so replaces, `Content-Security-Policy` on every `/app` and `/admin` response. Verified with `curl -I`: `/app/` and `/admin/` each return exactly one CSP, the panel's own.
   - **What it blocks.** Any script that is not `/motion.js` from this origin, including inline script and `eval`. Inline `style` attributes and `<style>` blocks. Fonts, which are system stacks anyway. Cross-origin fetch/XHR/WebSocket traffic. `connect-src 'self'` keeps same-origin requests possible; the landing itself makes none. With `connect-src 'none'`, Lighthouse could not read `/robots.txt` from the page, and the SEO score fell from 100 to 92 for that reason alone. `<base>`, form posts, and framing by another site.
   - **What it allows.** Same-origin CSS, images (the poster, sponsor and wordmark SVGs, the favicon and the Fig. 1 PNG), the MP4, and the WebVTT captions (a `<track>` loads under `media-src`).
   - **CSSOM still works.** `element.style.setProperty('--mx', …)` is a CSSOM call, not an inline style attribute, so `style-src 'self'` allows it.
   - **Browser check.** Chromium, at 1440px with motion: zero `securitypolicyviolation` events and zero console errors. Poster set, `readyState` 4, 8 caption cues and a 40s duration. The only failed request was the MP4's `net::ERR_ABORTED`, which is the browser cancelling its `preload="metadata"` range read. It happens with motion, without motion and with JS off.
   - **Pinned.** `check.mjs` exports the policy as `LANDING_CSP` and fails unless `_headers` carries exactly that one CSP line. `check.test.mjs` pins the literal on the `/*` rule and rejects a widened, duplicated or missing policy. `verify-live.mjs` now asserts that `/` is served with exactly `LANDING_CSP`, next to its existing check of the panel policy on `/app/`.
3. **`website/package.json`.** One line: `"diagrams": "node scripts/diagrams.mjs"`.
4. **`website/public/release.json`.** Revision `2026-11-03.1` to `2026-11-04.1`, as upstream bumps it for a content change.

Nothing in `website/src/` changed, and the panel CSP is as before.

## Option B: real React Bits and React Flow (xyflow) islands

What it would take:

- **Build step.** Vite (or esbuild) would produce hashed bundles in `public/`. Every build changes the file names, so either the `publicFiles` allowlist churns on every release, or `check.mjs` moves to an allowlist-by-manifest model. That second option is a larger security-policy rewrite.
- **Weight.** `react` and `react-dom` are about 45 KB gzipped. `@xyflow/react` is about 50–60 KB gzipped, plus its CSS. Each React Bits component brings its own dependencies, and several of the background components pull in `ogl`, `three` or `gsap` (tens to hundreds of KB). Today the landing ships about 2.0 KB of gzipped JS.
- **CSP.** `script-src 'self'` works with bundled files. But several React Bits components, and React Flow, set inline styles through `style` attributes. That needs `style-src 'unsafe-inline'`, or a nonce or hash. Nonces are not possible on static assets without the Worker rewriting HTML. This would loosen the landing CSP, and the panel CSP too if any island reached `/app`.
- **Rendering model.** The site is static assets behind a Worker. The choice is client-only islands (empty boxes until hydration, with a layout-shift and no-JS story to solve), build-time SSR to static HTML followed by hydration (a second toolchain), or Worker SSR (application code in `src/`, which this work must not touch).
- **Licence.** React Bits component source is MIT plus Commons Clause. Copying it into this Apache-2.0 repository mixes in a licence that restricts selling the software. That would need a legal read before it ships.
- **Maintenance.** A new toolchain, lockfile surface and CI steps (build, then check the built output). A larger review surface for every UI change. Tests that today read the HTML directly would read build output instead.

**Recommendation: A (this draft).** It gets the React Bits look at about 2 KB of JS. It tightens the landing CSP instead of loosening it. It keeps the reviewed allowlist model and adds no new licence exposure.

B would be worth it when the site needs real interactivity that static SVG cannot provide: a live, pannable and zoomable topology of a user's actual mesh in `/app`, editable flows, or drag-to-connect sharing grants. At that point React Flow earns its weight, and the build and CSP work should be done once, on purpose, for the panel.

## Mobbin references

- Quo call flow, https://mobbin.com/screens/da1c81a1-d69f-4ac0-abca-6e0cb8bcd15f: vertical node flow, labelled connectors and port dots. Used for the narrow layouts and the port dots on every edge.
- Gumloop flow canvas, https://mobbin.com/screens/c51cb543-b0cf-4ac9-a45e-b50371575c48: dashed connectors on a dot canvas, numbered ports. Used for the dot-grid diagram canvas and the dashed optional and architectural edges.
- Mintlify hero, https://mobbin.com/screens/4cc8ee93-cf4e-4b9f-a905-8e11b2b9da9e: flowing line field and a live counter chip. Used for the hero dot field.
- Klaviyo starter guide, https://mobbin.com/screens/c5b38604-64df-4b30-890d-45a26ca8555e: vertical stepper. Used for the narrow "How it would work" layout, with the owner rail feeding each step.

## /app (optional part): not done

No motion was added to `/app`. Count-up, the one candidate, was cut from the landing as well. A panel fade-in would have to sit before the first `.topo` rule, because of the `fabric-overview` no-motion pin; it is better as its own small, reviewed change.

## Evidence

Re-captured on 2026-11-04 after the review changes, with Playwright Chromium against `website/dist` (fresh `npm run build`) served by a local static server that sends `LANDING_CSP`.

- `screenshots/landing-{1440,390}-{light,dark}.webp`: full page, `reducedMotion: 'no-preference'`, captured after scrolling the page once and waiting 6s for every effect to settle. There is no scroll reveal any more, so no section starts hidden. The 390px page is 15,078px tall and is not scaled.
- `recordings/`, each under 10s:
  - `a-hero-load.webm`: sheen, decrypt and the dot grid at 1440×900.
  - `b-pointer.webm`: scripted pointer over the CTA (magnet), the hero dot grid, the `how` diagram and the build matrix (spotlight).
  - `c-diagrams.webm`: the three diagrams scrolled into view in turn (beams).
  - `d-narrow-390.webm`: the narrow layouts at a 390×844 viewport.
  - `c` and `d` were trimmed to 9.6s with ffmpeg.
- axe-core 4.11 at 1440 and 390: 0 violations in light, dark, reduced motion and reduced motion dark.
- With `prefers-reduced-motion: reduce`, `getAnimations()` returned 0 and no `.js` class was set.
- CSP enforced (no bypass), 1440 with motion: zero `securitypolicyviolation` events and zero console errors.
- Horizontal document overflow was 0 at 1440 and 390, light and dark.
- From the first draft, not re-run: Lighthouse 12 on the local Worker scored 100 / 100 / 100 / 92 (SEO 92 only for a missing local `robots.txt`) on mobile and desktop, CLS 0; the smallest rendered diagram text was 12.5px at 360.
