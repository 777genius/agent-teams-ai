import {
  TERMINAL_WORKSPACE_GET_BOOTSTRAP,
  TERMINAL_WORKSPACE_STOP_TEAM,
} from '@features/terminal-workspace/contracts';
import { createTerminalWorkspaceBridge } from '@features/terminal-workspace/preload';
import { describe, expect, it, vi } from 'vitest';

import type { IpcRenderer } from 'electron';

describe('terminal workspace preload bridge fixture-e2e', () => {
  it('invokes the bootstrap IPC channel with the full request payload', async () => {
    const bootstrap = {
      controlPlaneUrl: 'ws://fixture-control',
      defaultShell: '/bin/zsh',
      projectPath: '/tmp/terminal-fixture',
      runtimeSlug: 'terminal-fixture-runtime',
      sessionStreamUrl: 'ws://fixture-stream',
      teamName: 'terminal-fixture',
    };
    const invoke = vi.fn().mockResolvedValue(bootstrap);
    const bridge = createTerminalWorkspaceBridge({ invoke } as unknown as IpcRenderer);
    const request = {
      projectPath: '/tmp/terminal-fixture',
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    };

    await expect(bridge.getBootstrap(request)).resolves.toBe(bootstrap);
    expect(invoke).toHaveBeenCalledWith(TERMINAL_WORKSPACE_GET_BOOTSTRAP, request);
  });

  it('invokes the stop IPC channel with only the team name', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const bridge = createTerminalWorkspaceBridge({ invoke } as unknown as IpcRenderer);

    await expect(bridge.stopTeamRuntime('terminal-fixture')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(TERMINAL_WORKSPACE_STOP_TEAM, 'terminal-fixture');
  });
});
