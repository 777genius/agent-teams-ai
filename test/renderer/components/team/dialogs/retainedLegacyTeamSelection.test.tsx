import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fingerprintResolvedMember,
  memberToEditableSettings,
} from '../../../../../src/features/team-provisioning/renderer/utils/memberSettingsPresentation';
import {
  loadExistingTeamLaunchDialog,
  stoppedTeamLaunchSelection,
} from '../../../../../src/renderer/components/team/dialogs/stoppedTeamLaunch';
import { useStoppedTeamLaunchDialog } from '../../../../../src/renderer/components/team/dialogs/useStoppedTeamLaunchDialog';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type { MemberSettingsRelaunchDraft } from '../../../../../src/features/team-provisioning/renderer/utils/memberSettingsRelaunch';
import type { ResolvedTeamMember } from '../../../../../src/shared/types';

const f = vi.hoisted(() => ({
  getData: vi.fn(),
  getSavedRequest: vi.fn(),
  getConnections: vi.fn(),
  stoppedImport: vi.fn(),
  getProvisioningStatus: vi.fn(),
  cancelProvisioning: vi.fn(),
  confirm: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  fetchTeams: vi.fn(),
  runId: 'TEST-original-run' as string | undefined,
  selected: { teamName: 'TEST-legacy', isAlive: false },
}));
vi.mock('@renderer/api', () => ({
  api: {
    agentBackend: { getConnections: f.getConnections, stoppedImport: f.stoppedImport },
    teams: {
      getData: f.getData,
      getSavedRequest: f.getSavedRequest,
      getProvisioningStatus: f.getProvisioningStatus,
      cancelProvisioning: f.cancelProvisioning,
    },
  },
}));
vi.mock('@features/agent-backend/renderer', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openRetainedLegacyLaunch: f.open,
  closeRetainedLegacyLaunch: f.close,
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: f.confirm }));
vi.mock('@renderer/store', () => ({
  useStore: {
    getState: () => ({
      teamByName: {},
      selectedTeamData: f.selected,
      selectedTeamName: 'TEST-legacy',
      selectedTeamError: null,
      currentRuntimeRunIdByTeam: { 'TEST-legacy': f.runId },
      currentProvisioningRunIdByTeam: {},
      fetchTeams: f.fetchTeams,
    }),
  },
}));

const member: ResolvedTeamMember = {
  name: 'team-lead',
  agentType: 'team-lead',
  providerId: 'anthropic',
  model: 'TEST-original-model',
  joinedAt: 1,
  status: 'idle',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
};
const draft: MemberSettingsRelaunchDraft = {
  teamName: 'TEST-legacy',
  memberName: member.name,
  targetKind: 'lead',
  expectedFingerprint: fingerprintResolvedMember(member),
  expectedTeamSettingsFingerprint: 'TEST-original-settings',
  settings: { ...memberToEditableSettings(member), model: 'TEST-selected-model' },
};
const choice = {
  teamName: 'TEST-legacy',
  scopeId: 'TEST-original-choice',
  mode: 'original-runtime',
  projectPath: '/TEST/original-project',
  expiresAt: Date.now() + 60_000,
};
const data = (isAlive: boolean) => ({
  teamName: 'TEST-legacy',
  isAlive,
  members: [member],
  config: { projectPath: '/TEST/original-project' },
});
const draftOptions = { memberSettingsDraft: draft, baselineMembers: [member] };

beforeEach(() => {
  vi.clearAllMocks();
  resetContextScopedRequestEpochForTests();
  f.runId = 'TEST-original-run';
  f.selected = { teamName: 'TEST-legacy', isAlive: false };
  f.getConnections.mockResolvedValue({ state: 'ready', bindings: [] });
  f.confirm.mockResolvedValue(true);
  f.getData.mockResolvedValue(data(false));
  f.getSavedRequest.mockResolvedValue({
    teamName: 'TEST-legacy',
    savedSettingsFingerprint: draft.expectedTeamSettingsFingerprint,
  });
  f.stoppedImport.mockResolvedValue({
    ok: false,
    reason: 'native-custody-unverified',
    outcome: 'not-dispatched',
  });
  f.open.mockResolvedValue(choice);
  f.close.mockResolvedValue(undefined);
  f.getProvisioningStatus.mockResolvedValue({
    teamName: 'TEST-legacy',
    runId: f.runId,
    state: 'ready',
  });
  f.cancelProvisioning.mockResolvedValue(undefined);
});

describe('explicit original-runtime team selection', () => {
  it('offers original choice only after a known native-custody import refusal', async () => {
    const retain = vi.fn();
    await expect(stoppedTeamLaunchSelection('TEST-legacy', false, retain)).resolves.toBe(
      'TEST-legacy'
    );
    expect(f.stoppedImport).toHaveBeenCalledExactlyOnceWith({
      teamName: 'TEST-legacy',
      action: 'prepare',
    });
    expect(f.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: 'Use original runtime for this team' })
    );
    expect(retain).toHaveBeenCalledExactlyOnceWith(choice);
    expect(f.cancelProvisioning).not.toHaveBeenCalled();
  });

  it('keeps a stopped member draft on its original team and original settings before any import', async () => {
    const retain = vi.fn();
    const before = structuredClone(draftOptions);
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', false, retain, undefined, draftOptions)
    ).resolves.toBe('TEST-legacy');
    expect(f.stoppedImport).not.toHaveBeenCalled();
    expect(f.getSavedRequest).toHaveBeenCalledExactlyOnceWith('TEST-legacy');
    expect(f.open).toHaveBeenCalledExactlyOnceWith('TEST-legacy', undefined);
    expect(draftOptions).toEqual(before);
  });

  it('does not import or open when the explicit draft choice is declined', async () => {
    f.confirm.mockResolvedValue(false);
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', false, vi.fn(), undefined, draftOptions)
    ).rejects.toBeInstanceOf(Error);
    expect(f.stoppedImport).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.cancelProvisioning).not.toHaveBeenCalled();
  });

  it('rejects a changed saved settings fingerprint without rebasing the draft', async () => {
    f.getSavedRequest.mockResolvedValue({
      teamName: 'TEST-legacy',
      savedSettingsFingerprint: 'TEST-changed',
    });
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', false, vi.fn(), undefined, draftOptions)
    ).rejects.toThrow('settings changed');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.stoppedImport).not.toHaveBeenCalled();
    expect(draft.expectedTeamSettingsFingerprint).toBe('TEST-original-settings');
  });

  it('stops the exact original run once and re-reads stopped data before opening original Launch', async () => {
    const order: string[] = [];
    f.confirm.mockImplementation(async () => {
      order.push('confirm');
      return true;
    });
    f.getData
      .mockImplementationOnce(async () => {
        order.push('read-live');
        return data(true);
      })
      .mockImplementationOnce(async () => {
        order.push('read-stopped');
        return data(false);
      });
    f.getProvisioningStatus.mockImplementation(async () => {
      order.push('original-run');
      return { teamName: 'TEST-legacy', runId: f.runId };
    });
    f.cancelProvisioning.mockImplementation(async () => {
      order.push('stop');
    });
    f.open.mockImplementation(async () => {
      order.push('open');
      return choice;
    });
    const original = vi.fn();
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, {
        mode: 'relaunch',
        onOriginalData: original,
      })
    ).resolves.toBe('TEST-legacy');
    expect(order).toEqual(['confirm', 'read-live', 'original-run', 'stop', 'read-stopped', 'open']);
    expect(f.cancelProvisioning).toHaveBeenCalledExactlyOnceWith('TEST-original-run');
    expect(f.stoppedImport).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledExactlyOnceWith(data(false));
  });

  it('cannot stop a team from a plain Launch action if it became live', async () => {
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, { mode: 'launch' })
    ).rejects.toThrow('already running');
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.cancelProvisioning).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('does not stop after context changes during explicit confirmation', async () => {
    f.confirm.mockImplementation(async () => {
      invalidateContextScopedRequestEpoch();
      return true;
    });
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, { mode: 'relaunch' })
    ).rejects.toThrow('context changed');
    expect(f.cancelProvisioning).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('does not retarget a replacement run observed while the original status read is pending', async () => {
    f.getData.mockResolvedValue(data(true));
    f.getProvisioningStatus.mockImplementation(async () => {
      f.runId = 'TEST-replacement-run';
      return { teamName: 'TEST-legacy', runId: 'TEST-original-run' };
    });
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, { mode: 'relaunch' })
    ).rejects.toThrow('run changed');
    expect(f.cancelProvisioning).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it.each([undefined, 'pending:TEST-run', 'host-run:TEST-invalid'])(
    'refuses an unavailable original run %s before Stop',
    async (runId) => {
      f.runId = runId;
      f.getData.mockResolvedValue(data(true));
      await expect(
        stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, { mode: 'relaunch' })
      ).rejects.toThrow(/run.*(unavailable|changed)/);
      expect(f.cancelProvisioning).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
    }
  );

  it('keeps lost Stop acknowledgement unknown without opening or retrying', async () => {
    f.getData.mockResolvedValue(data(true));
    f.cancelProvisioning.mockRejectedValue(new Error('TEST-lost-ACK'));
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, { mode: 'relaunch' })
    ).rejects.toThrow('Stop outcome is unknown');
    expect(f.cancelProvisioning).toHaveBeenCalledTimes(1);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.stoppedImport).not.toHaveBeenCalled();
  });

  it('does not treat Stop acknowledgement as proof that the original team is stopped', async () => {
    f.getData.mockResolvedValue(data(true));
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, { mode: 'relaunch' })
    ).rejects.toThrow('Stop is not confirmed');
    expect(f.cancelProvisioning).toHaveBeenCalledTimes(1);
    expect(f.open).not.toHaveBeenCalled();
  });

  it('rejects member settings changed by Stop instead of adopting a fresh baseline', async () => {
    f.getData.mockResolvedValueOnce(data(true)).mockResolvedValueOnce(data(false));
    f.getSavedRequest
      .mockResolvedValueOnce({
        teamName: 'TEST-legacy',
        savedSettingsFingerprint: draft.expectedTeamSettingsFingerprint,
      })
      .mockResolvedValueOnce({
        teamName: 'TEST-legacy',
        savedSettingsFingerprint: 'TEST-after-stop',
      });
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, {
        mode: 'relaunch',
        ...draftOptions,
      })
    ).rejects.toThrow('settings changed');
    expect(f.cancelProvisioning).toHaveBeenCalledTimes(1);
    expect(f.open).not.toHaveBeenCalled();
    expect(draft.expectedTeamSettingsFingerprint).toBe('TEST-original-settings');
  });

  it('keeps Host-unconfigured live relaunch on the original existing path', async () => {
    f.getConnections.mockResolvedValue({ state: 'unconfigured', bindings: [] });
    await expect(
      stoppedTeamLaunchSelection('TEST-legacy', true, vi.fn(), undefined, { mode: 'relaunch' })
    ).resolves.toBe('TEST-legacy');
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.cancelProvisioning).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('hydrates list Launch with freshly stopped original data after the explicit live transition', async () => {
    f.getData
      .mockResolvedValueOnce(data(true))
      .mockResolvedValueOnce(data(true))
      .mockResolvedValueOnce({ ...data(false), config: { projectPath: '/TEST/fresh-project' } });
    const result = await loadExistingTeamLaunchDialog(
      'TEST-legacy',
      '/TEST/stale-project',
      'relaunch'
    );
    expect(result).toMatchObject({
      teamName: 'TEST-legacy',
      mode: 'launch',
      projectPath: '/TEST/fresh-project',
      retainedLegacyLaunch: choice,
    });
    expect(f.getSavedRequest).toHaveBeenCalledExactlyOnceWith('TEST-legacy');
    expect(f.cancelProvisioning).toHaveBeenCalledTimes(1);
    expect(f.stoppedImport).not.toHaveBeenCalled();
  });

  it('opens the Detail dialog with the original member draft and closes its exact choice', async () => {
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
        hook!.openLaunchDialog('launch', draftOptions);
      });
      expect(hook!.launchDialogState).toMatchObject({
        open: true,
        mode: 'launch',
        memberSettingsDraft: draft,
        retainedLegacyLaunch: choice,
      });
      expect(hook!.launchTarget).toMatchObject({
        teamName: 'TEST-legacy',
        cwd: '/TEST/original-project',
      });
      expect(f.stoppedImport).not.toHaveBeenCalled();
      act(() => hook!.closeLaunchDialog());
      expect(f.close).toHaveBeenCalledWith(choice);
    } finally {
      act(() => root.unmount());
    }
  });
});
