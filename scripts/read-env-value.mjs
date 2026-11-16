#!/usr/bin/env node
// Prints the value of ONE variable of a systemd-style environment file, read the way the env guard reads it
// (scripts/demo-env-check.mjs: spaces around `=` and around the value are trimmed, then one pair of quotes; the last line wins).
//   node scripts/read-env-value.mjs <file> <NAME>
// For the pre-flight on the demo server only, where root hands the Kiro API key to `kiro-cli whoami` through the environment.
// It prints nothing and exits 1 when the variable is not there. Nothing else is ever printed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnvText } from './demo-env-check.mjs';
/** @param {string} text @param {string} name @returns {string | undefined} */
export function readEnvValue(text, name) {
  const { vars } = parseEnvText(text);
  return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
}
function main() {
  const [file, name] = process.argv.slice(2);
  if (!file || !name || process.argv.length > 4 || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return 2;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 1;
  }
  const value = readEnvValue(text, name);
  if (value === undefined || value === '') return 1;
  process.stdout.write(value);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
