import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMember = vi.fn(async (..._args: unknown[]) => undefined);
const removeMember = vi.fn(async (..._args: unknown[]) => undefined);
const fetchTeams = vi.fn(async () => undefined);
const refreshTeamData = vi.fn(async (..._args: unknown[]) => undefined);
const restoreMember = vi.fn(async (..._args: unknown[]) => undefined);
const replaceMembers = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      addMember: (...args: unknown[]) => addMember(...args),
      removeMember: (...args: unknown[]) => removeMember(...args),
      restoreMember: (...args: unknown[]) => restoreMember(...args),
      replaceMembers: (...args: unknown[]) => replaceMembers(...args),
    },
  },
}));
vi.mock('@renderer/store', () => ({
  useStore: { getState: () => ({ fetchTeams, refreshTeamData }) },
}));

import { buildChangeRuntimeLaunchState } from '@renderer/components/team/definitionEdit/changeRuntimeLaunch';
import { routeMemberActions } from '@renderer/components/team/definitionEdit/definitionEditActions';
import { getDefinitionEditAccess } from '@renderer/components/team/definitionEdit/definitionEditAccess';
import { buildDefinitionEditorInput } from '@renderer/components/team/definitionEdit/definitionEditorInput';

import { saveLaunchRoster } from '@renderer/components/team/dialogs/launchRosterPersistence';

import type { TeamCreateRequest } from '@shared/types';

describe('getDefinitionEditAccess', () => {
  const base = { retainedHistory: false, isAlive: false, isProvisioning: false };

  it('lets an ordinary team and a stopped per-project team edit', () => {
    expect(getDefinitionEditAccess(base)).toEqual({ canEdit: true, unavailableKey: null });
    expect(getDefinitionEditAccess({ ...base, logicalTeamName: 'builders' })).toEqual({
      canEdit: true,
      unavailableKey: null,
    });
  });

  it('never edits a retained read-only copy, even a per-project one', () => {
    expect(
      getDefinitionEditAccess({ ...base, retainedHistory: true, logicalTeamName: 'builders' })
    ).toEqual({ canEdit: false, unavailableKey: null });
  });

  it('explains why the controls are off while provisioning or while a per-project team runs', () => {
    expect(getDefinitionEditAccess({ ...base, isProvisioning: true })).toEqual({
      canEdit: true,
      unavailableKey: 'detail.tooltips.editUnavailableProvisioning',
    });
    expect(
      getDefinitionEditAccess({ ...base, logicalTeamName: 'builders', isAlive: true })
    ).toEqual({
      canEdit: true,
      unavailableKey: 'detail.tooltips.editUnavailableRunningProject',
    });
  });

  it('keeps live editing of an ordinary running team as it was', () => {
    expect(getDefinitionEditAccess({ ...base, isAlive: true })).toEqual({
      canEdit: true,
      unavailableKey: null,
    });
  });
});

describe('buildDefinitionEditorInput', () => {
  const saved = {
    teamName: 'builders',
    displayName: ' Builders ',
    description: 'Ships things',
    color: 'green',
    cwd: '/p',
    providerId: 'anthropic',
    model: 'opus',
    effort: 'high',
    members: [
      {
        name: 'alice',
        role: 'developer',
        workflow: 'review first',
        isolation: 'worktree',
        providerId: 'codex',
        model: 'gpt',
        fastMode: 'on',
      },
    ],
  } as unknown as TeamCreateRequest;

  it('shows the saved definition, not a run snapshot', () => {
    const input = buildDefinitionEditorInput(saved, 'builders');
    expect(input).toMatchObject({
      currentName: 'Builders',
      currentDescription: 'Ships things',
      currentColor: 'green',
    });
    expect(input.currentMembers).toHaveLength(1);
    expect(input.currentMembers[0]).toMatchObject({
      name: 'alice',
      role: 'developer',
      workflow: 'review first',
      isolation: 'worktree',
      status: 'unknown',
      taskCount: 0,
      configuredRuntimeSettings: { providerId: 'codex', model: 'gpt', fastMode: 'on' },
    });
  });

  it('shows the lead with the team-level runtime, and falls back to the team name', () => {
    const input = buildDefinitionEditorInput({ ...saved, displayName: undefined }, 'builders');
    expect(input.currentName).toBe('builders');
    expect(input.leadMember).toMatchObject({
      name: 'team-lead',
      agentType: 'team-lead',
      providerId: 'anthropic',
      model: 'opus',
      effort: 'high',
    });
  });
});

describe('routeMemberActions', () => {
  const native = {
    addMember: vi.fn(async (..._args: unknown[]) => undefined),
    removeMember: vi.fn(async (..._args: unknown[]) => undefined),
    restoreMember: vi.fn(async (..._args: unknown[]) => undefined),
  };

  beforeEach(() => vi.clearAllMocks());

  it('keeps the store actions for an ordinary team', async () => {
    const actions = routeMemberActions(undefined, 'legacy', native);
    await actions.add({ name: 'bob' });
    await actions.remove('bob');
    await actions.restore('bob');
    expect(native.addMember).toHaveBeenCalledWith('legacy', { name: 'bob' });
    expect(native.removeMember).toHaveBeenCalledWith('legacy', 'bob');
    expect(native.restoreMember).toHaveBeenCalledWith('legacy', 'bob');
    expect(addMember).not.toHaveBeenCalled();
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('writes to the logical team and then refreshes the open project copy and the team list', async () => {
    const actions = routeMemberActions('builders', 'ptc-a', native);
    await actions.add({ name: 'bob' });
    expect(addMember).toHaveBeenCalledWith('builders', { name: 'bob' });
    await actions.remove('bob');
    expect(removeMember).toHaveBeenCalledWith('builders', 'bob');
    await actions.restore('bob');
    expect(restoreMember).toHaveBeenCalledWith('builders', 'bob');
    expect(native.addMember).not.toHaveBeenCalled();
    expect(native.removeMember).not.toHaveBeenCalled();
    expect(native.restoreMember).not.toHaveBeenCalled();
    expect(fetchTeams).toHaveBeenCalledTimes(3);
    // The refresh action, not selectTeam: the visible team is not re-selected globally.
    expect(refreshTeamData).toHaveBeenCalledWith('ptc-a');
    expect(refreshTeamData).toHaveBeenCalledTimes(3);
  });
});

describe('change runtime for a per-project team', () => {
  const baselineMembers = [{ name: 'alice' }] as never;
  const draft = { targetKind: 'lead' } as never;

  it('always opens relaunch mode without a member settings draft, so the definition is never written', () => {
    for (const isAlive of [false, true]) {
      expect(
        buildChangeRuntimeLaunchState({
          logicalTeamName: 'builders',
          isAlive,
          isProvisioning: false,
          memberSettingsDraft: draft,
          baselineMembers,
        })
      ).toEqual({ open: true, mode: 'relaunch', memberSettingsDraft: undefined, baselineMembers });
    }
  });

  it('keeps the existing behavior for an ordinary team', () => {
    const input = { logicalTeamName: undefined, isProvisioning: false, memberSettingsDraft: draft, baselineMembers };
    expect(buildChangeRuntimeLaunchState({ ...input, isAlive: false })).toMatchObject({
      mode: 'launch',
      memberSettingsDraft: draft,
    });
    expect(buildChangeRuntimeLaunchState({ ...input, isAlive: true })).toMatchObject({ mode: 'relaunch' });
  });
});

describe('a launch dialog never writes the definition of a per-project team', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips the roster save for a read-only roster (stale project copy members must not overwrite it)', async () => {
    await saveLaunchRoster(true, 'builders', [{ name: 'stale' }]);
    expect(replaceMembers).not.toHaveBeenCalled();
  });

  it('keeps saving the roster of an ordinary team before launch', async () => {
    await saveLaunchRoster(false, 'legacy', [{ name: 'a' }]);
    await saveLaunchRoster(undefined, 'legacy', [{ name: 'b' }]);
    expect(replaceMembers).toHaveBeenCalledTimes(2);
    expect(replaceMembers).toHaveBeenCalledWith('legacy', {
      members: [{ name: 'a' }],
      memberSettingsRelaunch: undefined,
    });
  });
});
