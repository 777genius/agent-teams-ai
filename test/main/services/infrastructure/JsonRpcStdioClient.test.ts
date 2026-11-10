// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcStdioClient } from '../../../../src/main/services/infrastructure/codexAppServer/JsonRpcStdioClient';

import type { ChildProcess } from 'node:child_process';

const mocks = vi.hoisted(() => ({ spawnCli: vi.fn(), killProcessTree: vi.fn() }));
vi.mock('@main/utils/childProcess', () => mocks);

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(stdin: Writable): { child: ChildProcess; stdout: PassThrough } {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    exitCode: 0,
    signalCode: null,
    pid: 123,
  }) as unknown as ChildProcess;
  mocks.spawnCli.mockReturnValue(child);
  return { child, stdout };
}

async function open(): Promise<Awaited<ReturnType<JsonRpcStdioClient['openSession']>>> {
  return new JsonRpcStdioClient({ warn: vi.fn() }).openSession({
    binaryPath: 'synthetic-rpc',
    args: [],
  });
}

describe('JSON-RPC stdio transport', () => {
  it('rejects all pending requests on real Writable EPIPE and clears their timers', async () => {
    const failure = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    let count = 0;
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(++count === 2 ? failure : undefined);
      },
    });
    fixture(stdin);
    const session = await open();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const first = session.request('first');
    const second = session.request('second');
    const results = Promise.allSettled([first, second]);
    const observed = new Promise<Error>((resolve) => stdin.once('error', resolve));
    await expect(observed).resolves.toBe(failure);
    expect(await results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    for (const result of timers.mock.results) expect(clear).toHaveBeenCalledWith(result.value);
    await expect(session.request('future')).rejects.toBe(failure);
    await expect(session.notify('future')).rejects.toBe(failure);
    await session.close();
    expect(() => stdin.emit('error', failure)).not.toThrow();
  });

  it('settles a pending notification and queued request when a notification write fails', async () => {
    const failure = new Error('broken notification pipe');
    let failWrite!: (error: Error) => void;
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        failWrite = callback;
      },
    });
    fixture(stdin);
    const session = await open();
    const notification = session.notify('changed');
    const request = session.request('queued');
    const settled = Promise.allSettled([notification, request]);
    failWrite(failure);
    expect(await settled).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    await expect(session.notify('later')).rejects.toBe(failure);
    await session.close();
  });

  it('clears request timers on synchronous write exceptions without poisoning serialization failures', async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    fixture(stdin);
    const session = await open();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(session.request('invalid', circular)).rejects.toBeInstanceOf(TypeError);
    await expect(session.notify('healthy')).resolves.toBeUndefined();
    const failure = new Error('sync write failed');
    vi.spyOn(stdin, 'write').mockImplementation(() => {
      throw failure;
    });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await expect(session.request('sync')).rejects.toBe(failure);
    expect(clear).toHaveBeenCalledWith(timers.mock.results[0].value);
    await expect(session.notify('later')).rejects.toBe(failure);
    await session.close();
  });

  it('preserves healthy request/notification traffic and rejects calls after close', async () => {
    const writes: string[] = [];
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      },
    });
    const { stdout } = fixture(stdin);
    const session = await open();
    const notifications: unknown[] = [];
    session.onNotification((method, params) => notifications.push({ method, params }));
    const response = session.request('read', { value: 1 });
    const id = JSON.parse(writes[0]).id as number;
    stdout.write(`${JSON.stringify({ id, result: { ok: true } })}\n`);
    await expect(response).resolves.toEqual({ ok: true });
    await session.notify('ready', { done: true });
    expect(JSON.parse(writes[1])).toEqual({
      jsonrpc: '2.0',
      method: 'ready',
      params: { done: true },
    });
    stdout.write(`${JSON.stringify({ method: 'changed', params: 42 })}\n`);
    expect(notifications).toEqual([{ method: 'changed', params: 42 }]);
    await session.close();
    await expect(session.request('closed')).rejects.toThrow('session closed');
    await expect(session.notify('closed')).rejects.toThrow('session closed');
    expect(() => stdin.emit('error', new Error('late close error'))).not.toThrow();
  });
});
