import { appendFileSync } from 'node:fs';
import type { IssuedHandle } from './handles.js';
import type { SubmitDiagnosisInput } from './schemas.js';

/** One line of the Hunt ledger. The API reads these; nothing else writes the file. */
export type LedgerLine =
  | ({ type: 'handle'; seq: number; at: string } & IssuedHandle)
  | { type: 'diagnosis'; seq: number; input: SubmitDiagnosisInput; at: string };

export interface LedgerSink {
  append(line: string): void;
}

/** Appends to the ledger file with mode 0600. Synchronous, so lines keep their order. */
export class FileSink implements LedgerSink {
  constructor(private readonly path: string) {}
  append(line: string): void {
    appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  }
}

export class MemorySink implements LedgerSink {
  readonly lines: string[] = [];
  append(line: string): void {
    this.lines.push(line);
  }
}

export class Ledger {
  private seq = 0;

  constructor(
    private readonly sink: LedgerSink,
    private readonly now: () => number = Date.now,
  ) {}

  handle(issued: IssuedHandle): void {
    this.write({ type: 'handle', seq: ++this.seq, at: this.at(), ...issued });
  }

  diagnosis(input: SubmitDiagnosisInput): void {
    this.write({ type: 'diagnosis', seq: ++this.seq, input, at: this.at() });
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private write(line: LedgerLine): void {
    this.sink.append(`${JSON.stringify(line)}\n`);
  }
}

/** Parses ledger text: one valid object per line; bad lines are skipped. */
export function parseLedger(text: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const v = JSON.parse(raw) as LedgerLine;
      if (typeof v === 'object' && v !== null && (v.type === 'handle' || v.type === 'diagnosis')) out.push(v);
    } catch {
      // A line torn by a crash is ignored.
    }
  }
  return out;
}
