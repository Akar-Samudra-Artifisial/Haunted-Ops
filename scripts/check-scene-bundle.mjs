#!/usr/bin/env node
// Bundle check for the scene and the replay player: run after `pnpm build`.
//   - the entry chunk (and what it imports at start) must not contain PixiJS code;
//   - the scene chunk (behind the dynamic import) and the entry chunk must stay under their budgets (gzip);
//   - the replay chunk (behind its own dynamic import, loaded on /replays only) must stay under its budget, and the entry
//     chunk must not reach it with a static import.
// It reads Vite's manifest (apps/web/dist/.vite/manifest.json), so the build needs `build.manifest: true`.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { gzipSync } from 'node:zlib';

const KIB = 1024;
/**
 * Budgets in bytes (gzip), measured on 13 Nov 2026 after the review fixes:
 *   - `sceneFile`: the SceneCanvas chunk itself (the file Vite prints, 98 kB = 95.2 KiB): budget measured + 25 percent;
 *   - `scene`: every file the scene chunk imports statically and the entry does not have (6 files, 156.5 KiB): + 15 percent;
 *   - `entry`: the entry chunk and its static imports (80.2 KiB): + 15 percent.
 *   - `replay`: the replay player chunk (ReplayApp, the player, the controls and the file validator; 5665 bytes = 5.53 KiB on
 *     16 Nov 2026, after the validator got the host, address and markup rules and the SHA-256 of the review; it was 4117 bytes
 *     on 15 Nov), loaded on `/replays` only: measured + 20 percent (6800 bytes). The entry chunk grew from 92122 to 92603 bytes
 *     (0.47 KiB) for the route check and the lazy import; that growth is capped at 0.5 KiB by the replay spec.
 *   - `entry` raised from 92 to 94 KiB by `visual-refresh` (17 Nov 2026 build): the new page (header, Summary bar, Panel, Timeline, Legend,
 *     Icon module, table cards) measured 92.3 KiB gzip, 0.3 KiB over 92; the budget is the measured number plus a margin, never above 94 KiB.
 *     The replay chunk measured 6.5 KiB gzip on the same build, inside 6800 bytes.
 * PixiJS also loads a few small renderer chunks on demand (15.8 KiB more, 172.3 KiB in all); they are reported, not budgeted.
 */
export const BUDGETS = Object.freeze({ entry: 94 * KIB, scene: 180 * KIB, sceneFile: 119 * KIB, replay: 6800 });

/**
 * Budgets of the illustrated sprites (`visual-refresh` part 4), in bytes of the files in `dist/scene/*.webp` (they are already
 * compressed, so they are measured as they are): each file at most 80 KiB, all together at most 400 KiB (285.5 KB on 17 Nov 2026).
 */
export const ASSET_BUDGETS = Object.freeze({ file: 80 * KIB, total: 400 * KIB });
/** The only source that names the files of the sprites: the check reads its manifest. */
export const SPRITES_SOURCE = 'apps/web/src/scene/sprites.ts';
/** The file names (`room-payments.webp`) the manifest of a `sprites.ts` text lists, in order, without repeats. */
export function manifestFiles(source) {
  const names = [...source.matchAll(/['"]\/scene\/([A-Za-z0-9._-]+\.webp)['"]/g)].map((m) => m[1]);
  return [...new Set(names)];
}
/** Sizes of the `*.webp` files of `<dist>/scene`: `[{ name, size }]`, sorted by name. */
export function assetFiles(dist) {
  const dir = join(dist, 'scene');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.webp'))
    .sort()
    .map((name) => ({ name, size: statSync(join(dir, name)).size }));
}
/** What is wrong with the sprite files: a listed file missing, a file over its budget, the total over its budget. */
export function assetProblems(files, listed, budgets = ASSET_BUDGETS) {
  const out = [];
  const have = new Set(files.map((f) => f.name));
  for (const name of listed) if (!have.has(name)) out.push(`scene/${name} is listed in the sprite manifest but missing from dist/scene/`);
  for (const f of files) if (f.size > budgets.file) out.push(`scene/${f.name} is ${kib(f.size)}, budget ${kib(budgets.file)} per file`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > budgets.total) out.push(`dist/scene/*.webp is ${kib(total)} in all, budget ${kib(budgets.total)}`);
  return out;
}
/** The scene source that `SceneMount` loads with a dynamic import. */
export const SCENE_ENTRY_SUFFIX = 'src/scene/SceneCanvas.tsx';
/** The replay source that `Root` loads with a dynamic import, on `/replays` routes only. */
export const REPLAY_ENTRY_SUFFIX = 'src/replay/ReplayApp.tsx';

export function gzipSize(buffer) {
  return gzipSync(buffer).length;
}

/** All files reachable through static imports (and dynamic ones too when `dynamic`) from a manifest key, the key's own file first. */
export function closure(manifest, key, seen = new Set(), dynamic = false) {
  const item = manifest[key];
  if (!item || seen.has(key)) return seen;
  seen.add(key);
  for (const next of item.imports ?? []) closure(manifest, next, seen, dynamic);
  if (dynamic) for (const next of item.dynamicImports ?? []) closure(manifest, next, seen, dynamic);
  return seen;
}

/** Splits the manifest into the files of the entry chunk, the files only the scene needs and the files only the replay player needs. */
export function splitChunks(manifest) {
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) throw new Error('no entry chunk in the manifest');
  const sceneKey = Object.keys(manifest).find((k) => k.endsWith(SCENE_ENTRY_SUFFIX));
  if (!sceneKey) throw new Error(`no dynamic chunk for ${SCENE_ENTRY_SUFFIX}: the scene is not code-split`);
  const replayKey = Object.keys(manifest).find((k) => k.endsWith(REPLAY_ENTRY_SUFFIX));
  if (!replayKey) throw new Error(`no dynamic chunk for ${REPLAY_ENTRY_SUFFIX}: the replay player is not code-split`);
  const entryKeys = closure(manifest, entryKey);
  const sceneKeys = closure(manifest, sceneKey);
  const lazyKeys = closure(manifest, sceneKey, new Set(), true);
  const replayKeys = closure(manifest, replayKey);
  // The replay chunk is reached by the entry only when the static closure of the entry holds it.
  const replayInEntry = entryKeys.has(replayKey);
  for (const k of entryKeys) {
    sceneKeys.delete(k);
    lazyKeys.delete(k);
    replayKeys.delete(k);
  }
  for (const k of sceneKeys) lazyKeys.delete(k);
  for (const k of replayKeys) lazyKeys.delete(k);
  const files = (keys) => [...keys].map((k) => manifest[k].file);
  return { entry: files(entryKeys), scene: files(sceneKeys), lazy: files(lazyKeys), replay: files(replayKeys), sceneFile: manifest[sceneKey].file, replayFile: manifest[replayKey].file, sceneKey, replayKey, replayInEntry };
}
/** Sizes, and whether PixiJS code reached the entry chunk. `read(file)` returns a Buffer. */
export function analyze(manifest, read) {
  const { entry, scene, lazy, replay, sceneFile, replayFile, replayInEntry } = splitChunks(manifest);
  const sum = (files) => files.reduce((n, f) => n + gzipSize(read(f)), 0);
  const pixiInEntry = entry.filter((f) => /pixi/i.test(read(f).toString('utf8')));
  return {
    entry,
    scene,
    lazy,
    replay,
    sceneFile,
    replayFile,
    entryGzip: sum(entry),
    sceneGzip: sum(scene),
    sceneFileGzip: gzipSize(read(sceneFile)),
    replayGzip: sum(replay),
    lazyGzip: sum(lazy),
    pixiInEntry,
    replayInEntry,
  };
}
export function problems(result, budgets = BUDGETS) {
  const out = [];
  if (result.pixiInEntry.length > 0) out.push(`PixiJS code is in the entry chunk: ${result.pixiInEntry.join(', ')}`);
  if (result.scene.length === 0) out.push('the scene chunk is empty');
  if (result.replayInEntry) out.push('the entry chunk reaches the replay chunk with a static import');
  if (result.replay.length === 0) out.push('the replay chunk is empty');
  if (result.replay.some((f) => result.entry.includes(f))) out.push('a file of the replay chunk is also in the entry chunk');
  if (result.entryGzip > budgets.entry) out.push(`entry chunk is ${kib(result.entryGzip)} gzip, budget ${kib(budgets.entry)}`);
  if (result.sceneGzip > budgets.scene) out.push(`scene chunk is ${kib(result.sceneGzip)} gzip, budget ${kib(budgets.scene)}`);
  if (budgets.sceneFile !== undefined && result.sceneFileGzip > budgets.sceneFile) {
    out.push(`scene file ${result.sceneFile} is ${kib(result.sceneFileGzip)} gzip, budget ${kib(budgets.sceneFile)}`);
  }
  if (budgets.replay !== undefined && result.replayGzip > budgets.replay) out.push(`replay chunk is ${kib(result.replayGzip)} gzip, budget ${kib(budgets.replay)}`);
  return out;
}
export const kib = (bytes) => `${(bytes / KIB).toFixed(1)} KiB`;

function main() {
  const dist = process.argv[2] ?? 'apps/web/dist';
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'));
  } catch {
    process.stderr.write(`Cannot read ${join(dist, '.vite/manifest.json')}. Run \`pnpm build\` first (the build needs build.manifest).\n`);
    return 1;
  }
  const result = analyze(manifest, (f) => readFileSync(join(dist, f)));
  process.stdout.write(`entry chunk: ${kib(result.entryGzip)} gzip (${result.entry.length} files), budget ${kib(BUDGETS.entry)}\n`);
  process.stdout.write(`scene file: ${result.sceneFile} ${kib(result.sceneFileGzip)} gzip, budget ${kib(BUDGETS.sceneFile)}\n`);
  process.stdout.write(`scene chunk: ${kib(result.sceneGzip)} gzip (${result.scene.length} files with its static imports), budget ${kib(BUDGETS.scene)}\n`);
  for (const f of result.scene) process.stdout.write(`  scene file: ${f}\n`);
  process.stdout.write(`replay chunk: ${result.replayFile} ${kib(result.replayGzip)} gzip (${result.replay.length} files with its static imports), budget ${kib(BUDGETS.replay)}; loaded on /replays only\n`);
  process.stdout.write(`loaded on demand by PixiJS: ${kib(result.lazyGzip)} gzip (${result.lazy.length} files), not budgeted; scene in all ${kib(result.sceneGzip + result.lazyGzip)}\n`);
  const found = problems(result);
  let listed = [];
  try {
    listed = manifestFiles(readFileSync(fileURLToPath(new URL(`../${SPRITES_SOURCE}`, import.meta.url)), 'utf8'));
  } catch {
    found.push(`cannot read ${SPRITES_SOURCE}`);
  }
  if (listed.length === 0) found.push(`${SPRITES_SOURCE} lists no sprite file`);
  const assets = assetFiles(dist);
  const assetTotal = assets.reduce((n, f) => n + f.size, 0);
  process.stdout.write(`sprite files: ${assets.length} in dist/scene, ${kib(assetTotal)} in all (${assetTotal} bytes), budget ${kib(ASSET_BUDGETS.total)}; largest ${kib(Math.max(0, ...assets.map((f) => f.size)))}, budget ${kib(ASSET_BUDGETS.file)} per file\n`);
  found.push(...assetProblems(assets, listed));
  for (const p of found) process.stderr.write(`FAIL: ${p}\n`);
  if (found.length === 0) process.stdout.write('scene bundle check: PASS\n');
  return found.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
