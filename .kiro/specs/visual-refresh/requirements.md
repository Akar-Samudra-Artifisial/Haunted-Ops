# Requirements Document
## Introduction
`visual-refresh` is the tenth product spec of Haunted Ops, after `foundation`, `haunted-lab`, `ingest-haunt-score`, `scene-engine`, `exorcist-agent`, `fix-proposal-flow`, `accessible-mode`, `deploy-demo` and `replay`. It is split in two prompts. This spec covers part 1, the page around the Scene: design tokens, layout, header, summary bar, side panel with the hunt timeline, legend, restyled table, restyled replay pages and the document head. Part 2 (the PixiJS scene: rooms, ghosts, fog, sky) is a later prompt and a later set of tasks; this spec does not change `apps/web/src/scene/` except the palette values named in requirement 1.
Today the page is a plain column: the Scene, then a 9-column table, then the hunt detail. A first-time visitor cannot tell what is wrong, the hunt is below the fold, the table scrolls sideways on a phone (about 670 px wide at 390 px) and nothing explains ghosts, fog or dark rooms. The look is "a lantern in a dark house": dark calm surfaces, and only trouble glows.
The spec adds no dependency, no server code, no API change and no network call. It spends no credits and starts no cloud resource.
## Glossary
- **Workspace**, **API**, **Web**, **Lab**, **Hunt**, **Proposal**, **Scene**, **Accessible mode**, **Replay**, **Replay file**: as defined in the earlier specs.
- **Token**: a CSS custom property of `:root` in `apps/web/src/styles.css` (a colour, a type size, a space, a radius or the shadow). Every colour in CSS is a token; the contrast test refuses a colour literal outside `:root`.
- **Scene palette**: `apps/web/src/scene/palette.ts`. Its `bg` and `focus` must equal the CSS tokens `--bg` and `--focus` (`model.test.ts`).
- **Panel**: the `<aside aria-label="Incident">` that holds the Summary bar, the selected Hunt and the Legend.
- **Summary bar**: the plain text at the top of the Panel (and first in Accessible mode) with the number of services at each level and the hunt state of the hunted service.
- **Level**: one of the five haunt levels `calm`, `uneasy`, `haunted`, `possessed`, `dark`, each with its mark from `status-marks.ts` and its word from `format.ts`.
- **Hunt state**: the words shown for the hunted service from `HuntSummary`: "Hunt running · N steps", "Diagnosed", "Fix proposed" or "Fix merged". `stepCount` is the number of steps done; there is no total, so the Web never shows "x of y".
- **Legend**: the `<details>` "What am I looking at?" in the Panel.
- **Timeline**: the vertical list of Hunt steps, one dot and one line per step.
- **Card mode of the table**: the CSS-only layout below 40rem in which each table row is a block and each cell shows its column name from its `data-label` attribute. The DOM, the roles and the focus order do not change.
- **Icon module**: one small module of inline SVG paths (`apps/web/src/components/icons.tsx`) shared by the Timeline, the Legend and the replay controls.
- **Entry budget**: `BUDGETS.entry` of `scripts/check-scene-bundle.mjs` (gzip of the entry chunk and its static imports).
## Requirements
### Requirement 1: Design tokens and contrast
**User Story:** As a visitor, I want a dark, calm page where only trouble glows and every text can be read, so that the state of the house is clear at a glance.
#### Acceptance Criteria
1. THE `:root` of `apps/web/src/styles.css` SHALL define the colour tokens `--bg #0B0A12`, `--surface #16141F`, `--surface-2 #211E2E`, `--line #3A3550`, `--text #EDEAF6`, `--text-muted #A39DB8`, `--lantern #F4B860` (healthy light and accents), `--danger #FF5C7A`, `--fog #7FD4E6` (latency), `--ecto #9BF2C4` (the Exorcist, hunt progress) and a visible `--focus`.
2. THE `:root` SHALL define the type tokens `--font-display` (`ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif`, headings only, no font file), `--font-ui` (a `system-ui` stack) and `--font-num` (`ui-monospace, "SF Mono", Menlo, monospace`), a scale `--step--1` to `--step-3`, spacing `--space-1` to `--space-6`, `--radius-1` and `--radius-2`, and one shadow token; every number the page shows SHALL use `--font-num` with `font-variant-numeric: tabular-nums`.
3. EVERY colour in CSS outside `:root` SHALL be a custom property; no literal colour SHALL be added.
4. THE Scene palette SHALL change only `bg` (and `focus` if it changed) so that the CSS tokens and the Scene palette still agree; no other file of `apps/web/src/scene/` SHALL change in this spec.
5. THE contrast pairs of `palette.ts` (`CONTRAST_PAIRS`) and of `a11y/contrast.test.ts` SHALL cover text and muted text on `--bg`, `--surface` and `--surface-2`, each status colour used as text on the surface it is drawn on, and the focus ring on `--bg` and `--surface`.
6. EVERY pair SHALL pass WCAG AA: at least 4.5:1 for text and at least 3:1 for large text and UI parts. IF a token fails, THEN its lightness SHALL be adjusted and the change SHALL be written in the design.
### Requirement 2: Layout and header
**User Story:** As a visitor on a laptop or a phone, I want the scene and the incident side by side when there is room, so that I see the problem and the hunt without scrolling.
#### Acceptance Criteria
1. AT 64rem or wider, THE page SHALL be a two-column grid: the Scene (or the table in Accessible mode) on the left and the Panel, 360 px wide, on the right.
2. BELOW 64rem, THE page SHALL be one column and the Panel SHALL follow the Scene (or the table).
3. THE Panel SHALL be an `<aside aria-label="Incident">`.
4. THE page SHALL have no horizontal scroll at 390 px wide, on `/?demo=1`, on `/?mode=accessible&demo=1` and on `/replays`.
5. THE header SHALL show the product name in `--font-display`, the line "Live incident war room. Ghosts are errors, fog is latency, a dark room is down." under it, the connection status as a small pill and the Accessible mode switch as a quiet secondary button.
6. THE Skip link SHALL stay the first focusable element and the Accessible mode switch SHALL stay the first control after it.
### Requirement 3: Summary bar
**User Story:** As an on-call engineer, I want one line that says how many services are in trouble and what the hunt is doing, so that I know what is wrong before I read anything else.
#### Acceptance Criteria
1. THE Summary bar SHALL show the number of services at each level, read from the same `services` the table reads, in the form "2 haunted · 1 possessed · 1 calm", listing only the levels that have at least one service and worst level first.
2. FOR any list of services, THE counts SHALL add up to the number of services and each count SHALL equal the number of services at that level.
3. THE Summary bar SHALL then show the Hunt state of the hunted service from `HuntSummary`, and SHALL show no hunt state when there is no hunt.
4. THE Summary bar SHALL use plain text with the level marks of `status-marks.ts`, never colour alone, and SHALL NOT be a live region; the only live region SHALL remain `LiveAnnouncer`.
5. THE Summary bar SHALL be the first block of the Panel and, in Accessible mode, the first block before the table.
### Requirement 4: Panel and hunt
**User Story:** As a judge, I want the hunt to read as a story next to the scene, so that I follow the Exorcist's steps, the culprit and the proposed fix without hunting for them.
#### Acceptance Criteria
1. THE Panel SHALL hold the Summary bar, then the selected Hunt (`HuntSection.tsx`), then the Legend.
2. THE Hunt steps SHALL be a Timeline: one dot and one line per step, the tool name with a small inline SVG icon for each Exorcist tool (`query_metrics`, `search_errors`, `tail_logs`, `recent_deploys`, `diff_commit`, `submit_diagnosis`), the time and the step summary.
3. THE diagnosis SHALL be a highlighted card with the culprit, the summary and the "AI generated" label kept.
4. THE evidence SHALL be a compact list.
5. THE Proposal (`ProposalBlock`) SHALL be a card with its status as a pill and the pull request link as a link styled as a button; the link and its text SHALL not change.
6. WHEN there is no Hunt, THE Panel SHALL show an empty state of one sentence on what will appear there.
7. THE icons SHALL be decorative (`aria-hidden`), so the tool name text stays the accessible name.
### Requirement 5: Table and cards
**User Story:** As a user of a phone or a screen reader, I want the table to stay a real table and to fit a narrow screen, so that I can read every service without sideways scrolling.
#### Acceptance Criteria
1. THE table (`TableMode.tsx`) SHALL keep the same columns, the same DOM and the same focus order, and SHALL stay the table-first view of Accessible mode.
2. THE table SHALL have a sticky header, a hover and focus style for rows, numbers right-aligned in `--font-num`, and the level as a pill with its mark and its word.
3. EVERY cell SHALL carry a `data-label` attribute equal to the text of its column header.
4. BELOW 40rem, CSS only SHALL turn each row into a card (`display: block` rows, each cell shows its `data-label` through `::before`) and the sideways scroll SHALL be removed.
5. THE roles `table`, `row`, `columnheader` and `cell` (or `rowheader`) SHALL stay present in card mode, so a screen reader still reads a table.
### Requirement 6: Legend
**User Story:** As a first-time visitor, I want a short key to the ghosts, the fog and the dark rooms, so that I understand the scene.
#### Acceptance Criteria
1. THE Legend SHALL be a `<details>` with the summary "What am I looking at?" inside the Panel.
2. THE Legend SHALL be open on the first visit, when nothing is stored, and closed afterwards unless the visitor opened it; the choice SHALL be kept in `localStorage` under its own key, as the mode switch keeps its choice, and a storage that throws SHALL be ignored.
3. THE Legend SHALL list: ghost = errors, fog = latency, dark room = down, lantern = healthy, green mist = the Exorcist investigating; and the five levels `calm`, `uneasy`, `haunted`, `possessed` and `dark` with their marks from `format.ts`.
4. EACH row SHALL have a small inline SVG glyph drawn for this product (procedural shapes, no copied art); the glyphs SHALL be decorative.
### Requirement 7: Motion
**User Story:** As a visitor who is sensitive to motion, I want almost no animation, and none when I ask for none.
#### Acceptance Criteria
1. THE page SHALL use only CSS transitions shorter than 200 ms on hover, focus and open, and one soft pulse on the "Hunt running" pill.
2. UNDER `prefers-reduced-motion: reduce` AND in Accessible mode, THE transitions and the pulse SHALL be off.
### Requirement 8: Replay pages and the document
**User Story:** As a judge, I want the replay list and player to look like the live page and the document to describe itself, so that a shared link looks right.
#### Acceptance Criteria
1. THE replay list at `/replays` SHALL be cards with the title, the scenario as a pill, the date and the duration.
2. WHEN there are no replays, THE page SHALL show an empty state of one short line on what a replay is, and a link back to the live page.
3. THE replay controls SHALL be one toolbar with buttons that have an icon and a text, and the range input SHALL be styled; the button names SHALL not change.
4. THE banner "Replay of <date>, not live" SHALL stay visible at every position.
5. THE replay chunk SHALL stay within `BUDGETS.replay` (6800 bytes gzip); shared styles SHALL be in CSS, not in JS.
6. `apps/web/index.html` SHALL have a `<meta name="description">`, a `theme-color` of `#0B0A12` and a favicon as an inline SVG data URL (an original lantern or house glyph); the Content Security Policy already allows `img-src data:`.
### Requirement 9: Budget and Accessible mode
**User Story:** As the developer, I want the page to stay light and the Accessible mode rules to stay true, so that the refresh costs nothing that earlier specs promised.
#### Acceptance Criteria
1. THE spec MAY raise `BUDGETS.entry` from 92 KiB to 94 KiB gzip at most, only if the measured entry needs it; the measured number and the reason SHALL be written in the comment of `scripts/check-scene-bundle.mjs` and in the design.
2. THE spec SHALL add no dependency, no CSS-in-JS and no font file; the icons SHALL be inline SVG paths in the Icon module.
3. THE Accessible mode rules SHALL hold: one live region, the same focus order, Escape returns to the row, parity of the Scene and the table, `?mode=accessible`, and no Scene loaded in Accessible mode.
### Requirement 10: Tests
**User Story:** As the developer, I want the tests that the new layout breaks to keep proving what they proved, and new tests for the new parts.
#### Acceptance Criteria
1. THE tests that the layout breaks SHALL be updated by changing their selector, never by deleting an assertion: `App.test.tsx`, `table.test.tsx`, `focus.test.tsx`, `hunt.test.tsx`, `accessible-mode.test.tsx`, `replay.test.tsx`, `a11y.test.tsx`, and the end-to-end tests `accessible.spec.ts`, `replay.spec.ts`, `no-webgl.spec.ts` and `scene.spec.ts`.
2. NEW tests SHALL cover: the Summary bar counts (a property test), the Legend state, the Panel empty state, and the card mode keeping the table roles.
3. THE end-to-end test `apps/web/e2e/layout.spec.ts` SHALL check, at 390×844, that `document.documentElement.scrollWidth` is at most 390 on `/?demo=1`, `/?mode=accessible&demo=1` and `/replays`, and, at 1440×900, that the Panel is beside the Scene.
4. THE contrast tests SHALL cover every new pair of requirement 1.5.
5. THE screenshots in `e2e/gallery.spec.ts` SHALL be extended only if it is cheap; they are for the person who checks and are not baselines.
6. WHILE this spec is built, ONLY the checks named in the design (typecheck, lint, the touched test files, the web build, the bundle check, the spec validator) SHALL be run; the full suite SHALL be run afterwards by the orchestrator.
### Requirement 11: Steering, records and hygiene
**User Story:** As the maintainer, I want the rules and the history to match the code.
#### Acceptance Criteria
1. `.kiro/steering/a11y-perf.md` SHALL list the tokens and the contrast rule (every colour a token; every text pair at 4.5:1, large text and UI parts at 3:1).
2. `.kiro/steering/structure.md` SHALL list `10. visual-refresh` in the planned specs and renumber `spatial-audio` to 11 and `submission-kit` to 12; the README MAY get one sentence on the Legend.
3. `docs/KIRO_USAGE.md` SHALL get one line per finished task, in the form `2026-11-16 | visual-refresh/N | …`, and the file SHALL end with a newline.
4. THE work SHALL be original: procedural shapes and the product's own palette, no copied code, no imitation of any game, film or franchise, and no forbidden retro-client word in any file.
5. HELPER files created while working SHALL be deleted; nothing SHALL be committed by the implementation prompt.
