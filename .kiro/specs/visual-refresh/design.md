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
## Error Handling
- A `localStorage` that is missing or throws is ignored; the Legend is then open.
- A `HuntSummary` with an unknown status gives no hunt state text (never an exception, never "x of y").
- A tool name with no icon gets a neutral dot icon, so a new Exorcist tool never breaks the Timeline.
- The favicon and the meta tags are static; there is nothing to fail at run time.
## Testing Strategy
- **Unit and component tests**: `summary.test.ts` and `SummaryBar` (counts text, no live region, hunt states, no "of"), `Legend.test.tsx` (first visit open, remembered choice, throwing storage, the rows), the Panel empty state, the Timeline (one item per step, icon `aria-hidden`), the card-mode roles test (`data-label` and roles present).
- **Property tests**: `summary.property.test.ts` (Property 2), `legend-state.property.test.ts` (Property 3), `table.property.test.tsx` (Property 4), the contrast test (Property 1).
- **Updated tests** (selectors only): `App.test.tsx`, `table.test.tsx`, `focus.test.tsx`, `hunt.test.tsx`, `accessible-mode.test.tsx`, `replay.test.tsx`, `a11y.test.tsx`, `accessible.spec.ts`, `replay.spec.ts`, `no-webgl.spec.ts`, `scene.spec.ts`.
- **End-to-end**: `apps/web/e2e/layout.spec.ts` (no horizontal scroll at 390×844 on three pages; the Panel beside the Scene at 1440×900). `gallery.spec.ts` gets screenshots only if it is cheap.
- **Checks while building** (the rest is the orchestrator's): `pnpm typecheck`, `pnpm lint`, the touched test files with `pnpm --filter @haunted-ops/web exec vitest run <files>`, `pnpm --filter @haunted-ops/web build`, `node scripts/check-scene-bundle.mjs` once (entry and replay numbers reported), `node ../seance-crew/spike/kiro-validate.cjs .kiro/specs`.
