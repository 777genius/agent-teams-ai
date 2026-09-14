import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';

import {
  type HostedCoordinationEventStreamWriteDiagnostic,
  HostedCoordinationEventStreamWriter,
  hostedCoordinationEventStreamWriteSucceeded,
} from '@features/coordination-events/main/adapters/input/http/hostedCoordinationEventStreamWriter';
import { describe, expect, it, vi } from 'vitest';

class ManualScheduler {
  readonly tasks: Array<{ active: boolean; callback: () => void }> = [];

  schedule(_delayMs: number, callback: () => void): () => void {
    const task = { active: true, callback };
    this.tasks.push(task);
    return () => {
      task.active = false;
    };
  }

  fire(): void {
    const task = this.tasks.find(({ active }) => active);
    if (task === undefined) throw new Error('no_active_writer_deadline');
    task.callback();
  }
}

class FakeRawResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writeResult = false;
  writeError: Error | null = null;
  destroyCalls = 0;

  write(_frame: string): boolean {
    if (this.writeError !== null) throw this.writeError;
    return this.writeResult;
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
  }
}

function setup(input: { maxFrameBytes?: number; observerThrows?: boolean } = {}) {
  const scheduler = new ManualScheduler();
  const diagnostics: HostedCoordinationEventStreamWriteDiagnostic[] = [];
  const observer = vi.fn((diagnostic: HostedCoordinationEventStreamWriteDiagnostic) => {
    diagnostics.push(diagnostic);
    if (input.observerThrows === true) throw new Error('diagnostic_sink_failed');
  });
  const writer = new HostedCoordinationEventStreamWriter({
    maxFrameBytes: input.maxFrameBytes ?? 1_024,
    observer,
    scheduler,
    slowConsumerTimeoutMs: 5_000,
  });
  const raw = new FakeRawResponse();
  const abort = new AbortController();
  const write = (frame = 'frame') =>
    writer.write({ frame, raw, signal: abort.signal, streamId: 'stream-test' });
  return { abort, diagnostics, observer, raw, scheduler, write };
}

function expectClean(input: ReturnType<typeof setup>): void {
  expect(input.scheduler.tasks.every(({ active }) => !active)).toBe(true);
  expect(input.raw.listenerCount('drain')).toBe(0);
  expect(input.raw.listenerCount('close')).toBe(0);
  expect(input.raw.listenerCount('error')).toBe(0);
}

describe('HostedCoordinationEventStreamWriter', () => {
  it('distinguishes an immediate write and a drain before the deadline', async () => {
    const immediate = setup();
    immediate.raw.writeResult = true;
    await expect(immediate.write()).resolves.toBe('immediate');
    expect(hostedCoordinationEventStreamWriteSucceeded('immediate')).toBe(true);
    expect(immediate.scheduler.tasks).toEqual([]);

    const drained = setup();
    const result = drained.write();
    drained.raw.emit('drain');
    await expect(result).resolves.toBe('drained');
    expect(hostedCoordinationEventStreamWriteSucceeded('drained')).toBe(true);
    expectClean(drained);
  });

  it('hard-destroys exactly once on timeout and ignores a late drain', async () => {
    const input = setup({ observerThrows: true });
    const result = input.write();
    input.scheduler.fire();
    input.scheduler.tasks[0]?.callback();
    input.raw.emit('drain');

    await expect(result).resolves.toBe('timed_out');
    expect(input.raw.destroyCalls).toBe(1);
    expect(input.observer).toHaveBeenCalledWith({
      kind: 'backpressure_entered',
      streamId: 'stream-test',
      timeoutMs: 5_000,
    });
    expect(input.observer).toHaveBeenCalledWith({
      kind: 'terminal',
      streamId: 'stream-test',
      timeoutMs: 5_000,
      disposition: 'timed_out',
      transportTermination: 'hard_destroyed',
    });
    expectClean(input);
  });

  it.each([
    ['abort', 'aborted'],
    ['close', 'closed'],
    ['error', 'write_failed'],
  ] as const)('settles and cleans up on %s', async (event, disposition) => {
    const input = setup();
    const result = input.write();
    if (event === 'abort') input.abort.abort();
    else input.raw.emit(event);
    await expect(result).resolves.toBe(disposition);
    expect(input.raw.destroyCalls).toBe(0);
    expectClean(input);
  });

  it('distinguishes pre-abort, pre-closed, write exception, and oversize', async () => {
    const aborted = setup();
    aborted.abort.abort();
    await expect(aborted.write()).resolves.toBe('aborted');

    const closed = setup();
    closed.raw.destroyed = true;
    await expect(closed.write()).resolves.toBe('closed');

    const failed = setup();
    failed.raw.writeError = new Error('write failed');
    await expect(failed.write()).resolves.toBe('write_failed');

    const oversized = setup({ maxFrameBytes: 4 });
    await expect(oversized.write('five!')).resolves.toBe('oversized');
    expect(oversized.raw.destroyCalls).toBe(0);
    expect(hostedCoordinationEventStreamWriteSucceeded('oversized')).toBe(false);
  });

  it('physically terminates a loopback HTTP transport whose client withholds reads', async () => {
    const diagnostics: HostedCoordinationEventStreamWriteDiagnostic[] = [];
    let disposition: string | null = null;
    let markTransportClosed = (): void => undefined;
    let markWriteCompleted = (): void => undefined;
    const transportClosed = new Promise<void>((resolve) => {
      markTransportClosed = resolve;
    });
    const writeCompleted = new Promise<void>((resolve) => {
      markWriteCompleted = resolve;
    });
    const server = createServer(async (_request, response) => {
      response.once('close', markTransportClosed);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      const writer = new HostedCoordinationEventStreamWriter({
        maxFrameBytes: 16 * 1_024 * 1_024,
        observer: (diagnostic) => diagnostics.push(diagnostic),
        scheduler: {
          schedule: (delayMs, callback) => {
            const timer = setTimeout(callback, delayMs);
            return () => clearTimeout(timer);
          },
        },
        slowConsumerTimeoutMs: 25,
      });
      disposition = await writer.write({
        frame: `data: ${'x'.repeat(8 * 1_024 * 1_024)}\n\n`,
        raw: response,
        signal: new AbortController().signal,
        streamId: 'loopback-stream',
      });
      markWriteCompleted();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('loopback_address_missing');
    const socket = connect({ host: '127.0.0.1', port: address.port });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    try {
      await Promise.race([
        Promise.all([transportClosed, writeCompleted]),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('loopback_transport_not_terminated')), 2_000)
        ),
      ]);
      expect(disposition).toBe('timed_out');
      expect(diagnostics).toContainEqual({
        kind: 'terminal',
        streamId: 'loopback-stream',
        timeoutMs: 25,
        disposition: 'timed_out',
        transportTermination: 'hard_destroyed',
      });
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
