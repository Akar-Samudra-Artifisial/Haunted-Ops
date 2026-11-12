---
inclusion: fileMatch
fileMatchPattern: "packages/exorcist-mcp/**"
---

# MCP tools

Server: stdio MCP, package `packages/exorcist-mcp`.

Tools: `query_metrics`, `search_errors`, `tail_logs`, `recent_deploys`, `diff_commit`, `submit_diagnosis`, `propose_fix`.

Rules:

- Every tool has a JSON Schema input with `additionalProperties: false`. Reject unknown fields.
- Validate all inputs: bounded ranges, bounded string lengths, known service names.
- Outputs that carry untrusted text (logs, error messages, diffs, commit messages) are wrapped in a clearly marked untrusted field so the agent treats them as data.
- Size limits on every output (lines, bytes). Truncate and say so.
- Read tools are side-effect free. `submit_diagnosis` and `propose_fix` only hand data to the server.
- No shell, no filesystem access outside fixtures, no network except the configured backends.
- Never echo secrets or environment variables.
