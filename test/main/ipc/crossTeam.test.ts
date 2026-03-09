import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@preload/constants/ipcChannels', () => ({
  CROSS_TEAM_SEND: 'cross-team:send',
  CROSS_TEAM_LIST_TARGETS: 'cross-team:listTargets',
  CROSS_TEAM_GET_OUTBOX: 'cross-team:getOutbox',
}));

import {
  initializeCrossTeamHandlers,
  registerCrossTeamHandlers,
  removeCrossTeamHandlers,
} from '@main/ipc/crossTeam';

function createMockIpcMain() {
  return {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  };
}

function createMockService() {
  return {
    send: vi.fn(),
    listAvailableTargets: vi.fn(),
    getOutbox: vi.fn(),
  };
}

describe('crossTeam IPC handlers', () => {
  let mockIpc: ReturnType<typeof createMockIpcMain>;
  let mockService: ReturnType<typeof createMockService>;

  beforeEach(() => {
    mockIpc = createMockIpcMain();
    mockService = createMockService();
    // Re-initialize with fresh service for each test
    initializeCrossTeamHandlers(mockService as never);
  });

  it('registers 3 IPC handlers', () => {
    registerCrossTeamHandlers(mockIpc as never);

    expect(mockIpc.handle).toHaveBeenCalledTimes(3);
    expect(mockIpc.handle).toHaveBeenCalledWith('cross-team:send', expect.any(Function));
    expect(mockIpc.handle).toHaveBeenCalledWith('cross-team:listTargets', expect.any(Function));
    expect(mockIpc.handle).toHaveBeenCalledWith('cross-team:getOutbox', expect.any(Function));
  });

  it('removes all 3 handlers', () => {
    removeCrossTeamHandlers(mockIpc as never);

    expect(mockIpc.removeHandler).toHaveBeenCalledTimes(3);
    expect(mockIpc.removeHandler).toHaveBeenCalledWith('cross-team:send');
    expect(mockIpc.removeHandler).toHaveBeenCalledWith('cross-team:listTargets');
    expect(mockIpc.removeHandler).toHaveBeenCalledWith('cross-team:getOutbox');
  });

  it('send handler returns success on valid request', async () => {
    mockService.send.mockResolvedValue({ messageId: 'msg-1', deliveredToInbox: true });

    registerCrossTeamHandlers(mockIpc as never);
    const handler = mockIpc.handle.mock.calls.find((c) => c[0] === 'cross-team:send')![1];

    const result = await handler({} as never, {
      fromTeam: 'team-a',
      fromMember: 'lead',
      toTeam: 'team-b',
      text: 'Hello',
    });

    expect(result).toEqual({
      success: true,
      data: { messageId: 'msg-1', deliveredToInbox: true },
    });
    expect(mockService.send).toHaveBeenCalledWith({
      fromTeam: 'team-a',
      fromMember: 'lead',
      toTeam: 'team-b',
      text: 'Hello',
      summary: undefined,
      chainDepth: undefined,
    });
  });

  it('send handler returns error on service throw', async () => {
    mockService.send.mockRejectedValue(new Error('Target team not found'));

    registerCrossTeamHandlers(mockIpc as never);
    const handler = mockIpc.handle.mock.calls.find((c) => c[0] === 'cross-team:send')![1];

    const result = await handler({} as never, {
      fromTeam: 'team-a',
      fromMember: 'lead',
      toTeam: 'nonexistent',
      text: 'Hello',
    });

    expect(result).toEqual({ success: false, error: 'Target team not found' });
  });

  it('send handler rejects invalid request', async () => {
    registerCrossTeamHandlers(mockIpc as never);
    const handler = mockIpc.handle.mock.calls.find((c) => c[0] === 'cross-team:send')![1];

    const result = await handler({} as never, null);

    expect(result).toEqual({ success: false, error: 'Invalid request' });
  });

  it('listTargets handler calls service', async () => {
    mockService.listAvailableTargets.mockResolvedValue([
      { teamName: 'team-b', displayName: 'Team B' },
    ]);

    registerCrossTeamHandlers(mockIpc as never);
    const handler = mockIpc.handle.mock.calls.find(
      (c) => c[0] === 'cross-team:listTargets'
    )![1];

    const result = await handler({} as never, 'team-a');

    expect(result).toEqual({
      success: true,
      data: [{ teamName: 'team-b', displayName: 'Team B' }],
    });
    expect(mockService.listAvailableTargets).toHaveBeenCalledWith('team-a');
  });

  it('getOutbox handler calls service', async () => {
    mockService.getOutbox.mockResolvedValue([]);

    registerCrossTeamHandlers(mockIpc as never);
    const handler = mockIpc.handle.mock.calls.find(
      (c) => c[0] === 'cross-team:getOutbox'
    )![1];

    const result = await handler({} as never, 'team-a');

    expect(result).toEqual({ success: true, data: [] });
    expect(mockService.getOutbox).toHaveBeenCalledWith('team-a');
  });

  it('getOutbox handler rejects empty teamName', async () => {
    registerCrossTeamHandlers(mockIpc as never);
    const handler = mockIpc.handle.mock.calls.find(
      (c) => c[0] === 'cross-team:getOutbox'
    )![1];

    const result = await handler({} as never, '');

    expect(result).toEqual({ success: false, error: 'teamName is required' });
  });
});
