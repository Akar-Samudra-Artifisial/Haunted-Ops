---
inclusion: always
---

# Tech

Package manager: pnpm only. Runtime: Node 26. Language: TypeScript, strict mode.

## Stack

- `apps/web`: Vite + React + PixiJS v8 + Web Audio. Sound is a lazy chunk (`apps/web/src/sound/player.ts`, one `AudioContext`, eight cues in `apps/web/public/sfx/` made with Mirelo SFX 1.5 via Runware and curated by the team): it is imported and its files are fetched only when the visitor turns sound on, and sound is off by default (no spatial audio).
- `apps/api`: NestJS + Prisma + PostgreSQL + SSE. No Redis, single instance.
- `packages/exorcist-mcp`: MCP server over stdio. Tools: `query_metrics`, `search_errors`, `tail_logs`, `recent_deploys`, `diff_commit`, `submit_diagnosis`. There is no `propose_fix` tool: the fixer is a separate server-run agent (`exorcist-fixer`, `fs_read` and `fs_write` only), and the Exorcist stays read-only.
- `.kiro/agents/exorcist.json`: the Exorcist agent, restricted to the MCP tools.
- `tools/sanitize-replay`: turns recorded incidents into reviewed, sanitized fixtures.
- Lab: separate repo `haunted-lab` (gate, orders, payments, ledger + Prometheus + chaos controller).

## Decisions

- Agent runtime is headless `kiro-cli` + MCP, not ACP. ACP is the fallback only if the G0 spike fails.
- SSE over WebSocket: one-way server to browser stream, simpler, works through proxies.
- PostgreSQL only: state, events and replays in one store. Single instance keeps fan-out in memory.
- PixiJS v8 for the scene: WebGL/WebGPU sprites. Scene art is procedural shapes plus the team's illustrated sprites in `apps/web/public/scene/` (generated with Seedream 5.5 via Runware and curated by the team; original, imitating no existing game, film or franchise); the procedural art stays as the fallback. Only `apps/web/src/scene/sprites.ts` loads the files; no asset pipeline.
- The server, not the agent, holds the GitHub token and opens pull requests.

## Rejected alternatives

- ACP as primary runtime: more moving parts, session handling we do not need.
- Redis / message broker: single instance, not needed.
- WebSocket: bidirectional channel not needed.
- Three.js / true 3D: cost and risk for a 2.5D look.
- npm / yarn: pnpm only.
- Agent with shell or file-write tools: unsafe, replaced by MCP tools only.
