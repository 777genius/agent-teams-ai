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
