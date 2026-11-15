# Requirements Document

## Introduction

`accessible-mode` is the seventh product spec of Haunted Ops, after `foundation`, `haunted-lab`, `ingest-haunt-score`, `scene-engine`, `exorcist-agent` and `fix-proposal-flow` (the planned order puts it after `fix-proposal-flow`, so the hunt and the fix proposal states already exist). Earlier specs deferred "full accessible mode" to it. The promises it keeps are already written: `a11y-perf.md` (the table shows the same state as the scene, everything by keyboard with visible focus, one ARIA live region, contrast 4.5 to 1 for text and 3 to 1 for UI, never colour alone, `prefers-reduced-motion`, small main bundle), `product.md` ("the same state is available in an accessible table mode") and `scene-rendering.md` (no shake, no flashing, parity).

Today the scene, the table and the live announcer are always rendered together. This spec adds a switch that turns the whole page into a table-first view: the scene is not mounted and its lazy chunk is not requested, the table becomes the main view with landmarks, a skip link and ordered headings, every focusable element has a visible focus, every state change is announced once through the existing single live region, and the colours, motion and status marks follow the rules above. It changes no API, no database and no shared type, and it adds no dependency.

It does not add sound (`spatial-audio`), a deploy (`deploy-demo`), a second live region, or a new theme.

## Glossary

- **Workspace**, **API**, **Web**, **Shared**, **Service**, **Haunt level**, **Table mode**, **Live state**, **Selection**, **Demo mode**, **Reduced motion**, **Scene**, **SceneMount**: as defined in the earlier specs.
- **Accessible mode**: the state of the Web in which the Scene is not mounted and the table is the main view.
- **Mode preference**: the three inputs that decide Accessible mode: the saved choice, the URL parameter `mode`, and the Reduced motion setting of the browser.
- **Saved choice**: the user's last explicit choice (`on` or `off`) in `localStorage` under the key `haunted-ops.a11y.v1`.
- **Mode resolver**: the pure function `resolveMode` that turns the Mode preference into `{ accessible, source }`.
- **Switch**: the header button "Accessible mode" with `aria-pressed`.
- **Skip link**: the first focusable element of the page, "Skip to services", which moves focus to the table.
- **Announcer**: the existing `LiveAnnouncer` component, with its one `polite` live region. It is the only live region of the page.
- **Announcement queue**: the pure state machine `announcementQueue` that filters, spaces and orders the sentences the Announcer speaks.
- **Scene fact**: any piece of information the Scene shows: room status, error ratio, latency, last deploy, hunt progress steps, diagnosis with culprit deploy and commit, fix proposal status, pull request link and checks.
- **Contrast pair**: a foreground and a background colour token used together in `styles.css`.
- **Status mark**: the text label and the distinct symbol that state a status, so that colour is never the only signal.
- **Focus anchor**: the row id (a Service name) that had focus before a render, to which focus is restored after it.

## Requirements

### Requirement 1: The switch and the mode preference

**User Story:** As a screen-reader user, a judge with a shared link, or someone who prefers less motion, I want the page to open in the mode that suits me and to remember my choice, so that I do not have to set it again.

#### Acceptance Criteria

1. THE Web SHALL render the Switch as a real `<button>` with `aria-pressed`, labelled "Accessible mode", inside the `header`, and it SHALL be the first focusable element after the Skip link.
2. THE Mode resolver SHALL be a pure function of the Saved choice, the URL `mode` parameter and the Reduced motion flag, and it SHALL give Accessible mode on when, in this order of precedence: the URL has `mode=scene` (off), else the URL has `mode=accessible` (on), else the Saved choice is `on` or `off` (as saved), else Reduced motion is set (on), else off.
3. WHEN the URL has `mode=scene`, THE Web SHALL turn Accessible mode off for the session without writing or deleting the Saved choice.
4. WHEN the user presses the Switch, THE Web SHALL flip Accessible mode and SHALL save the new value as the Saved choice, and a saved `off` SHALL win over Reduced motion on later visits.
5. THE Web SHALL keep the Saved choice under the single key `haunted-ops.a11y.v1`, as the JSON text of an object with a `mode` field of `"on"` or `"off"`, and SHALL read it defensively: invalid JSON, a wrong shape, an unknown value, a missing `localStorage` and a `localStorage` that throws SHALL all be treated as no choice and SHALL NOT raise an error.
6. IF writing the Saved choice fails, THEN THE Web SHALL keep the new mode for the session and SHALL NOT raise an error.
7. WHEN Reduced motion changes while the page is open and the user has no Saved choice and the URL has no `mode` parameter, THE Web SHALL re-resolve the mode.

### Requirement 2: The Scene is not loaded in Accessible mode

**User Story:** As a user of assistive technology or a slow device, I want no WebGL, canvas or animation when I choose accessible mode, so that the page is light and calm.

#### Acceptance Criteria

1. WHILE Accessible mode is on, THE Web SHALL NOT mount `SceneMount`, SHALL NOT call the loader of the scene chunk (`loadCanvas`), SHALL NOT request the scene chunk over the network, and SHALL NOT create a `<canvas>`, a WebGL context or an animation frame request for the Scene.
2. WHEN Accessible mode is turned off, THE Web SHALL mount the Scene as the existing lazy path does.
3. WHEN Accessible mode is turned on while the Scene is mounted, THE Web SHALL unmount it, and the unmount SHALL stop every timer and animation frame of the Scene, destroy the renderer once, and leave no canvas in the document.
4. THE entry chunk of the Web SHALL grow by at most 3 KiB gzip against the value measured before this spec (88.1 KiB on 15 Nov 2026) and SHALL stay within the budget of `scripts/check-scene-bundle.mjs`; the Scene chunk budget SHALL not change.
5. THE Header, the Announcer, the Switch and the table SHALL keep working in both modes with the same Live state and the same Selection.

### Requirement 3: Table first

**User Story:** As a screen-reader user, I want the table to be a complete, well-structured page, so that I can find every fact without the picture.

#### Acceptance Criteria

1. WHILE Accessible mode is on, THE Web SHALL render one `<h1>` for the page, the landmarks `header` and `main` (and a `nav` only if it holds links), and headings in order without skipped levels.
2. THE Skip link SHALL read "Skip to services", SHALL be visible when it has focus, and WHEN activated SHALL move focus to the table region.
3. THE table SHALL have a `<caption>`, column headers with `scope="col"`, row headers with `scope="row"`, and the selected row SHALL carry `aria-current="true"`.
4. THE table and its detail panel SHALL contain every Scene fact as text: room status, error ratio, latency, last deploy, the hunt progress steps, the diagnosis with the culprit deploy and commit, the fix proposal status, the pull request link and the checks.
5. FOR ANY valid Live state, every fact the Scene model and the hunt and proposal views carry SHALL appear as text in Accessible mode, and the property test of parity SHALL assert it.
6. THE Web SHALL keep the same table content in Accessible mode and outside it, so that the existing parity between Scene and table keeps holding.

### Requirement 4: Keyboard

**User Story:** As a keyboard user, I want to do everything without a mouse and never lose my place, so that the page is usable.

#### Acceptance Criteria

1. THE Web SHALL make the Switch, the Skip link, every row, the hunt start control (when allowed), the proposal actions and links, and the detail open and close controls reachable and operable by keyboard alone, in reading order, with no keyboard trap.
2. EVERY focusable element SHALL show a visible focus indicator with a contrast of at least 3 to 1 against its surroundings, and the room buttons SHALL show an outline and not only a changed background.
3. WHEN the user presses Escape while the detail is open, THE Web SHALL close it and move focus back to the row that opened it.
4. WHEN an update of the Live state re-renders the table, THE Web SHALL keep the keys of the rows stable and SHALL restore focus to the Focus anchor if it was lost, so that focus never falls to `<body>`.
5. IF the Focus anchor row no longer exists, THEN THE Web SHALL move focus to the table region.
6. WHEN the page is opened at `/hunts/<id>` in Accessible mode, THE Web SHALL select that Service, move focus to its row and open its detail; a focus request made while the Scene is shown SHALL be dropped, so that a later switch to Accessible mode does not take focus.

### Requirement 5: Announcements

**User Story:** As a screen-reader user, I want each important change announced once, briefly and in order, so that I follow an incident without being flooded.

#### Acceptance Criteria

1. THE Web SHALL keep exactly one live region in the whole page, the `polite` region of the Announcer, and no component SHALL add another: no `aria-live`, `role="status"`, `role="alert"` or `role="log"` outside it, in either mode and with the Scene fallback shown. The Header, the stale notice and the Scene fallback show their text as plain text.
2. THE Announcer SHALL speak one sentence, short and in plain words, for each of these changes: a room goes dark; a room recovers; a hunt starts; each hunt step; the diagnosis is ready (service, culprit deploy, short commit); a fix proposal is opened (AI patch or revert); a fix is merged; a fix is deployed; a fix fails with its short reason (`aiFailReason` or `failReason` of the proposal view); the connection changes (live, reconnecting, offline); the data becomes stale or fresh again; the Scene fallback is shown. The first connection and the first ingest state are not changes.
3. THE Announcement queue SHALL drop a sentence identical to one spoken or queued in the last 10 seconds.
4. THE Announcement queue SHALL release at most one sentence per 2 seconds, in the order received, and every released sentence SHALL be a change of the DOM of the live region, also when its text equals the previous one.
5. THE Announcement queue SHALL hold at most 5 pending sentences and, WHEN a sixth arrives, SHALL drop the oldest pending sentence.
6. THE Announcement queue SHALL be a pure function of its state, the sentence and the time, with no timer, DOM or `Date.now`, and a thin hook SHALL drive it from `setTimeout` and clean the timer up on unmount.
7. WHILE the page is first loading, THE Announcer SHALL NOT speak the state that was already there; it SHALL speak only changes.

### Requirement 6: Motion and flashing

**User Story:** As a person sensitive to motion, I want no movement or flashing when I ask for none, so that the page is safe.

#### Acceptance Criteria

1. WHILE Accessible mode is on or Reduced motion is set, THE stylesheet SHALL leave no CSS animation or transition with a duration above 0 s on the page, except the focus indicator, and nothing SHALL blink.
2. WHILE Accessible mode is on, THE Web SHALL set a marker on the root element (`data-a11y="on"`) that the stylesheet uses for that rule, so that the rule holds even when the browser does not report Reduced motion.
3. OUTSIDE Accessible mode, THE Scene SHALL keep the rule of no flashing above 3 per second, and a test SHALL assert it from the constants of the Scene animator (flicker bandwidth and the pulse rates).
4. THE Web SHALL NOT shake the page or any text in either mode, and the Scene SHALL NOT move any Room or object at any Haunt level: level 3 dips the light slowly (at most 3 changes per second) instead of trembling.

### Requirement 7: Contrast and colour

**User Story:** As a user with low vision or colour blindness, I want readable text and clear states, so that I can read the page and tell the states apart.

#### Acceptance Criteria

1. THE Web SHALL provide a pure function `contrastRatio(a, b)` that implements the WCAG relative luminance formula for two `#rrggbb` colours, with no new dependency, using the sRGB threshold 0.04045 of WCAG 2.x.
2. THE test of contrast SHALL list explicitly every Contrast pair used by `styles.css` (text on background, and UI component or focus indicator on background), and SHALL check at least 4.5 to 1 for text and 3 to 1 for UI components, in the normal theme and in Accessible mode.
3. THE Web SHALL give every status (the five Haunt levels, dark, deploy and proposal states, connection states) a text label and a distinct symbol, so that no status relies on colour alone.
4. THE symbols of two different statuses of the same group SHALL differ, and a test SHALL assert it.
5. THE Web SHALL keep every colour used by `styles.css` as a named custom property, so that the test of 7.2 can read them.

### Requirement 8: Deep link and Demo mode

**User Story:** As a judge, I want the demo and the deep links to work in accessible mode, so that I can follow the story with a screen reader.

#### Acceptance Criteria

1. WHEN the page opens at `/hunts/<id>` in Accessible mode, THE Web SHALL behave as in 4.6.
2. WHILE Demo mode is on (`demo` is not `null`), THE Web SHALL work in Accessible mode with the same table, the same Announcer and no request to the API or the stream, as in the earlier specs.
3. THE parameters `mode` and `demo` SHALL combine: `/?demo=1&mode=accessible` SHALL show the demo in the table with no Scene.

### Requirement 9: Documents and tests

**User Story:** As a maintainer and a judge, I want the mode documented and checked, so that I can trust and find it.

#### Acceptance Criteria

1. THE `README.md` and `docs/DEV.md` SHALL explain how to turn Accessible mode on (the Switch and `?mode=accessible`) and what it guarantees.
2. THE `a11y-perf.md` steering file SHALL be updated only where this spec makes a promise concrete, in a few lines.
3. THE Web SHALL have a Playwright test `apps/web/e2e/accessible.spec.ts` that opens `/?mode=accessible` with demo data, asserts no request for the scene chunk and no `<canvas>`, reaches the Switch, every row and the detail with the keyboard alone, shows the canvas when the Switch is turned off and removes it when it is turned on, and checks that `prefers-reduced-motion: reduce` turns the mode on with no Saved choice.
4. THE existing tests SHALL stay green and no existing assertion SHALL be weakened.
5. THE spec SHALL add no dependency, change no API, no Prisma schema and no shared type, and SHALL contain original code and wording only.
