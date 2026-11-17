---
inclusion: fileMatch
fileMatchPattern: "apps/web/**"
---

# Accessibility and performance

- Table mode shows the same state as the scene: every room, its status, errors, latency and the hunt progress.
- Everything is reachable by keyboard, with visible focus.
- Accessible mode (`accessible-mode` spec): header switch, `?mode=accessible`, saved under `haunted-ops.a11y.v1`; the scene is not mounted and its chunk is not requested. One announcer queue: no repeat within 10 s, one sentence per 2 s, at most 5 waiting. Every colour pair of `styles.css` is listed in `a11y/contrast.test.ts`; a new colour must be a custom property and be added there.
- Design tokens (`visual-refresh` spec), all in `:root` of `styles.css`: colours `--bg #0B0A12`, `--surface`, `--surface-2`, `--line`, `--text`, `--text-muted`, `--lantern` (healthy, accents), `--danger`, `--fog` (latency), `--ecto` (the Exorcist), `--focus`; type `--font-display`, `--font-ui`, `--font-num` (tabular numbers), `--step--1` to `--step-3`; `--space-1` to `--space-6`, `--radius-1/2`, `--shadow`. Every colour in CSS is a token. Contrast rule: every text pair at 4.5:1, large text and UI parts at 3:1, listed in `a11y/contrast.test.ts`; `--bg` and `--focus` equal the scene palette (`night`, `ring`). Motion: only transitions under 200 ms and one soft pulse, off under Reduced motion and in Accessible mode.
- Use an ARIA live region for state changes (room goes dark, hunt step, diagnosis, fix merged). Keep announcements short and not repetitive.
- Contrast at least 4.5:1 for text, 3:1 for UI components. Do not rely on color alone.
- Honor `prefers-reduced-motion`.
- Performance: keep the main bundle small, lazy-load audio and heavy scene code, avoid layout thrash. Sound (`visual-refresh` part 7) is a lazy chunk plus the files of `public/sfx/`, loaded only when the visitor turns sound on with the header button ("Sound off" / "Sound on", `aria-pressed`, default off, kept under `haunted-ops.sound.v1`); the browser needs one click per page load, so a stored "on" starts at the first click. The same changes that the live region announces make the cues (`components/changes.ts`); no cue for the first snapshot or on the replay page; at most one cue per 700 ms, `hunt-step` once per 3 s, the same cue for the same room once per 5 s.
