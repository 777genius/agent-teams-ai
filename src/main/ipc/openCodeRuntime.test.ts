import { OPENCODE_RUNTIME_INSTALL } from '@preload/constants/ipcChannels';
import { describe, expect, it, vi } from 'vitest';

import {
  initializeOpenCodeRuntimeHandlers,
  registerOpenCodeRuntimeHandlers,
} from './openCodeRuntime';

import type { OpenCodeRuntimeInstallerService } from '@main/services';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

describe('OpenCode runtime install IPC', () => {
  it('forwards the generation and rejects unsupported caller fields before installation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = new Map<string, (event: IpcMainInvokeEvent, options?: unknown) => unknown>();
    const install = vi
      .fn()
      .mockResolvedValue({ installed: false, source: 'missing', state: 'idle' });
    initializeOpenCodeRuntimeHandlers({ install } as unknown as OpenCodeRuntimeInstallerService);
    registerOpenCodeRuntimeHandlers({
      handle: (name: string, handler: (event: IpcMainInvokeEvent, options?: unknown) => unknown) =>
        handlers.set(name, handler),
    } as unknown as IpcMain);
    const invoke = handlers.get(OPENCODE_RUNTIME_INSTALL)!;
    await expect(invoke({} as IpcMainInvokeEvent, { generation: 'v2' })).resolves.toMatchObject({
      success: true,
    });
    expect(install).toHaveBeenCalledWith({ generation: 'v2' });
    await expect(
      invoke({} as IpcMainInvokeEvent, { generation: 'nightly' })
    ).resolves.toMatchObject({ success: false });
    await expect(invoke({} as IpcMainInvokeEvent, { binaryPath: '/other' })).resolves.toMatchObject(
      { success: false }
    );
    expect(install).toHaveBeenCalledTimes(1);
  });
});
