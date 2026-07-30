import { TEAM_PROCESS_ALIVE, TEAM_PROCESS_SEND } from '@features/team-message-delivery/contracts';
import {
  registerLegacyTeamProcessIpc,
  removeLegacyTeamProcessIpc,
} from '@main/ipc/teamLegacyAdapters';
import { describe, expect, it, vi } from 'vitest';

function createHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const adapters = {
    sendMessageToTeam: vi.fn(() => Promise.resolve()),
    isTeamAlive: vi.fn(() => false),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  registerLegacyTeamProcessIpc(ipcMain as never, adapters);
  return { adapters, handlers, ipcMain };
}

describe('legacy team process IPC', () => {
  it('owns and removes exactly the two shell process channels', () => {
    const { handlers, ipcMain } = createHarness();

    expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual([
      TEAM_PROCESS_SEND,
      TEAM_PROCESS_ALIVE,
    ]);
    expect([...handlers.keys()]).toEqual([TEAM_PROCESS_SEND, TEAM_PROCESS_ALIVE]);

    removeLegacyTeamProcessIpc(ipcMain as never);
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      TEAM_PROCESS_SEND,
      TEAM_PROCESS_ALIVE,
    ]);
    expect(handlers.size).toBe(0);
  });

  it('validates process sends and preserves message whitespace at the host boundary', async () => {
    const { adapters, handlers } = createHarness();
    const send = handlers.get(TEAM_PROCESS_SEND);
    if (!send) throw new Error('process send handler was not registered');

    await expect(send({}, 'demo-team', '   ')).resolves.toEqual({
      success: false,
      error: 'message must be a non-empty string',
    });
    const message = '  keep transport whitespace  ';
    await expect(send({}, '  demo-team  ', message)).resolves.toEqual({
      success: true,
      data: undefined,
    });
    expect(adapters.sendMessageToTeam).toHaveBeenCalledWith('demo-team', message);
  });

  it('returns a false process-alive value in the legacy success envelope', async () => {
    const { adapters, handlers } = createHarness();
    const alive = handlers.get(TEAM_PROCESS_ALIVE);
    if (!alive) throw new Error('process alive handler was not registered');

    await expect(alive({}, '  demo-team  ')).resolves.toEqual({
      success: true,
      data: false,
    });
    expect(adapters.isTeamAlive).toHaveBeenCalledWith('demo-team');
  });
});
