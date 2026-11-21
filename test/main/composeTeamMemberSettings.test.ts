import { describe, expect, it, vi } from 'vitest';

import {
  TeamProjectContextLaunchGate,
  TeamProjectDefinitionEditor,
} from '../../src/features/team-project-context/main';
import { routeMemberSettingsWrites } from '../../src/main/composeTeamMemberSettings';
import {
  PROJECT_COPY_EDIT_MESSAGE,
  PROJECT_TEAM_LEAD_SETTINGS_MESSAGE,
} from '../../src/main/ipc/teams/teamProjectDefinitionEdit';

import type {
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../src/features/team-provisioning/contracts';
import type { TeamMemberSettingsFeatureApi } from '../../src/features/team-provisioning/main';
import type { TeamCreateRequest, TeamRuntimeState } from '../../src/shared/types/team';

/**
 * Member settings of a per-project team go through the definition router with
 * the REAL editor and the REAL stopped gate (storage and runtime are fakes): one
 * write path (the ordinary member settings use case on the logical name), under
 * the logical-team lock, refused while a project is not stopped, followed by the
 * projection onto every stopped project copy. Copies, the lead of a per-project
 * team and unreadable teams are refused before anything is written; an ordinary
 * team is passed through exactly as before.
 */

type Context = { executionTeamName: string; state: 'ready' | 'reserved' };
type Member = TeamCreateRequest['members'][number];

function world(options: { contexts?: Context[]; unreadable?: string[] } = {}) {
  const contexts: Context[] = options.contexts ?? [
    { executionTeamName: 'ptc-a', state: 'ready' },
    { executionTeamName: 'ptc-b', state: 'ready' },
  ];
  const running = new Set<string>();
  const roster = (role: string): Member[] => [{ name: 'alice', role }, { name: 'bob' }];
  const saved = new Map<string, Partial<TeamCreateRequest>>([
    ['builders', { teamName: 'builders', members: roster('dev'), displayName: 'Builders' }],
    ['ptc-a', { teamName: 'ptc-a', members: roster('dev'), displayName: 'Builders' }],
    ['ptc-b', { teamName: 'ptc-b', members: roster('dev'), displayName: 'Builders' }],
  ]);
  const registry = {
    list: vi.fn(async () => contexts),
    isOwnedExecutionAlias: vi.fn(async (name: string) =>
      contexts.some((context) => context.executionTeamName === name)
    ),
  };
  const runtime = {
    hasProvisioningRun: vi.fn((_name: string) => false),
    getRuntimeState: vi.fn(
      async (name: string): Promise<TeamRuntimeState> =>
        ({
          teamName: name,
          isAlive: running.has(name),
          runId: null,
          progress: null,
        }) as TeamRuntimeState
    ),
  };
  const projected: string[] = [];
  const editor = new TeamProjectDefinitionEditor(
    registry,
    new TeamProjectContextLaunchGate(registry, runtime),
    {
      getMode: vi.fn(async (name: string) => {
        if (options.unreadable?.includes(name)) throw new Error('Team metadata is unreadable');
        return name === 'builders' ? ('per_project' as const) : ('shared' as const);
      }),
      getSavedRequest: vi.fn(
        async (name: string) => (saved.get(name) ?? null) as TeamCreateRequest | null
      ),
      replaceMembers: vi.fn(async (name: string, request: { members: Member[] }) => {
        projected.push(name);
        saved.set(name, { ...saved.get(name), members: request.members });
      }),
      updateDisplayMetadata: vi.fn(async () => undefined),
      launchSettings: { save: vi.fn(async () => undefined) },
    },
    async () => undefined
  );
  let lockHeld = false;
  const runConfigurationOperation = vi.fn(
    async <T>(_name: string, operation: () => Promise<T>): Promise<T> => {
      lockHeld = true;
      try {
        return await operation();
      } finally {
        lockHeld = false;
      }
    }
  );
  const writtenInsideLock: boolean[] = [];
  const completed = (effect: 'persisted_only' | 'no_changes'): UpdateMemberSettingsResult => ({
    outcome: 'completed',
    effect,
    memberName: 'alice',
    previousFingerprint: 'before',
    currentFingerprint: effect === 'no_changes' ? 'before' : 'after',
    replayed: false,
  });
  const feature = {
    updateMemberSettings: vi.fn(async (request: UpdateMemberSettingsRequest) => {
      writtenInsideLock.push(lockHeld);
      // The ordinary use case writes the members file of the name it is given.
      if (request.teamName === 'builders' && request.targetKind === 'member') {
        saved.set('builders', {
          ...saved.get('builders'),
          members: roster(request.settings.role ?? ''),
        });
      }
      return completed(
        request.targetKind === 'member' && request.settings.role === 'dev'
          ? 'no_changes'
          : 'persisted_only'
      );
    }),
    getMemberSettingsTarget: vi.fn(async () => null),
  } satisfies TeamMemberSettingsFeatureApi;
  const routed = routeMemberSettingsWrites(
    feature,
    {
      data: () => ({ runConfigurationOperation }) as never,
      runtime: () => ({}) as never,
      run: () => ({}) as never,
    },
    () => editor
  );
  return {
    routed,
    feature,
    saved,
    projected,
    running,
    runConfigurationOperation,
    writtenInsideLock,
  };
}

function memberRequest(teamName: string, role = 'senior dev'): UpdateMemberSettingsRequest {
  return {
    commandId: 'c-1',
    idempotencyKey: 'c-1',
    teamName,
    memberName: 'alice',
    expectedFingerprint: 'before',
    targetKind: 'member',
    settings: {
      role,
      workflow: null,
      isolation: null,
      providerId: null,
      providerBackendId: null,
      model: null,
      effort: null,
      fastMode: null,
      mcpPolicy: null,
    },
  };
}

describe('member settings of a per-project team', () => {
  it('writes the definition under the logical lock, then refreshes every stopped project copy', async () => {
    const w = world();
    await expect(w.routed.updateMemberSettings(memberRequest('builders'))).resolves.toMatchObject({
      effect: 'persisted_only',
    });
    expect(w.runConfigurationOperation).toHaveBeenCalledWith('builders', expect.any(Function));
    expect(w.writtenInsideLock).toEqual([true]);
    expect(w.feature.updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'builders' })
    );
    // Both projects see the definition; neither got a value of its own.
    expect(w.projected.sort()).toEqual(['ptc-a', 'ptc-b']);
    for (const copy of ['ptc-a', 'ptc-b']) {
      expect(w.saved.get(copy)?.members?.[0]).toMatchObject({ name: 'alice', role: 'senior dev' });
    }
  });

  it('does not touch the copies when nothing changed', async () => {
    const w = world();
    await w.routed.updateMemberSettings(memberRequest('builders', 'dev'));
    expect(w.projected).toEqual([]);
  });

  it('refuses while any project runs, writing nothing anywhere', async () => {
    const w = world();
    w.running.add('ptc-b');
    await expect(w.routed.updateMemberSettings(memberRequest('builders'))).rejects.toThrow(
      /stop it in every project/
    );
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
    expect(w.projected).toEqual([]);
  });

  it('refuses while a project is still being prepared (unreconciled reservation)', async () => {
    const w = world({
      contexts: [
        { executionTeamName: 'ptc-a', state: 'ready' },
        { executionTeamName: 'ptc-c', state: 'reserved' },
      ],
    });
    await expect(w.routed.updateMemberSettings(memberRequest('builders'))).rejects.toThrow(
      /prepared/
    );
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
  });

  it('refuses a project copy: it never gets settings of its own', async () => {
    const w = world();
    await expect(w.routed.updateMemberSettings(memberRequest('ptc-a'))).rejects.toThrow(
      PROJECT_COPY_EDIT_MESSAGE
    );
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
    expect(w.runConfigurationOperation).not.toHaveBeenCalled();
  });

  it('refuses the lead of a per-project team (its runtime is a launch setting of the team)', async () => {
    const w = world();
    const lead: UpdateMemberSettingsRequest = {
      ...memberRequest('builders'),
      memberName: 'team-lead',
      targetKind: 'lead',
      leadRuntime: { model: 'other', effort: 'low' },
    } as UpdateMemberSettingsRequest;
    await expect(w.routed.updateMemberSettings(lead)).rejects.toThrow(
      PROJECT_TEAM_LEAD_SETTINGS_MESSAGE
    );
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
    expect(w.runConfigurationOperation).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable team metadata', async () => {
    const w = world({ unreadable: ['broken'] });
    await expect(w.routed.updateMemberSettings(memberRequest('broken'))).rejects.toThrow(
      /unreadable/
    );
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
  });

  it('passes an ordinary team (and its lead) through unchanged: no lock, no gate, no projection', async () => {
    const w = world();
    w.running.add('legacy');
    await w.routed.updateMemberSettings(memberRequest('legacy'));
    const lead = {
      ...memberRequest('legacy'),
      targetKind: 'lead',
      leadRuntime: { model: null, effort: null },
    };
    await w.routed.updateMemberSettings(lead as UpdateMemberSettingsRequest);
    expect(w.feature.updateMemberSettings).toHaveBeenCalledTimes(2);
    expect(w.writtenInsideLock).toEqual([false, false]);
    expect(w.runConfigurationOperation).not.toHaveBeenCalled();
    expect(w.projected).toEqual([]);
  });

  it('reads a member target without any routing', async () => {
    const w = world();
    await w.routed.getMemberSettingsTarget({ teamName: 'ptc-a', memberName: 'alice' });
    expect(w.feature.getMemberSettingsTarget).toHaveBeenCalledWith({
      teamName: 'ptc-a',
      memberName: 'alice',
    });
  });
});
