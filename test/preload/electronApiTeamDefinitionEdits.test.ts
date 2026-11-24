import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';
import type { TeamDefinitionEditApi } from '@shared/types/teamDefinitionEdit';

const mocks = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));
vi.mock('electron', () => mocks);

async function loadTeams(): Promise<ElectronAPI['teams']> {
  await import('../../src/preload/index');
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'electronAPI'
  );
  if (!call) throw new Error('electronAPI was not exposed');
  return (call[1] as ElectronAPI).teams;
}

const operations: { method: keyof TeamDefinitionEditApi; channel: string; args: unknown[] }[] = [
  {
    method: 'updateConfig',
    channel: 'team:updateConfig',
    args: ['builders', { description: 'New' }],
  },
  { method: 'addMember', channel: 'team:addMember', args: ['builders', { name: 'alice' }] },
  { method: 'replaceMembers', channel: 'team:replaceMembers', args: ['builders', { members: [] }] },
  { method: 'removeMember', channel: 'team:removeMember', args: ['builders', 'alice'] },
  { method: 'restoreMember', channel: 'team:restoreMember', args: ['builders', 'alice'] },
  {
    method: 'updateMemberRole',
    channel: 'team:updateMemberRole',
    args: ['builders', 'alice', undefined],
  },
];

describe('preload definition edit transports', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete (window as Window & { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__;
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockReset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(operations)(
    'keeps $method on its existing IPC channel in both transports',
    async ({ method, channel, args }) => {
      const teams = await loadTeams();
      const data = method === 'updateConfig' ? { name: 'Builders', members: [] } : undefined;
      mocks.ipcRenderer.invoke.mockResolvedValue({ success: true, data });
      for (const methods of [teams, teams.definitionEdits!]) {
        const call = methods[method] as (...values: unknown[]) => Promise<unknown>;
        await expect(call(...args)).resolves.toBe(data);
      }
      expect(mocks.ipcRenderer.invoke.mock.calls).toEqual([
        [channel, ...args],
        [channel, ...args],
      ]);
    }
  );

  it('uses a tagged plain result only for the known refusal and retains the raw rejection', async () => {
    const teams = await loadTeams();
    const message = 'Open the interrupted project first';
    const failure = { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' };
    mocks.ipcRenderer.invoke.mockResolvedValue({ success: false, error: message, failure });
    await expect(teams.definitionEdits!.updateConfig('builders', {})).resolves.toEqual({
      type: 'team-definition-edit-refusal',
      message,
      failure,
    });
    await expect(teams.updateConfig('builders', {})).rejects.toMatchObject({ message, failure });
    await expect(teams.updateConfig('builders', {})).rejects.toBeInstanceOf(Error);
  });

  it('keeps unrelated failures as errors even when their message names the recovery code', async () => {
    const teams = await loadTeams();
    const message = 'TEAM_PROJECT_CONTEXT_UNRECONCILED appears in ordinary diagnostic text';
    mocks.ipcRenderer.invoke.mockResolvedValue({
      success: false,
      error: message,
      failure: { code: 'OTHER_ERROR' },
    });
    await expect(teams.definitionEdits!.updateConfig('builders', {})).rejects.toThrow(message);
    await expect(teams.updateConfig('builders', {})).rejects.toThrow(message);
  });
});
