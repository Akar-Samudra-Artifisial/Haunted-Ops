# Design Document

## Overview

`accessible-mode` adds a page-level switch to the Web. The decision is a pure function; the rest is wiring around components that already exist.

```
saved choice (localStorage) --+
URL ?mode=                    +--> resolveMode --> { accessible, source } --> App
prefers-reduced-motion -------+                                              |
                                                     accessible: no SceneMount, data-a11y="on"
                                                     otherwise : SceneMount (lazy chunk) as today
live state --> table-model / hunt-text / proposal-text --> sentences --> announcementQueue --> LiveAnnouncer
```

Key decisions:

- **One pure resolver.** `resolveMode` takes plain values and returns the mode and why. Reading `localStorage` and the URL is done by small defensive readers that never throw. This keeps the precedence testable with fast-check.
- **Unmount, not hide.** In Accessible mode `SceneMount` is not rendered at all. The existing `loadCanvas` seam is therefore never called, and the existing unmount cleanup of the Scene stops the loop and destroys the renderer. No new Scene code is needed.
- **The table is the page.** The table, the hunt section and the Announcer are already always rendered. Accessible mode adds structure (`h1`, `main`, skip link, `scope`, `aria-current`) and focus handling. It does not fork the table.
- **One live region, one queue.** The Announcer keeps its single `polite` region. A pure queue sits in front of it and applies the 10 s repeat window, the 2 s spacing and the cap of 5.
- **CSS decides motion.** A `data-a11y="on"` attribute on the root element and the existing `prefers-reduced-motion` media query share one rule that zeroes every animation and transition duration. Focus has no transition, so it needs no exception.
- **Contrast is data.** The colours are custom properties. A pure `contrastRatio` and an explicit list of pairs in a test check them against the numbers in `styles.css`.
- **No new dependency.** Everything uses React, the DOM and the existing test tools.

### Bundle budget

`scene-engine` measured the entry chunk at 80.2 KiB gzip and the scene at 156.5 KiB. After `exorcist-agent` and `fix-proposal-flow`, the baseline measured for this spec on 15 Nov 2026 (`pnpm build`, then `scripts/check-scene-bundle.mjs`) is: entry 88.1 KiB (2 files), SceneCanvas file 97.3 KiB, scene with its static imports 158.6 KiB (6 files), plus 15.8 KiB loaded on demand. The entry may grow by at most 3 KiB over 88.1 KiB, which is also the room left under the 92 KiB budget (3.9 KiB). The Scene budgets do not change. The Scene budgets do not change.

## Architecture

New and changed files, all under `apps/web/src`:

| File | Kind | Content |
| --- | --- | --- |
| `a11y/mode.ts` | new, pure | `resolveMode`, `parseSavedChoice`, `serializeChoice`, `STORAGE_KEY`, `parseModeParam` |
| `a11y/storage.ts` | new | `readSavedChoice(storage?)`, `writeSavedChoice(choice, storage?)`, both total |
| `a11y/useAccessibleMode.ts` | new | hook: resolves the mode, re-resolves on a Reduced motion change, exposes `toggle` |
| `a11y/announcement-queue.ts` | new, pure | `createQueue`, `enqueue`, `release`, constants |
| `a11y/contrast.ts` | new, pure | `parseHex`, `relativeLuminance`, `contrastRatio` |
| `a11y/status-marks.ts` | new, pure | `statusMark(group, status)` giving `{ label, symbol }` |
| `a11y/focus.ts` | new | `useFocusAnchor`, `focusRow` helpers |
| `components/AccessibleSwitch.tsx` | new | the button |
| `components/SkipLink.tsx` | new | the skip link |
| `components/LiveAnnouncer.tsx` | changed | new sentences, drives the queue |
| `components/TableMode.tsx`, `HuntSection.tsx` | changed | `scope`, `aria-current`, stable keys, focus return |
| `App.tsx` | changed | landmarks, mode, no `SceneMount` in Accessible mode, Escape and deep link focus |
| `styles.css` | changed | focus of room buttons, `data-a11y` motion rule, status marks, skip link |

## Components and Interfaces

### Mode resolver (`a11y/mode.ts`)

```ts
export type SavedChoice = 'on' | 'off' | null;
export type ModeSource = 'url-scene' | 'url-accessible' | 'saved' | 'reduced-motion' | 'default';
export interface ModeInput { urlMode: 'scene' | 'accessible' | null; saved: SavedChoice; reducedMotion: boolean }
export interface ModeResult { accessible: boolean; source: ModeSource }
export const STORAGE_KEY = 'haunted-ops.a11y.v1';
export function resolveMode(input: ModeInput): ModeResult;
export function parseModeParam(search: string): 'scene' | 'accessible' | null;
export function parseSavedChoice(raw: string | null): SavedChoice;
```

Precedence: `url-scene`, then `url-accessible`, then `saved`, then `reduced-motion`, then `default` (off). `parseSavedChoice` returns `null` for anything that is not a JSON object with `mode` equal to `"on"` or `"off"`. `parseModeParam` accepts only the two exact words, case-sensitive, and the first `mode` value wins.

### Storage (`a11y/storage.ts`)

`readSavedChoice` looks up `globalThis.localStorage` inside a `try`; a missing object, a getter that throws, `getItem` that throws, bad JSON or a wrong shape all give `null`. `writeSavedChoice` returns `boolean` and swallows every error. The storage is passed as an argument in tests.

### Hook (`a11y/useAccessibleMode.ts`)

The hook reads the URL once, the saved choice once, and subscribes to `matchMedia('(prefers-reduced-motion: reduce)')` through the existing `usePrefersReducedMotion`. State is `{ saved, session }`. `toggle()` computes the new value from the current result, stores it as `saved` (and writes it) and, when the URL forced a mode, clears that force for the session so that the press has effect. A `mode=scene` URL never writes on load. The hook returns `{ accessible, toggle }`.

### Announcement queue (`a11y/announcement-queue.ts`)

```ts
export const REPEAT_WINDOW_MS = 10_000;
export const MIN_GAP_MS = 2_000;
export const MAX_PENDING = 5;
export interface QueueState { pending: string[]; seen: Array<{ text: string; at: number }>; lastSpokenAt: number | null }
export function createQueue(): QueueState;
export function enqueue(state: QueueState, text: string, now: number): QueueState;
export function release(state: QueueState, now: number): { state: QueueState; spoken: string | null; nextInMs: number | null };
```

`enqueue` drops the sentence if the same text is pending or was seen less than `REPEAT_WINDOW_MS` ago; otherwise it appends it and, above `MAX_PENDING`, drops the oldest. A sentence is recorded in `seen` when it is enqueued, so a burst of equal sentences yields one. `release` speaks the head when `lastSpokenAt` is `null` or `now - lastSpokenAt >= MIN_GAP_MS`; otherwise it reports `nextInMs`. `seen` entries older than the window are pruned on every call. The functions never mutate their input.

The hook inside `LiveAnnouncer` holds the state in a ref, calls `enqueue` for each new sentence, then `release`, and schedules one `setTimeout` for `nextInMs`. It clears the timer on unmount. The first render only records the sentences already there (requirement 5.7).

### Sentences (`components/LiveAnnouncer.tsx`)

The existing sentences (`:8-60`) are kept. A pure `announcementsFor(prev, next)` returns the sentences for a change of state, with these additions where missing:

| Change | Sentence |
| --- | --- |
| room goes dark | "payments is dark." |
| room recovers | "payments is back." |
| hunt started | "Hunt started on payments." |
| hunt step | "Hunt step 2: checked error logs." (from `hunt-text.ts`) |
| diagnosis ready | "Diagnosis ready for payments. Culprit deploy d-42, commit a1b2c3d." (commit short to 7 characters) |
| fix proposal opened | "AI patch proposed for payments." or "Revert proposed for payments." |
| merged | "Fix for payments merged." |
| deployed | "Fix for payments deployed." |
| failed | "Fix for payments failed: <short reason>." (`aiFailReason` or `failReason`) |

Reasons come from the proposal view and are already short and scrubbed; the sentence builder trims them to 80 characters. No sentence contains a link, a token or a path.

### Contrast (`a11y/contrast.ts`)

```ts
export function parseHex(hex: string): [number, number, number];   // '#rgb' and '#rrggbb'
export function relativeLuminance(hex: string): number;           // WCAG 2.x, 0..1
export function contrastRatio(a: string, b: string): number;      // (L1 + 0.05) / (L2 + 0.05), L1 >= L2, 1..21
```

The test `contrast.test.ts` reads the custom properties of `styles.css` as text, resolves them, and checks an explicit table of pairs (name, foreground, background, minimum). Pairs for text use 4.5; pairs for borders, focus rings and status symbols use 3. A guard test fails when `styles.css` has a colour literal outside the custom property block that is not covered, so a new colour cannot skip the check.

### Status marks (`a11y/status-marks.ts`)

`statusMark(group, status)` returns `{ label, symbol }` for the groups `haunt` (levels 0 to 4 and dark), `connection`, `deploy` and `proposal`. Symbols are plain text characters (for example `●`, `◐`, `▲`, `■`, `✕`, `✓`) rendered next to the label in a `span` with `aria-hidden="true"`, so a reader hears only the label. Within a group no two statuses share a symbol.

### Focus (`a11y/focus.ts`, `TableMode`, `App`)

- Rows keep `key={service.name}` and each row has `data-row={service.name}`.
- `useFocusAnchor(containerRef)` records the row id on `focusin` and, in a layout effect after each render, when `document.activeElement` is `body` or null and the anchor row exists, calls `focus()` on it; when the row is gone, it focuses the table region (`tabIndex={-1}`).
- When the detail opens, the opener row id is stored. Escape closes the detail (the existing Escape handler at `App.tsx:90-98`) and calls `focusRow(openerId)`.
- The deep link (`App.tsx:74-89`) selects the Service, and in Accessible mode calls `focusRow` and opens the detail once the services have loaded.
- `.room-button:focus-visible` gets `outline: 3px solid var(--focus)` and keeps its background.

### Landmarks and headings

```
<a class="skip-link" href="#services">Skip to services</a>
<header> <h1>Haunted Ops</h1> <AccessibleSwitch/> <status/> </header>
<main id="main"> <section id="services" tabIndex=-1 aria-labelledby="services-title"> <h2 id="services-title">Services</h2> <table>...</table> </section> <detail h3/> </main>
```

The Header, the stale notice and the Scene fallback show plain text without a live role; the app tells their changes (connection, stale or fresh, fallback shown) to the Announcer as notices that go through the same queue. The Announcer renders each released sentence in a `span` with a new key, so a repeated sentence is still a DOM change. In the normal mode the same structure renders around the Scene.

### Motion CSS

```css
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; scroll-behavior: auto !important; } }
:root[data-a11y='on'] *, :root[data-a11y='on'] *::before, :root[data-a11y='on'] *::after { /* same declarations */ }
```

`App` sets and removes `data-a11y` on `document.documentElement` in an effect. A test lists every `animation` and `transition` in `styles.css` and asserts the rule covers them.

## Data Models

No API, Prisma or shared type changes. New local types are the ones above (`ModeInput`, `ModeResult`, `QueueState`) and the saved choice JSON:

```json
{ "mode": "on" }
```

stored under `haunted-ops.a11y.v1`. A future format change uses a new key (`v2`); `v1` is never migrated in place.

## Correctness Properties

*A property is a statement that must hold for all valid inputs. Each one below is checked by a property-based test with fast-check, at least 100 runs, with the comment `// Feature: accessible-mode, Property N`.*

### Property 1: Mode resolution follows the precedence

For any combination of `urlMode`, `saved` and `reducedMotion`, `resolveMode` returns the value of the first rule that applies in the order URL `scene`, URL `accessible`, saved choice, reduced motion, default, and `source` names that rule. The function is total and deterministic.

**Validates: Requirements 1.2, 1.3, 1.4, 1.7**

### Property 2: Reading the saved choice never throws

For any string, `null`, and any storage double that throws on access, on `getItem` or on `setItem`, `parseSavedChoice`, `readSavedChoice` and `writeSavedChoice` return without raising. The result is `on`, `off` or `null`, and a value written then read gives back the same choice.

**Validates: Requirements 1.5, 1.6**

### Property 3: The announcement queue is calm, ordered and bounded

For any sequence of `(sentence, time)` pairs with non-decreasing times, driving the queue with `enqueue` and `release`: no sentence is spoken twice within 10 s; two spoken sentences are at least 2 s apart; the spoken sentences keep the order in which they were enqueued; `pending` never exceeds 5; and the input state is never mutated.

**Validates: Requirements 5.3, 5.4, 5.5, 5.6**

### Property 4: Every Scene fact appears as text

For any generated list of Services (with metrics, reason, incident, deploy), hunts (steps, diagnosis) and proposals (status, kind, link, checks, failure reason), the text content of the table and the detail in Accessible mode contains the room status, the error ratio, the latency, the last deploy, each hunt step, the culprit deploy and short commit, the proposal status and kind, each check by name and result, the AI failure reason, and the pull request link is a link with an accessible name and only `https://github.com/` addresses become links. The Service state carries no deploy besides the diagnosis culprit, so the culprit deploy and short commit are the deploy fact.

**Validates: Requirements 3.4, 3.5, 3.6, 8.2**

### Property 5: Contrast pairs hold and the function is sound

For any two valid colours, `contrastRatio(a, b)` equals `contrastRatio(b, a)`, lies between 1 and 21, and equals 1 when `a` equals `b`. For every listed pair of `styles.css`, the ratio is at least the minimum of its kind (4.5 for text, 3 for UI).

**Validates: Requirements 7.1, 7.2, 7.5**

### Property 6: Statuses have distinct marks

For any two different statuses of the same group, `statusMark` returns different symbols, and every mark has a non-empty label and a symbol.

**Validates: Requirements 7.3, 7.4**

### Property 7: Focus survives re-renders

For any sequence of Live state updates that keep or remove services, after each render `document.activeElement` is never `body` when it was a row before; it is the same row when that row still exists, and the table region otherwise. Escape from the detail returns focus to the row that opened it.

**Validates: Requirements 4.3, 4.4, 4.5**

### Property 8: Accessible mode never loads or leaves the Scene

For any sequence of switch presses starting in either mode: while the mode is on, the loader spy has no new call, no canvas is in the document and no animation frame is pending from the Scene; each time the mode goes on, every Scene timer and frame is cancelled and the renderer is destroyed once; each time it goes off, exactly one Scene is mounted.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 9: The Scene never flashes above 3 per second

The flicker bandwidth and every pulse or blink rate in the animator constants are at most 3 per second, for every Haunt level, and the room offset is 0 at every level, frame and motion mode.

**Validates: Requirements 6.3**

## Error Handling

- **Blocked or full storage**: reads give no choice, writes are dropped silently; the mode still works for the session.
- **Bad saved JSON or a future key version**: treated as no choice.
- **`?mode=` with an unknown value**: ignored.
- **`matchMedia` missing** (old jsdom, odd browsers): Reduced motion is treated as false and no subscription is made.
- **Scene chunk fails to load** (normal mode): the existing fallback applies; Accessible mode is not affected.
- **Announcement burst**: the repeat filter, the 2 s spacing and the cap of 5 drop sentences, oldest first; the table always has the full state.
- **Focus anchor gone**: focus goes to the table region, never to `<body>`.
- **No JavaScript timers left**: the queue timer is cleared on unmount and when the queue is empty.

## Testing Strategy

- **Unit tests** (Vitest, jsdom): `resolveMode` cases, `readSavedChoice` with a throwing storage, bad JSON, wrong shape and a missing object; the `mode` URL parameter; switch precedence in `App` (saved choice, URL, reduced motion, storage errors); the loader spy of `loadCanvas` never called in Accessible mode; toggling stops the Scene timers (fake frame loop); focus restore after a re-render; Escape returns focus; the deep link focuses the row and opens the detail; the Announcer sentences for each listed change and the single live region count; the contrast function against known values (black on white 21, equal colours 1) and the explicit pair table; the motion CSS rule; status marks.
- **Property tests** (fast-check): one test per property above, at least 100 runs, comment `// Feature: accessible-mode, Property N`. The parity property extends `parity.property.test.tsx` and `hunt-parity.property.test.tsx`.
- **Playwright** (`pnpm --filter @haunted-ops/web test:e2e`): `accessible.spec.ts` as in requirement 9.3.
- **Bundle check**: `node scripts/check-scene-bundle.mjs` before and after; entry growth at most 3 KiB.
- **Not covered here**: a real screen reader (NVDA, VoiceOver) run by hand, recorded in `docs/DEV.md` as a manual checklist; sound.
