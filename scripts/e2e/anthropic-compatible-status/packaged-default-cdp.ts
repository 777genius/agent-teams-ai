import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

type Reply = { result?: { value?: unknown }; exceptionDetails?: unknown };
type Pending = {
  resolve: (value: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Inspection and real mouse/keyboard input on the already ownership-checked renderer. */
export class PackagedDefaultCdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data)) as {
        id?: number;
        result: Reply;
        error?: { message: string };
      };
      const pending = message.id ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Packaged renderer disconnected'));
      }
      this.pending.clear();
    });
  }
  static async connect(endpoint: string) {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP connection failed')), {
        once: true,
      });
    });
    return new PackagedDefaultCdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
    return reply.result?.value as T;
  }
  async wait<T = unknown>(expression: string, label: string, timeout = 90_000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await this.evaluate<T>(expression);
      if (result) return result;
      await pause(250);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async clickElement(expression: string) {
    const point = await this.wait<{ x: number; y: number }>(
      `(() => {
      const e = (${expression}); if (!e || e.disabled) return null;
      e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect();
      return r.width && r.height ? {x:r.left+r.width/2,y:r.top+r.height/2} : null;
    })()`,
      'clickable control'
    );
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.send('Input.dispatchMouseEvent', {
        type,
        button: 'left',
        clickCount: 1,
        ...point,
      });
  }
  click(selector: string) {
    return this.clickElement(`document.querySelector(${JSON.stringify(selector)})`);
  }
  clickText(text: string, scope = 'document') {
    return this.clickElement(
      `[...${scope}.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})`
    );
  }
  async fill(selector: string, value: string) {
    await this.click(selector);
    await this.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement))
        throw new Error('Expected a text input for native fill');
      e.focus(); e.select();
    })()`);
    await this.send('Input.insertText', { text: value });
    assert.equal(
      await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),
      value
    );
  }
  async screenshot(file: string) {
    const reply = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(file, Buffer.from((reply as unknown as { data: string }).data, 'base64'));
  }
  close() {
    this.socket.close();
  }
}
