// True when the module that asks is the script node was started with. Both sides go through realpath, because node
// resolves the module URL to the real path while process.argv[1] keeps a symbolic link (the server runs the scripts
// through /opt/haunted-ops/current). A missing argv[1], or one that names another file, is false.
// Fail closed: when argv[1] has the base name of this module but the real paths differ or cannot be resolved, the check
// cannot tell whether the module is the started file, so it throws (one line, no path, no value) and the process ends with
// code 1 instead of exiting 0 having run nothing.
//   if (isMain(import.meta.url)) main();
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} importMetaUrl `import.meta.url` of the caller @returns {boolean} */
export function isMain(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(importMetaUrl);
  if (basename(argv1) !== basename(self)) return false;
  let same;
  try {
    same = realpathSync(self) === realpathSync(argv1);
  } catch {
    same = false;
  }
  if (!same) {
    const error = new Error(`is-main: cannot confirm that ${basename(self)} is the started file`);
    error.stack = error.message;
    throw error;
  }
  return true;
}
