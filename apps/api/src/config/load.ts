import { ConfigError, parseConfig, type Config } from './config.js';

/**
 * Validates configuration before the app is created. On failure it prints the
 * variable names (never values) and exits with code 1, so nothing listens.
 */
export function loadConfigOrExit(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  try {
    return parseConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
