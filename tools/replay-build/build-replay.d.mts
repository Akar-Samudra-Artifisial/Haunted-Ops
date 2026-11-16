import type { ReplayFile } from '@haunted-ops/shared';
export const SCENARIOS: string[];
export const LAB_REPO_URL: string;
export const MAX_FRAMES: number;
export const MAX_DURATION_MS: number;
export class ReplayBuildError extends Error {
  constructor(code: string, paths?: string[]);
  code: string;
  paths: string[];
}
export interface BuildDeps {
  hasHostName: (text: string) => boolean;
  hasIpv6: (text: string) => boolean;
  validateReplayFile: (input: unknown) => { ok: true; value: ReplayFile } | { ok: false; errors: string[] };
  initialHauntState: (level: 0 | 1 | 2 | 3 | 4, reason: null) => unknown;
  stepHaunt: (state: never, sample: { errorRate: number | null; p95Ms: number | null; up: number | null }) => never;
  sanitizePrText: (value: unknown, cap: number) => string;
}
export interface IncidentRows {
  incident: { id: string; service: string; openedAt: Date; closedAt: Date | null; peakLevel: number };
  services: Array<{ name: string; roomX: number; roomY: number }>;
  signals: Array<{ service: string; kind: string; value: number; at: Date }>;
  hunt: Record<string, unknown> | null;
  proposal: Record<string, unknown> | null;
  window: { startMs: number; endMs: number };
}
export function assertBuildFresh(name: string, distDir: string, srcDir: string): void;
export function loadDeps(options?: { check?: boolean }): Promise<BuildDeps>;
export function readIncidentRows(prisma: unknown, incidentId: string, options?: { leadMs?: number; tailMs?: number }): Promise<IncidentRows>;
export function buildReplay(rows: IncidentRows, opts: { id: string; title: string; scenario: string }, deps: BuildDeps): ReplayFile;
export function writeReplay(file: ReplayFile, outDir: string): string;
export const CLOCK_RANGE_MS: number;
export function replayBase(startMs: number): { recordedOn: string; baseMs: number };
export function rewriteClocks(text: string, win: { startMs: number; endMs: number }): { text: string; outOfRange: boolean };
export function main(
  argv: string[],
  io?: { out: (s: string) => void; err: (s: string) => void },
  seams?: { loadDeps?: () => Promise<BuildDeps>; createPrisma?: (url: string) => unknown; env?: Record<string, string | undefined> },
): Promise<number>;
