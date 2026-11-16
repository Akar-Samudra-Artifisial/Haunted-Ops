// True when the module that asks is the script node was started with. Both sides go through realpath, because node
// resolves the module URL to the real path while process.argv[1] keeps a symbolic link (the server runs the scripts
// through /opt/haunted-ops/current). A missing or unresolvable argv[1] is false.
//   if (isMain(import.meta.url)) main();
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** @param {string} importMetaUrl `import.meta.url` of the caller @returns {boolean} */
export function isMain(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
