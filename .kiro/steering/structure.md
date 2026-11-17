---
inclusion: always
---

# Structure

```
apps/
  web/              Vite + React + PixiJS scene, table mode
  api/              NestJS + Prisma + SSE; src/hunts runs the Exorcist (kiro-cli child process); src/fix runs the fixer, the patch checks, git and GitHub; src/replays seeds and serves replays (GET only)
packages/
  shared/           types and plain validators shared by api and web
  exorcist-mcp/     MCP server (stdio) for the Exorcist agent; bin/haunted-exorcist-mcp launcher
tools/
  sanitize-replay/  fixture sanitizer (hunt streams first, incidents in `replay`)
  replay-build/     build-replay.mjs (one incident from the database to a replay file) and review-replay.mjs (a person reads and approves it)
  fake-kiro-cli/    kiro-cli stand-in for tests (script and replay modes) and its fixtures
fixtures/
  replays/          reviewed replay files (`<id>.json`) and a README; only `review` set files ship
deploy/             build-release.sh (Mac) and server/ (install, units, Caddyfile, nftables, env examples)
scripts/            gate checks (g1-score, g2-hunt, gmvp-fix), fixer stream tools (sanitize-fixer-stream, fixer-stream-shapes), the live pre-flight (fix-live-preflight), the scene bundle check and the demo deploy tools (demo-env-check, demo-smoke, release-check)
.kiro/
  steering/         always-on and fileMatch guidance
  hooks/            agent hooks
  agents/           exorcist.json, exorcist-fixer.json (fix-proposal-flow)
  specs/            feature specs
docs/
  DEV.md            local setup (Node, pnpm, Postgres, tests)
  DEPLOY.md         demo server runbook (deploy-demo)
  KIRO_USAGE.md     one line per finished task
spikes/             committed spike work (spikes/g0)
spike/              local working briefs only, git-ignored
```

The lab lives in a separate repo, `haunted-lab`.

Note: `spike/` (singular) is ignored. `spikes/` (plural) is committed. Spike code is throwaway; product code is rewritten through specs.

## Planned specs, in order

1. `foundation`
2. `haunted-lab`
3. `ingest-haunt-score`
4. `scene-engine`
5. `exorcist-agent`
6. `fix-proposal-flow`
7. `accessible-mode`
8. `deploy-demo`
9. `replay`
10. `visual-refresh`
11. `spatial-audio` (replaced by `visual-refresh` part 7: simple sound cues with a mute button, no spatial audio)
12. `submission-kit`

Written so far: `foundation`, `ingest-haunt-score`, `scene-engine`, `exorcist-agent`, `fix-proposal-flow` (spec and code; the live recording and gate G-MVP are run by the orchestrator), `accessible-mode`, `deploy-demo` (spec, files and local tests; the orchestrator provisions the server and runs the smoke test there) and `replay` (spec and code; the orchestrator builds and reviews the real replays) in this repo, `haunted-lab` in the lab repo. The lab-side `fix-deploy` spec is still to be written in the lab repo. Write one spec per prompt.

Hunts run outside the repo, in `HUNT_WORKDIR` (default under the OS temp folder), so no project steering or hooks load into the Exorcist.
