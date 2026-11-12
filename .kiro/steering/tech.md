---
inclusion: always
---

# Tech

Package manager: pnpm only. Runtime: Node 26. Language: TypeScript, strict mode.

## Stack

- `apps/web`: Vite + React + PixiJS v8 + Web Audio.
- `apps/api`: NestJS + Prisma + PostgreSQL + SSE. No Redis, single instance.
- `packages/exorcist-mcp`: MCP server over stdio. Tools: `query_metrics`, `search_errors`, `tail_logs`, `recent_deploys`, `diff_commit`, `submit_diagnosis`, `propose_fix`.
- `.kiro/agents/exorcist.json`: the Exorcist agent, restricted to the MCP tools.
- `tools/sanitize-replay`: turns recorded incidents into reviewed, sanitized fixtures.
- Lab: separate repo `haunted-lab` (gate, orders, payments, ledger + Prometheus + chaos controller).

## Decisions

- Agent runtime is headless `kiro-cli` + MCP, not ACP. ACP is the fallback only if the G0 spike fails.
- SSE over WebSocket: one-way server to browser stream, simpler, works through proxies.
- PostgreSQL only: state, events and replays in one store. Single instance keeps fan-out in memory.
- PixiJS v8 for the scene: WebGL/WebGPU sprites with procedural shapes, no asset pipeline.
- The server, not the agent, holds the GitHub token and opens pull requests.

## Rejected alternatives

- ACP as primary runtime: more moving parts, session handling we do not need.
- Redis / message broker: single instance, not needed.
- WebSocket: bidirectional channel not needed.
- Three.js / true 3D: cost and risk for a 2.5D look.
- npm / yarn: pnpm only.
- Agent with shell or file-write tools: unsafe, replaced by MCP tools only.
