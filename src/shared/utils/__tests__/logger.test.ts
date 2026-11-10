import { describe, expect, it, vi } from 'vitest';

import { addLogSink, createLogger, type LogSinkEntry } from '../logger';

describe('shared logger sinks', () => {
  it('emits warning and error entries without persisting info noise', () => {
    const entries: LogSinkEntry[] = [];
    const removeSink = addLogSink((entry) => entries.push(entry));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const logger = createLogger('TestLogger');
      logger.info('not durable');
      logger.warn('slow connection', { category: 'timeout' });
      logger.error('connection failed', new Error('WS connection timeout'));

      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        level: 'warn',
        namespace: 'TestLogger',
        args: ['slow connection', { category: 'timeout' }],
      });
      expect(entries[1]).toMatchObject({
        level: 'error',
        namespace: 'TestLogger',
      });
      expect(entries[1]?.args[1]).toBeInstanceOf(Error);
    } finally {
      removeSink();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('persists a diagnostic entry without writing to the console', () => {
    const entries: LogSinkEntry[] = [];
    const removeSink = addLogSink((entry) => entries.push(entry));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      createLogger('TestLogger').diagnostic('opencode_launch_prompt_queued lead=lead chars=12');

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: 'diagnostic',
        namespace: 'TestLogger',
        args: ['opencode_launch_prompt_queued lead=lead chars=12'],
      });
      // The whole point of the level: durable evidence that costs nobody a
      // console line, so the suite-wide "no unexpected console output"
      // invariant needs no per-event allowlist.
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(log).toHaveBeenCalledTimes(0);
      expect(debug).toHaveBeenCalledTimes(0);
    } finally {
      removeSink();
      debug.mockRestore();
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('isolates application behavior from a failing sink', () => {
    const removeSink = addLogSink(() => {
      throw new Error('disk unavailable');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() => createLogger('TestLogger').error('still safe')).not.toThrow();
    } finally {
      removeSink();
      error.mockRestore();
    }
  });
});
