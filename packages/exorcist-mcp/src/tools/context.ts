import type { HandleRegistry } from '../handles.js';
import type { LabApi } from '../lab-client.js';
import type { Ledger } from '../ledger.js';
import type { PromApi } from '../prom-client.js';
import type { Envelope } from '../untrusted.js';

/** What a tool needs. Everything is injected, so tests run against fakes and a fixed clock. */
export interface ToolContext {
  lab: LabApi;
  prom: PromApi;
  handles: HandleRegistry;
  ledger: Ledger;
  now: () => number;
  /** Values never to show the agent (the lab token). */
  secrets: readonly string[];
}

export type ToolRun<I> = (input: I, ctx: ToolContext) => Promise<Envelope>;

const short = (sha: string): string => sha.slice(0, 7);
export { short };

/** `HH:MM:SS` of an ISO time, for short details. */
export function clock(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? (m[1] as string) : iso.slice(0, 19);
}

export const FULL_SHA = /^[0-9a-f]{40}$/;
export const DEPLOY_ID = /^d-[0-9]{1,9}$/;
