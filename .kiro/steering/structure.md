---
inclusion: always
---

# Structure

```
apps/
  web/              Vite + React + PixiJS scene, table mode
  api/              NestJS + Prisma + SSE
packages/
  shared/           types and plain validators shared by api and web
  exorcist-mcp/     MCP server (stdio) for the Exorcist agent
tools/
  sanitize-replay/  fixture sanitizer
.kiro/
  steering/         always-on and fileMatch guidance
  hooks/            agent hooks
  agents/           exorcist.json
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

Only `exorcist-agent` exists so far, with task 0 (the G0 spike). Write one spec per prompt.
