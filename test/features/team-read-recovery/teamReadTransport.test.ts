import { createTeamReadRecoveryBridge } from '@features/team-read-recovery/preload';
import {
  readTeamData,
  readTeamMemberActivity,
  readTeamMessagesPage,
  readTeamTaskLogs,
} from '@features/team-read-recovery/renderer';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';

describe('team read recovery transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  function install(result: unknown) {
    const invoke = vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(result)) as unknown));
    const legacy = vi.fn(() => Promise.reject(new Error('legacy read must not run')));
    vi.stubGlobal('window', {
      electronAPI: {
        teams: {
          readRecovery: createTeamReadRecoveryBridge(invoke),
          getData: legacy,
          getMessagesPage: legacy,
          getMemberActivityMeta: legacy,
          getLogsForTask: legacy,
        },
      } as unknown as ElectronAPI,
    });
    return { invoke, legacy };
  }

  it('retains plain recovering metadata and human message through unwrapIpc', async () => {
    const failure = { kind: 'recovering', retryAt: 30001, recoveryId: 'TEST-recovery-1' };
    const { invoke, legacy } = install({
      success: false,
      error: 'TEST-worker-unavailable',
      failure,
    });
    await expect(unwrapIpc('team:getData', () => readTeamData('TEST-team'))).rejects.toMatchObject({
      name: 'IpcError',
      operation: 'team:getData',
      message: 'TEST-worker-unavailable',
      failure,
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('team:getData', 'TEST-team');
    expect(legacy).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls[0]?.join(' ')).toContain('TEST-worker-unavailable');
    vi.mocked(console.error).mockClear();
  });

  it.each([
    { kind: 'recovering', retryAt: Infinity, recoveryId: 'TEST-1' },
    { kind: 'recovering', retryAt: -1, recoveryId: 'TEST-1' },
    { kind: 'recovering', retryAt: 30001, recoveryId: '' },
    { kind: 'recovering', retryAt: 30001, recoveryId: '../secret' },
    { kind: 'unsupported', retryAt: 30001, recoveryId: 'TEST-1' },
    { kind: 'recovering', retryAt: '30001', recoveryId: 'TEST-1' },
  ])('rejects malformed metadata without recovery eligibility: %j', async (failure) => {
    install({ success: false, error: 'Team data worker recovering after fatal failure', failure });
    await expect(readTeamData('TEST-team')).rejects.toMatchObject({
      message: 'Team data worker recovering after fatal failure',
      failure: undefined,
    });
  });

  it.each(['busy', 'fatal', 'operation', 'disposed'] as const)(
    'preserves %s without inventing a cooldown',
    async (kind) => {
      install({ success: false, error: 'TEST-failure', failure: { kind } });
      await expect(readTeamMessagesPage('TEST-team')).rejects.toMatchObject({ failure: { kind } });
    }
  );

  it('uses all four existing channels, preserves options and returns data', async () => {
    const data = { TEST: 'payload' };
    const { invoke } = install({ success: true, data });
    const thin = { includeMemberBranches: false };
    const page = { cursor: 'TEST-cursor', limit: 17 };
    const logs = { status: 'in_progress', since: 'TEST-since' };
    expect(await readTeamData('TEST-team', thin)).toEqual(data);
    expect(await readTeamMessagesPage('TEST-team', page)).toEqual(data);
    expect(await readTeamMemberActivity('TEST-team')).toEqual(data);
    expect(await readTeamTaskLogs('TEST-team', 'TEST-task', logs)).toEqual(data);
    expect(invoke.mock.calls).toEqual([
      ['team:getData', 'TEST-team', thin],
      ['team:getMessagesPage', 'TEST-team', page],
      ['team:getMemberActivityMeta', 'TEST-team'],
      ['team:getLogsForTask', 'TEST-team', 'TEST-task', logs],
    ]);
  });

  it.each([
    {
      method: 'getData',
      channel: 'team:getData',
      tail: [{ includeMemberBranches: false }],
      read: (team: string) => readTeamData(team, { includeMemberBranches: false }),
    },
    {
      method: 'getMessagesPage',
      channel: 'team:getMessagesPage',
      tail: [{ limit: 17 }],
      read: (team: string) => readTeamMessagesPage(team, { limit: 17 }),
    },
    {
      method: 'getMemberActivityMeta',
      channel: 'team:getMemberActivityMeta',
      tail: [],
      read: (team: string) => readTeamMemberActivity(team),
    },
    {
      method: 'getLogsForTask',
      channel: 'team:getLogsForTask',
      tail: ['TEST-task', { owner: 'alice' }],
      read: (team: string) => readTeamTaskLogs(team, 'TEST-task', { owner: 'alice' }),
    },
  ])(
    '$method keeps Host authority while native reads retain typed recovery',
    async ({ read, channel, tail }) => {
      const hostTeam = 'host-team:TEST-captured-handle';
      const payload = { owner: hostTeam };
      const captured = vi.fn(() => Promise.resolve(payload));
      const failure = { kind: 'recovering', retryAt: 30001, recoveryId: 'TEST-native-recovery' };
      const invoke = vi.fn(() =>
        Promise.resolve({ success: false, error: 'TEST-native-unavailable', failure })
      );
      vi.stubGlobal('window', {
        electronAPI: {
          teams: {
            readRecovery: createTeamReadRecoveryBridge(invoke),
            getData: captured,
            getMessagesPage: captured,
            getMemberActivityMeta: captured,
            getLogsForTask: captured,
          },
        } as unknown as ElectronAPI,
      });

      expect(await read(hostTeam)).toBe(payload);
      expect(captured).toHaveBeenCalledExactlyOnceWith(hostTeam, ...tail);
      expect(invoke).not.toHaveBeenCalled();

      await expect(read('TEST-native-team')).rejects.toMatchObject({
        message: 'TEST-native-unavailable',
        failure,
      });
      expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, 'TEST-native-team', ...tail);
      expect(captured).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves legacy reads without deriving recovery from text', async () => {
    const legacy = vi.fn(() =>
      Promise.reject(new Error('Team data worker recovering after fatal failure'))
    );
    vi.stubGlobal('window', { electronAPI: { teams: { getData: legacy } } });
    await expect(readTeamData('TEST-team', undefined)).rejects.toThrow(
      'Team data worker recovering'
    );
    expect(legacy).toHaveBeenCalledExactlyOnceWith('TEST-team');
  });
});
