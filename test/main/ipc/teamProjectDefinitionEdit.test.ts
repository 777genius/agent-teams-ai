import { beforeEach, describe, expect, it, vi } from 'vitest';

const metaByTeam = new Map<string, { projectContextMode?: string } | null>();

vi.mock('../../../src/main/services/team/TeamMetaStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/main/services/team/TeamMetaStore')>();
  return {
    ...original,
    TeamMetaStore: class {
      async getMeta(teamName: string) {
        return metaByTeam.get(teamName) ?? null;
      }
    },
  };
});

import {
  createProjectDefinitionEditRouting,
  NATIVE_LEAD_PROMPT_MESSAGE,
  PROJECT_COPY_EDIT_MESSAGE,
  PROJECT_TEAM_SETTINGS_RELAUNCH_MESSAGE,
  readRosterForMutation,
  refuseLeadPromptOfNativeTeam,
  refuseSettingsRelaunchOfDefinition,
  rosterOf,
  route,
} from '../../../src/main/ipc/teams/teamProjectDefinitionEdit';

import type { TeamKind } from '../../../src/features/team-project-context/main';
import type { TeamProjectDefinitionEditor } from '../../../src/features/team-project-context/main';

function routing(target: TeamKind) {
  const editor = {
    classify: vi.fn(async () => target),
    assertEditable: vi.fn(async () => undefined),
    findRunningContextForEdit: vi.fn(async () => null),
    projectToAliases: vi.fn(async () => ({ failed: [] as { executionTeamName: string; message: string }[] })),
  };
  const handler = vi.fn(async (..._args: unknown[]) => ({ success: true as const, data: undefined }));
  const wrapped = createProjectDefinitionEditRouting(
    { data: () => ({ runConfigurationOperation: (_name: string, operation: () => Promise<unknown>) => operation() }) } as never,
    () => editor as unknown as TeamProjectDefinitionEditor,
    () => ({ hasPending: async () => false, begin: async () => undefined, clear: async () => undefined })
  )(handler);
  return { editor, handler, wrapped };
}

const event = {} as never;

describe('withProjectDefinitionEdit', () => {
  it('runs the handler unchanged for an ordinary team and never touches the editor policy', async () => {
    const r = routing('native');
    await expect(r.wrapped(event, 'legacy', { name: 'x' })).resolves.toEqual({
      success: true,
      data: undefined,
    });
    expect(r.handler).toHaveBeenCalledWith(event, 'legacy', { name: 'x' });
    expect(r.editor.assertEditable).not.toHaveBeenCalled();
    expect(r.editor.projectToAliases).not.toHaveBeenCalled();
  });

  it('passes an invalid team name to the handler so it keeps its own validation error', async () => {
    const r = routing('logical');
    await r.wrapped(event, 42);
    expect(r.handler).toHaveBeenCalledWith(event, 42);
    expect(r.editor.classify).not.toHaveBeenCalled();
  });

  it('refuses to edit a project copy directly: the definition lives in the logical team', async () => {
    const r = routing('alias');
    await expect(r.wrapped(event, 'ptc-a', {})).resolves.toEqual({
      success: false,
      error: PROJECT_COPY_EDIT_MESSAGE,
    });
    expect(r.handler).not.toHaveBeenCalled();
  });

  it('refuses a per-project edit while any project runs and writes nothing', async () => {
    const r = routing('logical');
    r.editor.findRunningContextForEdit.mockRejectedValue(new Error('Stop it in every project'));
    await expect(r.wrapped(event, 'builders', {})).resolves.toEqual({
      success: false,
      error: 'Stop it in every project',
    });
    expect(r.handler).not.toHaveBeenCalled();
    expect(r.editor.projectToAliases).not.toHaveBeenCalled();
  });

  it('writes to the logical team first, then refreshes the stopped project copies', async () => {
    const r = routing('logical');
    const order: string[] = [];
    r.handler.mockImplementation(async () => {
      order.push('write');
      return { success: true as const, data: undefined };
    });
    r.editor.projectToAliases.mockImplementation(async () => {
      order.push('project');
      return { failed: [] };
    });
    await expect(r.wrapped(event, 'builders', { name: 'x' })).resolves.toEqual({
      success: true,
      data: undefined,
    });
    expect(order).toEqual(['write', 'project']);
    expect(r.handler).toHaveBeenCalledWith(event, 'builders', { name: 'x' });
  });

  it('does not refresh copies when the logical write failed', async () => {
    const r = routing('logical');
    r.handler.mockResolvedValue({ success: false as never, error: 'bad member' } as never);
    await expect(r.wrapped(event, 'builders', {})).resolves.toEqual({
      success: false,
      error: 'bad member',
    });
    expect(r.editor.projectToAliases).not.toHaveBeenCalled();
  });

  it('keeps the saved edit successful when a project copy cannot be refreshed right now', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = routing('logical');
    r.editor.projectToAliases.mockResolvedValue({
      failed: [{ executionTeamName: 'ptc-a', message: 'busy' }],
    });
    await expect(r.wrapped(event, 'builders', {})).resolves.toMatchObject({ success: true });
    r.editor.projectToAliases.mockRejectedValue(new Error('registry unreadable'));
    await expect(r.wrapped(event, 'builders', {})).resolves.toMatchObject({ success: true });
    // The refresh problem is not hidden: it is logged, and the next launch repeats the refresh.
    expect(warn.mock.calls.map((call) => call.map(String).join(' '))).toEqual([
      expect.stringContaining('ptc-a of builders: busy'),
      expect.stringContaining('registry unreadable'),
    ]);
    warn.mockRestore();
  });
});

describe('readRosterForMutation', () => {
  beforeEach(() => metaByTeam.clear());

  it('returns the snapshot of an ordinary team', async () => {
    const data = { getTeamData: vi.fn(async () => ({ members: [{ name: 'a' }] })) };
    await expect(readRosterForMutation(data as never, 'legacy')).resolves.toEqual({
      members: [{ name: 'a' }],
    });
  });

  it('has no live roster to read for a per-project definition without config.json', async () => {
    metaByTeam.set('builders', { projectContextMode: 'per_project' });
    const data = {
      getTeamData: vi.fn(async () => {
        throw new Error('Team not found: builders');
      }),
    };
    await expect(readRosterForMutation(data as never, 'builders')).resolves.toEqual({ members: [] });
  });

  it('keeps every other failure, including a missing ordinary team', async () => {
    metaByTeam.set('draft', { projectContextMode: 'shared' });
    const missing = {
      getTeamData: vi.fn(async () => {
        throw new Error('Team not found: draft');
      }),
    };
    await expect(readRosterForMutation(missing as never, 'draft')).rejects.toThrow(
      'Team not found: draft'
    );
    metaByTeam.set('builders', { projectContextMode: 'per_project' });
    const broken = {
      getTeamData: vi.fn(async () => {
        throw new Error('disk failure');
      }),
    };
    await expect(readRosterForMutation(broken as never, 'builders')).rejects.toThrow('disk failure');
  });
});

describe('the router bound to the team handlers', () => {
  it('refuses to route before the handlers are initialized instead of skipping the policy', async () => {
    const handler = vi.fn(async (..._args: unknown[]) => ({ success: true as const, data: undefined }));
    await expect(route(handler)(event, 'builders')).rejects.toThrow('not initialized');
    expect(handler).not.toHaveBeenCalled();
  });

  it('reads the roster a live mutation rolls back to as roster members', async () => {
    metaByTeam.clear();
    const data = { getTeamData: vi.fn(async () => ({ members: [{ name: 'a', role: 'dev' }] })) };
    await expect(rosterOf(data as never, 'legacy')).resolves.toEqual([{ name: 'a', role: 'dev' }]);
  });
});

describe('lead instructions in the update-config route', () => {
  function updateRouting(target: TeamKind) {
    const editor = {
      classify: vi.fn(async () => target),
      assertEditable: vi.fn(async () => undefined),
      findRunningContextForEdit: vi.fn(async () => null),
      projectToAliases: vi.fn(async () => ({ failed: [] as { executionTeamName: string; message: string }[] })),
    };
    const handler = vi.fn(async (..._args: unknown[]) => ({ success: true as const, data: undefined }));
    const wrapped = createProjectDefinitionEditRouting(
      { data: () => ({ runConfigurationOperation: (_name: string, operation: () => Promise<unknown>) => operation() }) } as never,
      () => editor as unknown as TeamProjectDefinitionEditor,
    () => ({ hasPending: async () => false, begin: async () => undefined, clear: async () => undefined })
    )(handler, refuseLeadPromptOfNativeTeam);
    return { editor, handler, wrapped };
  }

  it('refuses a lead prompt for an ordinary team and writes nothing', async () => {
    const r = updateRouting('native');
    await expect(r.wrapped(event, 'legacy', { prompt: 'new rules' })).resolves.toEqual({
      success: false,
      error: NATIVE_LEAD_PROMPT_MESSAGE,
    });
    expect(r.handler).not.toHaveBeenCalled();
  });

  it('refuses even an empty prompt for an ordinary team, but lets the other fields through', async () => {
    const r = updateRouting('native');
    await expect(r.wrapped(event, 'legacy', { prompt: '' })).resolves.toMatchObject({ success: false });
    await expect(r.wrapped(event, 'legacy', { description: 'x', prompt: undefined })).resolves.toMatchObject({
      success: true,
    });
    expect(r.handler).toHaveBeenCalledTimes(1);
  });

  it('accepts the lead prompt of a per-project team through the gate and projects it', async () => {
    const r = updateRouting('logical');
    await expect(r.wrapped(event, 'builders', { prompt: 'new rules' })).resolves.toMatchObject({
      success: true,
    });
    expect(r.editor.findRunningContextForEdit).toHaveBeenCalledWith('builders');
    expect(r.handler).toHaveBeenCalledWith(event, 'builders', { prompt: 'new rules' });
    expect(r.editor.projectToAliases).toHaveBeenCalledWith('builders');
  });

  it('only names a refusal when the payload really carries a prompt', () => {
    expect(refuseLeadPromptOfNativeTeam(null)).toBeNull();
    expect(refuseLeadPromptOfNativeTeam('text')).toBeNull();
    expect(refuseLeadPromptOfNativeTeam({ name: 'x' })).toBeNull();
    expect(refuseLeadPromptOfNativeTeam({ prompt: undefined })).toBeNull();
    expect(refuseLeadPromptOfNativeTeam({ prompt: '' })).toBe(NATIVE_LEAD_PROMPT_MESSAGE);
  });
});

/**
 * A settings-originated relaunch writes member settings into the team it
 * relaunches. For a per-project team that would be a second writer of its
 * definition, outside the stopped-team rule, so main refuses it; an ordinary
 * team keeps it, and an ordinary roster replace of a per-project team still works.
 */
describe('settings-originated relaunch of a per-project team', () => {
  function replaceRouting(target: TeamKind) {
    const editor = {
      classify: vi.fn(async () => target),
      assertEditable: vi.fn(async () => undefined),
      findRunningContextForEdit: vi.fn(async () => null),
      projectToAliases: vi.fn(async () => ({ failed: [] })),
    };
    const handler = vi.fn(async (..._args: unknown[]) => ({ success: true as const, data: undefined }));
    const wrapped = createProjectDefinitionEditRouting(
      { data: () => ({ runConfigurationOperation: (_name: string, operation: () => Promise<unknown>) => operation() }) } as never,
      () => editor as unknown as TeamProjectDefinitionEditor,
    () => ({ hasPending: async () => false, begin: async () => undefined, clear: async () => undefined })
    )(handler, undefined, refuseSettingsRelaunchOfDefinition);
    return { editor, handler, wrapped };
  }
  const relaunch = { members: [], memberSettingsRelaunch: { memberName: 'alice' } };

  it('refuses it for a per-project team before the gate, writing nothing', async () => {
    const r = replaceRouting('logical');
    await expect(r.wrapped(event, 'builders', relaunch)).resolves.toEqual({
      success: false,
      error: PROJECT_TEAM_SETTINGS_RELAUNCH_MESSAGE,
    });
    expect(r.editor.assertEditable).not.toHaveBeenCalled();
    expect(r.handler).not.toHaveBeenCalled();
  });

  it('keeps an ordinary roster replace of a per-project team and the relaunch of an ordinary team', async () => {
    const logical = replaceRouting('logical');
    await expect(logical.wrapped(event, 'builders', { members: [] })).resolves.toMatchObject({ success: true });
    expect(logical.editor.projectToAliases).toHaveBeenCalledWith('builders');
    const native = replaceRouting('native');
    await expect(native.wrapped(event, 'legacy', relaunch)).resolves.toMatchObject({ success: true });
    expect(native.handler).toHaveBeenCalledWith(event, 'legacy', relaunch);
  });

  it('names a refusal only for a request that carries the relaunch intent', () => {
    expect(refuseSettingsRelaunchOfDefinition(undefined)).toBeNull();
    expect(refuseSettingsRelaunchOfDefinition({ members: [] })).toBeNull();
    expect(refuseSettingsRelaunchOfDefinition({ memberSettingsRelaunch: undefined })).toBeNull();
    expect(refuseSettingsRelaunchOfDefinition(relaunch)).toBe(PROJECT_TEAM_SETTINGS_RELAUNCH_MESSAGE);
  });
});
