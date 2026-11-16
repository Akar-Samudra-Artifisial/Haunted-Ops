# Design Document
## Overview
The page around the Scene becomes a two-column workspace: the Scene (or the table) on the left, a 360 px Panel on the right with the Summary bar, the Hunt as a Timeline and the Legend. The change is almost all CSS and small React components. No scene file changes except the `bg` (and `focus`) value of the palette, and the API, the shared package and the data flow do not change.
Three choices carry the design. First, tokens: every colour, size and space is a custom property of `:root`, so the contrast test can read them and the Scene palette can be checked against them. Second, one DOM: the table keeps its DOM, roles and focus order, and card mode is CSS only (`data-label` and `::before`), so Accessible mode keeps its promises. Third, weight: icons are inline SVG paths in one module, styles are CSS, and the replay chunk moves nothing into JS, so the entry and replay budgets hold.
## Architecture
```
styles.css :root tokens ──> every rule (colours only as var(--…))
        │                      └─> a11y/contrast.test.ts reads the tokens, checks CONTRAST_PAIRS
        └─ scene/palette.ts (bg, focus only) ── model.test.ts: CSS and Scene share them
App
 ├─ Header (name, line, connection pill, mode switch)
 ├─ main grid ≥ 64rem: [ Scene | TableMode ]  [ <aside aria-label="Incident"> ]
 │                                              ├─ SummaryBar (summarize(services, hunt))
 │                                              ├─ HuntSection (Timeline, diagnosis card, evidence, ProposalBlock) or empty state
 │                                              └─ Legend (<details>, localStorage)
 └─ LiveAnnouncer (the one live region)
```
- `apps/web/src/styles.css`: tokens, grid, header, panel, timeline, cards, table, legend, replay pages, motion.
- `apps/web/src/components/icons.tsx`: the Icon module (one `<svg>` wrapper and a map of path strings).
- `apps/web/src/components/SummaryBar.tsx` and `summary.ts` (pure `summarize`).
- `apps/web/src/components/Legend.tsx` and `legend-state.ts` (read and write of the stored choice).
- `Header.tsx`, `HuntSection.tsx`, `TableMode.tsx`, `App.tsx`, `replay/ReplayApp.tsx`, `replay/ReplayControls.tsx`, `index.html`.
- `scripts/check-scene-bundle.mjs` (entry budget), `.kiro/steering/a11y-perf.md`, `.kiro/steering/structure.md`, `docs/KIRO_USAGE.md`.
## Components and Interfaces
### Tokens (`styles.css`)
```css
:root {
  --bg:#0B0A12; --surface:#16141F; --surface-2:#211E2E; --line:#3A3550;
  --text:#EDEAF6; --text-muted:#A39DB8;
  --lantern:#F4B860; --danger:#FF5C7A; --fog:#7FD4E6; --ecto:#9BF2C4; --focus:/* passes on --bg and --surface */;
  --font-display: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --font-ui: system-ui, …; --font-num: ui-monospace, "SF Mono", Menlo, monospace;
  --step--1 … --step-3; --space-1 … --space-6; --radius-1; --radius-2; --shadow;
}
```
Every number uses `font-family: var(--font-num); font-variant-numeric: tabular-nums`. Contrast: `CONTRAST_PAIRS` in `palette.ts` and the CSS pairs in `contrast.test.ts` list text and muted text on bg, surface and surface-2, each status colour as text on its surface, and `--focus` on bg and surface. The ratio is the WCAG relative-luminance ratio already in the test. If a token fails AA, its lightness is raised or lowered (hue and chroma kept) and the final value is recorded under "Contrast results" below.
### Layout
`.layout` is a grid: one column by default; at `min-width: 64rem` it is `minmax(0, 1fr) 360px`. `minmax(0, 1fr)` and `min-width: 0` on the left cell stop a wide child from pushing the page sideways. In Accessible mode the left cell holds the table, and the Summary bar comes first in the DOM before the table. Below 64rem the Panel follows the left cell in DOM order, so the focus order is the same at every width.
### Header
Product name (`--font-display`), the one-line explanation, the connection pill, the mode switch as `button.secondary`. DOM order: Skip link, mode switch, then the rest, as `accessible.spec.ts` expects.
### Summary bar (`summary.ts`, `SummaryBar.tsx`)
```ts
type Level = 'calm' | 'uneasy' | 'haunted' | 'possessed' | 'dark';
summarize(services: ServiceState[]): {
  counts: Array<{ level: HauntLevel; count: number; word: string; symbol: string }>;   // levels with count > 0, worst first
  huntState: string | null;   // "Hunt running · 5 steps" | "Hunt queued" | "Diagnosed" | "Fix proposed" | "Fix merged" | null
  running: boolean;
}   // the hunted service is chosen by huntedService(services): running, queued, a proposal, then a diagnosis
```
`summarize` is pure and total. `counts` is built from the same `services` the table reads, so the sum equals `services.length`. The text is `"<n> <word>"` joined with ` · `, each count preceded by the level mark of `status-marks.ts`. `stepCount` is the steps done, so the text is "Hunt running · N steps", never "x of y". The component is a `<p>` (not `role=status`, not `aria-live`).
### Panel and hunt (`HuntSection.tsx`)
The step list is `<ol class="timeline">`; each `<li>` has a dot (CSS pseudo-element), a line to the next dot, the tool name with its icon, a `<time>` and the summary. The diagnosis is `<section class="card card--diagnosis">` with the culprit, the summary and the "AI generated" label as before. Evidence is a `<ul class="evidence">`. `ProposalBlock` is a card; its status is `<span class="pill pill--<status>">`; the pull request link keeps its text and `href` and gets `class="button"`. The empty state is one sentence ("The Exorcist's steps, its diagnosis and the fix proposal appear here when a hunt starts."). Icons are `<svg aria-hidden="true" focusable="false">`.
### Table and cards (`TableMode.tsx`, `styles.css`)
Each `<td>` gets `data-label="<column header text>"` from the same column list that draws the headers. The header is `position: sticky; top: 0`. Below `40rem`:
```css
@media (max-width: 40rem) {
  table, tbody, tr, td { display: block; }
  thead { /* visually hidden, still in the DOM */ }
  td::before { content: attr(data-label); }
}
```
Setting `display: block` on table elements makes some engines drop the table role from the accessibility tree, so the roles `table`, `row`, `columnheader`, `cell` are written as explicit attributes on the elements, and the header row is clipped with the visually-hidden pattern (not `display: none`). The DOM, the focus order and the Escape rule do not change.
### Legend (`Legend.tsx`, `legend-state.ts`)
```ts
const LEGEND_KEY = 'haunted-ops:legend';
readLegendOpen(storage): boolean   // nothing stored → true; stored 'open' → true; stored 'closed' → false; throws → true
writeLegendOpen(storage, open: boolean): void  // ignores a throwing storage
```
`<details open={initial} onToggle={…}>`. Rows are a `<dl>` or `<ul>` of glyph, term and meaning. Glyphs are decorative inline SVG made of simple shapes (a ghost body from a path and two dots, wavy fog lines, a dark square with a small window, a lantern, a green mist blob) and the five level marks come from `format.ts`.
### Motion
`transition: … 150ms` on hover, focus and open only; `@keyframes soft-pulse` on `.pill--running`. `@media (prefers-reduced-motion: reduce)` and `[data-mode="accessible"]` set `transition: none; animation: none` (extending the block at `styles.css:187-198`).
### Replay pages
`ReplayApp.tsx` renders the list as `<ul class="cards">` of cards (title, scenario pill, date, duration) and, with no replays, an empty state with a link to `/`. `ReplayControls.tsx` is one `role="toolbar"` with the same buttons and names, each with an icon from the Icon module and a text label; the range input is styled in CSS. The banner stays where it is. All new rules are CSS in `styles.css`; the JS delta of the chunk is the icon imports (shared with the entry through the Icon module, so no copy).
### Document (`index.html`)
`<meta name="description" content="…">`, `<meta name="theme-color" content="#0B0A12">` and `<link rel="icon" href="data:image/svg+xml,…">` with a URL-encoded SVG lantern. The CSP allows `img-src data:`.
### Bundle budget
The entry is 90.4 of 92 KiB gzip. The new components, the Icon module and the CSS go into the entry. If the measured entry is above 92 KiB, `BUDGETS.entry` is raised to the measured number rounded up plus a small margin, never above 94 KiB; the measured number and the reason are written in the comment of `check-scene-bundle.mjs` and under "Budget record" below. If it fits in 92 KiB, nothing is raised. The replay budget stays 6800 bytes.
## Data Models
None. The spec adds no table, no API field and no shared type. `localStorage` gets one key (`haunted-ops:legend`) with the value `open` or `closed`.
## Contrast results
Every pair passes with the tokens as given; no token's lightness was adjusted. `--focus` stays `#ffd866` (the scene ring), `--selected` is `#312827` (lantern at 12% over `--surface`). Measured ratios of the key pairs: see the test table in `a11y/contrast.test.ts` (it runs every pair on `--bg`, `--surface` and `--surface-2` in both modes). The normal-theme `--line` is a decorative border and is checked at 3:1 in Accessible mode only (`#9a93b3`). The scene `CONTRAST_PAIRS` are unchanged: only `night` changed (`#0b0a12`) and it still passes there.
## Budget record
Measured on the build of this spec: entry 92.3 KiB gzip (2 files; the 92 KiB budget failed by 0.3 KiB), replay chunk 6581 bytes gzip (budget 6800), scene file 97.3 KiB. `BUDGETS.entry` is raised from 92 to 94 KiB because the new components, the Icon module and the page code live in the entry. No dependency was added. The reason is also in the comment of `scripts/check-scene-bundle.mjs`.
## Part 2: the Scene and four fixes
### Overview
Part 2 is "a lantern in a dark house" inside the PixiJS scene chunk, plus four fixes of the page. The level of a room decides how it looks (one table), fog is its own layer, a level rise gives one soft pulse, and a Hunt puts a green mist over its room. Ghosts, fog, sky and rooms are redrawn from code. The entry chunk and `scene/hooks.ts` do not change (the replay chunk imports `hooks.ts`).
### Level to look (`model.ts`)
```ts
interface RoomLook { glow: number; danger: number; edge: number; outline: 'trim' | 'edge' | 'danger'; outlineAlpha: number; ghostMin: number }
const LEVEL_LOOK: [RoomLook, RoomLook, RoomLook, RoomLook, RoomLook]  // calm, uneasy, haunted, possessed, dark
lookOf(level, dark): RoomLook      // the dark row when dark
ghostFloor(level): number          // largest ghostMin up to the level: never falls as trouble grows
```
| level | glow | danger tint | cold edge | outline | ghosts |
| --- | --- | --- | --- | --- | --- |
| calm | 0.25 | 0 | 0 | quiet trim, 0.35 | none |
| uneasy | 0.4 | 0 | 0.55 | the cold edge | as the errors say |
| haunted | 0.7 | 0.35 | 0.2 | trim, 0.5 | visible |
| possessed | 1 | 0.6 | 0 | danger, 0.9 | at least 6 when the trouble is errors |
| dark | 0 | 0 | 1 (thin) | the cold edge | none |
`RoomVisual` gets `look` and `mist` (a Hunt entering or working); `light` is `look.glow` (no longer scaled by errors or p95). Calm rooms get no ghost; dust motes are only in lit rooms and not in Low quality. The summary text of a room does not change.
### Animator and Frame
`RoomFrame` gets `tint`, `edge`, `alarm` (danger outline), `pulse`, `mist`, `mistX`, `mistY` and `fogLayers[3]` (`x`, `y`, `alpha`); `Frame` gets `parallax {x, y}` and `roofAlpha`. All values approach their targets with the existing transition, and jump with Reduced motion.
- **Pulse**: `glowPulse(start, now) = sin²(π·t)` for `t` in (0, 1) over `GLOW_PULSE_MS` (2000 ms): one rise, one fall. It starts when the level of a lit room rises (never at first sight), at least `GLOW_PULSE_GAP_MS` (1000 ms) after the last start; none in Low quality or Reduced motion. The glow changes direction once per pulse, so the no-flashing rule (3 per second) holds.
- **Ghosts**: `ghostSpec` spreads slots on a golden-ratio sequence (the seed only rotates it). `fill` adds a sine sway to x and rotation, and eases the fade: `alpha = target · smoothstep(a / target)` while fading in.
- **Fog layers**: three noise sprites per room, drift `x = amp·sin(t·speed + phase)` with speeds `FOG_DRIFT` (periods about 30 to 80 s), inside the floor (`amp ≤ 0.55` floor halves). Low quality keeps layer 0 and holds it still; Reduced motion holds all of them still.
- **Camera**: there is no zoom. The camera is the focused room: `parallax` moves toward it by at most `PARALLAX_PX` (10 px) plus a sway of 3 px; the far stars move 30 %, the near stars 100 % and the moon 15 % of it. `roofAlpha` goes to 0.15 while a room is focused. Low quality and Reduced motion: parallax 0.
- **Mist**: two ecto-tinted noise sprites per room, alpha 0.5 and 0.35 times `mist`, drifting a little (`mistX`, `mistY`; 0 under Reduced motion).
- **Dust**: the mote pool, 0 in Reduced motion (the Animator hides it), 0 in Low quality (the model).
### Drawing (`textures.ts`, `shapes.ts`, `pixi-surface.ts`)
- Textures (8, all built once at init): `ghost` (rounded head, narrowing body, a wavy tail that curls to one side, two eye holes cut with `destination-out`), `fog`, `fogBank`, `mote`, `glow`, and `noiseA/B/C` (seeded soft blobs with faded edges, `mulberry32`).
- Rooms: three floor strips from the back (far colour at 0.7, 0.4, 0.15) and a darker inner panel on each back wall (`RoomArt.detail`, drawn after the floor, before the rug); the danger tint is the silhouette in `danger` with alpha `tint` (up by 60 % at the peak of a pulse); the glow turns from `glowWarm` to `danger` as the tint grows; the outline is one of three strokes (trim, cold edge, danger).
- Icons (`serviceIcon`): payments a coin (disc, ring, bar), orders a box (body, lid, tape), ledger a book (two pages, spine, text lines), gate an arch (posts, semicircle, bar). The icon is on the right back wall, left of the clock; any other name has no icon.
- Roof: the first two house shapes (roof and chimney) are on their own layer, solid, with the alpha of `roofAlpha`.
- Sky: horizon bands, far stars (40), near stars (16, another seed), the moon (halo sprite and a disc with a bite). Parallax moves the three containers.
- Palette (`palette.ts` only): `fog #7FD4E6`, `danger #FF5C7A`, `ecto #9BF2C4`, `moon`, `floorFar`, `wallInner`; `CONTRAST_PAIRS` gets the danger outline on night, the cold outline on a dark room and the mist on night.
- Labels: `computeLayout` gives `labelPx = max(14, …)` when the width is under 640 px; the boxes of the rows use `max(11, 0.34·scale)` so the Hunt slot stays clear. The pill around the name follows the measured text.
### Quality and motion
Low quality: no parallax, one fog layer (held still), no dust, no pulse; every look stays. Reduced motion: no sway, drift, parallax, dust or pulse (every offset zero for any time); the levels, the mist and the fog still show.
### The four fixes of the page
1. `huntSectionService` falls back to `latestFinishedService(services, true)` (the finished Hunt with a diagnosis that finished last) and then to `latestFinishedService(services, false)`. `huntedService` (the Summary bar) uses the same first function, so the two always speak of one service. `HuntSection` says "Diagnosed. The steps and evidence are shown in live mode." for a diagnosed Hunt with no steps when there is no API to load its detail.
2. Tokens `--level-calm #A39DB8`, `--level-uneasy #9CC7E6`, `--level-haunted #FF9EB0`, `--level-possessed #FF5C7A`, `--level-dark #DCD7EE`; the level pills use them (dark keeps its double border, possessed a thicker one). Pairs are in `contrast.test.ts` on the three surfaces, with a style test that calm does not use `--lantern`.
3. From 40.01rem the table is `table-layout: fixed`, `min-width: 60rem`, with `th` widths (6.5, 7.5, 8.5, 5.5, 4.5, 3.5, 5.5, 9.5, 9.5 rem); the scroll area takes any overflow, cells wrap (`overflow-wrap: anywhere`) and numbers are tabular.
4. Under 64rem `.layout-main` and `.panel` are `display: contents` and `order` puts the summary bar (1), the Hunt (2), the Scene (3), the service cards (4) and the Legend (5); replay controls stay first. The DOM, the focus order and the one live region do not change.
### Budget record, part 2
Measured on the build of part 2 (`pnpm --filter @haunted-ops/web build && node scripts/check-scene-bundle.mjs`): entry 92.7 KiB gzip of 94 (was 92.3; the scene code is not in it, the +0.4 KiB is the CSS of the four page fixes, 3211 bytes gzip in all, and the two small functions of the panel fix), scene chunk 161.0 KiB of 180 (was 158.6), scene file 99.7 KiB of 119 (was 97.3 in part 1), replay chunk 6579 bytes of 6800 (was 6581; `scene/hooks.ts` has no new import). `BUDGETS` did not change. No dependency was added.
### Part 3: polish (chip, ghosts, mist, table)
#### One chip per room (`layout.ts`, `shapes.ts`, `pixi-surface.ts`)
- `RoomLayout` drops `labelAt`, `badgeAt`, `incidentAt`, `labelBox`, `badgeBox` and `incidentBox` and gets `chipAt` (centre), `chipBox` (the pill in px), `chipBand` (the column of the room, 3.2 iso units each side of its centre, from the top of the bottom 20 % of the room's screen rect down past the overhang) and the `textTop` of the chip. `SceneLayout` gets `chipReserve`, the overhang in px.
- Size: `chipFont = max(narrow ? 14 : 11, 0.34 · scale)` (the rule of part 2, unchanged), height `CHIP_H · font = 1.6 · font`, width `(name length + 4) · 0.55 · font + 2 · 0.45 · font` (level mark, space, name, space, `!`). The box is an estimate; the pill drawn follows the measured text.
- Place: the chip is centred on the room. Its top is `1 − min(chipH, 0.2 · 3)` iso units below the floor centre (the room's screen rect is 3 units high, the floor 2 and the wall 1), so a chip shorter than 20 % of the room sits on the front corner and a taller one covers exactly the bottom 20 % and hangs below the front corner. On a phone (14 px at a scale near 22) it hangs about 12 px.
- Fit: the room is fitted with `chipReserve` px kept free at the bottom (four passes of `fit(chipOverhang(scale))`, which settle because the overhang only grows as the scale falls), so no chip leaves the canvas. At 4K the scale is capped and the reserve is 0.
- `chipLayout` (replaces `plaqueLayout`): the pill is `pillRect(chipAt, text width, text height)`, the name starts at its left padding and the `!` follows after a gap of 0.35 of the text height. The `!` is a second `Text` (`PALETTE.danger`, a new contrast pair on `pill`), visible while an incident is open. The level mark is `LEVEL_MARKER` of the table (`levelMark` in `RoomVisual`, the dark mark for a dark room). The reason badge and the incident triangle and word are gone; their facts stay in the table.
- The figure (`figurePlace`) stands right of the middle of the floor at the height the floor, the wall and the clock allow, and at most `FIGURE_GAP` above the chip top; the Hunt slot is far above on the left wall.
- The ghost feet stay above `textTop − 0.04 · scale`, which is now the chip top.
#### Ghosts (`particles.ts`, `textures.ts`, `model.ts`)
- `ghostSites(seed)`: a hex lattice of 4 rows of 4 and 3 sites (14 sites), spacing `0.165` in u and v (row distance `0.165 · 0.866`), fitted in the band 0.25 to 0.8 and shifted inside the slack by the seed. The widest ghost (0.8 · 96/144 wide) needs `0.6 · 0.533 / 2 = 0.16` of the floor edge (2 iso units), so every pair of sites keeps the minimum and the order does not matter.
- `ghostSpec(seed, i)` takes site `order[i]`, where `order` is a seeded Fisher–Yates shuffle of the sites; the first n slots are therefore always apart, and slots appear in index order. Size 0.5 to 0.8, drift 0.012 to 0.027 (was 0.03 to 0.08), so a ghost in motion stays near its place. `ghostMinDistance` and `ghostDistance` give the rule to the tests. `GHOST_BACK_LIMIT` is gone; the band replaces it.
- Opacity `0.25 + 0.45 · e` (was 0.6 · e): at most 0.7. `ghostMin` stays 6 for possessed, because the lattice has room for 12.
- The texture: a body from `rgba(247,252,255)` to `rgba(150,205,225,0.15)` (the fog colour toward the tail), a dark outline of `0.035 · width` and larger eye holes, still drawn once.
#### The hunt mist (`animator.ts`, `pixi-surface.ts`, `surface.ts`)
- **Cause found.** The test written first (`pixi-surface.test.ts`, "shows the green mist over the room that is hunted") passed for the path of the data (the model's `mist`, the animator's `rf.mist`, the ecto tint, the order above the floor and the glow, the width of 85 % of the room) and failed on one number: the largest alpha of a mist sprite was 0.5 (the second 0.35), and each sprite used a noise texture (`noiseC`, `noiseA`) whose blobs have an alpha of 0.25 to 0.55 and whose edges fade to 0. The visible opacity was at most about 0.25 at the middle, drawn in normal blend over a room that is lit by the danger glow, so the green was lost. The panel said "running" because the state was right; the drawing was too thin.
- **Fix.** The first mist sprite uses the round `fog` puff (alpha 1 at the centre) and the second keeps `noiseA`; rest alphas are 0.92 and 0.78. The breath takes away at most `MIST_SWING = 0.12` (`rf.mistBreath`, a sine of period 4 s, a new field of `RoomFrame`, 0 under Reduced motion), so the alpha stays between 0.80 and 0.92 and between 0.66 and 0.78, never below 0.6, and the step per frame is under 0.002. The drift (`mistX`, `mistY`) is unchanged. In Low quality the second sprite has alpha 0 (one layer). The layer order is unchanged: floor, danger tint, fog layers, glow, dark overlay, mist, outlines, then the chip layer and the ghosts.
#### Table (`styles.css`)
Widths 6.5, 9.5, 7, 5.5, 4.5, 3.5, 10, 9.5 and 6 rem (62 in all, the same `min-width`), `overflow-wrap: break-word`. The Haunt level column keeps 9.5 rem for "◕ 3 (possessed)".
### Budget record, part 3
Measured on the build of part 3 (`pnpm --filter @haunted-ops/web build && node scripts/check-scene-bundle.mjs`): entry 92.8 KiB gzip of 94 (was 92.7; the CSS of the table widths and the `levelMark` field of the model), scene chunk 160.6 KiB of 180 (was 161.0), scene file 99.3 KiB of 119 (was 99.7; the chip replaced three texts and a triangle), replay chunk 6579 bytes of 6800 (the same; `scene/hooks.ts` has no new import). `BUDGETS` did not change. No dependency was added.
### Illustrated sprites (part 4: `sprites.ts`, `pixi-surface.ts`, `particles.ts`, `animator.ts`, `surface.ts`)
This part supersedes the "procedural only" rules of the closed specs and of earlier requirements of this spec (requirement 23.6); those texts are not rewritten. The procedural art is kept whole as the fallback.
- **Files.** Ten WebP files of the team in `apps/web/public/scene/` (Seedream 5.5 via Runware, curated by hand): `room-payments`, `room-orders`, `room-ledger`, `room-gate` (768 by 768), `ghost-calm`, `ghost-drift`, `ghost-angry` (256), `exorcist-walk`, `exorcist-scan` (384) and `fog-wisp` (512). Vite copies `public/` to the root of `dist`, so they are `/scene/<file>`. They are never changed by the work.
- **Loader.** `sprites.ts` is the only file that names or loads them. `SPRITE_MANIFEST` holds the ten literals; `ROOM_SPRITE` maps payments, orders, ledger and gate to a room file; `loadSprites(timeoutMs = 8000)` runs `Assets.load` for all ten in parallel and races them with the timer. A rejection, the timeout, or an answer that is not a texture with a width and height above 1 (the server's `try_files` answers a missing file with `index.html` and status 200, which does not decode) gives `null`. The timer is always cleared. `unloadSprites` removes the files from the PixiJS cache when the surface is destroyed, because `app.destroy(..., { texture: true })` destroys the textures and a later scene must not get destroyed ones from the cache.
- **When it loads.** `PixiSurface.init` starts `loadSprites()` before `app.init`, so both run together, and awaits it before the textures are built. It starts only when a WebGL context can be made (a probe on a throw-away canvas that is lost at once): a browser without WebGL never asks for a picture. The Accessible mode never mounts the surface, so it asks for nothing either. Neither the entry chunk nor the replay chunk imports `sprites.ts` (it is imported by `pixi-surface.ts` only).
- **Fit.** `roomSpriteFit(floor)`: the content box is `x 0.0605 to 0.941` and `y 0.078 to 0.930` of the image, so `size = floorWidth / 0.8805`, `x = frontCorner.x − 0.50075 · size`, `y = frontCorner.y − 0.930 · size` (the sprite has anchor 0). `spriteSilhouette(fit)` is the hexagon of the picture (left floor corner, left wall top, back corner, right wall top, right floor corner, front corner; the floor is half as high as wide, the wall the rest of the box) and is what the trim, cold edge and danger outlines follow.
- **Room.** With a sprite, `buildRoom` puts the `Sprite` alone in `body`; the procedural polygons, rug, service icon, clock face and clock hands are not made. The roof layer draws nothing when any room has a sprite (the pictures have their own wall caps); corridors, the house and the sky stay. The danger tint polygon is the floor diamond. The dark overlay (`dim`) is not used on a sprite room.
- **Level look.** `spriteBrightness(light, dim) = (0.32 + 0.68 · light) · (1 − dim)`, with `light` the displayed light (the glow of `LEVEL_LOOK`, times the flicker) and `dim` the displayed dark overlay (0.92 for a dark room). The sprite `tint` is the grey of that number. So calm (0.25) is 0.49, uneasy 0.59, haunted 0.80, possessed 1.00 and dark 0.026; the additive lamp glow over a sprite room is capped at 0.6 (0.85 for a procedural one). The pulse, mist, fog layers and outlines are the layers of part 2 unchanged; the danger tint covers the floor only. No filter is used.
- **Ghosts.** `Surface` buffers get a `kind: Uint8Array` (0 for every class but ghosts). `ghostKind(level, i)`: level 0 calm; levels 1 and 2 alternate calm and drift; level 3 and above angry, except that every fourth slot drifts. `GHOST_KIND_MAX = [6, 6, 9]` is the most slots of one room that a pool ever holds (the maximum over the levels), so a pool is sized once as `MAX_ROOMS · GHOST_KIND_MAX[k]`. `Pool.fill(buffer, kind)` writes only the slots of that kind and hides the rest. The animator writes `kind` with the level of the room and the caps (`GHOST_MAX` per room, `PARTICLE_CAP` in all, trimmed by `enforceCap`) are untouched. WITHOUT sprites there is one procedural pool filled with every slot.
- **Fog.** The wisps pool uses the `fog-wisp` texture tinted `#7FD4E6`; the fog bank and the noise layers stay procedural. The procedural `fog` puff is still built, because the hunt mist uses it.
- **Exorcist.** With sprites the figure body is a `Sprite` (anchor at the feet, scaled so the picture is `FIGURE_H · scale` high): `exorcist-walk` while `walk < 0.999` and `exorcist-scan` after. The pictures face left, so the sprite is mirrored (negative `scale.x`) when the way from the door to the place of the figure goes right. The glow of the lantern sits over the lantern of the picture (0.23 of the height to the side, 0.42 up) and is tinted `--ecto`; the procedural lantern dot is not drawn, and the sparks fall from the same point.
- **Quality and motion.** Nothing here adds an offset: the tint follows the displayed light only, ghosts keep the sway, rotation and drift of the animator (zero under Reduced motion), and Low quality keeps one fog layer, no dust and no pulse.
- **Release finding.** `deploy/build-release.sh` copies `apps/web/dist` whole (`cp -R`), and `deploy/pack-release.sh` packs every regular file with fixed modes and times; there is no extension filter. `scripts/release-check.mjs` rejects ELF and Mach-O headers (a WebP starts with `RIFF`), and skips the text scan for a file that holds a NUL byte. The ten files hold no home path or token. So `dist/scene/` ships with no change to the scripts, and `check:build` (which hashes every file of `dist`) stays deterministic because Vite copies the files byte for byte.
- **Budget check.** `scripts/check-scene-bundle.mjs` reads the manifest of `sprites.ts` (a regex over the source, no import), lists `dist/scene/*.webp` and reports the total; it fails for a missing listed file, a file over 80 KiB and a total over 400 KiB.
- **Measured (build of part 4).** Entry 93.0 KiB gzip of 94, scene chunk 175.9 KiB of 180 (was 160.6: PixiJS `Assets`, its loader and the texture parser, which the surface now imports), scene file 92.4 KiB of 119, replay chunk 6581 bytes of 6800 (the same; `hooks.ts` has no new import). Sprite files: 10 files, 292398 bytes (285.5 KiB) of 400 KiB, largest 56.6 KiB of 80. `BUDGETS` did not change. No dependency was added.
## Correctness Properties
*A property is a statement that must hold for all valid inputs. Each one below is checked by a property-based test with fast-check, at least 100 runs, with the comment `// Feature: visual-refresh, Property N`.*
### Property 1: Every contrast pair passes its threshold
For every pair of `CONTRAST_PAIRS` and of the CSS pairs of the contrast test, the ratio computed from the tokens of `:root` is at least 4.5 for text pairs and at least 3 for large text and UI pairs, and the CSS `--bg` and `--focus` equal the Scene palette `bg` and `focus`.
**Validates: Requirements 1.1, 1.4, 1.5, 1.6**
### Property 2: The summary counts add up and match the levels
For any list of services with random levels, `summarize` returns counts whose sum is the number of services, each count equals the number of services at that level, the levels are in worst-first order, and no level with count 0 is listed.
**Validates: Requirements 3.1, 3.2**
### Property 3: The Legend remembers its state
For any sequence of open and close choices written with `writeLegendOpen`, `readLegendOpen` returns the last choice; with nothing stored it returns true; with a throwing storage it never throws.
**Validates: Requirements 6.2**
### Property 4: Every cell is labelled by its column and keeps its role
For any list of services, every rendered row has one cell for each column, each cell has a `data-label` equal to the text of its column header, and the roles `table`, `row`, `columnheader` and `cell` (or `rowheader`) are present.
**Validates: Requirements 5.1, 5.3, 5.5**
### Property 5: The light follows the trouble
For any service state and any options, the glow of a room is non-decreasing from calm to possessed (same metrics and reason), strictly higher for haunted and possessed than for calm and uneasy, and zero for a dark room; the settled glow in the frame of the Animator has the same order.
**Validates: Requirements 12.1, 12.2, 12.6**
### Property 6: Reduced motion freezes every animated offset
For any house and any times under Reduced motion, the parallax, the pulse, the mist drift, every fog layer offset and every ghost rotation are zero, there is no dust, and the picture (tints, edges, fog alphas, ghost positions) is the same at any two times.
**Validates: Requirements 15.2, 15.3**
### Property 7: One chip per room, in the band under it, and no two chips overlap
For any room set of the 3 by 3 grid (one to four rooms with their own names) and any viewport width from 320 to 1920 px, the layout has one chip per room, the chip text is 14 px or more under 640 px and 11 px or more from there, every chip lies in the column of its room, starts in the bottom 20 % of the room's screen rect and covers at most that 20 % (the rest hangs below the front corner), and no two chips overlap.
**Validates: Requirements 18.1, 18.3, 18.4, 18.5**
### Property 8: Ghosts are separate and inside the room
For any seed and any count up to 12 (and for the ghost count the model gives at any level), the rest positions of the ghosts of one room lie in the band 0.25 to 0.8 of the floor on both axes, every ghost with its drift lies inside the floor, its size is 0.5 to 0.8, any two ghosts are at least 0.6 of the wider ghost's width apart (in iso units of the floor), and the opacity of a ghost is at most 0.7.
**Validates: Requirements 19.1, 19.2, 19.3**
### Property 9: The picture of a room is brighter as the trouble grows, and darkest when dark
For any service with a sprite (payments, orders, ledger, gate) and any metrics and reason, the brightness of its picture (`spriteBrightness` of the displayed light and the dark overlay) is non-decreasing from calm through uneasy and haunted to possessed, strictly higher for possessed than for calm, and the dark room is darker than every other level and under 0.05.
**Validates: Requirements 25.1, 25.2, 25.4**
### Property 10: The ghost pools never pass the caps
For any set of rooms and levels, after any number of frames, the ghosts of all variant pools together are at most 12 per room and at most the total particle cap of 200; no pool holds more than `MAX_ROOMS · GHOST_KIND_MAX[k]` slots; and for every level the slots of one room that `ghostKind` hands to the three pools add up to exactly 12 and never pass a pool's per-room size.
**Validates: Requirements 26.1, 26.2**
## Error Handling
- A `localStorage` that is missing or throws is ignored; the Legend is then open.
- A `HuntSummary` with an unknown status gives no hunt state text (never an exception, never "x of y").
- A tool name with no icon gets a neutral dot icon, so a new Exorcist tool never breaks the Timeline.
- The favicon and the meta tags are static; there is nothing to fail at run time.
## Testing Strategy
- **Unit and component tests**: `summary.test.ts` and `SummaryBar` (counts text, no live region, hunt states, no "of"), `Legend.test.tsx` (first visit open, remembered choice, throwing storage, the rows), the Panel empty state, the Timeline (one item per step, icon `aria-hidden`), the card-mode roles test (`data-label` and roles present).
- **Property tests**: `summary.property.test.ts` (Property 2), `legend-state.property.test.ts` (Property 3), `table.property.test.tsx` (Property 4), the contrast test (Property 1).
- **Updated tests** (selectors only): `App.test.tsx`, `table.test.tsx`, `focus.test.tsx`, `hunt.test.tsx`, `accessible-mode.test.tsx`, `replay.test.tsx`, `a11y.test.tsx`, `accessible.spec.ts`, `replay.spec.ts`, `no-webgl.spec.ts`, `scene.spec.ts`.
- **Part 2 tests**: `look.test.ts` (the pulse, the frame for each level, the mist, fog layers, camera and roof), `look.property.test.ts` (Properties 5 and 6), the look table in `model.test.ts`, icons, floor detail and roof split in `art.test.ts`, the narrow label rule in `layout.test.ts`, the level pill tokens in `contrast.test.ts`, the panel fix in `hunt.test.tsx`; `layout.spec.ts` gets the table-width and the mobile-order checks (run by the orchestrator). Updated by the new rule, none deleted: `layout.test.ts`, `animator.test.ts`, `pixi-surface.test.ts`, `model.test.ts`, `model.property.test.ts`, `art.test.ts`.
- **Part 3 tests**: `layout.property.test.ts` (Property 7, and the chip in Property 15 and in the first property), `look.property.test.ts` (Property 8 and the zero `mistBreath` of Property 6), `pixi-surface.test.ts` (the mist: written first and failing on alpha 0.5, then passing; breathing; Reduced motion; Low quality), `art.test.ts` (`chipLayout`), `layout.test.ts` (the chip in the bottom 20 % at 1440×900 and 390×844). Updated by the new rule, none deleted: `hunt-scene.test.ts`, `animator.test.ts` (ghost feet above the chip), `model.test.ts` (ghost opacity 0.7), `model.property.test.ts` (the band replaces the back limit). `layout.spec.ts` gets the Incident cell height check at 1440 px (it was run once in part 3).
- **Part 4 tests**: `sprites.test.ts` (the fit, the outline hexagon, the manifest, `loadSprites` on success, a rejection, the timeout and a non-image answer, `spriteBrightness`, the ghost split), `sprites.property.test.ts` (Properties 9 and 10), `pixi-surface.test.ts` (ten files asked for and 7 textures with sprites, none without WebGL and 8 textures on the fallback, the picture alone in the body and no roof with sprites, the three ghost pools within their sizes, the figure picture), `art.test.ts` (the new audit rule), `scripts/check-scene-bundle.test.mjs` (the asset budget). Updated by the new rule, none deleted: `art.test.ts`, `pixi-surface.test.ts`; `animator.test.ts` is unchanged and its source check still holds. E2E: `scene.spec.ts` (ten files with status 200 and `image/webp` on `/?demo=1`, no console error, a fallback case with `/scene/*` aborted), `no-webgl.spec.ts` and `accessible.spec.ts` (no `/scene/*.webp` request).
- **Checks while building part 4**: `pnpm typecheck`, `pnpm lint`, the created or changed vitest files, `e2e/scene.spec.ts` once, `pnpm --filter @haunted-ops/web build && node scripts/check-scene-bundle.mjs` once, the spec validator. Not run: the full suite, the whole Playwright run.
- **End-to-end**: `apps/web/e2e/layout.spec.ts` (no horizontal scroll at 390×844 on three pages; the Panel beside the Scene at 1440×900). `gallery.spec.ts` gets screenshots only if it is cheap.
- **Checks while building** (the rest is the orchestrator's): `pnpm typecheck`, `pnpm lint`, the touched test files with `pnpm --filter @haunted-ops/web exec vitest run <files>`, `pnpm --filter @haunted-ops/web build`, `node scripts/check-scene-bundle.mjs` once (entry and replay numbers reported), `node ../seance-crew/spike/kiro-validate.cjs .kiro/specs`.
