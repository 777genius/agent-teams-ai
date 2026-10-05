// @vitest-environment node
import { Console } from 'node:console';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installStandardOutputGuard } from '../../../src/main/utils/standardOutputGuard';
import { addLogSink, createLogger } from '../../../src/shared/utils/logger';

const pipeError = (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
const cleanups: (() => void)[] = [];
const guard = (stream: Writable): (() => void) => {
  const dispose = installStandardOutputGuard(stream);
  cleanups.push(dispose);
  return dispose;
};

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe('standard output guard', () => {
  it('handles a real asynchronous Writable EPIPE and completes discarded writes without backpressure', async () => {
    const failure = pipeError();
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(failure);
      },
    });
    guard(stream);
    const observed = new Promise<Error>((resolve) => stream.once('error', resolve));
    stream.write('first');
    await expect(observed).resolves.toBe(failure);
    const callback = vi.fn();
    expect(stream.write('discarded', callback)).toBe(true);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]).toEqual([]);
  });

  it('contains synchronous console EPIPE and keeps the other stream healthy', () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const writes = vi.spyOn(stdout, 'write').mockImplementation(() => {
      throw pipeError();
    });
    const errors = vi.spyOn(stderr, 'write');
    guard(stdout);
    guard(stderr);
    const output = new Console({ stdout, stderr, ignoreErrors: false });
    expect(() => {
      output.info('one');
      output.info('two');
      output.error('still visible');
    }).not.toThrow();
    expect(writes).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
  });

  it('preserves durable logger sinks and the existing console wrapper', () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    vi.spyOn(stream, 'write').mockImplementation(() => {
      throw pipeError();
    });
    guard(stream);
    const output = new Console({ stdout: stream, stderr: stream, ignoreErrors: false });
    const wrapper = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => output.error(...args));
    const sink = vi.fn();
    cleanups.push(addLogSink(sink));
    const logger = createLogger('StdioTest');
    logger.error('first');
    logger.error('second');
    expect(wrapper).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][0].args).toEqual(['second']);
    wrapper.mockClear();
  });

  it('propagates synchronous non-EPIPE errors and preserves asynchronous error observers', async () => {
    const failure = Object.assign(new Error('disk failed'), { code: 'EIO' });
    const sync = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    vi.spyOn(sync, 'write').mockImplementation(() => {
      throw failure;
    });
    guard(sync);
    expect(() => sync.write('data')).toThrow(failure);
    expect(() => sync.emit('error', failure)).toThrow(failure);
    const asyncStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(failure);
      },
    });
    guard(asyncStream);
    const observed = new Promise<Error>((resolve) => asyncStream.once('error', resolve));
    asyncStream.write('data');
    await expect(observed).resolves.toBe(failure);
  });

  it('preserves healthy encoding, callback and receiver and installs idempotently', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const original = stream.write;
    const dispose = guard(stream);
    expect(installStandardOutputGuard(stream)).toBe(dispose);
    await new Promise<void>((resolve, reject) =>
      stream.write('héllo', 'utf8', (error) => (error ? reject(error) : resolve()))
    );
    expect(chunks).toEqual(['héllo']);
    dispose();
    expect(stream.write).toBe(original);
    expect(stream.listenerCount('error')).toBe(0);
  });
});
