# Haunted Ops

Haunted Ops is an incident war room drawn as a 2.5D haunted house. Each service is a room, errors are ghosts, latency is fog, and a down service is a dark room. An "Exorcist" Kiro agent investigates through MCP tools, writes an evidence chain and proposes a fix as a pull request. A human approves before anything merges, then the room lights up again. Built for Kiroween 2026 (Costume Contest).

## Accessible mode

Accessible mode turns the page into a table-first view: the house scene is not loaded (no WebGL, no canvas, no animation), and the table shows every fact the scene shows.

- Turn it on with the "Accessible mode" button in the header (it is the first control after the "Skip to services" link), or open the page with `?mode=accessible` (share that link with a screen-reader user). `?mode=scene` forces the scene for one visit. Your button choice is remembered in this browser; with no choice, a browser set to reduce motion starts in Accessible mode.
- What it guarantees: everything works by keyboard with a visible focus, Escape closes the detail and returns to its row, one polite live region announces each change once (a room goes dark or is back, a hunt starts and its steps, the diagnosis, a fix opened, merged, deployed or failed), no animation or flashing, text contrast of at least 4.5:1 and 3:1 for controls, and every status has a word and a symbol, never colour alone.

Live demo: `https://<demo-domain>/` (link added after deployment; `?demo=1` plays the scripted incident without the API). Deploy runbook: [docs/DEPLOY.md](docs/DEPLOY.md).

Status: work in progress.
