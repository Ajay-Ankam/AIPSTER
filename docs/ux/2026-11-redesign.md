# Website UI/UX redesign, November 2026

Sponsored work from Kainotomic. This is a presentation-layer change: every route, API call, form field, element id and script behaviour stays the same. Nothing under `website/src/`, `website/migrations/`, `website/scripts/` or any `*.js`/`*.mjs` file changes.

## 1. Map

### Surfaces and where people spend time

| Surface | Route | Shell / styles | Who | Notes |
|---|---|---|---|---|
| Public landing | `/` | `public/index.html`, `public/styles.css` | Everyone, hackathon judges | Video, proposition, research diagrams, progress log |
| Not found | any unknown path (404) | `public/404.html`, `public/styles.css` | Everyone | Worker `not_found_handling: 404-page` |
| Control panel | `/app/` | `public/app/index.html`, `public/app/styles.css`, `public/app/app.js` | Signed-in owners, demo account | 1 sign-in view + 10 tabs; the product surface |
| Administration console | `/admin/` | `public/admin/index.html`, `public/admin/styles.css`, `public/admin/admin.js` | Operators with an admin grant | 15 read-only panels + synthetic demo |
| DSH × DGM experiment | `/app/experiments/dsh-dgm/index.html` | own `styles.css` + `site.css` | Admins only | **Not changed**: its `styles.css` must stay byte-identical to the reviewed copy in `experiments/dsh-dgm-adapter` (`tests/dsh-dgm-experiment.test.mjs`) |
| Local worker tray | Windows tray menu (`local-worker/packaging/aipster_tray`) | Win32 native menu + 3 `.ico` states | Owners who installed the worker | **Not changed**: native OS menu, no packaged installer is published yet ("Installer coming soon" in the panel), so the website is where people actually spend time |

### Control panel (`/app/`)

`app.js` toggles `#view-login` / `#view-app`; tabs are `button[role=tab][data-tab]` switching `section[role=tabpanel]`. All calls go through `api()` (same-origin, server-authorized).

| View | Element | Reads | Writes | Tests |
|---|---|---|---|---|
| Sign in | `#view-login` | `/api/auth/get-session` | GitHub OAuth start, demo username/password sign-in | `ui-session`, `demo-auth`, `f77-auth-routes`, `public-signup` |
| Overview | `#tab-overview` | `/api/status`, `/api/usage`, `/api/inventory`, `/api/shared-with-me`, `/api/catalog/summary` | none | `fabric-overview`, `status`, `qa-ui`, `ui-heartbeat` |
| My Compute | `#tab-compute` (`#connect-card`, `#resource-form`, `#compute-list`) | `/api/inventory` | `/api/pairing/codes`, resource registration | `ui-connect-card`, `ui-connect-platforms`, `ui-pairing-repair`, `pairing*`, `heartbeat-paging` |
| Shared With Me | `#tab-shared` | `/api/shared-with-me` | none | `qa-ui` |
| Sharing | `#tab-sharing` (`#grant-form`, `#grant-list`) | `/api/grants` | create / `DELETE /api/grants/:id` | `access-revocation`, `qa-ui` |
| Models | `#tab-models` (catalog, assets, upload, deployments) | `/api/catalog/search`, `/assets/:repo`, `/my-assets`, `/deployments` | `/api/catalog/compat`, `/plans`, `/deployments`, `/uploads`, cancel | `ui-models`, `ui-uploads`, `catalog-*` |
| Federation | `#tab-federation` (nodes, invitations, connections, preview/commit, grants, denies, authz) | fabric endpoints | node register, invite, accept, preview, approve/commit, deny | `fabric-f1*`, `qa-f1r-ui-extra`, `federation-*` |
| API Keys | `#tab-keys` | `/api/keys` | create / `DELETE /api/keys/:id` | `qa-ui`, `heartbeat-*` |
| Usage | `#tab-usage` | `/api/usage` | none | `qa-ui` |
| Advice | `#tab-advice` | `/api/advisor` | advisor request (opt-in) | `advisor-ui`, `advisor` |
| Settings | `#tab-settings` | `/api/settings`, `/api/audit` | display name | `qa-ui` |

### Administration console (`/admin/`)

Panels: synthetic demo, overview, fabrics, resources, metrics, access (users, sessions), operations, tickets, engineering, audit, data coverage, DGM preview (status, runs, run detail, state matrix), DGM Muse proposal. Reads `/api/admin/v1/{status,overview,resources,access/users,access/sessions,operations/health,audit,coverage,dgm/preview/runs,dgm/preview/muse}`; mutations are disabled except the gated DGM preview run/Muse request. Tests: `admin-ui`, `admin-audit-ui`, `admin-milestone1-ui`, `dgm-preview-ui`, `dgm-muse-ui`, `admin-*`.

### Landing (`/`) and 404

Sections: sponsors strip, application card (top bar + nav + sign-in, v0.2 video + caption + transcript, hero copy, "intended experience" steps), direction/principles, research diagram, model & LoRA diagram, progress (changelog + blog trace), footer. No data reads. Tests: `hackathon-video` (player is the first card content, pinned focus ring, flush card rule), `scripts/check.mjs` + `check.test` (allowlist, CSS/markup policy, required copy), `favicon`.

### Constraints that shaped the design

- `scripts/check.mjs` forbids remote CSS content, `@import`, CSS escapes and any file outside the explicit allowlist, so there are no web fonts and no new files under `public/`. The token layer is repeated at the top of the three stylesheets with identical names and values.
- `fabric-overview` forbids `transition`/`animation` anywhere after the first `.topo` rule and pins the topology grid declarations; those rules are kept verbatim except colour tokens and minimum font sizes.
- `hackathon-video` pins the video's DOM position and three CSS rules; all are kept.

## 2. Audit (before, 45c9eb7)

Evidence: `screenshots/before/*` (32 full-page captures, 1440×900 and 390×844), `evidence/axe-before.json`, `evidence/lighthouse-summary.json`.

Accessibility (WCAG 2.2 AA):
1. Landing contrast failures, 7 nodes: 10–11px labels `#60746b`/`#64736a`/`#68796e` on paper at 4.36–4.45:1 (axe, Lighthouse).
2. Landing scroll traps: `.changelog` and `.blog-trace` were fixed-height scroll regions that cannot be reached by keyboard (axe `scrollable-region-focusable`).
3. Wordmark links: `aria-label="AIPSTER home"` hid the visible "In development" / tagline text (axe `label-content-name-mismatch`, 2 nodes).
4. Control panel: the Experiments link rendered UA-default blue on the dark panel (contrast failure); status labels in the topology failed contrast.
5. Focus ring `#bd8d30` on paper is 2.78:1, under the 3:1 non-text minimum.
6. Admin console mobile: CLS 0.19, the authorization line rewrapped the sticky header after load (Lighthouse performance 91).
7. Landing: three progress images had no intrinsic size (layout shift risk); the 275px wordmark comp was upscaled to card width.

Hierarchy, type and spacing:
8. Type below a readable floor across the landing: 9–11px uppercase labels, 10–11px notes, footer and changelog dates.
9. Tracked all-caps labels on every section eyebrow, competing with the serif headlines.
10. Landing: at 1440×900 the hero headline sat below the first screen; the 16:9 video took the full card width.
11. Control panel: browser-default headings (2em bold sans) with no scale; every card and form looked the same weight.
12. Forms: every field stacked full-width in one column (Federation was ~3,900px tall at desktop); secondary buttons (`Done`, `Copy curl`, `Cancel`, `Retry`) were unstyled UA buttons on the dark theme.
13. Empty states ("No nodes yet…") were small bordered cards indistinguishable from content.

Navigation and responsiveness:
14. Control panel tabs: 10 buttons wrapping to 2 rows at desktop and a 5-row button wall at 390px before any content.
15. Control panel mobile top bar: name and "Sign out" wrapped to two lines each.
16. Landing mobile nav: five 11px links squeezed into one line.
17. Brand continuity: "Sign in" moved from the light forest landing to a navy/copper dark panel and a separate "A"-glyph admin header (the generic glyph the favicon work had retired); the 404 still showed the old text logo "AIPSTER / Research project".

## 3. Direction

**Service panel.** AIPSTER asks owners to act as a small provider of their own capacity. The interface should feel like the owner's service panel: calm, legible, precise about state, and plainly the same product from the landing page through sign-in to the console. The approved wordmark (copper italic "Ai", forest "PSTER", Georgia) is the one expressive element; everything else stays quiet.

Research references. The brief asked for Mobbin (`search_screens` / `search_flows`); the Mobbin MCP was not available in this session, so no Mobbin screens are cited. The direction instead follows public design-system guidance:
- GitHub Primer, navigation and forms patterns (https://primer.style/): vertical side navigation for settings-style products with many sections, label-above-field forms, explicit empty states.
- Vercel Geist (https://vercel.com/geist): dashboard shell with a sticky top bar and left section rail; scrolling tab strip on small screens.
- Radix Colors (https://www.radix-ui.com/colors): paired light/dark scales with tinted status backgrounds rather than coloured outlines.
- WCAG 2.2 (https://www.w3.org/TR/WCAG22/): 4.5:1 text, 3:1 non-text and focus indicators, 24px target minimum, reduced motion, no keyboard traps.

### Tokens

Identical at the top of `public/styles.css`, `public/app/styles.css`, `public/admin/styles.css`.

| Token | Light | Dark (control panel only) | Use |
|---|---|---|---|
| `--paper` | `#f5f7f3` | `#0f1715` | page |
| `--surface` | `#ffffff` | `#16211e` | cards, fields |
| `--sunken` | `#ecf1eb` | `#0b1210` | alternating bands, code |
| `--ink` / `--ink-2` | `#11292b` / `#43585a` | `#e6eeea` / `#a4b6af` | text / secondary text |
| `--line` / `--control` | `#d3ddd4` / `#7e9488` | `#26352f` / `#5f756c` | dividers / field and button borders (≥3:1) |
| `--forest` | `#143b34` | — | top bars, footer, brand |
| `--accent` / `--on-accent` | `#1e5e49` / `#fff` | `#f2b887` / `#14201c` | primary action, links, selection |
| `--copper` | `#a2521f` | `#f2b887` | the wordmark's "Ai" colour, the headline's ISP, newest log entry |
| `--focus` | `#8f6514` | `#f2b887` | focus ring (4.8:1 on paper) |
| `--ok` `--warn` `--bad` (+ `-bg`) | `#1f6b43` `#7a4f00` `#a8231b` | `#7cc4a4` `#e8b04f` `#f08a80` | status text on tinted fills, all ≥5.6:1 |

Measured contrast (text/background): ink 14.2, ink-2 7.0 on paper and 6.6 on sunken, accent 7.1, white on accent 7.6, copper 5.2, dark-mode ink 15.4, ink-2 7.8, copper 9.4.

Type. No web fonts are allowed by the site's CSS policy, and the brand is already Georgia: Georgia for display and page titles, the system UI stack for interface and body text, `ui-monospace` for secrets, codes and commands. Scale is a major third on a 16px base: 13 / 16 / 20 / 25 / 31 / 39 / 49px, display `clamp(44px, 5.6vw, 76px)`. 13px is the floor. Labels are sentence case; all-caps tracking is gone from the landing and panel chrome.

Spacing is a 4px base (`--space-1`…`--space-9` = 4, 8, 12, 16, 24, 32, 48, 64, 96px). Radius encodes level: 6px controls, 10px cards, 16px the landing's application card. Shadows only on the landing card and the panel's toast.

Motion: none on load; a 120ms colour change on buttons only; `prefers-reduced-motion` keeps the existing overrides.

## 4. Before / after per page

| Page | Before | After |
|---|---|---|
| Landing `/` | Full-width video pushed the headline off the first screen; 9–11px uppercase labels; nested scroll boxes for the changelog and blog; 7 contrast failures | Video and its caption side by side at ≥1100px, so the headline is on the first screen at 1440×900; one type scale with a 13px floor; sentence-case labels; progress log and changelog flow with the page (a dot timeline marks the newest entry in copper); wordmark link names fixed; sized images; mobile nav fits on one row with Sign in pinned beside the wordmark |
| 404 | Old text logo "AIPSTER / Research project", unaligned | Current SVG wordmark and "In development" lockup, display scale headline |
| Control panel, sign-in | Full-width form in a 1000px card, two equal primary buttons | 28rem card; GitHub is the one primary action; demo sign-in is a secondary path under a divider |
| Control panel, shell | Dark navy theme unrelated to the landing; 10 wrapping tab buttons | Forest top bar with the wordmark; light theme by default with a full dark theme via `prefers-color-scheme`; left section rail at ≥960px, single scrollable tab strip (sticky) below |
| Control panel, tabs | Default headings, one-column forms, UA-styled secondary buttons, small empty-state cards | Georgia page titles; forms on a responsive 2–3 column grid with labels above 44px fields; one button system (primary / secondary / danger / disabled); tinted status pills; dashed full-width empty states; inline error blocks; secret reveals as a warning panel |
| Admin console | "A" glyph header, 0.72rem uppercase labels, CLS 0.19 on mobile | Wordmark header, shared tokens and focus ring, 13px floor, header reserves the authorization line so it no longer shifts |
| DSH × DGM experiment | — | Unchanged (reviewed byte-identical stylesheet) |

## 5. Evidence

- Screenshots: `screenshots/before/` (32) and `screenshots/after/` (32 light + 22 dark control-panel captures), every page at 1440×900 and 390×844, signed in as the seeded demo account against a local `wrangler dev` with a local D1.
- axe-core 4 (WCAG 2.0/2.1/2.2 A+AA rules) on every captured page: 28 violation nodes before, 0 after in light and 0 in dark (`evidence/axe-*.json`).
- Lighthouse 12 on `/`, `/app/`, `/admin/` (mobile and desktop presets): `evidence/lighthouse-summary.json`. The 404 page is not scored by Lighthouse because it returns HTTP 404.

Remaining items outside this change: the landing's diagram PNGs could ship as WebP/AVIF (Lighthouse estimates ~470 KiB saved) but they are reviewed assets on the allowlist; `/app/` has no meta description (SEO 91); `/admin/` logs the expected 401 when signed out (best practices 96); the panel's tabs use button focus order rather than roving arrow-key focus, which would be a behaviour change.
