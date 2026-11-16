import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSET_BUDGETS, BUDGETS, analyze, assetProblems, manifestFiles, closure, gzipSize, problems, splitChunks } from './check-scene-bundle.mjs';

const manifest = {
  'index.html': { file: 'assets/index-a.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/scene/SceneCanvas.tsx', 'src/replay/ReplayApp.tsx'] },
  '_shared.js': { file: 'assets/shared-b.js' },
  'src/scene/SceneCanvas.tsx': { file: 'assets/SceneCanvas-c.js', isDynamicEntry: true, imports: ['_shared.js', '_pixi.js'] },
  'src/replay/ReplayApp.tsx': { file: 'assets/ReplayApp-f.js', isDynamicEntry: true, imports: ['index.html'] },
  '_pixi.js': { file: 'assets/pixi-d.js', dynamicImports: ['_renderer.js'] },
  '_renderer.js': { file: 'assets/renderer-e.js' },
};
const files = {
  'assets/index-a.js': 'console.log("app and react");'.repeat(50),
  'assets/shared-b.js': 'export const x = 1;'.repeat(20),
  'assets/SceneCanvas-c.js': 'export default function SceneCanvas(){}'.repeat(40),
  'assets/pixi-d.js': 'PixiJS renderer code '.repeat(200),
  'assets/renderer-e.js': 'lazy renderer part '.repeat(30),
  'assets/ReplayApp-f.js': 'export default function ReplayApp(){}'.repeat(30),
};
const read = (f) => Buffer.from(files[f]);

test('closure follows static imports and ignores dynamic ones', () => {
  assert.deepEqual([...closure(manifest, 'index.html')], ['index.html', '_shared.js']);
  assert.deepEqual([...closure(manifest, 'src/scene/SceneCanvas.tsx')], ['src/scene/SceneCanvas.tsx', '_shared.js', '_pixi.js']);
  assert.deepEqual([...closure(manifest, 'missing')], []);
  assert.deepEqual([...closure(manifest, 'src/scene/SceneCanvas.tsx', new Set(), true)], ['src/scene/SceneCanvas.tsx', '_shared.js', '_pixi.js', '_renderer.js']);
});

test('splits the entry files from the files only the scene needs, and the parts loaded on demand', () => {
  const split = splitChunks(manifest);
  assert.deepEqual(split.entry, ['assets/index-a.js', 'assets/shared-b.js']);
  assert.deepEqual(split.scene, ['assets/SceneCanvas-c.js', 'assets/pixi-d.js']);
  assert.deepEqual(split.lazy, ['assets/renderer-e.js']);
  assert.equal(split.sceneFile, 'assets/SceneCanvas-c.js');
});

test('measures gzip sizes and finds no PixiJS in a clean entry', () => {
  const r = analyze(manifest, read);
  assert.equal(r.entryGzip, gzipSize(read('assets/index-a.js')) + gzipSize(read('assets/shared-b.js')));
  assert.ok(r.sceneGzip > 0);
  assert.deepEqual(r.pixiInEntry, []);
  assert.deepEqual(problems(r), []);
});

test('fails when PixiJS code reaches the entry chunk', () => {
  const dirty = { ...files, 'assets/shared-b.js': 'import "pixi.js"; // PixiJS' };
  const r = analyze(manifest, (f) => Buffer.from(dirty[f]));
  assert.deepEqual(r.pixiInEntry, ['assets/shared-b.js']);
  assert.match(problems(r)[0], /PixiJS code is in the entry chunk/);
});

test('fails over budget', () => {
  const r = analyze(manifest, read);
  const tight = problems(r, { entry: 10, scene: 10, sceneFile: 10, replay: 10 });
  assert.equal(tight.length, 4);
  assert.match(tight[0], /entry chunk is/);
  assert.match(tight[1], /scene chunk is/);
  assert.match(tight[2], /scene file assets\/SceneCanvas-c\.js is/);
  assert.match(tight[3], /replay chunk is/);
  assert.equal(r.sceneFileGzip, gzipSize(read('assets/SceneCanvas-c.js')));
  assert.equal(r.lazyGzip, gzipSize(read('assets/renderer-e.js')));
  assert.ok(BUDGETS.entry > 0 && BUDGETS.scene > BUDGETS.entry && BUDGETS.sceneFile < BUDGETS.scene);
  assert.ok(BUDGETS.replay > 0 && BUDGETS.replay <= 16 * 1024);
});

test('fails when the scene is not code-split or there is no entry', () => {
  const merged = { 'index.html': { file: 'assets/index-a.js', isEntry: true } };
  assert.throws(() => splitChunks(merged), /scene is not code-split/);
  const noReplay = { ...merged, 'src/scene/SceneCanvas.tsx': { file: 'assets/s.js' } };
  assert.throws(() => splitChunks(noReplay), /replay player is not code-split/);
  assert.throws(() => splitChunks({ x: { file: 'a.js' } }), /no entry chunk/);
});
test('splits the replay files: only the replay chunk needs them, and the scene "on demand" list does not hold them', () => {
  const split = splitChunks(manifest);
  assert.deepEqual(split.replay, ['assets/ReplayApp-f.js']);
  assert.equal(split.replayFile, 'assets/ReplayApp-f.js');
  assert.equal(split.replayInEntry, false);
  assert.ok(!split.lazy.includes('assets/ReplayApp-f.js'));
  const r = analyze(manifest, read);
  assert.equal(r.replayGzip, gzipSize(read('assets/ReplayApp-f.js')));
});
test('fails when the entry chunk reaches the replay chunk with a static import, or the replay is over its budget', () => {
  const eager = { ...manifest, 'index.html': { ...manifest['index.html'], imports: ['_shared.js', 'src/replay/ReplayApp.tsx'] } };
  assert.equal(splitChunks(eager).replayInEntry, true);
  const found = problems(analyze(eager, read));
  assert.ok(found.some((p) => /entry chunk reaches the replay chunk with a static import/.test(p)), found.join('; '));
  const r = analyze(manifest, read);
  assert.deepEqual(problems(r, { ...BUDGETS, replay: r.replayGzip }), []);
  assert.match(problems(r, { ...BUDGETS, replay: r.replayGzip - 1 })[0], /replay chunk is .* gzip, budget/);
});

test('reads the sprite files of the manifest in sprites.ts', () => {
  const source = "export const M = { a: '/scene/room-a.webp', b: \"/scene/ghost-b.webp\", c: '/scene/room-a.webp' } as const; // /scene/<file>";
  assert.deepEqual(manifestFiles(source), ['room-a.webp', 'ghost-b.webp']);
});

test('checks the sprite files: missing, over 80 KiB, over 400 KiB in all', () => {
  const KIB = 1024;
  const files = [
    { name: 'room-a.webp', size: 50 * KIB },
    { name: 'ghost-b.webp', size: 8 * KIB },
  ];
  assert.deepEqual(assetProblems(files, ['room-a.webp', 'ghost-b.webp']), []);
  assert.match(assetProblems(files, ['room-a.webp', 'fog.webp'])[0], /fog\.webp is listed in the sprite manifest but missing/);
  assert.match(assetProblems([{ name: 'big.webp', size: 80 * KIB + 1 }], [])[0], /big\.webp is .* budget 80\.0 KiB per file/);
  const many = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.webp`, size: 70 * KIB }));
  assert.match(assetProblems(many, [])[0], /in all, budget 400\.0 KiB/);
  assert.equal(ASSET_BUDGETS.file, 80 * KIB);
  assert.equal(ASSET_BUDGETS.total, 400 * KIB);
});
