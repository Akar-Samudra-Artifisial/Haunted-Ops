---
inclusion: fileMatch
fileMatchPattern: "apps/web/src/scene/**"
---

# Scene rendering

- PixiJS v8. Our own palette. Scene art is procedural shapes plus the team's illustrated sprites in `apps/web/public/scene/` (generated with Seedream 5.5 via Runware and curated by the team; original, imitating no existing game, film or franchise); the procedural art stays as the fallback.
- Budget: 60 fps. Frame time target under 16.7 ms.
- Sprite caps: set a hard maximum for ghosts, fog puffs and particles per room. Drop the oldest first.
- Use `ParticleContainer` for ghosts, fog and sparks. Avoid per-frame allocations.
- Auto low-power mode: when frame time stays above 20 ms for 2 s, reduce particles, disable fog blur, lower resolution. Recover only after a sustained good period.
- Respect `prefers-reduced-motion`: no camera shake, slow or static fog, no flashing.
- Keep the table mode in parity: any state shown in the scene must also be shown in the table.

## Lantern in a dark house (`visual-refresh` part 2)

The house sits in the dark. A calm room is dim and quiet; trouble is what lights up. A viewer tells which room is in trouble, and how bad, in two seconds. Scene art is procedural shapes plus the team's illustrated sprites in `apps/web/public/scene/` (generated with Seedream 5.5 via Runware and curated by the team; original, imitating no existing game, film or franchise); the procedural art stays as the fallback. The procedural art (shapes, gradients and textures drawn by code, built once at init, never per frame) is what draws when the files cannot load.

### Level to look (`LEVEL_LOOK` in `model.ts`, the one table; `isDark` stays the rule for a dark room)

| Level | Look |
| --- | --- |
| 0 calm | dim lantern only: low warm glow (0.25), no tint, no ghost, quiet trim outline |
| 1 uneasy | faint cold edge light (outline in `lightCold`), glow 0.4 |
| 2 haunted | clear danger tint on floor and walls (0.35), glow 0.7, ghosts visible |
| 3 possessed | strong danger glow (1.0), tint 0.6, dense ghosts (at least 6 when the trouble is errors), outline in the danger colour |
| 4 dark | no light, near-black room, thin cold outline (the edge), no tint |

- The glow is non-decreasing from calm to possessed and zero when dark; it does not depend on errors or latency (those drive ghosts and fog only). Property 5 of `visual-refresh` tests it.
- Fog (latency) is its own layer, cold cyan, independent of the level: puffs from the pools, plus three soft noise textures (`noiseA/B/C`) that drift at different speeds inside the floor.
- A level rise starts one glow pulse (one cycle, 2 s, at most one per second per room). Never started for a fall, a dark room, Low quality or Reduced motion.
- A Hunt entering or working puts the green mist (`ecto`) over that room. It maps to the Hunt column, so the table needs no new column.

### Layers, back to front

sky (horizon bands, far stars, near stars, moon; parallax of a few pixels with the focused room) → house (without roof) → roof (solid, fades while a room is focused) → corridors → rooms (floor gradient, inner wall panels, icon of the service on the back wall: payments coin, orders box, ledger book, gate arch; danger tint; three fog noise layers; lamp glow; dark overlay; mist; outlines) → fog bank and wisps → dust motes → corridor pulses → selection ring → texts → ghosts (silhouette texture with two eye holes, sine sway, eased fade, spread so no two share a spot).

### Quality and motion

- Low quality: no parallax, one fog layer, no dust, no pulse; every level look stays.
- Reduced motion: no sway, drift, parallax, dust or pulse; static ghosts and fog; every level look stays (Property 6: every animated offset is zero for any time).
- Palette colours for the scene live only in `palette.ts`; `danger`, `ecto` and `fog` equal the CSS tokens.
- One chip per room (level mark, name, and a danger `!` while an incident is open) under the room: its top is in the bottom 20 % of the room's screen rect, the rest hangs below the front corner, text 14 px or more under 640 px; no reason badge or incident word in the Scene (the table has them). Property 7 of `visual-refresh`.
- Ghosts rest on seeded lattice sites inside 0.25 to 0.8 of the floor, at least 0.6 of the wider ghost's width apart, size 0.5 to 0.8, alpha at most 0.7, with a dark outline; the hunt mist is dense (alpha 0.6 or more, breath of 4 s, swing 0.12). Property 8.
- `scene/hooks.ts` is imported by the replay chunk: add no import to it.
- With a room sprite, the danger tint is drawn on `spriteFloor(fit)` (inside the sprite outline, Property 12 of `visual-refresh`), never on the layout floor, and the lamp glow is scaled by `ROOM_SPRITE_SCALE`; the procedural fallback keeps its shapes.
- Under `NARROW_BELOW` the Hunt marks are dots of radius 4 px or more with a 2 px gap when eight fit in the slot, else the pill "Hunt · n steps" at 14 px or more (`huntMarkStyle` in `shapes.ts`); never "n of 8", and the slot geometry does not change.
