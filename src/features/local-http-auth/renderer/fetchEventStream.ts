import { BrowserAccessSession } from './browserSession';

export class SseFrameDecoder {
  private readonly decoder = new TextDecoder();
  private pending = '';
  private channel = 'message';
  private data: string[] = [];

  constructor(private readonly dispatch: (channel: string, data: unknown) => void) {}

  push(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    if (this.pending.length > 1_048_576) throw new Error('SSE frame too large');
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      if (!line) {
        if (this.data.length) {
          let payload: unknown;
          try {
            payload = JSON.parse(this.data.join('\n'));
          } catch {
            this.data = [];
            this.channel = 'message';
            continue;
          }
          this.dispatch(this.channel, payload);
        }
        this.channel = 'message';
        this.data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') this.channel = value;
        if (field === 'data') this.data.push(value);
        if (this.data.reduce((length, item) => length + item.length, 0) > 1_048_576) {
          throw new Error('SSE data too large');
        }
      }
    }
  }
}

/** One authorized connection per client; listener API remains channel + JSON payload. */
export class AuthenticatedEventStream {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private active: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly unsubscribeSession: () => void;

  constructor(
    private readonly session: BrowserAccessSession,
    private readonly reconnectMs = 1000
  ) {
    this.unsubscribeSession = session.subscribe(() => {
      this.stop();
      this.connect();
    });
  }

  subscribe(channel: string, callback: (data: unknown) => void): () => void {
    if (this.disposed) throw new Error('Event stream disposed');
    let callbacks = this.listeners.get(channel);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(channel, callbacks);
    }
    callbacks.add(callback);
    this.connect();
    return () => {
      callbacks.delete(callback);
      if (!callbacks.size) this.listeners.delete(channel);
      if (!this.listeners.size) this.stop();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeSession();
    this.stop();
    this.listeners.clear();
  }

  private stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.active?.abort();
    this.active = null;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
  }

  private connect(): void {
    if (
      this.disposed ||
      this.active ||
      this.retry ||
      !this.listeners.size ||
      this.session.getSnapshot() !== 'ready'
    )
      return;
    const controller = new AbortController();
    this.active = controller;
    void this.run(controller);
  }

  private async run(controller: AbortController): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const ownsConnection = (): boolean =>
      !controller.signal.aborted &&
      this.active === controller &&
      !this.disposed &&
      this.session.getSnapshot() === 'ready';
    try {
      const response = await this.session.fetch('/api/events', { signal: controller.signal });
      if (!ownsConnection()) {
        await response.body?.cancel();
        return;
      }
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.startsWith('text/event-stream')
      ) {
        await response.body?.cancel();
        return;
      }
      reader = response.body.getReader();
      this.reader = reader;
      const frames = new SseFrameDecoder((channel, payload) => {
        if (!ownsConnection()) return;
        for (const listener of this.listeners.get(channel) ?? []) {
          if (!ownsConnection()) return;
          // One failing subscriber must not disconnect the other subscribers.
          try {
            listener(payload);
          } catch {
            /* subscriber owns its failure */
          }
        }
      });
      while (ownsConnection()) {
        const result = await reader.read();
        if (!ownsConnection() || result.done) break;
        frames.push(result.value);
      }
    } catch {
      /* Network interruptions reconnect after a bounded delay. */
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      if (this.active === controller) {
        this.active = null;
        this.reader = null;
        if (!this.disposed && this.listeners.size && this.session.getSnapshot() === 'ready') {
          this.retry = setTimeout(() => {
            this.retry = null;
            this.connect();
          }, this.reconnectMs);
        }
      }
    }
  }
}
