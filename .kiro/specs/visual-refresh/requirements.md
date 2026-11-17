# Requirements Document
## Introduction
`visual-refresh` is the tenth product spec of Haunted Ops, after `foundation`, `haunted-lab`, `ingest-haunt-score`, `scene-engine`, `exorcist-agent`, `fix-proposal-flow`, `accessible-mode`, `deploy-demo` and `replay`. It is split in four prompts. This spec covers part 1, the page around the Scene: design tokens, layout, header, summary bar, side panel with the hunt timeline, legend, restyled table, restyled replay pages and the document head. Part 2 (the PixiJS scene: rooms, ghosts, fog, sky, and four fixes of the page found on screenshots) is requirements 12 to 17 below, written in a second prompt. Part 3 (polish found on new screenshots: one chip per room, ghosts as separate silhouettes, a hunt mist that can be seen, and the Incident column of the table) is requirements 18 to 22, written in a third prompt. Part 4 (illustrated sprites for rooms, ghosts, fog and the Exorcist, with the procedural art as the fallback) is requirements 23 to 30, written in a fourth prompt. Requirements 1 to 11 change `apps/web/src/scene/` only in the palette values named in requirement 1.
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
- **Look**: one row of the table `LEVEL_LOOK` in `apps/web/src/scene/model.ts` (pure data): the lamp glow, the danger tint, the cold edge light, the outline and the fewest ghosts of a room at a level. A dark room uses the dark row.
- **Glow pulse**: one soft swell of a room's glow, one cycle of 2 s, started when its level rises.
- **Mist**: the green cloud (`--ecto`, `#9BF2C4`) over a room while a Hunt is entering or working there.
- **Fog layer**: one of three soft noise clouds that drift inside a room's floor at different speeds. Fog is the latency layer and does not depend on the level.
- **Low quality** and **Reduced motion**: as in `scene-engine`.
- **Chip**: the one label of a room in the Scene, a pill under the room with the level mark, the service name and, only while an incident is open, a `!` marker in the danger colour. It replaces the three stacked labels (reason badge, incident mark, name) of earlier parts.
- **Chip band**: the part of the screen under a room that its chip may use: the column of the room (3.2 iso units to each side of its centre) and the bottom 20 % of the room's screen rect, plus the part of the chip that hangs below the front corner.
- **Ghost site**: one of the 14 resting places of a room's ghosts, a hex lattice inside the band 0.25 to 0.8 of the floor on both axes, shifted by the seed of the room.
- **Mist breath**: the slow change of the mist's alpha, one cycle of 4 s, at most 0.12 of alpha.
- **Sprite**: one of the ten WebP pictures of the team in `apps/web/public/scene/` (four rooms, three ghosts, two poses of the Exorcist, one fog wisp), loaded by `sprites.ts`.
- **Sprite set**: the textures `loadSprites` returns when every file loaded; `null` means the procedural art is drawn.
- **Fit**: the pure function of `sprites.ts` that places a room picture so its content box is as wide as the floor diamond and its bottom centre is the front corner of the floor.
- **Sprite floor**: the four floor corners of a scaled room picture (left, back, right, front), from `spriteFloor(fit)`; it lies inside the outline hexagon of the picture and shares its front corner.
- **Hunt mark style**: the pure choice of `huntMarkStyle` in `shapes.ts` between the progress dots and the narrow text pill "Hunt · n steps".
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
### Requirement 12: Level to look
**User Story:** As an on-call engineer, I want to see in two seconds, without the table, which room is in trouble and how bad, so that I look at the right room first.
#### Acceptance Criteria
1. THE Scene model SHALL define the look of each level in ONE table `LEVEL_LOOK` (pure data, unit tested): calm is a dim lantern only (a low warm glow, no ghost); uneasy has a faint cold edge light; haunted has a clear danger tint on the floor and the walls and visible ghosts; possessed has a strong danger glow, dense ghosts and the outline of the room in the danger colour; dark has no light at all, a near-black room and a thin cold outline so it still reads as a room.
2. THE glow of a room SHALL be non-decreasing from calm to possessed, SHALL be strictly higher for haunted and possessed than for calm and uneasy, and SHALL be zero for a dark room; `isDark` (level 4, or `up` below 0.5) SHALL stay the rule for a dark room.
3. THE fog (latency) SHALL be its own layer, cold cyan (`--fog`), with a density from the p95 as before, and SHALL not be drawn in a dark room.
4. WHEN the level of a room rises, THE Scene SHALL give the glow of that room one soft pulse of one cycle, at least 1 s long, and SHALL start no second pulse within 1 s; no room SHALL change brightness more than 3 times per second.
5. WHILE a Hunt is entering or working on a service, THE Scene SHALL draw the green mist (`--ecto`) over that room; the mist maps to the Hunt column of the table, so no new fact appears in the Scene.
6. THE glow SHALL not depend on the error ratio or the p95 (they drive ghosts and fog only), and every colour SHALL come from `palette.ts`.
### Requirement 13: Ghosts, fog and sky
**User Story:** As a visitor, I want ghosts and fog that look like ghosts and fog and move smoothly, and a night sky with depth, so that the house feels alive without being noisy.
#### Acceptance Criteria
1. THE ghost texture SHALL be a procedural silhouette (a rounded head, a wavy tail and two eye holes) drawn once in `textures.ts`; ghosts SHALL sway with a sine, fade in and out with an eased curve, and SHALL be spread so that no two slots of a room share a spot.
2. THE counts SHALL still come from the existing pools and caps of `particles.ts` (ghost 12, fog 20, mote 6, total 200).
3. EACH lit room SHALL draw 2 to 3 soft noise textures (made by code once) that drift at different speeds inside the floor of the room, in addition to the fog puffs.
4. THE sky SHALL have three layers (far stars, near stars, and a soft moon over a horizon gradient) that move by a few pixels with the focused room; the sky SHALL be still under Reduced motion and in Low quality.
5. DUST motes SHALL be drawn in lit rooms only, from the existing mote pool.
6. NO texture SHALL be built per frame; all textures SHALL be built at start.
### Requirement 14: Rooms and labels
**User Story:** As a visitor, I want rooms that look like rooms, with a small sign of what each service does, and labels I can read on a phone.
#### Acceptance Criteria
1. EACH room SHALL have a floor gradient and a darker inner wall panel on each back wall, and the roof of the house SHALL be solid and SHALL fade out while a room is focused.
2. EACH service SHALL have one small procedural icon on the back wall: payments a coin, orders a box, ledger a book, gate a gate arch; an unknown service SHALL have no icon.
3. THE room name SHALL keep its size rule on a desktop; on a viewport narrower than 40rem (640 px) THE name SHALL be drawn at 14 px or more, and the rows of the room SHALL keep the 11 px rule so that the Hunt slot stays clear.
4. THE Scene SHALL show no fact that the table does not show; the parity property test SHALL keep passing.
### Requirement 15: Low quality and Reduced motion
**User Story:** As a visitor with a slow device or a motion sensitivity, I want the scene to cost less or stand still, and still tell me the levels.
#### Acceptance Criteria
1. IN Low quality THE Scene SHALL turn off the parallax, every fog layer beyond the first, the dust and the glow pulse, and SHALL keep every level look of requirement 12.
2. UNDER Reduced motion THE Scene SHALL draw no sway, drift, parallax, dust or pulse; ghosts and fog SHALL stand at their rest positions and every level look SHALL still be visible.
3. FOR any time, every animated offset (ghost rotation, fog layer offset, mist drift, parallax, pulse) SHALL be zero under Reduced motion.
### Requirement 16: Four fixes of the page
**User Story:** As a visitor, I want the panel, the level colours, the table and the phone layout to agree with what the page says.
#### Acceptance Criteria
1. WHEN nothing is selected and no Hunt is running, queued or fixing, THE Hunt section SHALL show the service of the most recently finished Hunt (one with a diagnosis first), the same service the Summary bar speaks of; WHEN that Hunt has no steps and the Web has no API to load its detail (demo mode), THE section SHALL say "Diagnosed. The steps and evidence are shown in live mode." in place of the empty text.
2. THE calm level pill SHALL not use `--lantern`; it SHALL use a neutral token, and uneasy, haunted, possessed and dark SHALL each have their own token (`--level-calm`, `--level-uneasy`, `--level-haunted`, `--level-possessed`, `--level-dark`) that matches requirement 12; the contrast pairs SHALL be added to `contrast.test.ts`.
3. THE desktop table (40rem and up) SHALL have `table-layout: fixed` with explicit column widths and tabular numbers, so that the header cells keep their widths when values change; no text SHALL be clipped at 1440 and 1024 px, and `layout.spec.ts` SHALL assert that the header cell widths are equal before and after the demo reaches t=20 s.
4. BELOW 64rem THE page SHALL read: the Summary bar and the Hunt first, then the Scene, then the service cards, then the Legend, by CSS order; the DOM order, the focus order (skip link, mode switch, content) and the single live region SHALL not change, and `layout.spec.ts` SHALL assert the visual order at 390×844.
### Requirement 17: Budget, tests, steering and records of part 2
**User Story:** As the maintainer, I want part 2 to cost nothing that earlier specs promised and to leave the rules and the history true.
#### Acceptance Criteria
1. THE entry chunk SHALL not grow (part 2 SHALL be in the scene chunk), the scene chunk SHALL stay within 180 KiB, the scene file within 119 KiB and the replay chunk within 6800 bytes; `apps/web/src/scene/hooks.ts` SHALL get no new import. THE measured numbers SHALL be written in the design.
2. THE tests that lock old values SHALL be updated to the new rule and none SHALL be deleted; NEW tests SHALL cover the look table, a property that the glow is non-decreasing with trouble (Property 5), a property that every animated offset is zero under Reduced motion (Property 6), and the pulse.
3. WHILE this part is built, ONLY the checks named in the design SHALL be run; the full suite SHALL be run afterwards by the orchestrator.
4. `.kiro/steering/scene-rendering.md` SHALL list the level to look table and the new layers; `docs/KIRO_USAGE.md` SHALL get one line per finished task, in the form `2026-11-17 | visual-refresh/N | …`, ending with a newline.
5. THE work SHALL add no dependency, no image, font or sprite file, and no forbidden retro-client word; it SHALL be original.
### Requirement 18: One chip per room
**User Story:** As a visitor on a phone or a laptop, I want one small label per room instead of three stacked ones, so that a room in trouble is not hidden behind its own text.
#### Acceptance Criteria
1. THE Scene SHALL draw ONE chip for each room, under the room in front of the floor edge, with the level mark and the service name; WHILE an incident is open in that room, THE chip SHALL end with a `!` marker in the danger colour (`--danger`), and WHILE none is open it SHALL have no marker.
2. THE reason badge and the "incident" word SHALL not be drawn in the Scene; the reason and the incident stay in the table and the cards, so the Scene shows no fact that the table does not show and the incident fact keeps its table cell.
3. THE chip text SHALL be 14 px or more on a viewport narrower than 40rem (640 px) (`MIN_FONT_NARROW_PX`), and SHALL keep the size rule of earlier parts (0.34 of the iso unit, 11 px at least) from 640 px up.
4. THE top of a chip SHALL be inside the bottom 20 % of the room's screen rect (the chip covers no more than that part of the room) and the rest of the chip SHALL hang below the front corner; THE layout SHALL leave room under the lowest room for that part, so no chip leaves the canvas.
5. FOR any room set of the 3 by 3 grid and any viewport width from 320 to 1920 px, no two chips SHALL overlap and every chip SHALL lie inside the chip band of its room (Property 7).
6. THE ghosts, the Hunt slot and the Exorcist figure SHALL stay clear of the chip: ghost feet stay above its top, and the Hunt slot and the figure box are separate from it.
### Requirement 19: Ghosts as separate silhouettes
**User Story:** As a visitor, I want the ghosts of a haunted room to read as several figures, so that the number and the spread of ghosts say how bad the room is.
#### Acceptance Criteria
1. THE ghosts of a room SHALL rest on ghost sites inside the band 0.25 to 0.8 of the floor on both axes, taken in a seeded order, so that the same seed always gives the same places and the first n slots never share a site.
2. FOR any seed and any count up to 12, any two ghosts of one room SHALL rest at least 0.6 of the wider ghost's width apart (in iso units of the floor), and every ghost, with its drift, SHALL lie inside the floor (Property 8).
3. THE ghost height SHALL be 0.5 to 0.8 iso units; THE alpha of one ghost SHALL be at most 0.7 (`0.25 + 0.45 · error ratio`), so that overlaps stay readable; the drift of a ghost SHALL be at most 0.027 of the floor.
4. THE ghost texture SHALL have a body that turns from cold white toward the fog colour, a dark outline and two deep eye holes, drawn once in `textures.ts`.
5. A possessed room SHALL still read stronger than a haunted one (the counts of the model and the glow of Property 5 are unchanged), THE caps (ghost 12, fog 20, mote 6, total 200) SHALL not change, and Low quality and Reduced motion SHALL keep the rules of requirement 15.
### Requirement 20: The hunt mist can be seen
**User Story:** As a visitor, I want the green mist over the room the Exorcist is hunting in, so that the panel's "hunt running" matches what the house shows.
#### Acceptance Criteria
1. WHILE a Hunt is entering or working on a service, THE mist sprites of that room SHALL be visible, tinted `#9BF2C4`, in the room's layer above its floor and its lamp glow (and so below the chip layer and the ghosts), at least one of them with an alpha of 0.6 or more, and wide enough to cover at least 60 % of the room's width.
2. THE test of 1 SHALL be written first and SHALL fail on the old drawing; THE cause found SHALL be written in the design and the drawing SHALL be fixed for it.
3. THE mist SHALL breathe slowly: one cycle of 4 s (at least 2 s) and a swing of at most 0.15 of alpha, never below 0.6.
4. UNDER Reduced motion THE mist SHALL be still (no drift, no breath) and still visible; IN Low quality THE mist SHALL stay as one layer.
5. THE mist SHALL not appear over a room that has no Hunt, and SHALL not hide the ghosts or the chip.
### Requirement 21: The Incident column of the table
**User Story:** As an on-call engineer on a laptop, I want the Incident column to show its text in one or two lines with whole words, so that I can read it without guessing.
#### Acceptance Criteria
1. THE desktop table SHALL have the column widths (rem) Service 6.5, Haunt level 9.5, Reason 7, Error ratio 5.5, p95 4.5, Up 3.5, Incident 10, Hunt 9.5 and Fix 6, which add up to 62, and `min-width` SHALL be the same 62rem (the total is written in a comment of the CSS).
2. THE cells SHALL wrap whole words (`overflow-wrap: break-word`) and SHALL never break a word in the middle.
3. AT 1440 px, at demo second 20, every Incident cell SHALL be at most two lines high (its content height is at most twice its line height); `layout.spec.ts` SHALL assert it, and its stable-width and no-clip tests SHALL keep passing at 1440 and 1024 px.
4. AT 1024 px the scroll area `.table-scroll` MAY scroll sideways; THE page itself SHALL not scroll sideways at 390 px (requirement 2.4).
### Requirement 22: Budget, tests, steering and records of part 3
**User Story:** As the maintainer, I want part 3 to cost nothing that earlier specs promised and to leave the rules and the history true.
#### Acceptance Criteria
1. THE entry chunk SHALL not grow beyond its 94 KiB budget (part 3 adds only the CSS of requirement 21 to it), the scene chunk SHALL stay within 180 KiB, the scene file within 119 KiB and the replay chunk within 6800 bytes; `apps/web/src/scene/hooks.ts` SHALL get no new import. THE measured numbers SHALL be written in the design.
2. THE tests that lock old numbers or positions (`layout.test.ts`, `layout.property.test.ts`, `art.test.ts`, `hunt-scene.test.ts`, `animator.test.ts`, `model.test.ts`, `model.property.test.ts`, `pixi-surface.test.ts`) SHALL be updated to the new rule and no assertion SHALL be deleted; NEW tests SHALL cover Property 7, Property 8 and the mist.
3. WHILE this part is built, ONLY the checks named in the design SHALL be run; the full suite and the whole end-to-end run SHALL be run afterwards by the orchestrator.
4. `.kiro/steering/scene-rendering.md` SHALL state the chip rule and the ghost spacing rule (two lines); `docs/KIRO_USAGE.md` SHALL get one line per finished task, in the form `2026-11-17 | visual-refresh/N | …`, ending with a newline.
5. THE work SHALL add no dependency, no image, font or sprite file, and no forbidden retro-client word; it SHALL be original.
### Requirement 23: Illustrated sprites, loaded with the procedural art as the fallback
**User Story:** As a visitor, I want the house, its ghosts, its fog and the Exorcist drawn as the team's illustrations, and as shapes if a picture cannot load, so that the Scene looks finished and never breaks.

#### Acceptance Criteria

1. THE Scene SHALL use ten WebP files made by the team in `apps/web/public/scene/` (generated with Seedream 5.5 via Runware and curated by hand; original art that imitates no game, film or franchise): four room files of 768 by 768 px (payments, orders, ledger, gate), three ghost files (calm, drift, angry), two Exorcist files (walk, scan) and one fog wisp file. Vite serves them as `/scene/<file>`. THE files SHALL not be regenerated, resized, renamed or re-encoded by this work.
2. THE new module `apps/web/src/scene/sprites.ts` SHALL be the only place that loads image files: it holds the manifest of the ten paths (string literals that start with `/scene/`), the room fit constants and the map from a service to its room file (payments, orders, ledger and gate; any other service has no sprite), and `loadSprites(): Promise<SpriteSet | null>` that loads all files in parallel with PixiJS `Assets.load` and a timeout of 8 s. No dependency SHALL be added.
3. WHEN any file fails, the timeout passes, or a file does not decode as a picture (the web server answers a missing file with `index.html` and status 200), `loadSprites` SHALL return `null`.
4. `PixiSurface.init` SHALL start `loadSprites` while the renderer starts and wait for it before the textures are built; WITH `null`, THE Scene SHALL draw exactly today's procedural rooms, ghosts, fog wisps and figure (the code stays as the fallback, and the low-power path is unchanged). A room whose service has no sprite SHALL always use the procedural room.
5. NOTHING SHALL be loaded when the Scene is not loaded: Accessible mode and a browser without WebGL SHALL make no `/scene/*.webp` request (the surface asks for the files only when a WebGL context can be made), and neither the entry chunk nor the replay chunk SHALL import `sprites.ts`.
6. THIS requirement supersedes the "procedural shapes only" rules of earlier requirements and specs: requirement 13.2 of `scene-engine` (`scene-engine/requirements.md:193`) and requirements 13.1 (`:132`), 17.5 (`:165`), 19.4 (`:181`) and 22.5 (`:205`) of this spec. From part 4 the Scene art is procedural shapes plus the team's sprites, and the procedural art stays as the fallback. The closed specs and the earlier requirements SHALL not be rewritten.

### Requirement 24: The rooms are illustrated
**User Story:** As a visitor, I want each room to be an illustrated cutaway of its service, so that the house looks like a house.

#### Acceptance Criteria

1. WITH sprites, `buildRoom` SHALL put one `Sprite` of the room file at the bottom of the room container, placed and scaled by one pure function of `sprites.ts` so that the content box of the picture (as a fraction of the image: x 0.0605 to 0.941, y 0.078 to 0.930; the same for the four files) is as wide as the floor diamond (`RoomLayout.floor`) and the bottom centre of the box is the front corner of the floor.
2. FOR a sprite room, THE procedural body, rug, service icon and clock SHALL not be drawn, and the roof SHALL not be drawn over it (the picture has its own wall caps); the corridors SHALL stay.
3. THE outlines of a sprite room (quiet trim, cold edge, danger) SHALL follow the outline of the picture (a hexagon computed from the same box), and the danger tint SHALL cover the floor diamond only.
4. THE chip and the labels of part 3 SHALL stay as they are and SHALL stay above the sprites.

### Requirement 25: The level look on the pictures
**User Story:** As an on-call engineer, I want the room in trouble to be the brightest thing on screen, also on a phone, so that I find it in two seconds.

#### Acceptance Criteria

1. THE look of part 2 (`LEVEL_LOOK`) SHALL stay the source of the levels and SHALL be applied to a sprite room with the sprite `tint` (a grey from a pure function of the displayed light and the dark overlay) and the existing overlay layers (danger tint, glow, outline, pulse, mist), not with filters.
2. CALM SHALL read dim and quiet, clearly darker than any room in trouble; UNEASY a little brighter with a faint cold edge; HAUNTED the danger glow and a danger tint limited to the floor diamond; POSSESSED a stronger danger glow and the danger outline; DARK the picture tinted to near black (brightness under 0.05) with the thin cold outline, so it still reads as a room.
3. THE fog (latency) layers and the hunt mist SHALL stay their own layers above the picture.
4. FOR any service with a sprite and any trouble, the brightness of the picture SHALL be non-decreasing from calm to possessed and the dark room SHALL be the darkest (Property 9).

### Requirement 26: Ghosts, fog and the Exorcist as sprites
**User Story:** As a visitor, I want ghosts that look different when they are calm or angry, cyan fog and a figure that looks like an investigator, so that the story of an incident can be read in the picture.

#### Acceptance Criteria

1. WITH sprites, THE ghosts SHALL use three textures (calm, drift, angry), one pool per texture (a `ParticleContainer` holds one texture), and the existing slots of each room SHALL be shared between the pools by a pure function `ghostKind(level, i)`: uneasy and haunted rooms use calm and drift, a possessed room uses mostly angry. THE caps SHALL not change (12 per room, 200 in all) and no pool SHALL be sized to hold more than the slots of its kind need; THE size rule (the sprite height) and the spacing of part 3 SHALL stay.
2. FOR any set of rooms and levels, THE ghosts of all pools SHALL never pass the per-room and the total cap (Property 10).
3. THE fog wisps SHALL use `fog-wisp.webp` tinted with the fog token (`#7FD4E6`) in the same layer, with the same counts and drift; the fog bank and the noise layers stay.
4. THE Exorcist figure SHALL be a `Sprite` of height `FIGURE_H` times the scale: `exorcist-walk` while it enters or moves and `exorcist-scan` while it works, mirrored horizontally to face its direction; the green mist SHALL stay.
5. WITHOUT sprites, the procedural ghost, wisps and figure SHALL be drawn as before.

### Requirement 27: Quality and motion keep their rules
**User Story:** As a visitor with Reduced motion or a slow machine, I want the same rules as before with the new pictures.

#### Acceptance Criteria

1. UNDER Reduced motion and in Low quality, every rule of parts 2 and 3 SHALL hold with the sprites: static positions, no sway, drift, parallax, dust or pulse, and the level looks visible.
2. THE pictures SHALL be tinted by the displayed light only, so a still scene stays still.

### Requirement 28: Asset budget, build and release
**User Story:** As the maintainer, I want the pictures to cost a known amount and to ship with the app.

#### Acceptance Criteria

1. `scripts/check-scene-bundle.mjs` SHALL check `dist/scene/*.webp`: each file at most 80 KiB, all together at most 400 KiB (285.5 KB at the start of part 4), print the measured total, and fail when a file named in the `sprites.ts` manifest is missing from `dist/scene/`. THE JS budgets SHALL not change (entry 94 KiB, scene chunk 180 KiB, scene file 119 KiB, replay 6800 bytes).
2. THE release SHALL ship `dist/scene/`: `deploy/build-release.sh` copies `apps/web/dist` whole and the release check has no file filter that would drop a WebP file; `check:build` SHALL stay deterministic (the files are copied byte for byte). THE finding SHALL be written in the design.

### Requirement 29: Tests of part 4
**User Story:** As the maintainer, I want the new rules tested and the old tests kept.

#### Acceptance Criteria

1. THE test of `art.test.ts` that forbids image files, `Assets.load`, `fetch(` and `url(` in `src/scene/*.ts` SHALL be updated, not deleted: `Assets.load` and `/scene/` paths are allowed only in `sprites.ts`, every loaded path is in the manifest and starts with `/scene/`, and the other bans stay for every file.
2. `pixi-surface.test.ts` SHALL add `Assets` to its `pixi.js` mock and assert the texture count for both paths (sprites loaded and fallback); `animator.test.ts` SHALL keep its source check true.
3. NEW tests SHALL cover the fit function (box width equals the floor width, bottom centre equals the front corner), `loadSprites` returning `null` on a rejection, on the timeout and on a non-image answer, the surface building no procedural body, icon or roof with sprites and building them without, the ghost split never passing `GHOST_MAX` per room or the total cap, Property 9 and Property 10.
4. `scene.spec.ts` SHALL check that on `/?demo=1` the ten files are requested with status 200 and `image/webp` and the console has no error, and that with `/scene/*` aborted the Scene still renders; `no-webgl.spec.ts` and `accessible.spec.ts` SHALL check that no `/scene/*.webp` request is made.

### Requirement 30: Steering, README and records of part 4
**User Story:** As the maintainer, I want the rules and the history to say what the code does.

#### Acceptance Criteria

1. `.kiro/steering/scene-rendering.md`, `tech.md` and `security.md` SHALL replace the procedural-only rule with: "Scene art is procedural shapes plus the team's illustrated sprites in `apps/web/public/scene/` (generated with Seedream 5.5 via Runware and curated by the team; original, imitating no existing game, film or franchise); the procedural art stays as the fallback".
2. THE README SHALL get a short "Art" section with the same credit sentence.
3. `docs/KIRO_USAGE.md` SHALL get one line per finished task, in the form `2026-11-17 | visual-refresh/N | …`, ending with a newline.
4. THE work SHALL add no dependency, no secret, no home path and no forbidden retro-client word; the ten files SHALL be unchanged; and while part 4 is built, ONLY the checks named in the design SHALL be run.
### Requirement 31: The rooms no longer cover each other
**User Story:** As a visitor, I want every room picture to show its own floor and the floors of its neighbours, so that the house reads as four rooms and not one pile.
#### Acceptance Criteria
1. `ROOM_STRIDE`, `ROOM_SIZE` and `computeLayout` SHALL not change. `sprites.ts` SHALL export one constant `ROOM_SPRITE_SCALE`, at most 0.9, and `roomSpriteFit` SHALL draw the content box of the picture `ROOM_SPRITE_SCALE` times as wide as the floor diamond, pivoting on the front corner of the floor (the bottom centre of the box stays where it was). The outline hexagon (`spriteSilhouette`) follows the new fit.
2. IN the demo layout (the four rooms, at any viewport width), THE content box of the picture of a room SHALL not contain the front corner of the floor diamond of any room behind it. `ROOM_SPRITE_SCALE` SHALL be the largest value, at most 0.9, for which this holds; the chosen value and its limit SHALL be written in the design.
### Requirement 32: No procedural leftovers over the pictures
**User Story:** As a visitor, I want the pictures free of rings and half discs that belong to the procedural house.
#### Acceptance Criteria
1. THE empty rings of the hunt marks SHALL be drawn only while the room has a hunt (queued, running, or finished); a room with no hunt SHALL show no ring, no lit mark and no result mark. A dark pill (the chip pill colour and alpha) SHALL sit behind the marks so they read on the picture and on the procedural wall. The same SHALL hold without sprites.
2. THE attic window SHALL be drawn only when sprites are off.
3. THE other decorations of the house and the roof SHALL be checked, and each one that only makes sense for the procedural house SHALL be skipped with sprites and listed in the design.
### Requirement 33: A calm room is darker than a room in trouble
**User Story:** As an on-call engineer, I want the calm rooms dim, so that the room in trouble stands out, also on a phone.
#### Acceptance Criteria
1. WITH sprites, `spriteBrightness` SHALL give at most 0.40 for a calm room, a value for an uneasy room between calm and haunted, at least 0.80 for a haunted room, 1 for a possessed room and under 0.05 for a dark room, and SHALL stay non-decreasing in the light and non-increasing in the dark overlay (Property 9, extended with these bounds).
2. THE fog, the hunt mist, the lamp glow and the other layers SHALL not change.
### Requirement 34: The Exorcist can be seen
**User Story:** As a visitor, I want to see the Exorcist at work, above the ghosts and with a light of its own.
#### Acceptance Criteria
1. WITH sprites, THE figure SHALL be `FIGURE_H_SPRITE` (1.15) iso units high, and at least 28 px on screen under 40rem; the procedural figure SHALL keep `FIGURE_H` (0.85).
2. THE figure SHALL be drawn above every ghost pool and below the chips, and the chips SHALL be the top layer of the stage (Property 11).
3. A soft glow in the Exorcist colour (`#9BF2C4`, the `ecto` token) SHALL sit behind the figure, from the existing glow texture, at alpha 0.5. It SHALL be static: the same under Reduced motion and in Low quality, with no animation.
### Requirement 35: Tests, budget and records of part 5
**User Story:** As the maintainer, I want the new rules tested, the old tests kept and the budget respected.
#### Acceptance Criteria
1. THE tests that locked an old number or order SHALL be updated to the new rule, none deleted: the fit and outline tests (`sprites.test.ts`), the brightness unit test and Property 9 (`sprites.test.ts`, `sprites.property.test.ts`), and the layer order, the ghost pool slice and the lantern glow of `pixi-surface.test.ts`. NEW tests SHALL cover the geometry of the demo layout (Requirement 31.2), the marks and pill shown only with a hunt, the figure height (also under 40rem) and Property 11.
2. THE scene chunk SHALL stay at most 180 KiB gzip (175.9 KiB before part 5), and the other budgets SHALL not change. The part adds no dependency, no texture file and no change to `apps/web/public/scene/`.
3. `docs/KIRO_USAGE.md` SHALL get one line per finished task, in the form `2026-11-17 | visual-refresh/N | …`, ending with a newline. While part 5 is built, ONLY the checks named in the design SHALL be run.
### Requirement 36: The trouble tint stays on the sprite floor
**User Story:** As a visitor, I want the red tint of a room in trouble to stay inside the room outline, so that it does not spill onto the dark around the house.
#### Acceptance Criteria
1. `sprites.ts` SHALL export a pure `spriteFloor(fit)` that returns the four floor corners of the scaled picture (left, back, right, front), from the same fit numbers and content box as `spriteSilhouette(fit)`; it SHALL lie inside that outline, share its front corner and be no wider.
2. WITH a sprite, THE danger tint SHALL be drawn on `spriteFloor(fit)` (Property 12); without sprites it SHALL keep the procedural shape.
3. WITH a sprite, THE lamp glow SHALL be `ROOM_SPRITE_SCALE` times its procedural size, so it does not reach past the picture; without sprites it SHALL not change.
### Requirement 37: The Exorcist's mint glow is visible
**User Story:** As a visitor on a laptop or a phone, I want to see the Exorcist's own light, so that I find it at once.
#### Acceptance Criteria
1. THE glow behind the figure SHALL be `h·1.6` wide and `h·1.8` high (`h` the figure height), centred on the body, additive, in the `ecto` colour, under the figure in the `figures` layer (Property 11 unchanged), at alpha 0.85 at rest.
2. WHILE neither Reduced motion nor Low quality is on, THE glow alpha SHALL breathe between 0.7 and 0.9 along a smooth sine of one cycle per 3 s; WHILE either is on, it SHALL stay at 0.85.
3. UNDER `NARROW_BELOW`, THE glow SHALL be at least 40 px tall on screen.
### Requirement 38: The Hunt progress is readable on a phone
**User Story:** As an on-call engineer on a phone, I want to read how far the Hunt is.
#### Acceptance Criteria
1. UNDER `NARROW_BELOW`, THE Hunt marks SHALL be dots of radius 4 px or more with a gap of 2 px or more between dots WHEN eight of them fit in the slot; OTHERWISE THE Scene SHALL show the text "Hunt · n steps" in the pill style of the chip, at `MIN_FONT_NARROW_PX` (14 px) or more. THE Scene SHALL never show "n of 8".
2. THE slot geometry (`huntRect`) SHALL not change, and the hunt mark area SHALL not overlap the room chip and SHALL stay inside the canvas, above the body of the working figure. Desktop SHALL keep the current dots.
3. THE table SHALL not change: no new fact is shown (the step count is already in the Hunt column).
### Requirement 39: Tests, budget and records of part 6
**User Story:** As the maintainer, I want the three fixes tested, the old tests kept and the budget respected.
#### Acceptance Criteria
1. THE tests that locked the old glow alpha SHALL be updated to the new rule, none deleted. NEW tests SHALL cover `spriteFloor`, Property 12, the glow size and its 40 px floor under 40rem, the breathing range, period and its fixed value under Reduced motion and Low quality, and the narrow Hunt marks.
2. THE scene chunk SHALL stay at most 180 KiB gzip, the entry at most 94 KiB and the replay chunk at most 6800 bytes; `hooks.ts` SHALL get no import; no asset, texture or dependency SHALL be added.
3. `.kiro/steering/scene-rendering.md` SHALL get one line for the tint-on-sprite-floor rule and one for the narrow Hunt marks rule. `docs/KIRO_USAGE.md` SHALL get one line per finished task, `2026-11-17 | visual-refresh/N | …`, ending with a newline. While part 6 is built, ONLY the checks named in the design SHALL be run.
