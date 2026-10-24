import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InternalStorageOperationInterruptedError as InterruptedError } from '../../../src/features/internal-storage/core/application/InternalStorageOperationInterruptedError';
import type { InternalStorageWorkerClient as WorkerClient } from '../../../src/features/internal-storage/main/infrastructure/InternalStorageWorkerClient';

let InternalStorageOperationInterruptedError: typeof InterruptedError;
let InternalStorageWorkerClient: typeof WorkerClient;

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
  const closeProbe = vi.fn();
  const nativeDriver = vi.fn(function () {
    return { close: closeProbe };
  });
  const requireModule = vi.fn(() => nativeDriver);
  return { workers, construct, nativeDriver, closeProbe, requireModule };
});

vi.mock('node:module', async () => {
  const actual = await vi.importActual<typeof import('node:module')>('node:module');
  const createRequire = () => fixture.requireModule;
  return { ...actual, createRequire, default: { ...actual, createRequire } };
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
  beforeEach(async () => {
    vi.resetModules();
    ({ InternalStorageWorkerClient } =
      await import('../../../src/features/internal-storage/main/infrastructure/InternalStorageWorkerClient'));
    ({ InternalStorageOperationInterruptedError } =
      await import('../../../src/features/internal-storage/core/application/InternalStorageOperationInterruptedError'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    fixture.workers.length = 0;
    vi.clearAllMocks();
    fixture.nativeDriver.mockReset();
    fixture.nativeDriver.mockImplementation(function () {
      return { close: fixture.closeProbe };
    });
    vi.useRealTimers();
  });

  // Missing or late pinning allows a terminated worker to be the native addon's
  // last owner; merely requiring the JS constructor does not prevent that.
  it('loads and closes the memory probe before the first worker, once across replacements', async () => {
    const client = new InternalStorageWorkerClient({ databasePath: '/test-only/storage.db' });
    expect(fixture.nativeDriver).not.toHaveBeenCalled();
    expect(fixture.requireModule).not.toHaveBeenCalled();
    const first = client.ping();
    expect(fixture.requireModule).toHaveBeenCalledWith('better-sqlite3');
    expect(fixture.nativeDriver).toHaveBeenCalledExactlyOnceWith(':memory:');
    expect(fixture.closeProbe).toHaveBeenCalledTimes(1);
    expect(fixture.closeProbe.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.construct.mock.invocationCallOrder[0]
    );
    fixture.workers[0].reply(0, { backend: 'sqlite' });
    await first;
    fixture.workers[0].emit('exit', 0);
    const replacement = client.ping();
    fixture.workers[1].reply(0, { backend: 'sqlite' });
    await replacement;
    const otherClient = new InternalStorageWorkerClient({ databasePath: '/test-only/other.db' });
    const other = otherClient.ping();
    fixture.workers[2].reply(0, { backend: 'sqlite' });
    await other;
    expect(fixture.nativeDriver).toHaveBeenCalledExactlyOnceWith(':memory:');
    expect(fixture.closeProbe).toHaveBeenCalledTimes(1);
    expect(fixture.construct).toHaveBeenCalledTimes(3);
  });

  // An ABI/load failure must leave all application database work unstarted so
  // the selector can safely retain its existing JSON fallback.
  it('rejects native binding pin failure without creating a worker or starting a write', async () => {
    fixture.nativeDriver.mockImplementationOnce(function () {
      throw new Error('NODE_MODULE_VERSION mismatch');
    });
    const client = new InternalStorageWorkerClient({ databasePath: '/test-only/storage.db' });
    const write = client.replaceStallJournalEntries('sandbox', []).catch((error: unknown) => error);
    expect(fixture.construct).not.toHaveBeenCalled();
    expect(await write).toMatchObject({
      message: 'better-sqlite3 native module pin failed: NODE_MODULE_VERSION mismatch',
    });
    expect(fixture.nativeDriver).toHaveBeenCalledExactlyOnceWith(':memory:');
    expect(fixture.closeProbe).not.toHaveBeenCalled();
    await expect(client.waitForSettling()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
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
    await expect((failure as InterruptedError).settled).resolves.toBeUndefined();

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
