import { describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createHostBackendRenderer } from '../../../src/features/agent-backend/renderer/createHostBackendRenderer';
import { createHostTeamLaunch } from '../../../src/features/agent-backend/renderer/createHostTeamLaunch';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';
import { resolveLaunchDialogPrefill } from '../../../src/renderer/components/team/dialogs/launchDialogPrefill';

import type {
  BackendLaunchConfigurationView,
  BackendLaunchSnapshot,
} from '../../../src/features/agent-backend/contracts/launch';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendRosterConfiguration } from '../../../src/features/agent-backend/contracts/roster';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamsAPI } from '../../../src/shared/types/api';

const launch: BackendLaunchSnapshot = {
  launchId: 'run',
  rosterRevision: 'original-revision',
  status: 'pending',
  ready: 0,
  expected: 1,
  retryCapability: 'same-binding-no-allocation-only',
  members: [
    {
      memberId: 'alice',
      generation: '1',
      attemptId: 'attempt',
      status: 'not-started',
      nativeReady: false,
      usable: false,
      controlAvailable: false,
      noAllocation: true,
      reason: 'not-started',
    },
  ],
};
const view: BackendLaunchConfigurationView = {
  launch,
  members: [
    {
      memberId: 'alice',
      label: 'Alice',
      role: 'lead',
      selected: {
        provider: 'claude',
        workspace: '/TEST/project',
        model: 'original-model',
        capabilities: ['model', 'effort', 'fastMode', 'permissions', 'context'],
        fastMode: false,
      },
    },
  ],
};
const handle = { handleId: 'TEST-original-owner' };
const choices = { members: [{ memberId: 'alice', model: 'selected-model', fastMode: false }] };
function fixture() {
  let current = true;
  const backend: AgentBackendApi = {
    getConnections: vi
      .fn()
      .mockResolvedValue({ state: 'ready', bindings: [{ handle, label: 'Team', members: [] }] }),
    invoke: vi.fn().mockImplementation(async (request) => ({
      ok: true,
      value:
        request.operation === 'team.launch.configuration.read'
          ? structuredClone(view)
          : structuredClone(launch),
    })),
  };
  const control = createHostTeamLaunch(
    backend,
    hostTeamSelectionKey(handle.handleId),
    () => current
  );
  return {
    backend,
    control,
    revoke: () => {
      current = false;
    },
  };
}
function rawLaunch() {
  return {
    ...launch,
    members: launch.members.map(({ generation, ...member }) => ({
      memberId: member.memberId,
      binding: { memberId: member.memberId, generation },
      attempt: member,
    })),
  };
}

describe('ordinary Host launch intent', () => {
  it('reads saved choices, captures original owner and submits one exact intent without legacy preflight', async () => {
    const f = fixture();
    const loaded = await f.control.read();
    expect(loaded.members[0].selected?.fastMode).toBe(false);
    await f.control.start(loaded, choices);
    expect(f.control.hasSubmitted()).toBe(true);
    expect(f.backend.invoke).toHaveBeenLastCalledWith({
      handle,
      commandId: expect.any(String),
      operation: 'team.launch.start',
      payload: { launchId: 'run', rosterRevision: 'original-revision', configuration: choices },
    });
    await expect(f.control.start(loaded, choices)).rejects.toThrow('already submitted');
    expect(
      vi.mocked(f.backend.invoke).mock.calls.filter(([r]) => r.operation === 'team.launch.start')
    ).toHaveLength(1);
  });
  it('does not generate another launch after uncertain or malformed results; read status remains available', async () => {
    for (const response of [
      { ok: false, code: 'hold', outcome: 'unknown' },
      { ok: true, value: null },
      new Error('transport failed'),
    ]) {
      const f = fixture();
      const loaded = await f.control.read();
      if (response instanceof Error) vi.mocked(f.backend.invoke).mockRejectedValueOnce(response);
      else
        vi.mocked(f.backend.invoke).mockResolvedValueOnce(
          response as Awaited<ReturnType<AgentBackendApi['invoke']>>
        );
      await expect(f.control.start(loaded, choices)).rejects.toThrow('unknown');
      await expect(f.control.start(loaded, choices)).rejects.toThrow('already submitted');
      expect(await f.control.read()).toEqual(view);
      expect(
        vi.mocked(f.backend.invoke).mock.calls.filter(([r]) => r.operation === 'team.launch.start')
      ).toHaveLength(1);
    }
  });
  it('retains a captured owner on refresh and refuses invalid selection or stale contexts before effect', async () => {
    const f = fixture();
    await f.control.read();
    vi.mocked(f.backend.getConnections).mockResolvedValueOnce({ state: 'ready', bindings: [] });
    await f.control.read();
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
    f.revoke();
    await expect(f.control.start(view, choices)).rejects.toThrow('context changed');
    expect(
      vi.mocked(f.backend.invoke).mock.calls.every(([r]) => r.operation !== 'team.launch.start')
    ).toBe(true);
    const other = createHostTeamLaunch(f.backend, 'host-team:WRONG', () => true);
    await expect(other.read()).rejects.toThrow('unavailable');
  });
  it('distinguishes a known rejection from an uncertain effect and never adopts an already admitted launch', async () => {
    const f = fixture();
    const loaded = await f.control.read();
    vi.mocked(f.backend.invoke).mockResolvedValueOnce({
      ok: false,
      code: 'conflict',
      outcome: 'rejected',
    });
    await expect(f.control.start(loaded, choices)).rejects.toThrow('refused');
    expect(f.control.hasSubmitted()).toBe(false);
    await expect(
      f.control.start(
        {
          ...loaded,
          launch: {
            ...launch,
            admission: { commandId: 'another-intent', sourceRosterRevision: 'original-revision' },
          },
        },
        choices
      )
    ).rejects.toThrow('already submitted');
  });
});

describe('launch configuration projection', () => {
  it('returns only selected contextual user fields on the control lane and preserves false', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        launch: rawLaunch(),
        members: [
          {
            ...view.members[0],
            selected: {
              ...view.members[0].selected,
              account: 'PRIVATE',
              env: { SECRET: 'PRIVATE' },
              executable: '/PRIVATE/bin',
            },
          },
        ],
      },
    });
    const facade = new BackendOperationsFacade({ request, lookup: vi.fn() });
    const result = await facade.invoke({
      handle,
      commandId: 'read',
      operation: 'team.launch.configuration.read',
      payload: {},
    });
    expect(result).toEqual({ ok: true, value: view });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(request).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ control: true, method: 'team.launch.configuration.read' })
    );
  });
  it('refuses duplicate/missing members, unadvertised options and malformed finite choices', async () => {
    for (const members of [
      [],
      [view.members[0], view.members[0]],
      [{ ...view.members[0], memberId: 'WRONG' }],
      [{ ...view.members[0], role: undefined }],
      [{ ...view.members[0], role: 'member' }],
      [
        {
          ...view.members[0],
          selected: { ...view.members[0].selected, capabilities: ['model'], effort: 'high' },
        },
      ],
      [{ ...view.members[0], selected: { ...view.members[0].selected, fastMode: 'false' } }],
    ]) {
      const request = vi
        .fn()
        .mockResolvedValue({ ok: true, value: { launch: rawLaunch(), members } });
      expect(
        await new BackendOperationsFacade({ request, lookup: vi.fn() }).invoke({
          handle,
          commandId: 'read',
          operation: 'team.launch.configuration.read',
          payload: {},
        })
      ).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

describe('direct Host controls share the ordinary Team read fence', () => {
  it('rejects an offline read that finishes after Launch, including an uncertain Launch response', async () => {
    const snapshot: BackendTeamSnapshot = {
      teamName: 'team',
      revision: 'a'.repeat(64),
      feed: { streamId: 'stream', sequence: 0, cursor: 'cursor' },
      members: [{ name: 'Alice', role: 'lead' }],
      tasks: [],
      messages: [],
      kanbanState: { teamName: 'team', reviewers: [], tasks: {} },
    };
    for (const uncertain of [false, true])
      for (const pendingRead of ['team.launch.read', 'process.list', 'team.roster.read']) {
        const f = fixture();
        const observation = deferred<Awaited<ReturnType<AgentBackendApi['invoke']>>>();
        const reading = deferred<void>();
        vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
          if (request.operation === 'team.snapshot') return { ok: true, value: snapshot };
          if (request.operation === pendingRead) {
            reading.resolve();
            return observation.promise;
          }
          if (request.operation === 'process.list') return { ok: true, value: [] };
          if (request.operation === 'team.launch.read' || request.operation === 'team.roster.read')
            return { ok: true, value: null };
          return uncertain
            ? { ok: false, code: 'hold', outcome: 'unknown' }
            : { ok: true, value: launch };
        });
        const adapter = createHostBackendRenderer(
          { getData: vi.fn() } as unknown as TeamsAPI,
          f.backend,
          () => () => true
        );
        const pending = adapter.teams.getData(hostTeamSelectionKey(handle.handleId));
        const rejected = expect(pending).rejects.toThrow('mutation boundary');
        await reading.promise;
        await adapter.backend.invoke({
          handle,
          commandId: 'start',
          operation: 'team.launch.start',
          payload: { launchId: 'run', rosterRevision: 'original-revision', configuration: choices },
        });
        observation.resolve({ ok: true, value: null });
        await rejected;
        expect(vi.mocked(f.backend.invoke).mock.calls.every(([request]) => request.handle.handleId === handle.handleId)).toBe(true);
      }
  });
  it('holds a late mutation response and never dispatches in a stale context', async () => {
    const f = fixture();
    let current = true;
    const effect = deferred<Awaited<ReturnType<AgentBackendApi['invoke']>>>();
    vi.mocked(f.backend.invoke).mockReturnValueOnce(effect.promise);
    const adapter = createHostBackendRenderer({} as TeamsAPI, f.backend, () => () => current);
    const request = {
      handle,
      commandId: 'start',
      operation: 'team.launch.start' as const,
      payload: { launchId: 'run', rosterRevision: 'original-revision', configuration: choices },
    };
    const pending = adapter.backend.invoke(request);
    current = false;
    effect.resolve({ ok: true, value: launch });
    expect(await pending).toEqual({ ok: false, code: 'forbidden', outcome: 'unknown' });
    expect(await adapter.backend.invoke(request)).toEqual({
      ok: false,
      code: 'forbidden',
      outcome: 'not-dispatched',
    });
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('existing Launch dialog saved-request contract', () => {
  const key = hostTeamSelectionKey(handle.handleId);
  function staleLead() {
    return {
      name: 'Alice',
      agentType: 'team-lead',
      status: 'idle' as const,
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
      providerId: 'codex' as const,
      model: 'WRONG-observed-model',
      effort: 'high' as const,
    };
  }
  const stalePreviousLaunch = {
    providerId: 'codex' as const,
    model: 'WRONG-previous-model',
    effort: 'high',
    fastMode: 'on' as const,
    limitContext: true,
  };
  function configuredRoster(): BackendRosterConfiguration {
    return {
      revision: 'b'.repeat(64),
      savedSettings: {
        cwd: '/TEST/project',
        displayName: 'Configured team',
        description: 'Saved description',
        color: 'blue',
        prompt: 'Saved launch prompt',
        providerId: 'anthropic',
        providerBackendId: 'adapter',
        model: 'claude-opus-4-6',
        effort: 'medium',
        fastMode: 'off',
        syncModelsWithLead: false,
        limitContext: false,
        skipPermissions: false,
        worktree: 'TEST-worktree',
        extraCliArgs: '--verbose',
        allowExperimentalLocalModels: false,
      },
      members: [
        {
          memberId: 'alice',
          name: 'Alice',
          role: 'lead',
          settings: { model: 'WRONG-lead-member-model' },
        },
        {
          memberId: 'bob',
          name: 'Bob',
          role: 'member',
          settings: {
            role: 'Reviewer',
            workflow: 'Review carefully',
            isolation: 'worktree',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            cwd: '/TEST/bob',
            model: 'codex-configured',
            effort: 'high',
            fastMode: 'off',
            mcpPolicy: { mode: 'appOnly' },
          },
        },
      ],
      removedMembers: [],
    };
  }
  function productSnapshot(): BackendTeamSnapshot {
    return {
      teamName: 'team',
      revision: 'a'.repeat(64),
      configurationRevision: 'b'.repeat(64),
      feed: { streamId: 'stream', sequence: 0, cursor: 'cursor' },
      members: [
        { name: 'Alice', role: 'lead' },
        { name: 'Bob', role: 'member' },
      ],
      tasks: [],
      messages: [],
      kanbanState: { teamName: 'team', reviewers: [], tasks: {} },
    };
  }
  function savedFixture(roster = configuredRoster(), snapshot = productSnapshot()) {
    const f = fixture();
    vi.mocked(f.backend.invoke).mockImplementation(
      async (request) =>
        ({
          ok: true,
          value:
            request.operation === 'team.roster.read'
              ? structuredClone(roster)
              : request.operation === 'team.snapshot'
                ? structuredClone(snapshot)
                : request.operation === 'process.list'
                  ? []
                  : request.operation === 'team.launch.read'
                    ? null
                    : (() => {
                        throw new Error(`Unexpected operation: ${request.operation}`);
                      })(),
        }) as Awaited<ReturnType<AgentBackendApi['invoke']>>
    );
    const legacy = { getSavedRequest: vi.fn(), getData: vi.fn() } as unknown as TeamsAPI;
    return { ...f, legacy };
  }

  it('hydrates all configured choices from the roster without reading native runtime configuration', async () => {
    const { createHostTeamsApi } =
      await import('../../../src/features/agent-backend/renderer/createHostTeamsApi');
    const roster = configuredRoster();
    roster.members[1].settings.role = 'team-lead';
    roster.members[0].settingsFingerprint = 'c'.repeat(64);
    roster.members[1].settingsFingerprint = 'd'.repeat(64);
    const f = savedFixture(roster);
    const adapter = createHostTeamsApi(f.legacy, f.backend);
    const result = await adapter.getSavedRequest(key);
    expect(result).toEqual({
      ...roster.savedSettings,
      teamName: key,
      savedSettingsFingerprint: roster.revision,
      members: [{ name: 'Bob', ...roster.members[1].settings }],
    });
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)).toEqual([
      'team.roster.read',
    ]);
    const prefill = resolveLaunchDialogPrefill({
      members: [staleLead()],
      previousLaunchParams: stalePreviousLaunch,
      savedRequest: result,
      multimodelEnabled: true,
      storedProviderId: 'codex',
      storedEffort: 'high',
      storedFastMode: 'on',
      storedLimitContext: true,
      getStoredModel: () => 'WRONG-local-default',
    });
    expect(prefill).toMatchObject({
      providerId: 'anthropic',
      model: 'claude-opus-4-6',
      effort: 'medium',
      fastMode: 'off',
      limitContext: false,
    });
    const data = await adapter.getData(key);
    expect(data.config.projectPath).toBe('/TEST/project');
    expect(data.members[0]).toMatchObject({
      name: 'Alice',
      model: 'claude-opus-4-6',
      configuredRuntimeSettings: {
        providerId: 'anthropic',
        providerBackendId: 'adapter',
        model: 'claude-opus-4-6',
        effort: 'medium',
        fastMode: 'off',
      },
    });
    expect(data.members[1]).toMatchObject({
      name: 'Bob',
      role: 'team-lead',
      agentType: 'general-purpose',
      configuredSettingsFingerprint: 'd'.repeat(64),
      cwd: '/TEST/bob',
      configuredRuntimeSettings: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'codex-configured',
        effort: 'high',
        fastMode: 'off',
      },
    });
    expect(f.legacy.getSavedRequest).not.toHaveBeenCalled();
    expect(f.legacy.getData).not.toHaveBeenCalled();
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)).toEqual([
      'team.roster.read',
      'team.snapshot',
      'team.launch.read',
      'process.list',
      'team.roster.read',
    ]);
  });

  it('returns unknown settings as null and preserves explicit defaults without inventing a model', async () => {
    const { createHostTeamsApi } =
      await import('../../../src/features/agent-backend/renderer/createHostTeamsApi');
    const roster = configuredRoster();
    delete roster.savedSettings;
    const unknown = savedFixture(roster);
    expect(
      await createHostTeamsApi(unknown.legacy, unknown.backend).getSavedRequest(key)
    ).toBeNull();
    const unknownData = await createHostTeamsApi(unknown.legacy, unknown.backend).getData(key);
    expect(unknownData.members[1]).toMatchObject({
      name: 'Bob',
      workflow: 'Review carefully',
      providerId: 'codex',
      model: 'codex-configured',
      mcpPolicy: { mode: 'appOnly' },
      configuredRuntimeSettings: { providerId: 'codex', model: 'codex-configured' },
    });
    roster.savedSettings = { cwd: '/TEST/project' };
    const defaults = savedFixture(roster);
    const saved = await createHostTeamsApi(defaults.legacy, defaults.backend).getSavedRequest(key);
    expect(saved).toEqual({
      teamName: key,
      cwd: '/TEST/project',
      savedSettingsFingerprint: roster.revision,
      members: [{ name: 'Bob', ...roster.members[1].settings }],
    });
    expect(saved).not.toHaveProperty('model');
    expect(saved).not.toHaveProperty('providerId');
    const defaultsData = await createHostTeamsApi(defaults.legacy, defaults.backend).getData(key);
    expect(defaultsData.members[0].configuredRuntimeSettings?.model).toBeUndefined();
    const prefill = resolveLaunchDialogPrefill({
      members: [staleLead()],
      previousLaunchParams: stalePreviousLaunch,
      savedRequest: saved,
      multimodelEnabled: true,
      storedProviderId: 'codex',
      storedEffort: 'high',
      storedFastMode: 'on',
      storedLimitContext: true,
      getStoredModel: () => 'WRONG-local-default',
    });
    expect(prefill).toMatchObject({
      providerId: 'anthropic',
      model: '',
      effort: '',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('rejects a saved settings read when the context changes while the roster read is pending', async () => {
    const { createHostTeamsApi } =
      await import('../../../src/features/agent-backend/renderer/createHostTeamsApi');
    const f = savedFixture();
    const entered = deferred<void>();
    const response = deferred<Awaited<ReturnType<AgentBackendApi['invoke']>>>();
    vi.mocked(f.backend.invoke).mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    let current = true;
    const adapter = createHostTeamsApi(f.legacy, f.backend, () => () => current);
    const pending = adapter.getSavedRequest(key);
    await entered.promise;
    current = false;
    response.resolve({ ok: true, value: configuredRoster() });
    await expect(pending).rejects.toThrow('Team context changed');
    expect(f.legacy.getSavedRequest).not.toHaveBeenCalled();
  });

  it.each(['revision', 'members'] as const)(
    'keeps product data readable but refuses saved settings from a different %s',
    async (mismatch) => {
      const { createHostTeamsApi } =
        await import('../../../src/features/agent-backend/renderer/createHostTeamsApi');
      const snapshot = productSnapshot();
      if (mismatch === 'revision') snapshot.configurationRevision = 'c'.repeat(64);
      else snapshot.members[1] = { name: 'Another member', role: 'member' };
      const f = savedFixture(configuredRoster(), snapshot);
      const data = await createHostTeamsApi(f.legacy, f.backend).getData(key);
      expect(data.members.map((member) => member.name)).toEqual(
        snapshot.members.map((member) => member.name)
      );
      expect(data.members.every((member) => member.configuredRuntimeSettings === undefined)).toBe(
        true
      );
      expect(data.config.projectPath).toBeUndefined();
      expect(data.warnings).toContain('Saved launch settings are unavailable.');
      expect(f.legacy.getData).not.toHaveBeenCalled();
    }
  );
});
