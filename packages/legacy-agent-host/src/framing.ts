import type { HostCloseReason } from './contracts.js';

/** Fixed-size storage bounds incomplete frames before decoding or parsing. */
export class BoundedLineDecoder {
  private readonly buffer: Buffer;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private length = 0;
  private failed = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onFrame: (frame: string) => void,
    private readonly onFailure: (reason: HostCloseReason) => void
  ) {
    this.buffer = Buffer.allocUnsafe(maxBytes);
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.failed) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const size = end - offset;
      if (this.length + size > this.maxBytes) {
        this.fail('frame_too_large');
        return;
      }
      chunk.copy(this.buffer, this.length, offset, end);
      this.length += size;
      if (newline < 0) return;
      let frame: string;
      try {
        frame = this.decoder.decode(this.buffer.subarray(0, this.length));
      } catch {
        this.fail('invalid_utf8');
        return;
      }
      this.length = 0;
      this.onFrame(frame);
      offset = newline + 1;
    }
  }

  end(): void {
    if (this.length > 0 && !this.failed) this.fail('truncated_frame');
  }

  stop(): void {
    this.failed = true;
    this.length = 0;
  }

  private fail(reason: HostCloseReason): void {
    this.stop();
    this.onFailure(reason);
  }
}
