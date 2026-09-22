import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerRendererLogHandlers,
  removeRendererLogHandlers,
} from '../../../src/main/ipc/rendererLogs';
import { addLogSink, type LogSinkEntry } from '../../../src/shared/utils/logger';

class FakeSender extends EventEmitter {
  readonly id = 42;
}

describe('renderer log IPC lifecycle', () => {
  const ipcMain = new EventEmitter();

  afterEach(() => {
    removeRendererLogHandlers(ipcMain as never);
  });

  it('registers one destroy cleanup across repeated renderer boots', () => {
    const sender = new FakeSender();
    registerRendererLogHandlers(ipcMain as never);

    for (let index = 0; index < 25; index += 1) {
      ipcMain.emit('renderer:boot', { sender });
    }

    expect(sender.listenerCount('destroyed')).toBe(1);
  });

  it('routes validated renderer warnings and errors through the durable logger', () => {
    const sender = new FakeSender();
    const entries: LogSinkEntry[] = [];
    const removeSink = addLogSink((entry) => entries.push(entry));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerRendererLogHandlers(ipcMain as never);

    try {
      ipcMain.emit(
        'renderer:log',
        { sender },
        {
          level: 'warn',
          message: '[Runtime:connection] reconnect delayed',
        }
      );
      ipcMain.emit(
        'renderer:log',
        { sender },
        {
          level: 'error',
          message: '[Runtime:connection] WS connection timeout',
        }
      );
      ipcMain.emit('renderer:log', { sender }, { level: 'info', message: 'ignored' });
      ipcMain.emit('renderer:log', { sender }, { level: 'error', message: '   ' });

      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        level: 'warn',
        namespace: 'Renderer',
        args: ['[Runtime:connection] reconnect delayed'],
      });
      expect(entries[1]).toMatchObject({
        level: 'error',
        namespace: 'Renderer',
        args: ['[Runtime:connection] WS connection timeout'],
      });
    } finally {
      removeSink();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
