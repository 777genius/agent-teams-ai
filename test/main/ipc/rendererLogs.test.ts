import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import {
  registerRendererLogHandlers,
  removeRendererLogHandlers,
} from '../../../src/main/ipc/rendererLogs';

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
});
