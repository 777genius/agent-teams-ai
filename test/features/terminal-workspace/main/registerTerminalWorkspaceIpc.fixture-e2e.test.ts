import {
  TERMINAL_WORKSPACE_GET_BOOTSTRAP,
  TERMINAL_WORKSPACE_STOP_TEAM,
} from '@features/terminal-workspace/contracts';
import {
  registerTerminalWorkspaceIpc,
  removeTerminalWorkspaceIpc,
} from '@features/terminal-workspace/main/adapters/input/registerTerminalWorkspaceIpc';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalWorkspaceFeatureFacade } from '@features/terminal-workspace/main/composition/createTerminalWorkspaceFeature';
import type { IpcMainInvokeEvent } from 'electron';

describe('terminal workspace IPC fixture-e2e', () => {
  it('normalizes bootstrap requests before reaching the runtime facade', async () => {
    const { handlers, ipcMain } = createFakeIpcMain();
    const getBootstrap = vi.fn().mockResolvedValue(createBootstrap());
    const feature = createFeatureFacade({ getBootstrap });

    registerTerminalWorkspaceIpc(ipcMain as never, feature);

    const result = await handlers.get(TERMINAL_WORKSPACE_GET_BOOTSTRAP)?.(
      {} as IpcMainInvokeEvent,
      {
        projectPath: ' /tmp/terminal-fixture ',
        teamDisplayName: ' Terminal Fixture ',
        teamName: ' terminal-fixture ',
      }
    );

    expect(result).toEqual(createBootstrap());
    expect(getBootstrap).toHaveBeenCalledWith({
      projectPath: '/tmp/terminal-fixture',
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });
  });

  it('rejects malformed bootstrap payloads without starting the runtime facade', async () => {
    const { handlers, ipcMain } = createFakeIpcMain();
    const getBootstrap = vi.fn().mockResolvedValue(createBootstrap());
    const feature = createFeatureFacade({ getBootstrap });

    registerTerminalWorkspaceIpc(ipcMain as never, feature);
    const handler = handlers.get(TERMINAL_WORKSPACE_GET_BOOTSTRAP);

    await expect(handler?.({} as IpcMainInvokeEvent, null)).rejects.toThrow(
      'request must be an object'
    );
    await expect(
      handler?.({} as IpcMainInvokeEvent, {
        projectPath: '/tmp/project',
        teamName: '../real-project',
      })
    ).rejects.toThrow('teamName contains invalid characters');
    await expect(
      handler?.({} as IpcMainInvokeEvent, {
        projectPath: 42,
        teamName: 'terminal-fixture',
      })
    ).rejects.toThrow('projectPath must be a string');
    await expect(
      handler?.({} as IpcMainInvokeEvent, {
        projectPath: '/tmp/project',
        teamDisplayName: 'x'.repeat(161),
        teamName: 'terminal-fixture',
      })
    ).rejects.toThrow('teamDisplayName exceeds max length (160)');

    expect(getBootstrap).not.toHaveBeenCalled();
  });

  it('trims stop requests and treats unknown stopped runtimes as a no-op facade call', async () => {
    const { handlers, ipcMain } = createFakeIpcMain();
    const stopTeamRuntime = vi.fn().mockResolvedValue(undefined);
    const feature = createFeatureFacade({ stopTeamRuntime });

    registerTerminalWorkspaceIpc(ipcMain as never, feature);
    const result = await handlers.get(TERMINAL_WORKSPACE_STOP_TEAM)?.(
      {} as IpcMainInvokeEvent,
      ' terminal-fixture '
    );

    expect(result).toBeUndefined();
    expect(stopTeamRuntime).toHaveBeenCalledWith('terminal-fixture');
  });

  it('rejects unsafe stop team names before reaching the runtime facade', async () => {
    const { handlers, ipcMain } = createFakeIpcMain();
    const stopTeamRuntime = vi.fn().mockResolvedValue(undefined);
    const feature = createFeatureFacade({ stopTeamRuntime });

    registerTerminalWorkspaceIpc(ipcMain as never, feature);

    await expect(
      handlers.get(TERMINAL_WORKSPACE_STOP_TEAM)?.({} as IpcMainInvokeEvent, 'Team With Spaces')
    ).rejects.toThrow('teamName contains invalid characters');
    await expect(
      handlers.get(TERMINAL_WORKSPACE_STOP_TEAM)?.({} as IpcMainInvokeEvent, 123)
    ).rejects.toThrow('teamName must be a string');
    expect(stopTeamRuntime).not.toHaveBeenCalled();
  });

  it('removes both terminal workspace IPC handlers during disposal', () => {
    const { handlers, ipcMain } = createFakeIpcMain();
    const feature = createFeatureFacade();

    registerTerminalWorkspaceIpc(ipcMain as never, feature);
    expect(handlers.has(TERMINAL_WORKSPACE_GET_BOOTSTRAP)).toBe(true);
    expect(handlers.has(TERMINAL_WORKSPACE_STOP_TEAM)).toBe(true);

    removeTerminalWorkspaceIpc(ipcMain as never);

    expect(handlers.has(TERMINAL_WORKSPACE_GET_BOOTSTRAP)).toBe(false);
    expect(handlers.has(TERMINAL_WORKSPACE_STOP_TEAM)).toBe(false);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(TERMINAL_WORKSPACE_GET_BOOTSTRAP);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(TERMINAL_WORKSPACE_STOP_TEAM);
  });
});

function createFakeIpcMain(): {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  ipcMain: {
    handle: ReturnType<typeof vi.fn>;
    removeHandler: ReturnType<typeof vi.fn>;
  };
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
}

function createFeatureFacade({
  getBootstrap = vi.fn().mockResolvedValue(createBootstrap()),
  stopTeamRuntime = vi.fn().mockResolvedValue(undefined),
}: {
  getBootstrap?: TerminalWorkspaceFeatureFacade['getBootstrap'];
  stopTeamRuntime?: TerminalWorkspaceFeatureFacade['stopTeamRuntime'];
} = {}): TerminalWorkspaceFeatureFacade {
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
    getBootstrap,
    stopTeamRuntime,
  };
}

function createBootstrap() {
  return {
    controlPlaneUrl: 'ws://fixture-control',
    defaultShell: '/bin/zsh',
    projectPath: '/tmp/terminal-fixture',
    runtimeSlug: 'terminal-fixture-runtime',
    sessionStreamUrl: 'ws://fixture-stream',
    teamName: 'terminal-fixture',
  };
}
