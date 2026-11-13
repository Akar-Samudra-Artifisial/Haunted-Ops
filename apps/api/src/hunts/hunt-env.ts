import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUID_PATTERN,
  HAUNT_REASON_KINDS,
  HUNT_TOOLS,
  SERVICE_DEPENDENCIES,
  SERVICE_NAMES,
  downstreamOf,
  type HauntReasonKind,
  type ServiceName,
} from '@haunted-ops/shared';
import type { HuntConfig } from './hunt-config.js';

/** `@exorcist/<tool>`: the names `--trust-tools` and the allow-list use. */
export const TRUSTED_TOOL_NAMES: readonly string[] = HUNT_TOOLS.map((t) => `@exorcist/${t}`);

/** `gate calls orders, orders calls payments, payments calls ledger`, from the shared chain. */
export const CHAIN_TEXT = SERVICE_NAMES.flatMap((s) => SERVICE_DEPENDENCIES[s].map((d) => `${s} calls ${d}`)).join(', ');

/** The facts a prompt is built from. Every field is checked; no text of the lab or the model gets in. */
export interface PromptFacts {
  incidentId: string;
  service: ServiceName;
  level: 2 | 3 | 4;
  reasonKind: HauntReasonKind | null;
  openedAt: Date;
}

export class PromptFactsError extends Error {
  constructor(readonly field: keyof PromptFacts) {
    super(`invalid prompt fact: ${field}`);
    this.name = 'PromptFactsError';
  }
}

/** The one prompt of a Hunt, from a fixed template. Throws `PromptFactsError` naming the field, never its value. */
export function huntPrompt(f: PromptFacts): string {
  if (!CUID_PATTERN.test(f.incidentId)) throw new PromptFactsError('incidentId');
  if (!(SERVICE_NAMES as readonly string[]).includes(f.service)) throw new PromptFactsError('service');
  if (f.level !== 2 && f.level !== 3 && f.level !== 4) throw new PromptFactsError('level');
  if (f.reasonKind !== null && !(HAUNT_REASON_KINDS as readonly string[]).includes(f.reasonKind)) throw new PromptFactsError('reasonKind');
  if (!(f.openedAt instanceof Date) || !Number.isFinite(f.openedAt.getTime())) throw new PromptFactsError('openedAt');
  const opened = f.openedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  // The lab is one call chain, so a fault downstream also breaks the services that call it. The sentence is built
  // only from the fixed chain and the checked service name.
  const downstream = downstreamOf(f.service);
  const cause = downstream.length === 0 ? `a recent deploy of ${f.service}` : `a recent deploy of ${f.service} or of ${downstream.join(', ')}`;
  return `Incident ${f.incidentId} on service ${f.service}: haunt level ${f.level}, reason ${f.reasonKind ?? 'unknown'}, opened at ${opened}. The services call each other in a chain: ${CHAIN_TEXT}. The cause may be ${cause}. Investigate it and call submit_diagnosis once.`;
}

/** The whole argument vector of `kiro-cli`. The order is fixed; nothing here comes from a request. */
export function buildHuntArgv(cfg: Pick<HuntConfig, 'model'>, facts: PromptFacts): string[] {
  return [
    'chat',
    '--no-interactive',
    '--trust-workspace',
    '--require-mcp-startup',
    '--agent',
    'exorcist',
    '--model',
    cfg.model,
    '--output-format',
    'stream-json',
    `--trust-tools=${TRUSTED_TOOL_NAMES.join(',')}`,
    huntPrompt(facts),
  ];
}

/** The only variable names a Hunt process may have. */
export const HUNT_ENV_NAMES = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'NO_COLOR',
  'LAB_URL',
  'LAB_READ_TOKEN',
  'LAB_ALLOW_REMOTE',
  'PROMETHEUS_URL',
  'PROMETHEUS_ALLOW_REMOTE',
  'HUNT_ID',
  'HUNT_LEDGER_PATH',
] as const;

export interface HuntEnvInput {
  cfg: Pick<HuntConfig, 'labUrl' | 'labReadToken' | 'labAllowRemote' | 'kiroCliPath'>;
  prometheusUrl: string;
  prometheusAllowRemote: boolean;
  huntId: string;
  ledgerPath: string;
  /** The folder with the `haunted-exorcist-mcp` launcher. */
  mcpBinDir: string;
  /** The environment of the API process: only `HOME` and `LANG` are read from it. */
  parentEnv: Readonly<Record<string, string | undefined>>;
  nodeDir?: string;
}

const SYSTEM_PATH = ['/usr/bin', '/bin'];

/** The environment of a Hunt process: exactly the names in `HUNT_ENV_NAMES`, nothing inherited. */
export function buildHuntEnv(i: HuntEnvInput): Record<string, string> {
  const path = [i.mcpBinDir, i.nodeDir ?? dirname(process.execPath), dirname(i.cfg.kiroCliPath), ...SYSTEM_PATH];
  const home = i.parentEnv.HOME !== undefined && i.parentEnv.HOME !== '' ? i.parentEnv.HOME : homedir();
  const lang = i.parentEnv.LANG !== undefined && /^[A-Za-z0-9_.@-]{1,40}$/.test(i.parentEnv.LANG) ? i.parentEnv.LANG : 'en_US.UTF-8';
  return {
    PATH: [...new Set(path.filter((p) => p !== '' && p !== '.'))].join(':'),
    HOME: home,
    LANG: lang,
    TERM: 'dumb',
    NO_COLOR: '1',
    LAB_URL: i.cfg.labUrl,
    LAB_READ_TOKEN: i.cfg.labReadToken ?? '',
    LAB_ALLOW_REMOTE: i.cfg.labAllowRemote ? 'true' : 'false',
    PROMETHEUS_URL: i.prometheusUrl,
    PROMETHEUS_ALLOW_REMOTE: i.prometheusAllowRemote ? 'true' : 'false',
    HUNT_ID: i.huntId,
    HUNT_LEDGER_PATH: i.ledgerPath,
  };
}

/** `packages/exorcist-mcp/bin`, found from this file (`src/hunts` and `dist/hunts` are the same depth). */
export function defaultMcpBinDir(): string {
  return fileURLToPath(new URL('../../../../packages/exorcist-mcp/bin/', import.meta.url)).replace(/\/$/, '');
}
