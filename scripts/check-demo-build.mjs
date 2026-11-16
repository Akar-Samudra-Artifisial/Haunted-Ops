#!/usr/bin/env node
// Checks that a web build carries the demo settings:  node scripts/check-demo-build.mjs <web-dist> <domain>
// Vite inlines the VITE_* variables into the object that replaces `import.meta.env`, so a build made with
// VITE_DEMO_MODE=true and VITE_API_BASE_URL=https://<domain> holds both as properties of an object literal in one of its scripts.
// The check reads every script of the build (not one file name) and accepts any quote style and spacing of the minifier.
// It does not match a code line that only reads the variable (`env.VITE_DEMO_MODE !== 'true'`). Exit 0 when both are found.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';
const QUOTE = '["\'`]';
const escapeRegExp = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A property `NAME: "value"` of an object literal, after `{` or `,`. */
const property = (/** @type {string} */ name, /** @type {string} */ value) => new RegExp(`[{,]\\s*${QUOTE}?${name}${QUOTE}?\\s*:\\s*${QUOTE}${value}${QUOTE}`);
/** @param {string} dir @returns {string[]} */
function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return scripts(full);
      return /\.(?:m?js|cjs)$/.test(entry.name) ? [full] : [];
    });
}
/**
 * @param {string} distDir
 * @param {string} domain
 * @returns {string[]} the names of the settings that are missing (empty when the build is right)
 */
export function checkDemoBuild(distDir, domain) {
  const files = scripts(distDir);
  if (files.length === 0) return ['scripts'];
  const demo = property('VITE_DEMO_MODE', 'true');
  const base = property('VITE_API_BASE_URL', escapeRegExp(`https://${domain}`));
  let hasDemo = false;
  let hasBase = false;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    hasDemo = hasDemo || demo.test(text);
    hasBase = hasBase || base.test(text);
  }
  return [...(hasDemo ? [] : ['VITE_DEMO_MODE']), ...(hasBase ? [] : ['VITE_API_BASE_URL'])];
}
function main() {
  const [dist, domain] = process.argv.slice(2);
  if (!dist || !domain || process.argv.length > 4) {
    process.stderr.write('usage: check-demo-build.mjs <web-dist> <domain>\n');
    process.exit(2);
  }
  let missing;
  try {
    missing = checkDemoBuild(dist, domain);
  } catch {
    process.stderr.write('check-demo-build: cannot read the build folder\n');
    process.exit(2);
  }
  if (missing.length > 0) {
    process.stderr.write(`check-demo-build: the build lacks: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('check-demo-build: ok\n');
}
if (isMain(import.meta.url)) main();
