import type { AiFailReason } from '@haunted-ops/shared';
import { HuntProcess, DEFAULT_MAX_OUTPUT_BYTES, type HuntProcessOptions, type HuntStopReason } from '../hunts/hunt-process.js';
import { MAX_MALFORMED_LINES, type HuntProcessLike } from '../hunts/hunt-runner.js';
import { StreamParser } from '../hunts/stream-parser.js';
import type { FixConfig } from './fix-config.js';
import { buildFixArgv, buildFixEnv } from './fix-env.js';
import { FixerGuard } from './fixer-guard.js';

export interface FixerRunInput {
  proposalId: string;
  /** The folder the process starts in: the real path of the work folder. */
  folder: string;
  prompt: string;
  cfg: Pick<FixConfig, 'model' | 'creditCap' | 'timeoutMs' | 'maxToolCalls'>;
  /** The resolved `kiro-cli`. */
  kiroCliPath: string;
  /** The environment of the API process: only `HOME` and `LANG` are read from it. */
  parentEnv: Readonly<Record<string, string | undefined>>;
  /** Notes the process so a crash of the API cannot leave it behind (see `HuntWorkdir.reapOrphans`). */
  pids?: { write(id: string, pid: number): Promise<void>; remove(id: string): Promise<void> };
  /** Test seam: a fake process. */
  spawn?: (opts: HuntProcessOptions) => HuntProcessLike;
}

export interface FixerRunResult {
  /** The process was started (a missing or non-executable `kiro-cli` is not a start). */
  started: boolean;
  /** The run ended by itself with exit code 0 and nothing stopped it. */
  finished: boolean;
  /** Why the run is not usable, in the vocabulary of the AI fail reasons; null when it finished. */
  aiFailReason: Extract<AiFailReason, 'agent_failed' | 'timeout'> | null;
  /** What stopped the run, in a few words: the refused title, or the limit. */
  stopDetail: string | null;
  /** The Credits of the run: the report, or the cap when none arrived (`creditsEstimated`). */
  credits: number;
  creditsEstimated: boolean;
  toolCalls: number;
}

/** The handle of a running fixer: `stop` ends it (the Kill switch and a shutdown use it). */
export interface FixerHandle {
  readonly result: Promise<FixerRunResult>;
  stop(reason: HuntStopReason): void;
}

/**
 * Starts the fixer: `kiro-cli chat` with the `exorcist-fixer` agent in the work folder, in its own process group,
 * with a fixed environment. The stream is read for tool calls (allow-list, paths inside the folder, call limit) and
 * for the Credits report; the agent's words are dropped. Whatever stops it, the result says why and what it cost: a
 * run that ended with no Credits report is charged the per-run cap and marked as estimated.
 */
export function startFixer(i: FixerRunInput): FixerHandle {
  const env = buildFixEnv({ cfg: { kiroCliPath: i.kiroCliPath }, parentEnv: i.parentEnv });
  const argv = buildFixArgv(i.cfg, i.prompt);
  const guard = new FixerGuard(i.folder);
  const parser = new StreamParser();
  let credits = 0;
  let reports = 0;
  let stopDetail: string | null = null;
  let halted = false;

  const opts: HuntProcessOptions = {
    executable: i.kiroCliPath,
    argv,
    env,
    cwd: i.folder,
    timeoutMs: i.cfg.timeoutMs,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    onStdout: (chunk) => feed(parser.push(chunk)),
  };
  const proc: HuntProcessLike = (i.spawn ?? ((o) => new HuntProcess(o)))(opts);

  const halt = (reason: HuntStopReason, detail: string | null): void => {
    if (halted) return;
    halted = true;
    stopDetail = detail;
    proc.stop(reason);
  };

  function feed(events: ReturnType<StreamParser['push']>): void {
    for (const ev of events) {
      if (halted) return;
      if (ev.type === 'credits') {
        reports += 1;
        credits += ev.usage;
        if (credits >= i.cfg.creditCap) halt('credit_cap', 'credit cap');
        continue;
      }
      if (ev.type === 'tool_call' || ev.type === 'tool_call_update') {
        const out = guard.judge(ev);
        if (out.kind === 'stop') return halt('foreign_tool', out.detail);
        if (out.kind === 'step' && guard.count > i.cfg.maxToolCalls) return halt('tool_limit', 'tool call limit');
      }
      if (parser.malformed > MAX_MALFORMED_LINES) return halt('stream_error', 'stream error');
    }
  }

  const result = (async (): Promise<FixerRunResult> => {
    proc.start();
    if (proc.pid !== undefined) await i.pids?.write(i.proposalId, proc.pid).catch(() => undefined);
    const exit = await proc.done;
    await i.pids?.remove(i.proposalId).catch(() => undefined);
    if (!halted) feed(parser.end());
    const started = !exit.spawnFailed;
    // A run that started but sent no Credits report was stopped early or crashed: it is charged the cap.
    const estimated = started && reports === 0;
    const base = { started, credits: estimated ? i.cfg.creditCap : credits, creditsEstimated: estimated, toolCalls: guard.count, stopDetail };
    if (exit.stoppedBy === 'timeout') return { ...base, finished: false, aiFailReason: 'timeout', stopDetail: 'timeout' };
    if (exit.stoppedBy !== null || halted) return { ...base, finished: false, aiFailReason: 'agent_failed' };
    if (exit.spawnFailed || exit.code !== 0) return { ...base, finished: false, aiFailReason: 'agent_failed', stopDetail: exit.spawnFailed ? 'not started' : `exit ${exit.code ?? 'signal'}` };
    return { ...base, finished: true, aiFailReason: null };
  })();

  return { result, stop: (reason) => halt(reason, reason === 'shutdown' || reason === 'disabled' ? reason : null) };
}
