import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TEAM_GET_DATA,
  TEAM_GET_MEMBER_ACTIVITY_META,
  TEAM_GET_MESSAGES_PAGE,
} from '../../../src/features/team-view-read-model/contracts';
import {
  registerTeamViewReadModelIpc,
  removeTeamViewReadModelIpc,
} from '../../../src/features/team-view-read-model/main';

import type { TeamViewReadModelFeature } from '../../../src/features/team-view-read-model/main';

describe('team view read-model IPC boundary', () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const dependencies = {
    getTeamView: { execute: vi.fn() },
    getMessagesPage: { execute: vi.fn() },
    getMemberActivityMeta: { execute: vi.fn() },
    logger: { error: vi.fn() },
  } as unknown as TeamViewReadModelFeature;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    dependencies.getTeamView.execute = vi.fn().mockResolvedValue({
      kind: 'success',
      data: { teamName: 'team-one' },
    });
    dependencies.getMessagesPage.execute = vi.fn().mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });
    dependencies.getMemberActivityMeta.execute = vi.fn().mockResolvedValue({
      teamName: 'team-one',
      computedAt: '2026-07-23T00:00:00.000Z',
      members: {},
      feedRevision: 'rev-1',
    });
    registerTeamViewReadModelIpc(ipcMain as never, dependencies);
  });

  it('owns exactly three channels and removes them symmetrically', () => {
    const channels = [TEAM_GET_DATA, TEAM_GET_MESSAGES_PAGE, TEAM_GET_MEMBER_ACTIVITY_META];
    expect([...handlers.keys()]).toEqual(channels);

    removeTeamViewReadModelIpc(ipcMain as never);

    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(channels);
    expect(handlers.size).toBe(0);
  });

  it('validates getData and preserves the normalized option call shape', async () => {
    const handler = handlers.get(TEAM_GET_DATA)!;

    await handler({} as never, 'team-one', { includeMemberBranches: true });
    await handler({} as never, 'team-one', { includeMemberBranches: false });
    const invalid = await handler({} as never, '../bad');

    expect(dependencies.getTeamView.execute).toHaveBeenNthCalledWith(1, 'team-one', undefined);
    expect(dependencies.getTeamView.execute).toHaveBeenNthCalledWith(2, 'team-one', {
      includeMemberBranches: false,
    });
    expect(invalid).toEqual(expect.objectContaining({ success: false }));
    expect(dependencies.getTeamView.execute).toHaveBeenCalledTimes(2);
  });

  it('normalizes page defaults, cursor values, and limits before dispatch', async () => {
    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;

    await handler({} as never, 'team-one', undefined);
    await handler({} as never, 'team-one', { cursor: null, limit: 999 });
    await handler({} as never, 'team-one', { cursor: 42, limit: 0 });

    expect(dependencies.getMessagesPage.execute).toHaveBeenNthCalledWith(1, {
      teamName: 'team-one',
      cursor: undefined,
      limit: 50,
    });
    expect(dependencies.getMessagesPage.execute).toHaveBeenNthCalledWith(2, {
      teamName: 'team-one',
      cursor: null,
      limit: 200,
    });
    expect(dependencies.getMessagesPage.execute).toHaveBeenNthCalledWith(3, {
      teamName: 'team-one',
      cursor: undefined,
      limit: 1,
    });
  });

  it('contains rejected read ports in the legacy IPC result envelope', async () => {
    dependencies.getMemberActivityMeta.execute = vi
      .fn()
      .mockRejectedValue(new Error('read failed'));

    const result = await handlers.get(TEAM_GET_MEMBER_ACTIVITY_META)!({} as never, 'team-one');

    expect(result).toEqual({ success: false, error: 'read failed' });
    expect(dependencies.logger.error).toHaveBeenCalledWith(
      '[teams:getMemberActivityMeta] read failed'
    );
  });
});
