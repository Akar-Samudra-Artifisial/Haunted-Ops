export const BASE_SHA: string;
export const SERVICES: string[];
export interface Scenario {
  service: string;
  reason: string;
  signal: string;
  sha: string;
  deployId: string;
  ref: string;
  subject: string;
  diff: string;
  errors: Array<{ message: string; frame: string }>;
  logs: string[];
  values: { before: number; after: number };
}
export const SCENARIOS: Record<'error-spike' | 'fog' | 'dark-room', Scenario>;
export const HOSTILE: { message: string; line: string; subject: string; diff: string };
export interface DeployRecord {
  id: string;
  service: string;
  ref: string;
  sha: string;
  time: string;
  actor: string;
}
export function deploysFor(only?: string | null): DeployRecord[];
export function errorsFor(service: string, hostile?: boolean): Array<Record<string, unknown>>;
export function logsFor(service: string, hostile?: boolean): Array<Record<string, unknown>>;
export function diffFor(sha: string, hostile?: boolean): Record<string, unknown> | null;
export function metricSeries(service: string, scenario: string, startSec: number, endSec: number, stepSec: number): Array<[number, string]>;
