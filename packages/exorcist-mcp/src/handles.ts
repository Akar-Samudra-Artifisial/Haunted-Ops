import type { EvidenceKindName, HuntTool, ServiceName } from '@haunted-ops/shared';
import type { Signal, Window } from './schemas.js';

/** What a handle stands for. The ledger records it so the API can check a diagnosis. */
export interface IssuedHandle {
  handle: string;
  kind: EvidenceKindName;
  tool: HuntTool;
  service: ServiceName | null;
  deployId: string | null;
  sha: string | null;
  detail: string;
}

export type HandleKey =
  | { kind: 'metric'; service: ServiceName; signal: Signal; window: Window }
  | { kind: 'error' }
  | { kind: 'log' }
  | { kind: 'deploy'; deployId: string }
  | { kind: 'commit'; sha: string };

/**
 * Evidence handles of one process (one Hunt). A handle is unique; the same deploy, commit or metric
 * seen twice keeps its first handle, so it is issued and logged once. Errors and logs count from 1.
 */
export class HandleRegistry {
  private readonly byHandle = new Map<string, IssuedHandle>();
  private errors = 0;
  private logs = 0;

  constructor(private readonly onIssue: (issued: IssuedHandle) => void) {}

  /** Returns the handle for the key; `fresh` is true when it was issued by this call. */
  issue(key: HandleKey, meta: Omit<IssuedHandle, 'handle' | 'kind'>): { handle: string; fresh: boolean } {
    const handle = this.name(key);
    if (this.byHandle.has(handle)) return { handle, fresh: false };
    const issued: IssuedHandle = { handle, kind: key.kind, ...meta };
    this.byHandle.set(handle, issued);
    this.onIssue(issued);
    return { handle, fresh: true };
  }

  has(handle: string): boolean {
    return this.byHandle.has(handle);
  }

  all(): IssuedHandle[] {
    return [...this.byHandle.values()];
  }

  private name(key: HandleKey): string {
    switch (key.kind) {
      case 'metric':
        return `metric:${key.service}/${key.signal}/${key.window}`;
      case 'error':
        this.errors += 1;
        return `error:${this.errors}`;
      case 'log':
        this.logs += 1;
        return `log:${this.logs}`;
      case 'deploy':
        return `deploy:${key.deployId}`;
      case 'commit':
        return `commit:${key.sha}`;
    }
  }
}
