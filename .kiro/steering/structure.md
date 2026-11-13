---
inclusion: always
---

# Structure

```
apps/
  web/              Vite + React + PixiJS scene, table mode
  api/              NestJS + Prisma + SSE; src/hunts runs the Exorcist (kiro-cli child process); src/fix (planned) runs the fixer, git and GitHub
packages/
  shared/           types and plain validators shared by api and web
  exorcist-mcp/     MCP server (stdio) for the Exorcist agent; bin/haunted-exorcist-mcp launcher
tools/
  sanitize-replay/  fixture sanitizer (hunt streams first, incidents in `replay`)
  fake-kiro-cli/    kiro-cli stand-in for tests (script and replay modes) and its fixtures
scripts/            gate checks (g1-score, g2-hunt, gmvp-fix planned) and the scene bundle check
.kiro/
  steering/         always-on and fileMatch guidance
  hooks/            agent hooks
  agents/           exorcist.json, exorcist-fixer.json (planned, fix-proposal-flow)
  specs/            feature specs
docs/
  DEV.md            local setup (Node, pnpm, Postgres, tests)
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
10. `spatial-audio`
11. `submission-kit`

Written so far: `foundation`, `ingest-haunt-score`, `scene-engine`, `exorcist-agent` and `fix-proposal-flow` (spec only) in this repo, `haunted-lab` in the lab repo. The lab-side `fix-deploy` spec is still to be written in the lab repo. Write one spec per prompt.

Hunts run outside the repo, in `HUNT_WORKDIR` (default under the OS temp folder), so no project steering or hooks load into the Exorcist.
