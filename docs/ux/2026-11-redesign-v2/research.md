# Website redesign v2: research and three directions

Sponsored work from Kainotomic (ledger L-380, Jira KOPS-298). Phase 1 of 2: research, three prototype directions, then a stop for Andrew's pick. Nothing under `website/` changes in this phase.

Baseline: upstream `main` at `7870ff4`, which includes PR #88 (`ba1c72e`). #88 set shared tokens and restyled the existing layouts. It did not change the information architecture, the type voice or the control panel's structure. Andrew's review of it: "way too simple and minor tweaks". This round treats #88 as the floor.

## 1. Method

- Reference capture: 16 public sites at 1440×900 (top of page and 1,800px down) and 390×844, using Playwright and Chromium 145. For each page I also read the body and `h1` computed font family, size, weight and tracking. The screenshots are kept for notes only, in a git-excluded scratch folder, and are not committed.
- Award research: Awwwards Site of the Day and Developer Award winners and nominees from October and November 2026, checked on their listing pages. Typefaces come from each site's own CSS. **Godly** now redirects every path to `recent.design` and **Land-book** returned 403 to both fetch and curl, so neither was used. No picks are attributed to them.
- Mobbin: not available in Phase 1 (no Mobbin tools in that session). It became available for Phase 2, and the component references used for the build are listed in section 8.
- Anthropic Console signed-in screens were not used (they need an account). For Anthropic I used the public site and the Claude Platform docs landing.
- AIPSTER sources: `README.md`, `website/README.md`, `AGENTS.md`, `docs/ux/2026-11-redesign.md` (#88), `website/public/**`, `website/scripts/check.mjs`, `website/src/worker.js` (CSP), `website/tests/fabric-overview.test.mjs`, `website/tests/hackathon-video.test.mjs`, `demo/reviewed-exports/`.

## 2. What makes each reference feel premium

| Site | Type (measured) | Layout and density | Motion and imagery | What we take |
|---|---|---|---|---|
| Linear | Inter Variable, 64px, weight 510, −1.4px | The real product (issue view, sidebar, activity) is the hero, under a two-line headline. Below that, three-column "purpose-built / agents / speed" with isometric line drawings | Restrained. Dark `#08090A`. The drawings are thin-line wireframes, not glow | Product UI as hero. Thin-line technical illustration. Keyboard-first console density |
| Vercel | Geist, 64px, weight 400, −3.84px | Centred hero over a hairline 12-column grid with dashed construction lines. Logo strip. Stats row | One black prism. Almost no colour | Visible construction grid. Extreme tracking on display type. Monochrome restraint |
| Stripe | Söhne (variable), 48px, weight 300 | The headline runs into a second sentence in a muted colour. Product UI cards show real-looking payment data | The animated gradient wave is its signature | A two-tone headline-plus-continuation for long propositions. Credible product fragments |
| Raycast | Inter, 64px, weight 600 | One CTA. A product window with key caps | Red light-streak hero | Key-cap shortcut hints. One primary action |
| Supabase | Manrope, 46px, weight 500, over Inter | A bento grid where every tile holds a miniature of the real UI (table editor, auth, functions) | Line illustrations of the product | Tiles that show the product rather than describe it |
| Modal | ABC Diatype, 45px, weight 500 | Sticky left feature nav. Containers drawn as dot matrices (training, inference, sandboxes) | Pixel-matrix 3D hexagon hero | Dot-matrix data imagery, which is cheap in SVG. Sticky section nav |
| Replicate | basier-square | Code sample next to its output. Model cards with run counts | Loud magenta/yellow gradient | Code-and-output pairing for "how it works" |
| Perplexity (hub) | GT Canon serif, 180px, weight 600 | Huge serif display, cinematic photograph, serif section titles fading in | Scroll-linked type fades | Very large serif display can carry an AI brand |
| Anthropic | anthropicSerif, 40px, over anthropicSans | An editorial paragraph is the hero. Illustrated research tiles | Hand-drawn illustration and restraint | Editorial seriousness. Safety and limits stated in plain prose |
| Claude Platform docs | anthropicSerif, 52px, weight 300 | Hero next to a tabbed code panel. A model-family card row | None | A calm developer onboarding layout |
| Cursor | CursorGothic, 26px (small headline), over EB Garamond and Berkeley Mono | A large product screenshot on a painterly landscape. Dated changelog on the homepage | Still imagery | A dated changelog as a trust signal (AIPSTER already has one). Product inside atmosphere |
| Arc | Exposure VAR serif, 76px, weight 600 (Iowan Old Style fallback) | The page is now "A farewell to Arc" (Arc is sunsetting on 22 Dec 2026) and uses handwritten signatures | Personal and letter-like | A serif with an Iowan Old Style fallback: a system serif can carry a premium voice |
| Framer | GT Walsheim, 54px, −2.16px | A glowing prompt box over the product canvas | Neon glow | Little. The glow is the generic AI look to avoid |
| Resend | Domaine (serif) 96px, Inter, Commit Mono | Serif display, SDK tabs with language icons, code panel | A 3D glass cube | A three-voice type system (serif display, sans UI, mono code) |
| Oxide | Suisse Intl, 65px, weight 400 | Spec grids with small live graphs. Terminal inset. "Fig." framing in its docs | A photoreal rack with LEDs | Spec-sheet grids. Instrument-panel status |
| PlanetScale | **ui-monospace (system mono), 16px, weight 700** for the `h1` and the whole page | Dense document layout, hairline logo table, in-page anchors | None | Proof that system fonts can read as premium. Document-first honesty |

### Award sites (Awwwards, October–November 2026)

- **DeepBook** (SOTD 3 Nov, Dev Award; https://www.awwwards.com/sites/deepbook): TWK Everett with Everett Mono eyebrows. A big-number stats strip with no charts. Two colours.
- **Heron AI** (SOTD 12 Oct; https://www.awwwards.com/sites/heron-ai): a spec-sheet metadata block (type, founded, focus, location), a numbered boot sequence, and building-code annotations on line drawings.
- **MECHA** (SOTD 31 Oct, Dev Award; https://www.awwwards.com/sites/mecha): Neue Haas Grotesk with separate heading, title, body and caption tokens. Heavy GSAP and Three.js. No reduced-motion query in the fetched CSS.
- **Lidar Drone Scanning** (SOTD 6 Oct; https://www.awwwards.com/sites/lidar-drone-scanning): a real-time WebGL point cloud as an "instrument" hero, set in Switzer and Proto Mono.
- **Darkmoon** (nominee 28 Oct; https://www.awwwards.com/sites/darkmoon-ai-pentest-platform): mono section indices, stat tiles, terminal blocks and a findings table with bars. `tabular-nums` appears 40 times. It uses CSS scroll-driven animation (`animation-timeline: view()`) and has 52 reduced-motion queries, so it is the reference for motion done safely without JavaScript.
- **Krea 3** (nominee 3 Nov; https://www.awwwards.com/sites/krea-3): Suisse Intl and Suisse Mono, tabular numbers throughout, tight tracking.
- **Messenger by abeto** (Developer Site of the Year 2025; https://www.awwwards.com/sites/messenger): a WebGL world you walk around in. It marks the top end of the craft and is not borrowable here.

### Cross-cutting patterns (2026)

1. **Product UI as the hero** (Linear, Cursor, Supabase, Oxide). For AIPSTER the product's most characteristic object is the fabric map: browser, API, nodes and heartbeats.
2. **A three-voice type system**: serif display, sans UI and mono data (Resend, Cursor, Railway, Zed). AIPSTER already owns a serif voice through its Georgia italic wordmark.
3. **Spec-sheet and technical-manual framing**: numbered figures and key/value blocks (Oxide, Heron). This fits a project whose credibility rests on stating evidence precisely.
4. **Tabular numbers and big calm numbers instead of decorative charts** (DeepBook, Krea, Darkmoon).
5. **Thin-line and dot-matrix technical imagery** (Linear, Modal, PlanetScale's ASCII topology). All of it can be drawn as inline SVG under a strict CSP.
6. **CSS scroll-driven motion with full reduced-motion coverage** (Darkmoon, Vercel), rather than GSAP or Lenis.
7. **Visible construction**: hairline grids and dashed guides (Vercel, Cursor, PlanetScale).

Looks deliberately avoided: neon prompt-box glow (Framer), rainbow gradient washes (Stripe, Replicate), WebGL heroes (MECHA, Lidar, Messenger), cream + serif + terracotta, near-black with one acid accent, and identical rounded card grids.

## 3. Constraints that decide what is borrowable

| Constraint | Source | Consequence |
|---|---|---|
| `/app` and `/admin` are served with `default-src 'none'; style-src 'self'; img-src 'self'` and no `font-src` | `website/src/worker.js:32` (`APP_CSP`) | **No web fonts in the panel** unless the worker's CSP adds `font-src 'self'`. That is a security-header change in `src/`, which this brief excludes. Every direction therefore uses system stacks (SF Pro / Segoe UI Variable, New York / Iowan Old Style / Charter / Georgia, SF Mono / Cascadia / Consolas). No inline `style=""` and no inline script. |
| `public/` is an explicit file allowlist; CSS may not contain `@import`, escapes, `data:` or remote URLs | `website/scripts/check.mjs` | Any new asset (fonts, SVG sprites) means editing the allowlist, which is a reviewed policy change. The prototypes inline their SVG in HTML. |
| Topology CSS is pinned: the `.topo-map` grid `150px 60px 172px 60px minmax(320px,1fr)`, an `@media (max-width:860px)` collapse, the `.bench-lane-grid` columns, and no `animation`/`transition`/`@keyframes` anywhere after the first `.topo` rule | `website/tests/fabric-overview.test.mjs` "topology stylesheet is responsive, static, and reduced-motion safe" | In Phase 2 the pinned declarations stay and a **container query** is added on the fabric card to collapse it, which is the fix for P2 #1. Motion for the panel goes in rules placed before `.topo`, or the test pin is updated in a reviewed assertion-only edit. |
| Video markup and rules are pinned (player is the first card content, a focus ring, the flush card rule) | `website/tests/hackathon-video.test.mjs` | The video can move inside its figure but keeps its DOM position and pinned rules unless the test is changed. |
| Overview markup is produced by `app.js` string templates (`topo-*`, `bench-*`, `pill`, `card`) with text pinned by tests | `website/public/app/app.js:91-330` | A real console redesign (KPI strip, node table, inspector) needs **presentation-only edits to `app.js` templates**: same API calls, same data, same caveat strings. All three directions need this. Direction B needs the most. |

No direction needs a framework or a build step. All three are plain HTML, CSS and, at most, one same-origin presentation script.

## 4. Live P2 issues from #88 and their root causes

1. **`/app` at 1024px: the topology overflows the Fabric flow card.** The pinned `.topo-map` grid needs about 762px plus gaps. The collapse is an 860px *viewport* query, but at 1024px the sidebar leaves the card about 680px. Fix: `container-type:inline-size` on `#fabric-flow-panel`, plus `@container (max-width: 47rem)` repeating the vertical collapse. The pinned declarations stay as they are.
2. **Landing header at 768px collides.** From 761px to 1000px `.app-topbar` stays a non-wrapping flex row. `.brand-lockup` has `min-width:0`, so the wordmark and "In development" badge shrink underneath about 700px of nav links. Fix: let the bar wrap, with `flex-wrap:wrap` and the brand at `flex:none`, or move the stacked layout's breakpoint to where the content stops fitting (about 900px).
3. **Cyclic custom properties in the `app/styles.css` dark block.** `--accent-soft:var(--accent-soft)` and `--warn-line:var(--warn-line)` are self-references, so both are invalid at computed-value time in dark mode and every use falls back to the initial value. Fix: give them real dark values (for example `--accent-soft:#1f2f29`, `--warn-line:#8a6a1f`).

Each prototype shows the fixed behaviour: the header holds at 768, the topology reflows inside its card at 1024 with the sidebar present, and there are no cyclic properties.

**Update for Phase 2.** While Phase 1 was running, upstream merged its own fix for all three issues: CSS-REPAIR-001 (`875efd3`, follow-up `42178f1`), with the regression test `website/tests/css-repair-001.test.mjs`. That test pins the mechanism:
- a max-width media rule of at least 1024px (and below 1440px) that stacks `.topo-map` to one column;
- `.app-topbar` stacking via `flex-direction:column` under a max-width rule of at least 768px, with the 760px block keeping `.wrap`, `.sponsors-line` and `.app-card`;
- a `@media (prefers-color-scheme: dark)` block in `app/styles.css` with concrete hex values for `--accent-soft` and `--warn-line`.

The Phase 2 rebuild keeps that test green and carries the same behaviour into the new layouts. It does not reintroduce the fixes as new work.

## 5. The three directions

Only the picked direction (B, `b-switchboard/`) and its screenshots ship in this PR. The A (`a-lab-notebook/`) and C (`c-mesh/`) prototypes are kept on Kainotomic's local research branch and are described here for the record.

Each has `index.html` (landing hero plus one key section), `app.html` (`/app` overview with the seeded demo account's data, plus three labelled fixture rows taken from the site's tests to show density and reflow) and `styles.css`, whose token block opens the file. Screenshots are in `screenshots/<direction>-{landing,app}-{1440,1024,768,390}-{light,dark}.webp`, captured by `capture.mjs`, which also prints an overflow report.

### A. Lab notebook (editorial / technical)

The site is laid out like a careful technical report. AIPSTER's habit of separating what is verified, proposed and not live becomes the page structure itself. The main column reads cleanly: a very large serif "Now you’re the ISP", the intro, the v0.2 cut as Fig. 1, and the four real steps as a numbered procedure. Every hedge moves into a margin note marked with a shape: a filled dot for in this build, a ring for proposed, a dashed ring for not live. In `/app` the overview becomes a status report. It opens with a plain serif sentence ("One resource, none reachable. Demo data."), then a counts row, with the topology and the throughput bench as numbered figures. The caveats that make today's panel a wall of grey text become sidenotes. Copper appears only on the wordmark, the selected section and the newest log entry.

- **Colour:**
  - Light: paper `#f6f8f5`, ink `#13211d`, forest `#1d4a3f`, copper `#a2521f`.
  - Dark ("night reading"): paper `#0f1513`, ink `#ece7dd`, forest `#9fd3bc`, copper `#e9a877`.
  - Status colours have their own light and dark values.
  - Contrast: text is at least 4.9:1, non-text at least 3.2:1.
- **Type:** Iowan Old Style / Charter / Sitka / Cambria / Georgia for body and display, system UI for controls, mono only for ids and times. Display is `clamp(56px…128px)` at weight 400. Serif body is 18px with 1.6 line height.
- **Layout:** a 72rem sheet with a 17rem margin column, which folds the notes inline below 60rem. Corners are 3–4px and the page is flat. There is one motion moment: the hero notes settle in.
- **Files:** `a-lab-notebook/{index.html, app.html, styles.css}`, screenshots `screenshots/a-lab-notebook-*.webp` (16).

### B. Switchboard (dense pro console)

Owners are operators of a small ISP for AI inference, so the product looks like a network operations console: dark first, dense, keyboard-led, in the style of Linear, Oxide and Modal. The landing hero pairs "Now you’re the ISP" with a real slice of the Overview rendered from the demo account's data. The next section is a "What's in this build" status matrix built from the README, using the same state marks as the console. Its signature is a visual language for honesty:
- Each heartbeat state has its own colour and its own shape: online a filled disc, stale a half disc, offline a hollow diamond, unknown a dashed ring.
- Anything unmeasured is a diagonal hatch, so "not measured" can never read as zero.

`/app` has:
- a grouped left rail;
- a jump field (visual only);
- a six-number summary strip;
- the fabric drawn as a patch-bay of browser, API and nodes, with request, heartbeat and result lanes;
- a dense resources table;
- a detail panel for the selected node, with every measurement hatched.

- **Colour:**
  - Dark: base `#101a17`, surfaces `#15211d` and `#1b2a25`, hairline `#263731`, text `#dce7e1`, muted `#8fa49b`, copper `#e39a5c` for primary actions and focus.
  - Dark states: online `#5fcb97`, stale `#e2b54e`, offline `#ef8576`, unknown `#9aa8f0`.
  - Light: base `#f3f5f2`, ink `#0f1f1a`, copper `#a24e16`.
  - Light states: `#1d7048`, `#85590a`, `#b42b1f`, `#4651b5`.
  - Contrast: text is at least 5.2:1, non-text at least 3.4:1.
- **Type:** SF Pro / Segoe UI Variable via `system-ui`, at 13–14px in the console. Display is `clamp(44px…88px)` at weight 650, −0.035em. Mono uses tabular, slashed-zero figures for data only.
- **Layout:** 4/6/8/12px radii, by level. One overlay shadow, on the hero window. One motion moment: the hero lanes draw in once.
- **Files:** `b-switchboard/{index.html, app.html, styles.css}`, screenshots `screenshots/b-switchboard-*.webp` (16).

### C. Mesh (cinematic / immersive)

Mesh tells the v0.2 story instead of explaining it.
- **Landing hero:** a full-bleed night-forest scene of personal meshes in inline SVG (50 nodes, 61 links). Copper marks capacity an owner chooses to share. The headline is set in large italic serif, the wordmark's own voice.
- **Manifesto:** the v0.2 voiceover lines next to the real player, ending on "AI is for everyone." The section is attributed as a direction, not proof.
- **"People you choose. Limits you set.":** one small mesh in four scenes. Own capacity lights up, a circle is drawn around the chosen people, limit rings show the real form defaults (50 jobs, 50,000 tokens), and one link is cut and marked revoked.
- **`/app`:** "Your mesh", an orbital fabric map with you at the centre, the API ring and the nodes as orbiting state shapes. It becomes a lane list in narrow containers. Big, calm numbers are hatched when unmeasured. The scene and orbit are labelled architectural, not live traffic.

- **Colour:**
  - Night: `#08211b` fading to `#051510`, surfaces `#0c2620` and `#11302a`, moss `#4b8a71`, mist `#d5e4dd`, muted `#93ada3`, copper `#f0a66b`.
  - Daylight: sage `#e8f0eb`, ink `#0f2a24`, copper `#a2521f`.
  - Contrast: body text 13.3–13.9:1, muted 6.6–7.6:1, copper 9.0:1 in dark and 4.9:1 on sage.
- **Type:** Iowan Old Style / Palatino / Georgia italic display at `clamp(3.5rem…10.5rem)`, system UI body at 17px with 1.6 line height.
- **Layout:** 8/14/22px radii. Motion is one load sequence (links draw in, nodes fade in) plus CSS scroll-driven scene reveals inside `@supports`, all gated on reduced motion. The static state is complete.
- **Files:** `c-mesh/{index.html, app.html, styles.css}`, screenshots `screenshots/c-mesh-*.webp` (16).

### Verification of the prototypes (this run)

- **`capture.mjs`:** 48 captures (3 directions × 2 pages × 4 widths × light/dark), every line `ok` with `docOverflow=0`.
- **P2 #2, header at 768px:** none of the header's links, buttons or badges overlap in any direction, light or dark (6–7 items checked each).
- **P2 #1, topology at 1024px with the sidebar present:** no fabric-card descendant extends past the card edge. Measured card / sidebar widths: A 747 / 216px, B 776 / 200px, C 702 / 240px.
- **P2 #3, cyclic custom properties:** none in any prototype stylesheet. The same detector run on the live `website/public/app/styles.css` reports `--accent-soft,--warn-line`, so the detector catches the real bug.
- **Policy:** no `style=""`, no `<script>`, no remote fonts or CSS, no `@import` in any prototype. Every referenced repo asset exists.
- **Not done in Phase 1:** axe or Lighthouse on the prototypes (planned for Phase 2 on the real pages), and keyboard walk-throughs.

### Recommendation

**B, Switchboard**, with two pieces taken from the others: A's margin-note treatment for the landing's caveats, and C's mesh scene as a smaller illustration on the landing's story section. Reasons:
1. The control panel is where owners spend their time. B is the only direction whose `/app` reads as a professional console on par with Linear or Oxide: density, the table, the detail panel, a grouped rail.
2. Its two signature devices, state shapes and hatching for unmeasured values, turn AIPSTER's honesty rules into something people can see at a glance. They also carry across the landing, `/app`, `/admin` and 404.
3. It is the cheapest to meet Phase 2's gates. It needs no web fonts, no large inline scene, and no scroll-driven motion to fall back from, which is the easiest route to Lighthouse ≥ 90 and accessibility ≥ 95.

**A** is the most distinctive editorial voice, but its console is more report than tool. **C** has the most memorable landing, but it costs the most in performance and motion work, and its console is the least dense.

## 6. Patterns borrowed per page

| Page | A. Lab notebook | B. Switchboard | C. Mesh |
|---|---|---|---|
| Landing hero | Very large editorial serif (Perplexity, Anthropic). Margin "status of this page" note (Tufte sidenotes). Video as "Fig. 1" (Oxide) | Product UI as hero: the real Overview slice (Linear, Cursor, Oxide). Single primary action (Raycast). Tight-tracked display (Vercel) | Illustrated network hero in SVG, standing in for WebGL (Modal; Lidar Drone and MECHA as the look, not the tech). Italic serif display (Perplexity, Resend) |
| Key section | The four steps as a numbered procedure with evidence notes, plus a line diagram (Oxide manual). Research figure with "Fig." captions | "What's in this build" status matrix (Oxide spec sheet, PlanetScale document honesty). State shapes reused from the console | The four steps as scenes of one mesh, with CSS scroll-driven reveals (Darkmoon) |
| Changelog / trust | Dated latest entries with a copper newest marker (Cursor changelog) | Sponsor strip with hairline dividers. Shipped rows dated to the 2026-10-31 check | Manifesto from the voiceover (Arc's letter-like honesty) |
| `/app` shell | Table-of-contents rail. Sticky hairline header | Grouped left rail, jump field, key-cap hints (Linear, Raycast). Square hairline frames (Cursor, PlanetScale) | Blurred sticky top bar and left rail (Vercel, Linear) |
| `/app` overview | Plain-language status sentence. Counts row (DeepBook big numbers). Topology and bench as figures with sidenotes | Six-number strip (Oxide, DeepBook). Patch-bay topology. Dense table with tabular mono figures (Krea, Darkmoon). Detail panel | Orbital map. Calm big numbers. Hatched "not measured" tiles |
| `/admin`, 404 (Phase 2) | Same report sheet, figures for DGM runs | Same console shell. Admin panels as dense tables and spec sheets | Same night palette, calmer panels. 404 as an empty mesh |
| Applies to all three | Container-query topology, shape+colour state marks, hatched unmeasured values, system font stacks, reduced-motion gates, one motion moment | ← | ← |

## 7. Phase 2 implications and decisions for Andrew

- **Presentation-only `app.js` edits:** all three directions need them, to the Overview render templates (`renderStatus`, `renderFabricFlow`, `fabricFlowNode`, `fabricBenchLane`, `loadOverview` cards). The API calls, data and caveat wording stay the same. Assertions in `fabric-overview` and `qa-ui` that pin markup strings would be updated as reviewed assertion-only edits. The pinned topology CSS stays, and the container query sits alongside it.
- **Decision 1, B's jump field and selectable detail panel:** these would be new UI behaviour, a ⌘K jump field and row selection. Recommendation: ship B's layout with the detail panel showing the first or only node (no selection), and the jump field left out. Then propose ⌘K as a separately reviewed follow-up, so "behaviour unchanged" holds.
- **Decision 2, web fonts:** not needed. All three directions are designed around system stacks. Adding self-hosted fonts would mean a CSP `font-src 'self'` change in `src/worker.js` plus allowlist edits in `scripts/check.mjs`. That is outside this brief.
- **Decision 3, wordmark swap:** all three prototypes switch the light and on-dark wordmark with `<picture>` / `<source media="(prefers-color-scheme: dark)" srcset>`. That needs `scripts/check.mjs` to accept `srcset` (a policy edit), or the swap can be done with two `<img>` elements toggled by CSS, which needs no policy change. Recommendation: two `<img>` elements.
- **Repo weight:** the 48 prototype screenshots total about 11 MB of WebP. For the Phase 2 PR, I would keep only the chosen direction's prototype screenshots, plus the real before and after evidence.
- **Content note:** the README's 2026-10-31 "Not in this build" list predates the PR #50 merge (model catalog). B's matrix marks the catalog "Merged, deploy unverified" instead of repeating the stale claim.

## 8. Mobbin component references (Phase 2)

Read-only searches (`search_screens`, web). Nothing was saved, collected or commented on Mobbin.

| Component | Screens | What we took |
|---|---|---|
| Dense resource tables with status | [Vapi monitors](https://mobbin.com/screens/1965682c-0c4e-4146-a0fb-864ad2eabf2d), [Tailscale services](https://mobbin.com/screens/ab0d198c-9365-457a-bdeb-84b210f325ce), [Snowflake services and jobs](https://mobbin.com/screens/8439d88b-17ea-4d9a-bdf0-0ea02f868c7a), [Render overview](https://mobbin.com/screens/94ccd75a-fb20-4444-8015-b32853c2b6f7), [Cloudflare domains](https://mobbin.com/screens/1ba36f21-a7a5-4f0b-8924-48c0997af10e) | A compact header row, a status column with dot plus label, ids in small mono under names (Tailscale), a count chip above the table, hairline row dividers, no zebra striping |
| Grouped sidebar navigation | Vapi, Cloudflare, Render | Section group labels (Build / Test / Observe), a filled selected row, account and status pinned at the bottom of the rail |
| Admin users table | [Google Workspace admin users](https://mobbin.com/screens/c7e98dbc-32a0-4f57-8cef-3659ebfc0899) | Table toolbar above the table, rows-per-page and paging in the footer |
| Empty states | [Laravel Cloud first application](https://mobbin.com/screens/b54903e7-e288-4eb2-8e47-12c2e1423976), [Whop connected accounts](https://mobbin.com/screens/bb43b054-7de7-457e-b8f8-2a6694b4aff3), [Steep get started](https://mobbin.com/screens/b026462f-39da-445e-b451-36da6d487c49) | One sentence plus the single existing action, centred inside the panel the data would fill, never a bordered card that looks like content |
| API keys | [fal API keys](https://mobbin.com/screens/65014a52-faa9-4485-9a7c-9a5def56e22c), [Midday key created](https://mobbin.com/screens/9e457f8a-1f4f-4446-af95-1941664bc0aa), [Greptile API keys](https://mobbin.com/screens/b70d98e5-0132-4b84-a089-df0b9fc6d838) | Keys table with a masked mono key column, a "shown once" reveal panel with copy, a create action in the panel header |
| 404 | [Coinbase developer platform](https://mobbin.com/screens/7484e648-c0ba-4ffa-888c-30c36d53ab32), [Assembly](https://mobbin.com/screens/02f7c160-dab5-4750-8997-851215225131) | A plain "Page not found" headline, one sentence, a single route back inside the product's own chrome |


## 9. Phase 2: the design system as built (direction B, Switchboard)

Andrew picked B on 2026-11-03. The landing also borrows A's margin notes for its caveats and a small version of C's mesh scene for its story section.

- **Tokens.** One block, identical at the top of `public/styles.css`, `public/app/styles.css` and `public/admin/styles.css`. Light is the default; dark comes from `prefers-color-scheme`. The block holds:
  - colour (surfaces, text, copper action and focus, brand bar, the four heartbeat states each with a tint, demo, hatch, selection);
  - the type families: SF Pro / Segoe UI Variable via `system-ui`, Iowan Old Style / Charter / Georgia, and `ui-monospace` with tabular figures;
  - a type scale of 12.5 / 13 / 14 / 16 / 20 / 26 / 34px plus a display clamp of 44–88px;
  - a 4px spacing scale;
  - radii that encode level (4 / 6 / 8 / 12);
  - two elevations;
  - motion durations of 120 / 240 / 640ms.

  Measured contrast is written in the block's header: text at least 5.3:1, non-text controls at least 3.4:1.
- **Signature devices.**
  - Each heartbeat state has a shape as well as a colour: online a filled disc, stale a half disc, offline a hollow diamond, unknown a dashed ring.
  - Unmeasured values are drawn as a diagonal hatch and never as zero.
  - Every number is set in tabular mono figures.
- **Components.** Sticky top bar; grouped section rail that becomes a horizontal scroller below 960px; one button system (primary copper, secondary, danger, disabled with a dashed border); labels above 40–44px fields on a responsive grid; hairline panels with header rows; dense row lists and tables in focusable labelled scroll regions; status pills; key/value spec blocks; KPI strip; patch-bay topology; hatched measurement bench; code and secret reveal panel; empty, loading, denied and error states; slim tinted notes; margin notes (landing); "What's in this build" status matrix (landing); 404 panel.
- **Motion.** One load moment on the landing (the hero lanes draw in) and a scroll-linked draw-in of the mesh where supported. All motion sits inside `prefers-reduced-motion: no-preference`. The topology rules keep no motion, as `fabric-overview` requires.
- **Behaviour unchanged.** Every route, element id, form field, API call, request body and caveat string is the same. The JS edits are presentation only: markup and classes in render templates, plus one `paintState` helper in `admin.js` that sets the same text as before and adds a `data-tone` attribute for styling. No test was edited.
- **Evidence.**
  - `evidence/lighthouse-summary.json`, `evidence/axe-before.json`, `evidence/axe-after.json`.
  - `screenshots/before/` and `screenshots/after/`: 88 captures each. Every page is at 1440 / 1024 / 768 / 390 in light and dark; the nine secondary `/app` tabs and the admin synthetic demo are at 1440 and 390.
  - Admin "granted" captures use Playwright route mocks built from the admin UI tests' own fixtures, because an admin grant needs GitHub OAuth.

### Proposed follow-up, not built: ⌘K jump

Proposed: a ⌘K / Ctrl+K command palette in `/app` and `/admin` that filters the existing section names and moves focus to the chosen tab or section. It would be keyboard-first (arrow keys, Enter, Esc), with `role="dialog"` and `aria-modal`, and return focus on close. It would make no API calls and include no search over data. It is new behaviour, so it should go through review as its own PR with tests for focus handling and no change to tab semantics.
