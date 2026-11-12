---
inclusion: fileMatch
fileMatchPattern: "apps/web/src/scene/**"
---

# Scene rendering

- PixiJS v8. Procedural shapes and our own palette only.
- Budget: 60 fps. Frame time target under 16.7 ms.
- Sprite caps: set a hard maximum for ghosts, fog puffs and particles per room. Drop the oldest first.
- Use `ParticleContainer` for ghosts, fog and sparks. Avoid per-frame allocations.
- Auto low-power mode: when frame time stays above 20 ms for 2 s, reduce particles, disable fog blur, lower resolution. Recover only after a sustained good period.
- Respect `prefers-reduced-motion`: no camera shake, slow or static fog, no flashing.
- Keep the table mode in parity: any state shown in the scene must also be shown in the table.
