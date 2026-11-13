# Requirements Document

## Introduction

`scene-engine` is the third product spec of Haunted Ops, after `foundation` and `ingest-haunt-score`. It draws the house: a 2.5D cutaway where each service is a room, errors are ghosts, latency is fog and a down service is a dark room. The scene is the hero of the demo video and of the design and presentation scores, so it has to read at a glance, look good, and be original.

Everything the scene shows comes from data that already exists: `ServiceState` (haunt level 0 to 4, reason, metrics, open incident, room position) delivered by `GET /api/services` and the SSE stream. A pure model turns that data into a description of each room; a renderer on PixiJS 8 draws the description; the accessible table mode stays in step with it.

It does not draw hunts or evidence (`exorcist-agent`), fix pull requests (`fix-proposal-flow`), play sound (`spatial-audio`) or deploy (`deploy-demo`). It only reserves the place where hunt progress will go. It adds one runtime dependency (`pixi.js`) and one dev dependency (`@playwright/test`).

## Glossary

- **Workspace**, **API**, **Web**, **Shared**, **Service**, **Haunt level**, **Haunt reason**, **Incident**, **Table mode**, **Live state**: as defined in the `foundation` and `ingest-haunt-score` specs.
- **Scene**: the drawn house in `apps/web/src/scene/`, with the DOM parts around it (summary, room buttons, fallback message).
- **Room**: the drawing of one Service. Its place comes from `ServiceState.room` (`x`, `y`).
- **Scene model**: the output of the pure function `toSceneModel`: one **Room visual** per Service plus totals. It has no PixiJS or DOM import.
- **Room visual**: the description of one Room: light, ghosts, fog, flicker, dark, label, badge, incident mark, seed.
- **Layout**: the output of the pure function `computeLayout`: screen positions of rooms, corridors, labels and hit boxes for a given viewport.
- **Animator**: the pure part of the renderer that moves displayed values toward the model, owns the particle pools and produces one **Frame** per tick.
- **Surface**: the part of the renderer that draws a Frame. The PixiJS surface is the only code that imports `pixi.js`; tests use a fake surface.
- **Frame**: plain data (typed arrays and numbers) describing everything to draw at one instant.
- **Ghost**: a small drawn wisp whose number and opacity follow the error ratio of a Room.
- **Fog**: soft drifting layers whose density follows the p95 latency of a Room.
- **Dark room**: a Room with Haunt level 4, or whose `up` metric is below 0.5: lights out, only a faint outline, the label and the badge visible.
- **Badge**: the small text pill in a Room that states the Haunt reason ("error rate 22%", "p95 2.2 s", "service down").
- **Particle**: any pooled sprite: ghost, fog puff, ambient mote or corridor pulse. The total never exceeds 200.
- **Quality**: `full` or `low`. Low power mode halves particle counts, drops filters and lowers the resolution.
- **Reduced motion**: the user setting `prefers-reduced-motion: reduce`.
- **Selection**: the one Service (or none) that is highlighted in both the Scene and Table mode.
- **Hunt slot**: the reserved area of a Room where hunt progress will be drawn by `exorcist-agent`.
- **Demo mode**: the `?demo=` query parameter that drives the Scene and the table from a script instead of the API.
- **Palette tokens**: the named colours in `apps/web/src/scene/palette.ts`.

## Requirements

### Requirement 1: Scene module, lazy loading and mount

**User Story:** As a visitor, I want the header and the table to appear at once, so that the page is useful before the heavy scene code has loaded.

#### Acceptance Criteria

1. THE Web SHALL keep every scene source file under `apps/web/src/scene/`, and only one file there, the PixiJS surface, SHALL import `pixi.js`.
2. THE renderer and `pixi.js` SHALL load through a dynamic import, so that the entry chunk of the Web does not contain PixiJS code and the header and the table render without waiting for it.
3. WHILE the scene chunk loads, THE `SceneMount` SHALL show a static placeholder with the text summary of the Scene, and SHALL keep its place so that the page does not jump when the canvas appears.
4. THE Web SHALL add `pixi.js` pinned to an exact version checked against the npm registry (8.23.0 on 13 Nov 2026) and `@playwright/test` pinned to an exact version as a dev dependency, and SHALL add no other runtime dependency.
5. THE gzip size of the scene chunk SHALL be recorded in `design.md` and checked by `scripts/check-scene-bundle.mjs` against a budget, and the same script SHALL fail if the entry chunk contains PixiJS code or exceeds its own budget.

### Requirement 2: House layout

**User Story:** As a viewer, I want a house that fits my screen and shows how the services call each other, so that I understand the system without reading.

#### Acceptance Criteria

1. THE Layout SHALL place one Room per Service in a 2:1 isometric cutaway at the grid position `ServiceState.room`, for grids up to 3 by 3, and SHALL accept any set of distinct positions, including gaps.
2. THE Layout SHALL scale and centre the house to fit the viewport for every size from 360 by 360 CSS pixels to 3840 by 2160, so that no Room silhouette (floor and back walls) leaves the viewport and no two Room silhouettes overlap.
3. THE Layout SHALL draw corridors that follow the call chain in the order of `SERVICE_NAMES` (gate, orders, payments, ledger), routed through the gaps between rooms, so that no corridor crosses the floor of a Room.
4. THE corridor between two Rooms SHALL be as lit as the dimmer of the two Rooms and SHALL be dark when either Room is dark.
5. THE Scene SHALL use a device pixel ratio of at most 2, and WHEN the size of the mount changes THE Scene SHALL recompute the Layout and resize the drawing without recreating the renderer.
6. THE Layout SHALL keep every text at 11 CSS pixels or larger, and WHEN the scale is too small for the badge text THE Layout SHALL ask for the short badge form.
7. THE Layout SHALL be a pure function of the Rooms and the viewport, with no PixiJS or DOM import.

### Requirement 3: Scene model

**User Story:** As a developer, I want all visuals to derive from one pure description, so that I can test them without a GPU and keep the table in step.

#### Acceptance Criteria

1. THE function `toSceneModel(services, now, options)` in `apps/web/src/scene/model.ts` SHALL be pure: no PixiJS or DOM import, no `Math.random`, no `Date.now`, and no input other than its arguments.
2. FOR EACH Service in the input, in input order, THE Scene model SHALL contain one Room visual with: the Haunt level and its label, `dark`, `light`, `ghostCount`, `ghostOpacity`, `fogDensity`, the motion amplitudes (`drift`, `flicker`, `tremble`), the badge text and its short form, the incident mark, the label, the clock angle derived from `now`, the seed, and the optional `hunt`.
3. THE Scene model SHALL be deterministic: the same arguments give a deeply equal result.
4. THE error intensity SHALL be the error ratio from the metrics (or from the reason when the reason is `error_rate` and the metric is `null`) scaled from 0 at 0 to 1 at 0.5, and THE latency intensity SHALL be the p95 scaled from 0 at 200 ms to 1 at 3000 ms, both clamped, and a `null` value SHALL count as 0.
5. THE Scene model SHALL be monotonic: with the other inputs unchanged, a higher Haunt level, error ratio or p95 SHALL NOT give fewer ghosts, a lower ghost opacity, less fog or more light.
6. THE Scene model SHALL cap ghosts at 12, fog puffs at 14 and ambient motes at 6 per Room, SHALL cap all Particles including 12 corridor pulses at 200 in total, and WHEN the wanted total is larger THE Scene model SHALL trim ambient motes first, then fog, then ghosts, from the Rooms with the lowest Haunt level upward.
7. THE Scene model SHALL set `dark` to true and `light` to 0 for every Service whose Haunt level is 4 or whose `up` metric is below 0.5, and for no other.
8. THE Scene model SHALL accept any array of valid `ServiceState`, including an empty array and an array with a Service that has `null` metrics, and SHALL NOT throw.
9. THE Room visual SHALL have an optional `hunt` field that is absent today, so that `exorcist-agent` only has to fill it.

### Requirement 4: Room states

**User Story:** As a viewer, I want each room to look like what is happening in the service, so that I can read the incident from the picture.

#### Acceptance Criteria

1. WHEN a Room is at Haunt level 0, THE Scene SHALL show warm steady light with idle details: a lamp whose glow breathes slightly and a clock whose hand follows `now`.
2. WHEN the error ratio of a Room rises, THE Scene SHALL show more ghosts and a higher ghost opacity, up to the caps, drifting along seeded paths inside the floor of that Room.
3. WHEN the p95 of a Room rises, THE Scene SHALL show denser fog in slowly drifting layers, up to the caps.
4. WHEN a Room is at Haunt level 3, THE Scene SHALL flicker its light and make its objects tremble slightly, with no more than 3 changes of brightness per second.
5. WHEN a Room is dark, THE Scene SHALL turn its light off, hide its ghosts, fog and ambient motes, and keep only a faint outline, the label and the badge visible.
6. THE Scene SHALL show the Haunt reason of every Room that has one as a Badge with text, so that neither colour nor motion is the only cue, and SHALL mark a Room that has an Open Incident with a small shape and the text "incident".
7. THE positions, sizes and phases of ghosts and fog puffs SHALL come from the seed of the Room and the index of the particle, so that the same Room always draws the same wisps.

### Requirement 5: Renderer lifecycle and transitions

**User Story:** As a viewer, I want changes to glide, not jump, and I want the page to stay healthy when I leave, so that the scene feels alive and does not leak.

#### Acceptance Criteria

1. THE renderer SHALL be created once for a mount, SHALL be updated with each new Scene model without being recreated, and SHALL draw only the model.
2. WHEN a Room changes state, THE Animator SHALL move the displayed light, fog density and ghost opacity toward the new values over about 1 s, SHALL fade ghosts in one by one as the count rises and out one by one as it falls, and SHALL never overshoot a target.
3. THE Animator SHALL take its Particles from fixed pools sized by the caps and SHALL allocate no new objects per frame once running.
4. WHEN the renderer is destroyed, THE renderer SHALL stop its frame loop, remove every listener and observer it added, and release its textures and its application; destroying twice, or destroying while the setup is still pending, SHALL be safe and SHALL leave nothing behind.
5. THE renderer SHALL be split into the Animator (pure), the Surface (draws a Frame) and a frame loop (injected), so that the logic runs in tests with a fake Surface and a manual loop.
6. WHEN nothing changes and no motion is active, THE renderer SHALL skip drawing instead of redrawing an identical Frame.

### Requirement 6: Performance budget

**User Story:** As a judge on a modest laptop, I want the scene to stay smooth, so that the demo does not stutter.

#### Acceptance Criteria

1. THE renderer SHALL cap its frame rate at 60 fps, SHALL keep the total number of Particles at 200 or fewer, and SHALL aim at a frame time under 16.7 ms on a 2020 laptop.
2. WHILE the tab is hidden, THE renderer SHALL stop its frame loop, and WHEN the tab is visible again THE renderer SHALL resume it without a jump in time (a frame step is limited to 100 ms).
3. WHEN the average frame time stays above 20 ms for 2 s, THE renderer SHALL switch to low power Quality (half the Particles, no filters, resolution 1), and SHALL switch back only after the average stays under 14 ms for 10 s.
4. THE renderer SHALL generate its textures procedurally once at start, no more than 6 textures, and SHALL draw ghosts, fog, ambient motes and corridor pulses from four particle containers.
5. THE renderer SHALL expose frame statistics (average frame time, particle count, quality) and SHALL publish them on `window` only in Demo mode, for measurement.

### Requirement 7: Reduced motion

**User Story:** As a viewer who is sensitive to motion, I want a still scene that says the same thing, so that I lose no information.

#### Acceptance Criteria

1. THE Web SHALL read `prefers-reduced-motion` at start and SHALL react when it changes.
2. WHILE reduced motion is on, THE Scene model SHALL set every motion amplitude (`drift`, `flicker`, `tremble`) to 0 and SHALL keep the ghost counts, ghost opacities and fog densities unchanged.
3. WHILE reduced motion is on, THE Scene SHALL show ghosts and fog at their seed positions without drifting, SHALL NOT flicker, shake or breathe, and SHALL apply a state change at once, without a transition.
4. WHILE reduced motion is on and nothing changes, THE renderer SHALL run no frame loop.

### Requirement 8: Accessibility and keyboard

**User Story:** As a keyboard or screen reader user, I want to reach every room and hear what it says, so that the scene is not a picture I cannot use.

#### Acceptance Criteria

1. THE canvas SHALL have `role="img"` and an accessible label that is the current text summary of the Scene, updated when the state changes, and the Scene SHALL NOT add a second live region (the existing polite level announcer stays the only one).
2. THE Scene SHALL give each Room one focusable button over its place, shaped like the silhouette of the Room, with a label such as "payments, haunted, error rate 22%, incident open"; Tab and Shift+Tab SHALL visit every Room once in room order, the arrow keys SHALL move the focus to the nearest Room in that direction (and stay when there is none), Home and End SHALL go to the first and last Room, and Enter or Space SHALL select.
3. WHEN a Room gets focus or is clicked, THE Scene SHALL select the matching row of Table mode (marked `aria-current`, highlighted with a non-colour cue, and scrolled into view), and WHEN a row is activated by click or keyboard THE Scene SHALL select the matching Room and draw a selection ring around it.
4. WHEN Escape is pressed with a selection, THE Web SHALL clear it in both views.
5. THE text of labels and badges SHALL have a contrast ratio of at least 4.5 to 1 against its pill, and the outline and the selection ring SHALL have at least 3 to 1 against the background they sit on, for every Palette token pair that is used.
6. THE Scene SHALL show the state by text and shape as well as by colour and motion, and SHALL NOT flash more than 3 times per second.

### Requirement 9: Parity with Table mode

**User Story:** As a user who cannot see the scene, I want the table to say exactly what the scene shows, so that I miss nothing.

#### Acceptance Criteria

1. THE Scene model and Table mode SHALL use the same helper `isDark(service)` and the same reason text function, so that they cannot disagree on the dark state or the reason.
2. FOR ANY array of valid `ServiceState`, THE Scene model and Table mode SHALL agree, for every Service, on the Haunt level, the reason text, the dark or lit state and the presence of an Open Incident, and an automated test SHALL check it.
3. THE Table mode SHALL state "dark" in its Haunt level cell for a Service whose room is dark even when its level is below 4 (for example when `up` is 0), and SHALL mark the selected row.
4. THE scene sources SHALL stay under `apps/web/src/scene/`, so that the existing `scene-table-parity` hook keeps matching every scene file that is saved.

### Requirement 10: Fallback

**User Story:** As a visitor with a browser or machine that cannot run the scene, I want a clear message and a working table, so that I never see a blank screen.

#### Acceptance Criteria

1. IF WebGL or WebGPU initialisation fails, THEN THE Scene SHALL hide the canvas, show a short text message in the mount, remove the room buttons, and leave Table mode as the full view.
2. IF the scene chunk fails to load, THEN THE Scene SHALL do the same.
3. WHEN the drawing context is lost, THE Scene SHALL show the message, and WHEN the context is restored THE Scene SHALL set the renderer up again once and remove the message.
4. THE mount SHALL always contain either the canvas or the message, and SHALL NOT be empty at any time after the first render.

### Requirement 11: Hunt slot

**User Story:** As the author of `exorcist-agent`, I want a reserved place and field for hunt progress, so that my spec only fills them.

#### Acceptance Criteria

1. THE Room visual SHALL have an optional `hunt` field of the type `HuntVisual` (phase, label and progress from 0 to 1), absent in this spec.
2. THE Layout SHALL reserve for each Room a rectangle for the hunt overlay inside the silhouette of the Room and clear of the label and the badge.
3. THE renderer SHALL draw nothing in the Hunt slot in this spec, and SHALL give the Surface the rectangle and the `hunt` value so that no change of the interfaces is needed later.

### Requirement 12: Demo mode

**User Story:** As the team making the video, I want to drive the scene from a script, so that I can record a clean take without the lab.

#### Acceptance Criteria

1. WHEN the URL has `?demo=1`, THE Web SHALL drive the Scene and Table mode from a scripted timeline (calm, then an error spike on payments, fog on orders, ledger dark, recovery) through the same model, without any call to the API or the stream.
2. WHEN the URL has `?demo=<scenario>` with a known name, THE Web SHALL freeze that state; the known names are `calm`, `payments-haunted`, `payments-possessed`, `orders-fog`, `ledger-dark` and `all-haunted`.
3. IF the value of `demo` is not `1` and not a known name, THEN THE Web SHALL ignore it and run in live mode.
4. WHILE the build is a production build, THE Web SHALL ignore the `demo` parameter unless `VITE_DEMO_MODE` is `true`.
5. WHILE Demo mode is on, THE Web SHALL show a visible text "Demo data, not live" in the header.
6. EVERY state the demo produces SHALL pass the Shared validators for `ServiceState`, and the timeline SHALL be a pure function of time, so that the same time always gives the same state; WHERE the URL also has `loop=1`, THE timeline SHALL start again when it ends.

### Requirement 13: Visual language and originality

**User Story:** As a designer and a judge, I want an original, coherent look, so that the entry stands on its own.

#### Acceptance Criteria

1. THE Palette tokens SHALL be defined once in `palette.ts`, and the CSS custom properties that repeat them SHALL be checked against it by a test.
2. THE Scene SHALL be drawn from procedural shapes, gradients and runtime generated textures only, and SHALL NOT import or load any image, SVG, font or sound file; an audit test SHALL scan the scene sources for such imports.
3. THE Scene SHALL NOT copy or imitate the names, characters, art or interface of any existing game, film or franchise; `design.md` SHALL describe the original motifs (the night, the cutaway house, the lamp, the wisps and the fog) in a Visual Language section.
4. THE text in the Scene SHALL use the system font stack of the page.

### Requirement 14: Verification, e2e and documents

**User Story:** As a maintainer, I want the scene covered by fast tests and one visual smoke test, so that I can change it with confidence.

#### Acceptance Criteria

1. THE unit and property tests of the model, the Layout, the Animator, the selection logic, the demo timeline and the renderer lifecycle SHALL run in Vitest without WebGL.
2. THE Web SHALL have a Playwright smoke test that opens `?demo=payments-haunted` and `?demo=ledger-dark`, saves screenshots under `apps/web/test-results/` (git-ignored), and asserts that the canvas is not blank and that the table shows the matching state; it SHALL run with `pnpm --filter @haunted-ops/web test:e2e` and not as part of `pnpm test`.
3. `docs/DEV.md` SHALL describe the demo URLs, `VITE_DEMO_MODE`, how to install the Playwright browser, how to run the smoke test and the bundle check, and `.env.example` SHALL list `VITE_DEMO_MODE` with no real value.
4. WHEN `scene-engine` is finished, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm check:build` SHALL pass at the root with no GPU, and the bundle check SHALL pass after a build.
