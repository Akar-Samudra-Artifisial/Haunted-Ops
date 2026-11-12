import { parseSseFrame, type SseFrame } from '@haunted-ops/shared';

/** Reads SSE frames from a fetch response body. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly frames: SseFrame[] = [];
  ended = false;

  constructor(res: Response) {
    if (!res.body) throw new Error('no body');
    this.reader = res.body.getReader();
  }

  /** Waits until n data frames (comments skipped) have arrived, or the stream ends. */
  async take(n: number, timeoutMs = 3_000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < n && !this.ended) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${n} frames, got ${this.frames.length}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<'timeout'>((r) => {
          timer = setTimeout(() => r('timeout'), left);
        }),
      ]);
      clearTimeout(timer);
      if (chunk === 'timeout') continue;
      if (chunk.done) {
        this.ended = true;
        break;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
        const block = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        if (block.startsWith(':') || block.startsWith('retry:')) continue;
        const frame = parseSseFrame(`${block}\n\n`);
        if (frame) this.frames.push(frame);
      }
    }
    return this.frames.splice(0, n);
  }

  /** Resolves true when the server ends the stream. */
  async waitForEnd(timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended && Date.now() < deadline) {
      try {
        await this.take(Number.MAX_SAFE_INTEGER, deadline - Date.now());
      } catch {
        break;
      }
    }
    return this.ended;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}
