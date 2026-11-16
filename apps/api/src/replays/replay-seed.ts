import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { replayHash, validateReplayFile, type ReplayFile } from '@haunted-ops/shared';
import type { PrismaClient } from '../prisma/client.js';
/** A file the seed refuses: its name and the failing paths, never a value. */
export class ReplaySeedError extends Error {
  constructor(
    readonly file: string,
    readonly paths: readonly string[],
  ) {
    super(`replay file refused: ${file}${paths.length > 0 ? ` (${paths.slice(0, 8).join(' ')})` : ''}`);
    this.name = 'ReplaySeedError';
  }
}
export interface ReplaySeedResult {
  /** Ids written (new or changed). */
  seeded: string[];
  /** Ids whose row already had the hash of the file. */
  kept: string[];
  /** File names with `review: null`: not seeded. */
  skipped: string[];
  /** Ids of rows removed because no reviewed file is left for them. */
  removed: string[];
}
/** `<id>.json` files of `dir`, in name order. A folder that is missing is an error: it never means "no replays". */
function jsonFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new ReplaySeedError(dir.split(/[\\/]/).pop() ?? 'replays', ['folder']);
  }
  const named = entries.filter((e) => e.name.endsWith('.json')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Only regular files count: a folder or a link named `x.json` stops the seed (a link could point out of the folder).
  for (const entry of named) if (!entry.isFile()) throw new ReplaySeedError(entry.name, ['not_regular_file']);
  return named.map((e) => e.name);
}
/**
 * Upserts every REVIEWED replay file of `dir`. Every file is read and validated before the first write, so an invalid
 * file (or a file whose name is not `<id>.json`) stops the seed with nothing changed; so does a reviewed file whose review
 * hash no longer matches its content (the validator checks it). A file with `review: null` is skipped and named in the
 * result. The `sha256` of a row is `replayHash` of its file (the canonical JSON, the same from the file and from the `jsonb`
 * column): a row that has it is kept; a row with no reviewed file is deleted.
 */
export async function seedReplays(prisma: PrismaClient, dir: string): Promise<ReplaySeedResult> {
  const result: ReplaySeedResult = { seeded: [], kept: [], skipped: [], removed: [] };
  const ready: Array<{ file: ReplayFile; sha256: string }> = [];
  for (const name of jsonFiles(dir)) {
    const text = readFileSync(join(dir, name), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ReplaySeedError(name, ['json']);
    }
    const checked = validateReplayFile(parsed);
    if (!checked.ok) throw new ReplaySeedError(name, checked.errors);
    if (name !== `${checked.value.id}.json`) throw new ReplaySeedError(name, ['$.id']);
    if (checked.value.review === null) {
      result.skipped.push(name);
      continue;
    }
    ready.push({ file: checked.value, sha256: replayHash(checked.value) });
  }
  for (const { file, sha256 } of ready) {
    const existing = await prisma.replay.findUnique({ where: { id: file.id }, select: { sha256: true, body: true } });
    // Kept only when the row says it is this file AND its body really is (a body changed by hand under the same hash is rewritten).
    if (existing?.sha256 === sha256 && replayHash(existing.body) === sha256) {
      result.kept.push(file.id);
      continue;
    }
    const data = {
      title: file.title,
      scenario: file.scenario,
      recordedOn: new Date(`${file.recordedOn}T00:00:00.000Z`),
      durationMs: file.durationMs,
      body: file as unknown as object,
      sha256,
    };
    await prisma.replay.upsert({ where: { id: file.id }, create: { id: file.id, ...data }, update: data });
    result.seeded.push(file.id);
  }
  const keep = ready.map((r) => r.file.id);
  const gone = await prisma.replay.findMany({ where: { id: { notIn: keep } }, select: { id: true } });
  if (gone.length > 0) {
    await prisma.replay.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
    result.removed.push(...gone.map((g) => g.id));
  }
  return result;
}
