import {
  OPENCODE_RUNTIME_GET_STATUS,
  OPENCODE_RUNTIME_INSTALL,
} from '@preload/constants/ipcChannels';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initializeOpenCodeRuntimeHandlers,
  registerOpenCodeRuntimeHandlers,
} from './openCodeRuntime';

import type { OpenCodeRuntimeInstallerService } from '@main/services';
import type { OpenCodeRuntimeStatus } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const selected = vi.hoisted(() => ({
  native: undefined as
    | { readOpenCodeRuntimeStatus?(): Promise<OpenCodeRuntimeStatus | null> }
    | undefined,
  current: (() => true) as (() => boolean) | null,
}));
vi.mock('./agentBackend', () => ({
  getDesktopProviderStatusPort: () => selected.native,
  captureDesktopStatusRequest: () => selected.current,
}));
afterEach(() => {
  selected.native = undefined;
  selected.current = () => true;
  vi.restoreAllMocks();
});

function statusFixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  const legacy: OpenCodeRuntimeStatus = {
    installed: false,
    source: 'path',
    state: 'failed',
    version: '2.777.777 (TEST sentinel)',
  };
  const getStatus = vi.fn(async () => legacy);
  initializeOpenCodeRuntimeHandlers({ getStatus } as unknown as OpenCodeRuntimeInstallerService);
  registerOpenCodeRuntimeHandlers({
    handle: (name: string, handler: (event: IpcMainInvokeEvent) => unknown) =>
      handlers.set(name, handler),
  } as unknown as IpcMain);
  return {
    getStatus,
    legacy,
    invoke: () => handlers.get(OPENCODE_RUNTIME_GET_STATUS)!({} as IpcMainInvokeEvent),
  };
}

const ready: OpenCodeRuntimeStatus = {
  installed: true,
  source: 'captured-host',
  state: 'ready',
  version: '2.1.4',
  v2Support: 'ready',
};

it('selected Host V2 status cannot be replaced by a global CLI sentinel', async () => {
  const f = statusFixture();
  const readOpenCodeRuntimeStatus = vi.fn(async () => ready);
  selected.native = { readOpenCodeRuntimeStatus };
  await expect(f.invoke()).resolves.toEqual({ success: true, data: ready });
  expect(readOpenCodeRuntimeStatus).toHaveBeenCalledOnce();
  expect(f.getStatus).not.toHaveBeenCalled();
});

it('unselected Host and explicit native V1 preserve the existing installer status source', async () => {
  const f = statusFixture();
  await expect(f.invoke()).resolves.toEqual({ success: true, data: f.legacy });
  selected.native = { readOpenCodeRuntimeStatus: async () => null };
  await expect(f.invoke()).resolves.toEqual({ success: true, data: f.legacy });
  expect(f.getStatus).toHaveBeenCalledTimes(2);
});

it('failed or absent native runtime evidence never falls back to a global CLI', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = statusFixture();
  selected.native = {};
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  selected.native = {
    readOpenCodeRuntimeStatus: async () => {
      throw new Error('Native runtime identity is unavailable');
    },
  };
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(f.getStatus).not.toHaveBeenCalled();
});

it('native runtime status requires the original sender and rejects a changed context after the read', async () => {
  const f = statusFixture();
  const readOpenCodeRuntimeStatus = vi.fn(async () => ready);
  selected.native = { readOpenCodeRuntimeStatus };
  selected.current = null;
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(readOpenCodeRuntimeStatus).not.toHaveBeenCalled();
  let current = true;
  selected.current = () => current;
  readOpenCodeRuntimeStatus.mockImplementationOnce(async () => {
    current = false;
    return ready;
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(f.getStatus).not.toHaveBeenCalled();
});

it('the V1 installer response is also discarded if the captured context changes while it is read', async () => {
  const f = statusFixture();
  let current = true;
  selected.current = () => current;
  selected.native = { readOpenCodeRuntimeStatus: async () => null };
  f.getStatus.mockImplementationOnce(async () => {
    current = false;
    return f.legacy;
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
});

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
