// Runs `pnpm build` twice from a clean state and compares a hash of every dist file.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const distDirs = ['packages/shared/dist', 'packages/exorcist-mcp/dist', 'apps/api/dist', 'apps/web/dist'].map((p) => join(root, p));

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.sort().flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function hashOutputs() {
  const h = createHash('sha256');
  for (const dir of distDirs) {
    for (const file of walk(dir)) {
      h.update(relative(root, file));
      h.update(readFileSync(file));
    }
  }
  return h.digest('hex');
}

function cleanBuild() {
  for (const dir of distDirs) rmSync(dir, { recursive: true, force: true });
  execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  return hashOutputs();
}

const first = cleanBuild();
const second = cleanBuild();
if (first !== second) {
  console.error(`Build is not deterministic: ${first} != ${second}`);
  process.exit(1);
}
console.log(`Build is deterministic: ${first}`);
