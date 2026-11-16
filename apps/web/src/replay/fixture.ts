import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReplayFile, type ReplayFile } from '@haunted-ops/shared';
/** The synthetic replay of the API tests: one made-up incident, reviewed by "TEST". Tests only. */
export function syntheticReplay(): ReplayFile {
  const text = readFileSync(join(process.cwd(), '../api/test/fixtures/replays/synthetic-error-spike.json'), 'utf8');
  const checked = validateReplayFile(JSON.parse(text));
  if (!checked.ok) throw new Error('the synthetic replay is not valid');
  return checked.value;
}
