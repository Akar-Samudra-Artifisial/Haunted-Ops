---
inclusion: fileMatch
fileMatchPattern: "apps/web/**"
---

# Accessibility and performance

- Table mode shows the same state as the scene: every room, its status, errors, latency and the hunt progress.
- Everything is reachable by keyboard, with visible focus.
- Accessible mode (`accessible-mode` spec): header switch, `?mode=accessible`, saved under `haunted-ops.a11y.v1`; the scene is not mounted and its chunk is not requested. One announcer queue: no repeat within 10 s, one sentence per 2 s, at most 5 waiting. Every colour pair of `styles.css` is listed in `a11y/contrast.test.ts`; a new colour must be a custom property and be added there.
- Use an ARIA live region for state changes (room goes dark, hunt step, diagnosis, fix merged). Keep announcements short and not repetitive.
- Contrast at least 4.5:1 for text, 3:1 for UI components. Do not rely on color alone.
- Honor `prefers-reduced-motion`.
- Performance: keep the main bundle small, lazy-load audio and heavy scene code, avoid layout thrash.
