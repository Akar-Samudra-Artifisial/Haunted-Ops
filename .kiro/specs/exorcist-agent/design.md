# Design Document: exorcist-agent

## Overview

The full design is written after G0. This document currently covers only the G0 spike: one headless hunt where `kiro-cli chat --no-interactive` runs the `exorcist` agent against a tiny stdio MCP server, plus a check that tools outside the allow-list are refused and a measurement of cost and wall time.

Spike code lives in `spikes/g0/` and is throwaway. Product code is rewritten through this spec.

## Architecture

```
kiro-cli chat --no-interactive --agent exorcist --trust-tools=<3 MCP tools>
        |
        |  stdio JSON-RPC (MCP)
        v
spikes/g0/server.ts  --->  spikes/g0/out/diagnosis.json
```

- Runtime: headless `kiro-cli` (engine v3), agent resolved by name from `.kiro/agents/`.
- Tool boundary: the agent config exposes only `@exorcist` tools; `--trust-tools` lists the same three tools.
- Output: the only side effect is `submit_diagnosis` writing one JSON file.

## Components and Interfaces

### Spike MCP server (`spikes/g0/server.ts`)

Stdio MCP server, run with `node --experimental-strip-types`. Tools:

- `query_metrics({service})`: returns a fixed fixture. `payments` error rate jumps from 0.2% to 31% after deploy `d-102`.
- `diff_commit({commit})`: returns a small fixture diff that removes a null check, wrapped as untrusted data.
- `submit_diagnosis(diagnosis)`: validates the payload and writes `spikes/g0/out/diagnosis.json`. Accepts one call per server process.

All input schemas use `additionalProperties: false`.

### Agent config (`spikes/g0/exorcist.json`, copied to `.kiro/agents/exorcist.json`)

Short prompt: investigate, cite evidence, call `submit_diagnosis` once. Tools limited to the three MCP tools; no shell, no file-write tools.

## Data Models

Diagnosis (input to `submit_diagnosis`):

| Field | Type | Rule |
| --- | --- | --- |
| `summary` | string | non-empty, max 500 chars |
| `evidence` | array of `{kind, ref, detail}` | 1 to 10 items, all strings |
| `culprit_commit` | string | non-empty, max 40 chars |
| `confidence` | number | 0 to 1 |

Fixtures are hard-coded in the spike MCP server. They are synthetic and contain no production data.

## Error Handling

- Invalid diagnosis or unknown field: `submit_diagnosis` returns `isError: true` with the reason; nothing is written.
- Second `submit_diagnosis` call: rejected with `already submitted`.
- Unknown tool or JSON-RPC method: error result / `-32601`.
- Agent not found or MCP server fails to start: `kiro-cli` exits non-zero; recorded as a FAIL cause.

## Testing Strategy

The spike is verified by running it, not by unit tests:

- Hunt run: exit code, wall time, credits, tool calls and the written diagnosis are recorded in `spikes/g0/G0.md`.
- Allow-list probe: ask the agent to run `ls` and confirm the call is refused.

### Decision rule

- PASS: the agent calls only allowed tools, `submit_diagnosis` is called once with a valid payload, an out-of-list tool is refused, and cost and time are measurable. Headless `kiro-cli` + MCP is the runtime.
- FAIL: headless mode cannot load the agent or the MCP server, cannot enforce the allow-list, or cost cannot be measured. Fall back to ACP; the fallback is described in `spikes/g0/G0.md` but not implemented in the spike.
