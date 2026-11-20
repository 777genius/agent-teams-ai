import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMember = vi.fn(async (..._args: unknown[]) => undefined);
const removeMember = vi.fn(async (..._args: unknown[]) => undefined);
const fetchTeams = vi.fn(async () => undefined);
const selectTeam = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@renderer/api', () => ({
  api: { teams: { addMember: (...args: unknown[]) => addMember(...args), removeMember: (...args: unknown[]) => removeMember(...args) } },
}));
vi.mock('@renderer/store', () => ({
  useStore: { getState: () => ({ fetchTeams, selectTeam }) },
}));

import { routeMemberActions } from '@renderer/components/team/definitionEdit/definitionEditActions';
import { getDefinitionEditAccess } from '@renderer/components/team/definitionEdit/definitionEditAccess';
import { buildDefinitionEditorInput } from '@renderer/components/team/definitionEdit/definitionEditorInput';

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
  };

  beforeEach(() => vi.clearAllMocks());

  it('keeps the store actions for an ordinary team', async () => {
    const actions = routeMemberActions(undefined, 'legacy', native);
    await actions.add({ name: 'bob' });
    await actions.remove('bob');
    expect(native.addMember).toHaveBeenCalledWith('legacy', { name: 'bob' });
    expect(native.removeMember).toHaveBeenCalledWith('legacy', 'bob');
    expect(addMember).not.toHaveBeenCalled();
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('writes to the logical team and then refreshes the open project copy and the team list', async () => {
    const actions = routeMemberActions('builders', 'ptc-a', native);
    await actions.add({ name: 'bob' });
    expect(addMember).toHaveBeenCalledWith('builders', { name: 'bob' });
    await actions.remove('bob');
    expect(removeMember).toHaveBeenCalledWith('builders', 'bob');
    expect(native.addMember).not.toHaveBeenCalled();
    expect(native.removeMember).not.toHaveBeenCalled();
    expect(fetchTeams).toHaveBeenCalledTimes(2);
    expect(selectTeam).toHaveBeenCalledWith('ptc-a');
    expect(selectTeam).toHaveBeenCalledTimes(2);
  });
});
