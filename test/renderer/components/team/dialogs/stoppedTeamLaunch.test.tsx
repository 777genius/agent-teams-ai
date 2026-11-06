import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadExistingTeamLaunchDialog,
  stoppedTeamLaunchSelection,
} from '../../../../../src/renderer/components/team/dialogs/stoppedTeamLaunch';
import { useStoppedTeamLaunchDialog } from '../../../../../src/renderer/components/team/dialogs/useStoppedTeamLaunchDialog';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../../../src/renderer/store/utils/contextScopedRequestEpoch';
const f = vi.hoisted(() => ({
  getData: vi.fn(),
  getConnections: vi.fn(),
  stoppedImport: vi.fn(),
  confirm: vi.fn(),
  fetchTeams: vi.fn(),
  selected: { teamName: 'TEST-legacy', isAlive: false } as {
    teamName: string;
    isAlive: boolean;
  } | null,
  selectedTeamName: 'TEST-legacy',
  selectedTeamError: null as string | null,
}));
vi.mock('@renderer/api', () => ({
  api: {
    agentBackend: { getConnections: f.getConnections, stoppedImport: f.stoppedImport },
    teams: { getData: f.getData },
  },
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: f.confirm }));
vi.mock('@renderer/store', () => ({
  useStore: {
    getState: () => ({
      selectedTeamData: f.selected,
      selectedTeamName: f.selectedTeamName,
      selectedTeamError: f.selectedTeamError,
      fetchTeams: f.fetchTeams,
    }),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  resetContextScopedRequestEpochForTests();
  f.confirm.mockResolvedValue(false);
  f.selected = { teamName: 'TEST-legacy', isAlive: false };
  f.selectedTeamName = 'TEST-legacy';
  f.selectedTeamError = null;
  f.getConnections.mockResolvedValue({ state: 'ready', bindings: [] });
  f.stoppedImport.mockResolvedValue({ ok: true, selection: 'host-team:TEST-import' });
  f.getData.mockImplementation(async (teamName: string) => ({
    teamName,
    isAlive: false,
    members: [],
    config: { projectPath: '/TEST/workspace' },
  }));
});
describe('existing stopped Team Launch dialog handoff', () => {
  it('actual metadata-only draft imports before list fallback and keeps source HOLD visible', async () => {
    const importedData = {
      teamName: 'host-team:TEST-import',
      members: [],
      config: { projectPath: '/TEST/imported' },
    };
    f.getData.mockImplementation(async (name: string) => {
      if (name === 'TEST-legacy') throw new Error('TEAM_DRAFT');
      return importedData;
    });
    expect(await loadExistingTeamLaunchDialog('TEST-legacy', '/TEST/source', 'launch')).toEqual({
      teamName: 'host-team:TEST-import',
      mode: 'launch',
      members: [],
      projectPath: '/TEST/imported',
    });
    expect(f.stoppedImport).toHaveBeenCalledExactlyOnceWith({
      teamName: 'TEST-legacy',
      action: 'prepare',
    });
    f.stoppedImport.mockResolvedValueOnce({
      ok: false,
      reason: 'native-custody-unverified',
      outcome: 'not-dispatched',
    });
    expect(await loadExistingTeamLaunchDialog('TEST-legacy', '/TEST/source', 'launch')).toBeNull();
    expect(f.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('not proven released') })
    );
  });
  it('verified metadata-only Detail draft binds imported dialog and never opens a held legacy fallback', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    f.selected = null;
    f.selectedTeamError = 'TEAM_DRAFT';
    let hook: ReturnType<typeof useStoppedTeamLaunchDialog> | undefined;
    function Probe() {
      hook = useStoppedTeamLaunchDialog('TEST-legacy');
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      act(() => root.render(<Probe />));
      await act(async () => {
        hook!.openLaunchDialog('launch');
      });
      expect(f.stoppedImport).toHaveBeenCalledExactlyOnceWith({
        teamName: 'TEST-legacy',
        action: 'prepare',
      });
      expect(hook!.launchTarget?.teamName).toBe('host-team:TEST-import');
      act(() => hook!.closeLaunchDialog());
      f.stoppedImport.mockResolvedValueOnce({
        ok: false,
        reason: 'native-custody-unverified',
        outcome: 'not-dispatched',
      });
      await act(async () => {
        hook!.openLaunchDialog('launch');
      });
      expect(hook!.launchDialogState.open).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
  it('metadata-only draft keeps old empty-roster fallback only when Host is unconfigured', async () => {
    f.getData.mockRejectedValue(new Error('TEAM_DRAFT'));
    f.getConnections.mockResolvedValue({ state: 'unconfigured', bindings: [] });
    expect(await loadExistingTeamLaunchDialog('TEST-legacy', '/TEST/source', 'launch')).toEqual({
      teamName: 'TEST-legacy',
      mode: 'launch',
      members: [],
      projectPath: '/TEST/source',
    });
    expect(f.stoppedImport).not.toHaveBeenCalled();
  });
  it('hydrates original list dialog from the canonical imported Host configuration with no automatic Launch', async () => {
    expect(await loadExistingTeamLaunchDialog('TEST-legacy', '/TEST/source', 'relaunch')).toEqual({
      teamName: 'host-team:TEST-import',
      mode: 'launch',
      members: [],
      projectPath: '/TEST/workspace',
    });
    expect(f.getData.mock.calls.map((call) => call[0])).toEqual([
      'TEST-legacy',
      'host-team:TEST-import',
    ]);
    expect(f.stoppedImport).toHaveBeenCalledExactlyOnceWith({
      teamName: 'TEST-legacy',
      action: 'prepare',
    });
  });
  it('detail hook opens the same Launch dialog with imported selection rather than invoking relaunch', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let hook: ReturnType<typeof useStoppedTeamLaunchDialog> | undefined;
    function Probe() {
      hook = useStoppedTeamLaunchDialog('TEST-legacy');
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      act(() => root.render(<Probe />));
      await act(async () => {
        hook!.openLaunchDialog('relaunch');
      });
      expect(hook!.launchDialogState.open).toBe(true);
      expect(hook!.launchDialogState.mode).toBe('launch');
      expect(hook!.launchTarget?.teamName).toBe('host-team:TEST-import');
      expect(f.fetchTeams).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });
  it('native custody HOLD and uncertain transport cannot fall back to legacy dialog or dispatch retry', async () => {
    f.stoppedImport.mockResolvedValueOnce({
      ok: false,
      reason: 'native-custody-unverified',
      outcome: 'not-dispatched',
    });
    expect(await loadExistingTeamLaunchDialog('TEST-legacy', '/TEST/source', 'launch')).toBeNull();
    expect(f.getData).toHaveBeenCalledTimes(1);
    expect(f.confirm).toHaveBeenCalled();
    f.stoppedImport.mockRejectedValueOnce(new Error('TEST-lost-ACK'));
    expect(await loadExistingTeamLaunchDialog('TEST-legacy', '/TEST/source', 'launch')).toBeNull();
    expect(f.stoppedImport.mock.calls.every((call) => call[0].action === 'prepare')).toBe(true);
  });
  it('known held original retries only after explicit confirmation; epoch change revokes reply', async () => {
    f.stoppedImport.mockResolvedValueOnce({ ok: false, reason: 'held', outcome: 'not-dispatched' });
    f.confirm.mockResolvedValueOnce(true);
    expect(await stoppedTeamLaunchSelection('TEST-legacy', false)).toBe('host-team:TEST-import');
    expect(f.stoppedImport.mock.calls.map((call) => call[0].action)).toEqual(['prepare', 'retry']);
    f.stoppedImport.mockImplementationOnce(async () => {
      invalidateContextScopedRequestEpoch();
      return { ok: true, selection: 'host-team:TEST-import' };
    });
    await expect(stoppedTeamLaunchSelection('TEST-legacy', false)).rejects.toThrow(
      'context changed'
    );
  });
  it('unconfigured legacy and already Host selections keep their existing dialog flow', async () => {
    f.getConnections.mockResolvedValueOnce({ state: 'unconfigured', bindings: [] });
    expect(await stoppedTeamLaunchSelection('TEST-legacy', false)).toBe('TEST-legacy');
    expect(await stoppedTeamLaunchSelection('host-team:TEST-import', false)).toBe(
      'host-team:TEST-import'
    );
    expect(f.stoppedImport).not.toHaveBeenCalled();
  });
});
