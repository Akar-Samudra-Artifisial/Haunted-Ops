#!/usr/bin/env node
// Bundle check for the scene: run after `pnpm build`.
//   - the entry chunk (and what it imports at start) must not contain PixiJS code;
//   - the scene chunk (behind the dynamic import) and the entry chunk must stay under their budgets (gzip).
// It reads Vite's manifest (apps/web/dist/.vite/manifest.json), so the build needs `build.manifest: true`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const KIB = 1024;
/**
 * Budgets in bytes (gzip), measured on 13 Nov 2026 after the review fixes:
 *   - `sceneFile`: the SceneCanvas chunk itself (the file Vite prints, 98 kB = 95.2 KiB): budget measured + 25 percent;
 *   - `scene`: every file the scene chunk imports statically and the entry does not have (6 files, 156.5 KiB): + 15 percent;
 *   - `entry`: the entry chunk and its static imports (80.2 KiB): + 15 percent.
 * PixiJS also loads a few small renderer chunks on demand (15.8 KiB more, 172.3 KiB in all); they are reported, not budgeted.
 */
export const BUDGETS = Object.freeze({ entry: 92 * KIB, scene: 180 * KIB, sceneFile: 119 * KIB });

/** The scene source that `SceneMount` loads with a dynamic import. */
export const SCENE_ENTRY_SUFFIX = 'src/scene/SceneCanvas.tsx';

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

/** Splits the manifest into the files of the entry chunk and the files only the scene needs. */
export function splitChunks(manifest) {
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) throw new Error('no entry chunk in the manifest');
  const sceneKey = Object.keys(manifest).find((k) => k.endsWith(SCENE_ENTRY_SUFFIX));
  if (!sceneKey) throw new Error(`no dynamic chunk for ${SCENE_ENTRY_SUFFIX}: the scene is not code-split`);
  const entryKeys = closure(manifest, entryKey);
  const sceneKeys = closure(manifest, sceneKey);
  const lazyKeys = closure(manifest, sceneKey, new Set(), true);
  for (const k of entryKeys) {
    sceneKeys.delete(k);
    lazyKeys.delete(k);
  }
  for (const k of sceneKeys) lazyKeys.delete(k);
  const files = (keys) => [...keys].map((k) => manifest[k].file);
  return { entry: files(entryKeys), scene: files(sceneKeys), lazy: files(lazyKeys), sceneFile: manifest[sceneKey].file, sceneKey };
}

/** Sizes, and whether PixiJS code reached the entry chunk. `read(file)` returns a Buffer. */
export function analyze(manifest, read) {
  const { entry, scene, lazy, sceneFile } = splitChunks(manifest);
  const sum = (files) => files.reduce((n, f) => n + gzipSize(read(f)), 0);
  const pixiInEntry = entry.filter((f) => /pixi/i.test(read(f).toString('utf8')));
  return { entry, scene, lazy, sceneFile, entryGzip: sum(entry), sceneGzip: sum(scene), sceneFileGzip: gzipSize(read(sceneFile)), lazyGzip: sum(lazy), pixiInEntry };
}

export function problems(result, budgets = BUDGETS) {
  const out = [];
  if (result.pixiInEntry.length > 0) out.push(`PixiJS code is in the entry chunk: ${result.pixiInEntry.join(', ')}`);
  if (result.scene.length === 0) out.push('the scene chunk is empty');
  if (result.entryGzip > budgets.entry) out.push(`entry chunk is ${kib(result.entryGzip)} gzip, budget ${kib(budgets.entry)}`);
  if (result.sceneGzip > budgets.scene) out.push(`scene chunk is ${kib(result.sceneGzip)} gzip, budget ${kib(budgets.scene)}`);
  if (budgets.sceneFile !== undefined && result.sceneFileGzip > budgets.sceneFile) {
    out.push(`scene file ${result.sceneFile} is ${kib(result.sceneFileGzip)} gzip, budget ${kib(budgets.sceneFile)}`);
  }
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
  process.stdout.write(`loaded on demand by PixiJS: ${kib(result.lazyGzip)} gzip (${result.lazy.length} files), not budgeted; scene in all ${kib(result.sceneGzip + result.lazyGzip)}\n`);
  const found = problems(result);
  for (const p of found) process.stderr.write(`FAIL: ${p}\n`);
  if (found.length === 0) process.stdout.write('scene bundle check: PASS\n');
  return found.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
