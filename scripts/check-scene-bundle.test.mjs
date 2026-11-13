import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGETS, analyze, closure, gzipSize, problems, splitChunks } from './check-scene-bundle.mjs';

const manifest = {
  'index.html': { file: 'assets/index-a.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/scene/SceneCanvas.tsx'] },
  '_shared.js': { file: 'assets/shared-b.js' },
  'src/scene/SceneCanvas.tsx': { file: 'assets/SceneCanvas-c.js', isDynamicEntry: true, imports: ['_shared.js', '_pixi.js'] },
  '_pixi.js': { file: 'assets/pixi-d.js', dynamicImports: ['_renderer.js'] },
  '_renderer.js': { file: 'assets/renderer-e.js' },
};
const files = {
  'assets/index-a.js': 'console.log("app and react");'.repeat(50),
  'assets/shared-b.js': 'export const x = 1;'.repeat(20),
  'assets/SceneCanvas-c.js': 'export default function SceneCanvas(){}'.repeat(40),
  'assets/pixi-d.js': 'PixiJS renderer code '.repeat(200),
  'assets/renderer-e.js': 'lazy renderer part '.repeat(30),
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
  const tight = problems(r, { entry: 10, scene: 10, sceneFile: 10 });
  assert.equal(tight.length, 3);
  assert.match(tight[0], /entry chunk is/);
  assert.match(tight[1], /scene chunk is/);
  assert.match(tight[2], /scene file assets\/SceneCanvas-c\.js is/);
  assert.equal(r.sceneFileGzip, gzipSize(read('assets/SceneCanvas-c.js')));
  assert.equal(r.lazyGzip, gzipSize(read('assets/renderer-e.js')));
  assert.ok(BUDGETS.entry > 0 && BUDGETS.scene > BUDGETS.entry && BUDGETS.sceneFile < BUDGETS.scene);
});

test('fails when the scene is not code-split or there is no entry', () => {
  const merged = { 'index.html': { file: 'assets/index-a.js', isEntry: true } };
  assert.throws(() => splitChunks(merged), /not code-split/);
  assert.throws(() => splitChunks({ x: { file: 'a.js' } }), /no entry chunk/);
});
