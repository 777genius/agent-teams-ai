import type { Duplex } from 'node:stream';
import { Socket } from 'node:net';
import { canonicalJson } from './canonical';

export const SELECTED_CONTROLLER_CHANNEL = 'agent-teams.hosted-selected-controller-fd3/v1' as const;
const MAXIMUM = 4 * 1024 * 1024;
/** The existing inherited FD3 socket, now explicitly framed and duplex. No
 * reconnect, listener, signer daemon, new FD, fallback or alternate authority. */
export class SelectedControllerChannel {
  readonly #stream: Duplex;
  readonly #closed = new AbortController();
  get closedSignal(): AbortSignal { return this.#closed.signal; }
  #buffer = Buffer.alloc(0);
  #read?: { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void; exchange: boolean };
  #failure?: Error;
  #writing = false;
  #exchange = false;
  #queue: unknown[] = [];
  constructor(stream: Duplex) {
    this.#stream = stream;
    stream.on('data', this.#data);
    stream.once('error', this.#lost);
    stream.once('end', this.#lost);
    stream.once('close', this.#lost);
  }
  static inherited(): SelectedControllerChannel {
    return new SelectedControllerChannel(new Socket({ fd: 3, readable: true, writable: true }));
  }
  #lost = () => this.close();
  #data = (part: Buffer) => {
    try {
      if (this.#failure || this.#exchange || !Buffer.isBuffer(part) || this.#buffer.length + part.length > MAXIMUM + 4) throw new Error();
      const previous = this.#buffer;
      this.#buffer = Buffer.concat([previous, part]); previous.fill(0);
      if (this.#buffer.length < 4) return;
      const length = this.#buffer.readUInt32BE(0);
      if (length < 2 || length > MAXIMUM) throw new Error();
      if (this.#buffer.length < length + 4) return;
      // One outstanding request/response at a time. Coalesced unsolicited
      // frames are a protocol failure, not an unbounded application queue.
      if (this.#buffer.length !== length + 4 || this.#queue.length) throw new Error();
      const source = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer.subarray(4));
      const value: unknown = JSON.parse(source);
      if (canonicalJson(value) !== source) throw new Error();
      this.#buffer.fill(0); this.#buffer = Buffer.alloc(0);
      const pending = this.#read;
      if (pending) { this.#read = undefined; pending.cleanup(); this.#exchange = pending.exchange; pending.resolve(value); }
      else this.#queue.push(value);
    } catch { this.close(); }
  };
  read(signal: AbortSignal, timeoutMs = 30_000, exchange = false): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#read || this.#exchange || signal.aborted) { this.close(); return Promise.reject(new Error('selected_controller_read')); }
    if (this.#queue.length) {
      if (this.#buffer.length) { this.close(); return Promise.reject(new Error('selected_controller_read')); }
      this.#exchange = exchange; return Promise.resolve(this.#queue.shift());
    }
    return new Promise((resolve, reject) => {
      const abort = () => this.close();
      const timer = setTimeout(abort, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      this.#read = { resolve, reject, exchange, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } };
    });
  }
  async write(value: unknown, completesExchange = false): Promise<void> {
    if (this.#failure || this.#writing || (completesExchange && !this.#exchange)) throw new Error('selected_controller_write');
    this.#writing = true;
    let bytes: Buffer | undefined;
    let frame: Buffer | undefined;
    try {
      bytes = Buffer.from(canonicalJson(value));
      if (bytes.length < 2 || bytes.length > MAXIMUM) throw new Error('selected_controller_bound');
      frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.close(); reject(new Error('selected_controller_write_timeout')); }, 5000);
        this.#stream.write(frame!, error => { clearTimeout(timer); if (error) reject(new Error('selected_controller_write')); else resolve(); });
      });
      if (this.#failure) throw this.#failure;
      if (completesExchange) this.#exchange = false;
    } catch { this.close(); throw new Error('selected_controller_write'); }
    finally { this.#writing = false; bytes?.fill(0); frame?.fill(0); }
  }
  close(): void {
    if (this.#failure) return;
    this.#failure = new Error('selected_controller_closed');
    this.#closed.abort();
    this.#buffer.fill(0); this.#buffer = Buffer.alloc(0); this.#queue.length = 0;
    const pending = this.#read; this.#read = undefined;
    if (pending) { pending.cleanup(); pending.reject(this.#failure); }
    this.#stream.off('data', this.#data);
    this.#stream.destroy();
  }
}
