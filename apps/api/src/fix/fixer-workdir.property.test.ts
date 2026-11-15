import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeReadOnly, makeWritable } from './fixer-workdir.js';

type Node = { kind: 'file' } | { kind: 'dir'; children: Record<string, Node> } | { kind: 'link'; target: number };

const name = fc.stringMatching(/^[a-z]{1,6}$/);
const tree = fc.letrec<{ children: Record<string, Node>; node: Node }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    fc.constant<Node>({ kind: 'file' }),
    fc.nat(5).map<Node>((target) => ({ kind: 'link', target })),
    tie('children').map<Node>((children) => ({ kind: 'dir', children })),
  ),
  children: fc.dictionary(name, tie('node'), { maxKeys: 4 }),
})).children;

/** Modes of six targets outside the tree: three files, then three folders. */
const modes = fc.array(fc.constantFrom(0o600, 0o640, 0o644, 0o444, 0o700, 0o755), { minLength: 6, maxLength: 6 });

describe('makeReadOnly and makeWritable never follow links (property)', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'fixer-links-'));
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // Feature: fix-proposal-flow, Property 19
  it('leaves the mode of every link target alone, and never throws for a link', async () => {
    let n = 0;
    await fc.assert(
      fc.asyncProperty(tree, modes, async (children, targetModes) => {
        const run = join(base, `r${(n += 1)}`);
        const outside = join(run, 'outside');
        const inside = join(run, 'inside');
        mkdirSync(outside, { recursive: true });
        mkdirSync(inside);
        const targets = targetModes.map((mode, i) => {
          const p = join(outside, `t${i}`);
          if (i < 3) writeFileSync(p, 'x');
          else {
            mkdirSync(p);
            writeFileSync(join(p, 'f'), 'x');
          }
          chmodSync(p, mode);
          return p;
        });
        const build = (dir: string, nodes: Record<string, Node>): void => {
          for (const [k, node] of Object.entries(nodes)) {
            const p = join(dir, k);
            if (node.kind === 'file') writeFileSync(p, 'x');
            else if (node.kind === 'link') symlinkSync(targets[node.target % targets.length] as string, p);
            else {
              mkdirSync(p);
              build(p, node.children);
            }
          }
        };
        build(inside, children);
        const before = targets.map((t) => statSync(t).mode & 0o777);
        await makeReadOnly(inside);
        expect(targets.map((t) => statSync(t).mode & 0o777)).toEqual(before);
        await makeWritable(inside);
        expect(targets.map((t) => statSync(t).mode & 0o777)).toEqual(before);
        // Writable again, so the folder can be removed; the outside targets may be read-only folders.
        for (const t of targets) chmodSync(t, 0o755);
      }),
      { numRuns: 100 },
    );
  });

  it('refuses a folder that is itself a link', async () => {
    const real = join(base, 'real');
    mkdirSync(real);
    chmodSync(real, 0o700);
    const link = join(base, 'link');
    symlinkSync(real, link);
    await expect(makeReadOnly(link)).rejects.toThrow();
    await expect(makeWritable(link)).rejects.toThrow();
    expect(statSync(real).mode & 0o777).toBe(0o700);
  });
});
