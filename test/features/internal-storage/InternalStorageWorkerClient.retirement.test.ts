import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InternalStorageOperationInterruptedError } from '../../../src/features/internal-storage/core/application/InternalStorageOperationInterruptedError';
import { InternalStorageWorkerClient } from '../../../src/features/internal-storage/main/infrastructure/InternalStorageWorkerClient';

const fixture = vi.hoisted(() => {
  type Request = { id: string; op: string; payload: unknown };
  class TestWorker {
    messages: Request[] = [];
    handlers = new Map<string, (value: never) => void>();
    finishTermination!: (code: number) => void;
    rejectTermination!: (error: Error) => void;
    termination = new Promise<number>((resolve, reject) => {
      this.finishTermination = resolve;
      this.rejectTermination = reject;
    });
    terminate = vi.fn(() => this.termination);
    postMessage = vi.fn((message: Request) => {
      this.messages.push(message);
    });
    on(event: string, handler: (value: never) => void) {
      this.handlers.set(event, handler);
    }
    emit(event: string, value: unknown) {
      this.handlers.get(event)?.(value as never);
    }
    reply(index: number, result: unknown = null) {
      this.emit('message', { id: this.messages[index].id, ok: true, result });
    }
  }
  const workers: TestWorker[] = [];
  const construct = vi.fn(function () {
    const worker = new TestWorker();
    workers.push(worker);
    return worker;
  });
  return { workers, construct };
});

vi.mock('node:worker_threads', () => ({
  Worker: fixture.construct,
  default: { Worker: fixture.construct },
}));
vi.mock('node:fs', async () => ({
  ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
  existsSync: () => true,
}));

describe('InternalStorageWorkerClient physical retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    fixture.workers.length = 0;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('blocks replacement and negative proof until a timed-out writer exits', async () => {
    const client = new InternalStorageWorkerClient({ databasePath: '/test-only/storage.db' });
    const write = client.replaceStallJournalEntries('sandbox', []).catch((error: unknown) => error);
    const queued = client.statusRead('sandbox', 'alice').catch((error: unknown) => error);
    const first = fixture.workers[0];
    await vi.advanceTimersByTimeAsync(20_000);
    const failure = await write;
    expect(failure).toBeInstanceOf(InternalStorageOperationInterruptedError);
    expect(failure).toMatchObject({ execution: 'unknown' });
    expect(await queued).toMatchObject({ execution: 'not_started' });
    expect(first.messages).toHaveLength(1);
    expect(first.terminate).toHaveBeenCalledTimes(1);

    let drained = false;
    const drain = client.waitForSettling().then(() => {
      drained = true;
    });
    await expect(client.statusRead('sandbox', 'alice')).rejects.toMatchObject({
      execution: 'not_started',
    });
    expect(fixture.workers).toHaveLength(1);
    expect(drained).toBe(false);

    // The late reply is not allowed to reopen admission: only physical exit is.
    first.reply(0);
    await expect(client.ping()).rejects.toMatchObject({ execution: 'not_started' });
    expect(drained).toBe(false);
    first.finishTermination(1);
    await drain;
    expect(drained).toBe(true);
    await expect(
      (failure as InternalStorageOperationInterruptedError).settled
    ).resolves.toBeUndefined();

    const read = client.statusRead('sandbox', 'alice');
    expect(fixture.workers).toHaveLength(2);
    const second = fixture.workers[1];
    first.emit('exit', 1);
    first.emit('error', new Error('late old error'));
    first.reply(0);
    second.reply(0, null);
    await expect(read).resolves.toBeNull();
    expect(second.terminate).not.toHaveBeenCalled();
  });

  it('keeps the fence after failed terminate until an independent exit event', async () => {
    const client = new InternalStorageWorkerClient({ databasePath: '/test-only/storage.db' });
    const pending = client.ping().catch((error: unknown) => error);
    const worker = fixture.workers[0];
    worker.emit('error', new Error('worker failure'));
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    worker.rejectTermination(new Error('termination unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(client.ping()).rejects.toMatchObject({ execution: 'not_started' });
    expect(fixture.workers).toHaveLength(1);
    worker.emit('exit', 1);
    await client.waitForSettling();
    const retry = client.ping();
    fixture.workers[1].reply(0, { backend: 'sqlite' });
    await expect(retry).resolves.toEqual({ backend: 'sqlite' });
  });

  it('close waits for an already retiring writer and stays idempotent', async () => {
    const client = new InternalStorageWorkerClient({ databasePath: '/test-only/storage.db' });
    const pending = client.ping().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    const close = client.close();
    expect(client.close()).toBe(close);
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    await expect(client.ping()).rejects.toThrow('client is closed');
    fixture.workers[0].finishTermination(1);
    await close;
    expect(closed).toBe(true);
    expect(fixture.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('confirmed exit permits replacement without waiting for terminate', async () => {
    const client = new InternalStorageWorkerClient({ databasePath: '/test-only/storage.db' });
    const pending = client.ping().catch((error: unknown) => error);
    const worker = fixture.workers[0];
    worker.emit('exit', 1);
    expect(await pending).toMatchObject({ execution: 'unknown' });
    expect(worker.terminate).not.toHaveBeenCalled();
    const next = client.ping();
    fixture.workers[1].reply(0, { backend: 'sqlite' });
    await expect(next).resolves.toEqual({ backend: 'sqlite' });
  });

  it('preserves normal serialized requests and graceful close', async () => {
    const client = new InternalStorageWorkerClient({ databasePath: '/test-only/storage.db' });
    const first = client.ping();
    const second = client.statusRead('sandbox', 'alice');
    const worker = fixture.workers[0];
    expect(worker.messages).toHaveLength(1);
    worker.reply(0, { backend: 'sqlite' });
    await first;
    expect(worker.messages).toHaveLength(2);
    worker.reply(1);
    await second;
    const closing = client.close();
    expect(worker.messages[2].op).toBe('close');
    worker.reply(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.finishTermination(0);
    await closing;
  });
});
