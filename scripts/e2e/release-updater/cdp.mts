import assert from 'node:assert/strict';

interface Message { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string }; }
interface Evaluation<T> { result: { value: T }; exceptionDetails?: { text: string; exception?: { description: string } }; }

export async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null && result !== false) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Native gate timed out: ${label}`);
}

export class Cdp {
  private id = 0;
  readonly events: Message[] = [];
  private readonly listeners = new Set<(event: Message) => void>();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id === undefined) { this.events.push(message); for (const listener of this.listeners) listener(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Native CDP closed')); }
      this.pending.clear();
    });
  }
  static async connect(url: string) {
    assert(new URL(url).hostname === '127.0.0.1', 'Inspector must bind loopback');
    const socket = new WebSocket(url);
    const client = new Cdp(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Native CDP connection timeout')); }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Native CDP connection failed')); }, { once: true });
    });
    return client;
  }
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  onEvent(listener: (event: Message) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async evaluate<T>(expression: string, callFrameId?: string): Promise<T> {
    const result = await this.send<Evaluation<T>>(callFrameId ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate', {
      expression, returnByValue: true, ...(callFrameId ? { callFrameId } : { awaitPromise: false }),
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}
