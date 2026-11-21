import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ dependencies: null as unknown }));

vi.mock('../../src/features/team-provisioning/main', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/features/team-provisioning/main')>();
  return {
    ...original,
    createNodeTeamMemberSettingsFeature: vi.fn((dependencies: unknown) => {
      captured.dependencies = dependencies;
      return { updateMemberSettings: vi.fn(), getMemberSettingsTarget: vi.fn() };
    }),
  };
});

import {
  TeamMetadataUnreadableError,
  TeamProjectContextLaunchConflictError,
  TeamProjectContextLaunchGate,
  TeamProjectDefinitionEditor,
} from '../../src/features/team-project-context/main';
import { fingerprintMemberSettingsTarget } from '../../src/features/team-provisioning/main';
import {
  composeTeamMemberSettings,
  memberSettingsRefusalOf,
  routeMemberSettingsWrites,
} from '../../src/main/composeTeamMemberSettings';
import { ProjectCopyEditError } from '../../src/main/ipc/teams/teamProjectDefinitionEdit';
import { definitionLeadTarget } from '../../src/main/definitionLeadSettings';

import type { DefinitionLaunchSettings } from '../../src/features/team-project-context/main';
import type {
  MemberSettingsTarget,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../src/features/team-provisioning/contracts';
import type { TeamMemberSettingsFeatureApi } from '../../src/features/team-provisioning/main';
import type { TeamCreateRequest, TeamRuntimeState } from '../../src/shared/types/team';

/**
 * Member settings of a per-project team go through the definition router with
 * the REAL editor and the REAL stopped gate (storage and runtime are fakes):
 * under the logical-team lock, refused while a project is not stopped, followed
 * by the projection onto every stopped project copy. A teammate is written by
 * the ordinary member settings use case on the logical name; the lead by the
 * definition's launch settings store (the store a launch records into), which
 * the projection then carries into the copies. Copies and unreadable teams are
 * refused with a code before anything is written; an ordinary team is passed
 * through exactly as before.
 */

type Context = { executionTeamName: string; state: 'ready' | 'reserved' };
type Member = TeamCreateRequest['members'][number];

const NO_SETTINGS = {
  role: null,
  workflow: null,
  isolation: null,
  providerId: null,
  providerBackendId: null,
  model: null,
  effort: null,
  fastMode: null,
  mcpPolicy: null,
} as const;

function world(options: { contexts?: Context[]; unreadable?: string[] } = {}) {
  const contexts: Context[] = options.contexts ?? [
    { executionTeamName: 'ptc-a', state: 'ready' },
    { executionTeamName: 'ptc-b', state: 'ready' },
  ];
  const running = new Set<string>();
  const roster = (role: string): Member[] => [{ name: 'alice', role }, { name: 'bob' }];
  const team = (teamName: string): Partial<TeamCreateRequest> => ({
    teamName,
    members: roster('dev'),
    displayName: 'Builders',
    providerId: 'anthropic',
    model: 'model-one',
    effort: 'medium',
  });
  const saved = new Map<string, Partial<TeamCreateRequest>>(
    ['builders', 'ptc-a', 'ptc-b', 'legacy'].map((name) => [name, team(name)])
  );
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
  const launchSaves: { team: string; settings: DefinitionLaunchSettings }[] = [];
  // One launch settings store, as in the app: the lead write and the projection share it.
  const launchSettings = {
    read: vi.fn(async (name: string): Promise<DefinitionLaunchSettings> => {
      const request = saved.get(name) ?? {};
      return { providerId: request.providerId, model: request.model, effort: request.effort };
    }),
    save: vi.fn(async (name: string, settings: DefinitionLaunchSettings) => {
      launchSaves.push({ team: name, settings });
      saved.set(name, { ...saved.get(name), ...settings });
    }),
  };
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
      launchSettings,
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
  let nextEffect: 'persisted_only' | 'no_changes' | 'recovery_required' | 'team_relaunch_required' =
    'persisted_only';
  const completed = (): UpdateMemberSettingsResult => ({
    outcome: 'completed',
    effect: nextEffect,
    memberName: 'alice',
    previousFingerprint: 'before',
    currentFingerprint: 'after',
    replayed: false,
  });
  // The saved lead of every team: a synthetic lead row without member settings of its own.
  const savedLead: MemberSettingsTarget = {
    name: 'team-lead',
    agentType: 'team-lead',
    agentId: null,
    joinedAt: null,
    settings: { ...NO_SETTINGS, providerId: 'opencode', model: 'row-model-is-not-the-lead' },
  };
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
      return completed();
    }),
    getMemberSettingsTarget: vi.fn(async ({ memberName }: { memberName: string }) =>
      memberName === 'team-lead' ? savedLead : null
    ),
  } satisfies TeamMemberSettingsFeatureApi;
  const routed = routeMemberSettingsWrites(
    feature,
    {
      data: () => ({ runConfigurationOperation }) as never,
      runtime: () => ({}) as never,
      run: () => ({}) as never,
    },
    () => ({ editor, launchSettings: launchSettings as never })
  );
  return {
    routed,
    feature,
    saved,
    projected,
    launchSaves,
    running,
    runConfigurationOperation,
    writtenInsideLock,
    setEffect: (effect: typeof nextEffect) => {
      nextEffect = effect;
    },
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
    settings: { ...NO_SETTINGS, role },
  };
}

function leadRequest(
  teamName: string,
  expectedFingerprint: string,
  leadRuntime: { model: string | null; effort: 'high' | 'medium' | null }
): UpdateMemberSettingsRequest {
  return {
    commandId: 'c-lead',
    idempotencyKey: 'c-lead',
    teamName,
    memberName: 'team-lead',
    expectedFingerprint,
    targetKind: 'lead',
    leadRuntime,
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
    // Both projects see the definition; neither got a value of its own.
    expect(w.projected.sort()).toEqual(['ptc-a', 'ptc-b']);
    for (const copy of ['ptc-a', 'ptc-b']) {
      expect(w.saved.get(copy)?.members?.[0]).toMatchObject({ name: 'alice', role: 'senior dev' });
    }
  });

  it('projects after a partly restored write (recovery required), not after a refusal to relaunch', async () => {
    const recovered = world();
    recovered.setEffect('recovery_required');
    await recovered.routed.updateMemberSettings(memberRequest('builders'));
    expect(recovered.projected.sort()).toEqual(['ptc-a', 'ptc-b']);

    for (const effect of ['no_changes', 'team_relaunch_required'] as const) {
      const unchanged = world();
      unchanged.setEffect(effect);
      // Nothing was written by the use case, so the copies are left alone.
      await unchanged.routed.updateMemberSettings(memberRequest('builders', 'dev'));
      expect(unchanged.projected).toEqual([]);
    }
  });

  it('refuses with a code while any project runs, writing nothing anywhere', async () => {
    const w = world();
    w.running.add('ptc-b');
    await expect(w.routed.updateMemberSettings(memberRequest('builders'))).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'project_running',
      message: expect.stringContaining('stop it in every project'),
    });
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
    expect(w.projected).toEqual([]);
  });

  it('refuses with a code while a project is still being prepared (unreconciled reservation)', async () => {
    const w = world({
      contexts: [
        { executionTeamName: 'ptc-a', state: 'ready' },
        { executionTeamName: 'ptc-c', state: 'reserved' },
      ],
    });
    await expect(w.routed.updateMemberSettings(memberRequest('builders'))).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'project_unreconciled',
    });
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
  });

  it('refuses a project copy with a code: it never gets settings of its own', async () => {
    const w = world();
    for (const request of [
      memberRequest('ptc-a'),
      leadRequest('ptc-a', 'any', { model: 'x', effort: 'high' }),
    ]) {
      await expect(w.routed.updateMemberSettings(request)).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'project_copy',
      });
    }
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
    expect(w.runConfigurationOperation).not.toHaveBeenCalled();
    expect(w.launchSaves).toEqual([]);
  });

  it('fails closed on unreadable team metadata (an unknown error is not turned into a refusal)', async () => {
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
    await w.routed.updateMemberSettings(
      leadRequest('legacy', 'any', { model: null, effort: null })
    );
    expect(w.feature.updateMemberSettings).toHaveBeenCalledTimes(2);
    expect(w.writtenInsideLock).toEqual([false, false]);
    expect(w.runConfigurationOperation).not.toHaveBeenCalled();
    expect(w.projected).toEqual([]);
    expect(w.launchSaves).toEqual([]);
  });
});

describe('the lead of a per-project team', () => {
  const shownLead = async (w: ReturnType<typeof world>) => {
    const target = await w.routed.getMemberSettingsTarget({
      teamName: 'builders',
      memberName: 'team-lead',
    });
    if (!target) throw new Error('no lead target');
    return target;
  };

  it('is shown with the team launch settings, not with a member row', async () => {
    const w = world();
    expect((await shownLead(w)).settings).toMatchObject({
      providerId: 'anthropic',
      model: 'model-one',
      effort: 'medium',
    });
    // An ordinary team's lead is the saved member target as is.
    const legacy = await w.routed.getMemberSettingsTarget({
      teamName: 'legacy',
      memberName: 'team-lead',
    });
    expect(legacy?.settings.model).toBe('row-model-is-not-the-lead');
  });

  it('saves model and effort into the definition while every project is stopped, and the copies follow', async () => {
    const w = world();
    const before = fingerprintMemberSettingsTarget(await shownLead(w));
    await expect(
      w.routed.updateMemberSettings(
        leadRequest('builders', before, { model: 'model-two', effort: 'high' })
      )
    ).resolves.toMatchObject({ outcome: 'completed', effect: 'persisted_only' });
    expect(w.launchSaves[0]).toEqual({
      team: 'builders',
      settings: { model: 'model-two', effort: 'high' },
    });
    for (const copy of ['ptc-a', 'ptc-b']) {
      expect(w.saved.get(copy)).toMatchObject({ model: 'model-two', effort: 'high' });
    }
    // No member row and no use case: the lead is a launch setting of the team.
    expect(w.feature.updateMemberSettings).not.toHaveBeenCalled();
    expect((await shownLead(w)).settings).toMatchObject({ model: 'model-two', effort: 'high' });
  });

  it('clears to the provider default with null, and writes nothing when nothing changes', async () => {
    const w = world();
    const same = fingerprintMemberSettingsTarget(await shownLead(w));
    await expect(
      w.routed.updateMemberSettings(
        leadRequest('builders', same, { model: 'model-one', effort: 'medium' })
      )
    ).resolves.toMatchObject({ effect: 'no_changes' });
    expect(w.launchSaves).toEqual([]);
    await w.routed.updateMemberSettings(
      leadRequest('builders', same, { model: null, effort: null })
    );
    expect(w.launchSaves[0]?.settings).toEqual({ model: undefined, effort: undefined });
  });

  it('is refused while a project runs and on a stale fingerprint, writing nothing', async () => {
    const running = world();
    const fingerprint = fingerprintMemberSettingsTarget(await shownLead(running));
    running.running.add('ptc-a');
    await expect(
      running.routed.updateMemberSettings(
        leadRequest('builders', fingerprint, { model: 'm', effort: 'high' })
      )
    ).resolves.toMatchObject({ outcome: 'refused', reason: 'project_running' });

    const stale = world();
    await expect(
      stale.routed.updateMemberSettings(
        leadRequest('builders', 'stale', { model: 'm', effort: 'high' })
      )
    ).resolves.toMatchObject({ outcome: 'target_conflict', reason: 'target_changed' });
    expect([...running.launchSaves, ...stale.launchSaves]).toEqual([]);
  });

  it('keeps the identity of the saved lead and only its launch settings change', () => {
    const lead: MemberSettingsTarget = {
      name: 'lead',
      agentType: 'team-lead',
      agentId: 'lead@team',
      joinedAt: 7,
      settings: { ...NO_SETTINGS, role: 'Lead', providerId: 'opencode', model: 'row' },
    };
    expect(
      definitionLeadTarget(lead, { providerId: 'codex', model: ' m ', effort: 'low' })
    ).toEqual({
      ...lead,
      settings: {
        ...lead.settings,
        providerId: 'codex',
        model: 'm',
        effort: 'low',
        fastMode: null,
      },
    });
  });
});

describe('refusal codes', () => {
  it('names the refusals of the definition rules and nothing else', () => {
    expect(memberSettingsRefusalOf(new ProjectCopyEditError())).toBe('project_copy');
    expect(memberSettingsRefusalOf(new TeamMetadataUnreadableError('x'))).toBe(
      'team_metadata_unreadable'
    );
    expect(memberSettingsRefusalOf(new TeamProjectContextLaunchConflictError('x'))).toBe(
      'project_running'
    );
    expect(
      memberSettingsRefusalOf(new TeamProjectContextLaunchConflictError('x', 'launching'))
    ).toBe('project_launching');
    expect(
      memberSettingsRefusalOf(new TeamProjectContextLaunchConflictError('x', 'unreconciled'))
    ).toBe('project_unreconciled');
    expect(memberSettingsRefusalOf(new Error('disk full'))).toBeNull();
  });
});

describe('composeTeamMemberSettings', () => {
  it('uses the durable ledger only when internal storage selected it for the session', async () => {
    const isDurable = vi.fn(async () => false);
    composeTeamMemberSettings({
      commandLedger: { runner: { run: vi.fn() } as never, backend: { isDurable } },
      apis: { memberLifecycle: {}, runtime: {}, provisioningRun: {} } as never,
      data: {} as never,
      leadRuntime: {} as never,
    });
    const dependencies = captured.dependencies as {
      isDurableStorageAvailable?: () => Promise<boolean>;
    };
    await expect(dependencies.isDurableStorageAvailable?.()).resolves.toBe(false);
    expect(isDurable).toHaveBeenCalledOnce();

    composeTeamMemberSettings({
      commandLedger: { runner: null, backend: null },
      apis: { memberLifecycle: {}, runtime: {}, provisioningRun: {} } as never,
      data: {} as never,
      leadRuntime: {} as never,
    });
    expect(
      (captured.dependencies as { isDurableStorageAvailable?: unknown }).isDurableStorageAvailable
    ).toBeUndefined();
  });
});
