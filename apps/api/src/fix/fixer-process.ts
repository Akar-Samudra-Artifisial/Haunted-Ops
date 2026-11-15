import type { AiFailReason } from '@haunted-ops/shared';
import { HuntProcess, DEFAULT_MAX_OUTPUT_BYTES, type HuntProcessOptions, type HuntStopReason } from '../hunts/hunt-process.js';
import type { HuntProcessLike } from '../hunts/hunt-runner.js';
import { StreamParser } from '../hunts/stream-parser.js';
import { StreamRecorder } from '../hunts/stream-recorder.js';
import type { FixConfig } from './fix-config.js';
import { buildFixArgv, buildFixEnv } from './fix-env.js';
import { FixerGuard, type GuardStopCode } from './fixer-guard.js';

/**
 * Why a fixer run is not usable, as a fixed code. The process codes come from here; the runner adds the ones it finds
 * after a run (`no_write`, `agent_changed`, `empty_diff`, `step_error`) or before one (`fixer_not_started`). Logged as `fixerHalt.code` and stored, with
 * the detail, in the internal column `Proposal.aiFailDetail`.
 */
export type FixerHaltCode =
  | GuardStopCode
  | 'not_started'
  | 'timeout'
  | 'credit_cap'
  | 'tool_limit'
  | 'stream_malformed'
  | 'exit_code'
  | 'stopped'
  | 'no_write'
  | 'agent_changed'
  | 'empty_diff'
  | 'step_error'
  | 'fixer_not_started';

export interface FixerHalt {
  code: FixerHaltCode;
  /** A few words, no value of an input, no path outside the work folder; at most 300 characters. */
  detail: string;
}

export const MAX_HALT_DETAIL = 300;

/** The halt as one line for the log and the column: `code: detail`, cleaned of control characters, bounded. */
export function haltText(h: FixerHalt): string {
  // eslint-disable-next-line no-control-regex
  return `${h.code}: ${h.detail}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_HALT_DETAIL);
}

export interface FixerRunInput {
  proposalId: string;
  /** The folder the process starts in: the real path of the work folder. */
  folder: string;
  /** Where `fs_write` may write, relative to the folder (`services/<service>/src/`); absent: anywhere in the folder. */
  writeScope?: string;
  /** The fixer's own `HOME` (`FixerWorkdir.prepareHome`); absent: the API user's home. */
  home?: string;
  prompt: string;
  cfg: Pick<FixConfig, 'model' | 'creditCap' | 'timeoutMs' | 'maxToolCalls'>;
  /** The resolved `kiro-cli`. */
  kiroCliPath: string;
  /** The environment of the API process: only `HOME` and `LANG` are read from it. */
  parentEnv: Readonly<Record<string, string | undefined>>;
  /** Notes the process so a crash of the API cannot leave it behind (see `HuntWorkdir.reapOrphans`). */
  pids?: { write(id: string, pid: number): Promise<void>; remove(id: string): Promise<void> };
  /**
   * Where the stream of this run is kept (`FIX_WORKDIR/streams/<proposalId>.fixer.stream.jsonl`, mode 0600), reduced
   * like the Hunt streams: tool calls with title and input, updates, Credits and run ends; no model text and no
   * tool output. `secrets` are masked in it.
   */
  stream?: { path: string; secrets: readonly string[] };
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
  /** What stopped the run, as a fixed code with its detail; null when it finished. */
  halt: FixerHalt | null;
  /** The Credits of the run: the report, or the cap when none arrived (`creditsEstimated`). */
  credits: number;
  creditsEstimated: boolean;
  toolCalls: number;
  /** Accepted `fs_write` calls. */
  writes: number;
}

/** The handle of a running fixer: `stop` ends it (the Kill switch and a shutdown use it). */
export interface FixerHandle {
  readonly result: Promise<FixerRunResult>;
  stop(reason: HuntStopReason): void;
}

/**
 * Starts the fixer: `kiro-cli chat` with the `exorcist-fixer` agent in the work folder, in its own process group,
 * with a fixed environment. The stream is read for tool calls (allow-list, paths inside the folder, call limit) and
 * for the Credits report; the agent's words are dropped. Whatever stops it, the result says why (a fixed code and a
 * detail) and what it cost: a run that ended with no Credits report is charged the per-run cap and marked estimated.
 */
export function startFixer(i: FixerRunInput): FixerHandle {
  const env = buildFixEnv({ cfg: { kiroCliPath: i.kiroCliPath }, parentEnv: i.parentEnv, home: i.home });
  const argv = buildFixArgv(i.cfg, i.prompt);
  const guard = new FixerGuard(i.folder, { writeScope: i.writeScope });
  const parser = new StreamParser();
  const recorder = i.stream === undefined ? null : new StreamRecorder(i.stream.path, i.stream.secrets);
  let credits = 0;
  let reports = 0;
  let halt: FixerHalt | null = null;
  let halted = false;

  const opts: HuntProcessOptions = {
    executable: i.kiroCliPath,
    argv,
    env,
    cwd: i.folder,
    timeoutMs: i.cfg.timeoutMs,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    onStdout: (chunk) => {
      recorder?.write(chunk);
      feed(parser.push(chunk));
    },
  };
  const proc: HuntProcessLike = (i.spawn ?? ((o) => new HuntProcess(o)))(opts);

  const stopWith = (reason: HuntStopReason, code: FixerHaltCode, detail: string): void => {
    if (halted) return;
    halted = true;
    halt = { code, detail: detail.slice(0, MAX_HALT_DETAIL) };
    proc.stop(reason);
  };

  function feed(events: ReturnType<StreamParser['push']>): void {
    for (const ev of events) {
      if (halted) return;
      if (ev.type === 'credits') {
        reports += 1;
        credits += ev.usage;
        if (credits >= i.cfg.creditCap) stopWith('credit_cap', 'credit_cap', 'credit cap');
        continue;
      }
      if (ev.type === 'tool_call' || ev.type === 'tool_call_update') {
        const out = guard.judge(ev);
        if (out.kind === 'stop') return stopWith('foreign_tool', out.code, out.detail);
        if (out.kind === 'step' && guard.count > i.cfg.maxToolCalls) return stopWith('tool_limit', 'tool_limit', 'tool call limit');
      }
      // Fail closed: the fixer can write files, so one line the guard cannot read (bad JSON, or longer than the
      // parser's cap, which could hide a tool call) stops the run at once. Hunts keep their tolerance.
      if (ev.type === 'malformed') return stopWith('stream_error', 'stream_malformed', 'stream error: a malformed or oversized line');
    }
  }

  const result = (async (): Promise<FixerRunResult> => {
    proc.start();
    if (proc.pid !== undefined) await i.pids?.write(i.proposalId, proc.pid).catch(() => undefined);
    const exit = await proc.done;
    await i.pids?.remove(i.proposalId).catch(() => undefined);
    if (!halted) feed(parser.end());
    await recorder?.close();
    const started = !exit.spawnFailed;
    // A run that started but sent no Credits report was stopped early or crashed: it is charged the cap.
    const estimated = started && reports === 0;
    const base = { started, credits: estimated ? i.cfg.creditCap : credits, creditsEstimated: estimated, toolCalls: guard.count, writes: guard.writes };
    const failed = (h: FixerHalt, aiFailReason: 'agent_failed' | 'timeout' = 'agent_failed'): FixerRunResult => ({
      ...base,
      finished: false,
      aiFailReason,
      halt: h,
      stopDetail: h.code === 'timeout' ? 'timeout' : h.detail,
    });
    if (exit.stoppedBy === 'timeout') return failed({ code: 'timeout', detail: `timeout after ${i.cfg.timeoutMs} ms` }, 'timeout');
    const stoppedHalt: FixerHalt | null = halt;
    if (stoppedHalt !== null) return failed(stoppedHalt);
    if (exit.stoppedBy !== null) return failed({ code: 'stopped', detail: exit.stoppedBy });
    if (exit.spawnFailed) return failed({ code: 'not_started', detail: 'not started' });
    if (exit.code !== 0) return failed({ code: 'exit_code', detail: `exit ${exit.code ?? 'signal'}` });
    return { ...base, finished: true, aiFailReason: null, halt: null, stopDetail: null };
  })();

  return {
    result,
    stop: (reason) => {
      if (reason === 'shutdown' || reason === 'disabled') stopWith(reason, 'stopped', reason);
      else stopWith(reason, reason === 'timeout' ? 'timeout' : 'stopped', reason);
    },
  };
}
