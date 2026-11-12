---
inclusion: always
---

# Product: Haunted Ops

Haunted Ops is a Kiroween 2026 entry (category Costume Contest, deadline 4 Dec 2026 14:00 PT).

It is an incident war room drawn as a 2.5D haunted house:

- each service is a room
- errors are ghosts
- latency is fog
- a down service is a dark room

An "Exorcist" Kiro agent investigates through MCP tools (metrics, errors, logs, deploys, commit diffs), writes an evidence chain and proposes a fix as a pull request. A human approves before anything merges, then the room lights up again.

## Users

- On-call engineers who need to see an incident and its likely cause fast.
- Hackathon judges who watch a short demo and may try the live app.

## The 3-minute demo story

1. 0:00 The house is calm. Four rooms are lit: gate, orders, payments, ledger.
2. 0:30 A bad deploy lands. Payments fills with ghosts and fog, then goes dark.
3. 1:00 The Exorcist starts a hunt. Tool calls appear as steps (metrics, errors, diff).
4. 1:45 The evidence chain and the culprit commit are shown with a confidence value.
5. 2:15 The Exorcist proposes a fix as a pull request. A human reviews and approves.
6. 2:45 The fix merges, errors stop, the room lights up again.

The same state is available in an accessible table mode.

## Non-goals

- Not a general observability product or a Grafana replacement.
- No auto-merge. A human always approves.
- No production data on the demo server; replays use sanitized fixtures.
- No multi-instance scaling, no Redis, no multi-tenant auth.
- No imitation of any existing game, film or franchise.
