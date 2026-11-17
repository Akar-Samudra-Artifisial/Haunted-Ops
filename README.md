# Haunted Ops

Haunted Ops is an incident war room drawn as a 2.5D haunted house. Each service is a room, errors are ghosts, latency is fog, and a down service is a dark room. An "Exorcist" Kiro agent investigates through MCP tools, writes an evidence chain and proposes a fix as a pull request. A human approves before anything merges, then the room lights up again. Built for Kiroween 2026 (Costume Contest).

## The legend

The panel next to the house has a "What am I looking at?" key: a ghost is errors, fog is latency, a dark room is down, a lantern is a healthy room and green mist is the Exorcist investigating. It is open on your first visit and remembers your choice.

## Art

Scene art is procedural shapes plus the team's illustrated sprites in `apps/web/public/scene/` (generated with Seedream 5.5 via Runware and curated by the team; original, imitating no existing game, film or franchise); the procedural art stays as the fallback. The ten WebP files (four rooms, three ghosts, the Exorcist in two poses and one fog wisp) live in `apps/web/public/scene/`; if one cannot load, the house is drawn with shapes as before. The eleventh file, `moon.webp`, is the moon of the sky (a plain disc without it).

The eight sound cues in `apps/web/public/sfx/` (ghost appears, possessed, room dark, calm restored, hunt start, hunt step, diagnosed, fix merged) were made with Mirelo SFX 1.5 via Runware and curated by the team. They are original; none imitates an existing game, film or franchise.

The header has a "Sound off" / "Sound on" button, off by default: nothing audio is loaded until you turn it on, and the browser plays sound only after a click on the page.

## Accessible mode

Accessible mode turns the page into a table-first view: the house scene is not loaded (no WebGL, no canvas, no animation), and the table shows every fact the scene shows.

- Turn it on with the "Accessible mode" button in the header (it is the first control after the "Skip to services" link), or open the page with `?mode=accessible` (share that link with a screen-reader user). `?mode=scene` forces the scene for one visit. Your button choice is remembered in this browser; with no choice, a browser set to reduce motion starts in Accessible mode.
- What it guarantees: everything works by keyboard with a visible focus, Escape closes the detail and returns to its row, one polite live region announces each change once (a room goes dark or is back, a hunt starts and its steps, the diagnosis, a fix opened, merged, deployed or failed), no animation or flashing, text contrast of at least 4.5:1 and 3:1 for controls, and every status has a word and a symbol, never colour alone.

Live demo: <https://3-209-32-188.sslip.io/> (read-only; a scheduled incident and hunt run a few times a day). Scripted incident without the API: <https://3-209-32-188.sslip.io/?demo=1>. Table-first view: <https://3-209-32-188.sslip.io/?mode=accessible>. Deploy runbook: [docs/DEPLOY.md](docs/DEPLOY.md).

Replays of past incidents (sanitized, reviewed by a person): <https://3-209-32-188.sslip.io/replays>.

Status: work in progress.
