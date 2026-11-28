import { describe, expect, it, vi } from 'vitest';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { createHostDefinitionEdits } from '../../../src/features/agent-backend/renderer/createHostDefinitionEdits';
import { prepareHostProjectLaunch } from '../../../src/features/agent-backend/renderer/createHostProjectContextApi';
import { projectHostTeamSummaries } from '../../../src/features/agent-backend/renderer/projectHostTeamSummaries';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { memberSettingsTargetToMember } from '../../../src/features/team-provisioning/renderer/utils/memberSettingsTarget';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { BackendRosterConfiguration } from '../../../src/features/agent-backend/contracts/roster';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { TeamLaunchRequest, TeamSummary } from '../../../src/shared/types/team';

const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64);
const rootHandle = { handleId: 'TEST-logical' }, childHandle = { handleId: 'TEST-child' };
const key = hostTeamSelectionKey(rootHandle.handleId), childKey = hostTeamSelectionKey(childHandle.handleId);
function fixture() {
  let current = true, scopeVersion = 0;
  const bindings: BackendConnectionSnapshot['bindings'] = [
    { handle: { ...rootHandle }, label: 'TEST logical', ownerResourceRef: 'TEST-owner', teamResourceRef: 'TEST-root-resource', projectContextMode: 'per_project', members: [] },
    { handle: { ...childHandle }, label: 'TEST history', ownerResourceRef: 'TEST-owner', teamResourceRef: 'TEST-child-resource',
      projectContextMode: 'shared', projectContext: { logicalHandleId: rootHandle.handleId, projectPath: '/TEST/project', workContextId: 'TEST-work-context' }, members: [] },
  ];
  const configuration: BackendRosterConfiguration = { revision,
    savedSettings: { cwd: '/TEST/project', projectContextMode: 'per_project', displayName: 'TEST name', prompt: 'TEST authored' },
    members: [{ memberId: 'TEST-lead', name: 'team-lead', role: 'lead', settings: {}, settingsFingerprint: 'c'.repeat(64) },
      { memberId: 'TEST-alice', name: 'alice', role: 'member', settings: { role: 'Researcher' }, settingsFingerprint: 'd'.repeat(64) }], removedMembers: [] };
  const receipts = new Map<string, { commandId: string; revision: string }>();
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => ({ state: 'ready' as const, bindings })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async request => {
      if (request.operation === 'team.roster.read') return { ok: true, value: structuredClone(configuration) };
      if (request.operation === 'team.roster.replace') {
        const value = { commandId: request.commandId, revision: nextRevision }; receipts.set(request.commandId, value);
        configuration.revision = nextRevision;
        configuration.members = configuration.members.map(member => ({ ...member, settingsFingerprint: 'e'.repeat(64),
          ...(member.role === 'member' ? { settings: request.payload.members.find(row => row.name === member.name)! } : {}) }));
        if (request.payload.savedSettings) configuration.savedSettings = structuredClone(request.payload.savedSettings);
        return { ok: true, value };
      }
      if (request.operation === 'team.roster.lookup') return { ok: true, value: receipts.get(request.commandId) ?? null };
      if (request.operation === 'team.project-context.read') return { ok: true, value: { kind: 'team-project-context', histories: [],
        view: { mode: 'per_project', state: 'empty' } } };
      if (request.operation === 'team.project-context.prepare') return { ok: true, value: { kind: 'team-project-context', histories: [],
        view: { mode: 'per_project', state: 'ready', executionTeamName: childKey, projectPath: '/TEST/project', workContextId: 'TEST-work-context' },
        prepared: { executionHandle: childHandle, rosterCommandId: 'TEST-original-child-roster', sourceRevision: nextRevision } } };
      return { ok: false, code: 'invalid', outcome: 'not-dispatched' };
    }),
  };
  const legacy = { getProjectContextView: vi.fn(), updateConfig: vi.fn(), updateMemberSettings: vi.fn(), getMemberSettingsTarget: vi.fn(),
    definitionEdits: { updateConfig: vi.fn() } } as unknown as TeamsAPI;
  return { backend, legacy, configuration, bindings, current: () => current, revoke: () => { current = false; },
    replaceScope: () => { scopeVersion++; },
    teams: createHostTeamsApi(legacy, backend, () => {
      const originalScope = scopeVersion;
      return () => current && scopeVersion === originalScope;
    }) };
}
function settingsRequest(commandId = 'TEST-retry-settings') {
  return {
    commandId,
    idempotencyKey: commandId,
    teamName: key,
    memberName: 'alice',
    expectedFingerprint: 'd'.repeat(64),
    targetKind: 'member' as const,
    settings: {
      role: 'Reviewer',
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
function launch(): TeamLaunchRequest {
  return { teamName: key, cwd: '/TEST/project', command: { commandId: 'TEST-launch', idempotencyKey: 'TEST-launch' },
    savedSettingsFingerprint: revision, providerId: 'opencode', model: 'TEST/source-model', prompt: 'TEST one run',
    skipPermissions: false, worktree: 'TEST-worktree', extraCliArgs: undefined };
}

describe('Host project definition boundary', () => {
  it('routes readonly view and nested definition edits through the captured owner', async () => {
    const f = fixture();
    expect(await f.teams.getProjectContextView(key, '/TEST/project')).toEqual({ mode: 'per_project', state: 'empty' });
    await f.teams.definitionEdits!.updateConfig(key, { name: 'TEST renamed', language: 'ru', prompt: 'TEST next prompt' });
    const operation = vi.mocked(f.backend.invoke).mock.calls.find(([row]) => row.operation === 'team.roster.replace')![0];
    expect(operation.handle).toEqual(rootHandle);
    expect(operation.payload).toMatchObject({ expectedRevision: revision, savedSettings: {
      displayName: 'TEST renamed', language: 'ru', prompt: 'TEST next prompt', projectContextMode: 'per_project' } });
    expect(f.legacy.getProjectContextView).not.toHaveBeenCalled();
    expect(f.legacy.updateConfig).not.toHaveBeenCalled();
    expect(f.legacy.definitionEdits!.updateConfig).not.toHaveBeenCalled();
  });

  it('member editor uses the issued owner fingerprint instead of inventing a legacy target identity', async () => {
    const f = fixture(), target = await f.teams.getMemberSettingsTarget({ teamName: key, memberName: 'alice' });
    expect(target!.configuredSettingsFingerprint).toBe('d'.repeat(64));
    expect(memberSettingsTargetToMember(target!).configuredSettingsFingerprint).toBe('d'.repeat(64));
    expect(f.legacy.getMemberSettingsTarget).not.toHaveBeenCalled();
  });

  it('logical lead settings keep the saved provider/model and absent aliases remain absent', async () => {
    const f = fixture();
    Object.assign(f.configuration.savedSettings!, { providerId: 'opencode', providerBackendId: 'opencode-cli',
      model: 'TEST/model', effort: 'medium', fastMode: 'off' });
    const lead = await f.teams.getMemberSettingsTarget({ teamName: key, memberName: 'team-lead' });
    expect(lead?.settings).toMatchObject({ providerId: 'opencode', providerBackendId: 'opencode-cli',
      model: 'TEST/model', effort: 'medium', fastMode: 'off' });
    expect(await f.teams.getMemberSettingsTarget({ teamName: key, memberName: 'lead' })).toBeNull();
  });

  it('settings no-op still commits an original retrievable roster receipt for a following project launch', async () => {
    const f = fixture(), target = await f.teams.getMemberSettingsTarget({ teamName: key, memberName: 'alice' });
    const request = { commandId: 'TEST-settings', idempotencyKey: 'TEST-settings', teamName: key, memberName: 'alice',
      expectedFingerprint: target!.configuredSettingsFingerprint!, targetKind: 'member' as const, settings: target!.settings };
    const result = await f.teams.updateMemberSettings(request);
    expect(result).toMatchObject({ outcome: 'completed', effect: 'no_changes', currentFingerprint: 'e'.repeat(64) });
    expect((await f.teams.updateMemberSettings(request)).replayed).toBe(true);
    expect(vi.mocked(f.backend.invoke).mock.calls.filter(([row]) => row.operation === 'team.roster.replace')).toHaveLength(1);
    expect(f.legacy.updateMemberSettings).not.toHaveBeenCalled();
  });

  it('conflicting same-command settings calls are refused before any overlapping capture can replace intent', async () => {
    const f = fixture(); let resolve!: () => void;
    const wait = new Promise<void>(done => { resolve = done; });
    vi.mocked(f.backend.getConnections).mockImplementationOnce(async () => { await wait; return { state: 'ready', bindings: f.bindings }; });
    const request = { commandId: 'TEST-settings', idempotencyKey: 'TEST-settings', teamName: key, memberName: 'team-lead',
      expectedFingerprint: 'c'.repeat(64), targetKind: 'lead' as const, leadRuntime: { model: null, effort: null } };
    const first = f.teams.updateMemberSettings(request);
    await expect(f.teams.updateMemberSettings({ ...request, leadRuntime: { model: 'TEST-other', effort: null } })).rejects.toThrow('intent-conflict');
    resolve(); await first;
    expect(vi.mocked(f.backend.invoke).mock.calls.filter(([row]) => row.operation === 'team.roster.replace')).toHaveLength(1);
  });

  it('project launch carries all captured options and selects only the verified existing child receipt', async () => {
    const f = fixture(), input = launch();
    const result = await prepareHostProjectLaunch({ backend: f.backend, resolve: async () => f.bindings[0] }, input, f.current);
    expect(result).toMatchObject({ teamName: childKey, cwd: '/TEST/project', savedRosterCommandId: 'TEST-original-child-roster', prompt: 'TEST one run' });
    const request = vi.mocked(f.backend.invoke).mock.calls.find(([row]) => row.operation === 'team.project-context.prepare')![0];
    expect(request).toMatchObject({ handle: rootHandle, commandId: 'TEST-launch:project', payload: {
      expectedRevision: revision, launchSettings: { providerId: 'opencode', model: 'TEST/source-model',
        skipPermissions: false, worktree: 'TEST-worktree', extraCliArgs: null } } });
    expect(input.teamName).toBe(key);
  });

  it('mutating the connection-list object during an await never retargets the original preparation', async () => {
    const f = fixture(), invoke = f.backend.invoke;
    f.backend.invoke = vi.fn<AgentBackendApi['invoke']>(async request => {
      if (request.operation === 'team.project-context.read') Object.assign(f.bindings[0].handle, { handleId: 'TEST-replacement' });
      return invoke(request);
    });
    await expect(prepareHostProjectLaunch({ backend: f.backend, resolve: async () => f.bindings[0] }, launch(), f.current)).rejects.toThrow('project-context-changed');
    expect(vi.mocked(f.backend.invoke).mock.calls.find(([row]) => row.operation === 'team.project-context.prepare')![0].handle).toEqual(rootHandle);
  });

  it('a child from another owner or original project cannot be adopted after prepare', async () => {
    const f = fixture(); f.bindings[1].ownerResourceRef = 'TEST-foreign';
    await expect(prepareHostProjectLaunch({ backend: f.backend, resolve: async () => f.bindings[0] }, launch(), f.current)).rejects.toThrow('project-context-changed');
  });

  it('verified histories fold into logical rows without merging another owners similarly named child', () => {
    const f = fixture();
    const base = { displayName: 'TEST', description: '', memberCount: 2, taskCount: 1, lastActivity: null };
    const rows: TeamSummary[] = [{ ...base, teamName: key, projectContextMode: 'per_project' }, { ...base, teamName: childKey }];
    const result = projectHostTeamSummaries(rows, f.bindings);
    expect(result).toHaveLength(1); expect(result[0].taskCount).toBe(2);
    expect(result[0].projectHistoryContexts).toEqual([{ executionTeamName: childKey, projectPath: '/TEST/project', memberCount: 2 }]);
    expect(projectHostTeamSummaries([{ ...base, teamName: key, projectContextMode: 'shared' },
      { ...base, teamName: childKey }], f.bindings)).toHaveLength(1);
    f.bindings[1].ownerResourceRef = 'TEST-foreign';
    expect(projectHostTeamSummaries(rows, f.bindings)).toHaveLength(2);
  });

  it('retries a failed initial discovery with the same reserved settings command', async () => {
    const f = fixture(), request = settingsRequest();
    vi.mocked(f.backend.getConnections).mockRejectedValueOnce(new Error('TEST discovery unavailable'));
    await expect(f.teams.updateMemberSettings(request)).rejects.toThrow('TEST discovery unavailable');
    expect(f.backend.invoke).not.toHaveBeenCalled();

    expect(await f.teams.updateMemberSettings(request)).toMatchObject({
      outcome: 'completed', effect: 'persisted_only', replayed: true,
    });
    expect(f.backend.getConnections).toHaveBeenCalledTimes(2);
    const replacements = vi.mocked(f.backend.invoke).mock.calls
      .filter(([row]) => row.operation === 'team.roster.replace');
    expect(replacements).toHaveLength(1);
    expect(replacements[0]![0]).toMatchObject({
      handle: rootHandle, commandId: request.commandId,
      payload: { expectedRevision: revision },
    });
    expect(f.legacy.updateMemberSettings).not.toHaveBeenCalled();
  });

  it('retries the failed roster read only at the already resolved cloned handle', async () => {
    const f = fixture(), request = settingsRequest();
    vi.mocked(f.backend.invoke).mockRejectedValueOnce(new Error('TEST roster unavailable'));
    await expect(f.teams.updateMemberSettings(request)).rejects.toThrow('TEST roster unavailable');
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);

    Object.assign(f.bindings[0]!.handle, { handleId: 'TEST-replacement-owner' });
    vi.mocked(f.backend.getConnections).mockRejectedValue(new Error('TEST discovery must not repeat'));
    expect(await f.teams.updateMemberSettings(request)).toMatchObject({ outcome: 'completed' });
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
    for (const [operation] of vi.mocked(f.backend.invoke).mock.calls)
      expect(operation.handle).toEqual(rootHandle);
    expect(vi.mocked(f.backend.invoke).mock.calls
      .filter(([row]) => row.operation === 'team.roster.replace')).toHaveLength(1);
  });

  it.each(['discovery', 'configuration'] as const)(
    'concurrent retries share one %s capture and one settings mutation',
    async (stage) => {
      const f = fixture(), request = settingsRequest();
      if (stage === 'discovery')
        vi.mocked(f.backend.getConnections).mockRejectedValueOnce(new Error('TEST first capture'));
      else vi.mocked(f.backend.invoke).mockRejectedValueOnce(new Error('TEST first capture'));
      await expect(f.teams.updateMemberSettings(request)).rejects.toThrow('TEST first capture');

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered = 0;
      if (stage === 'discovery') {
        vi.mocked(f.backend.getConnections).mockImplementationOnce(async () => {
          entered++;
          await gate;
          return { state: 'ready', bindings: f.bindings };
        });
      } else {
        const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
        vi.mocked(f.backend.invoke).mockImplementationOnce(async (operation) => {
          entered++;
          await gate;
          return invoke(operation);
        });
      }
      const pending = Promise.all([
        f.teams.updateMemberSettings(request),
        f.teams.updateMemberSettings(structuredClone(request)),
      ]);
      void pending.catch(() => {});
      try {
        await vi.waitFor(() => expect(entered).toBe(1));
        expect(vi.mocked(f.backend.invoke).mock.calls
          .filter(([row]) => row.operation === 'team.roster.replace')).toHaveLength(0);
        release();
        const [first, second] = await pending;
        expect(first).toMatchObject({ outcome: 'completed' });
        expect(second).toEqual(first);
        expect(entered).toBe(1);
        expect(f.backend.getConnections).toHaveBeenCalledTimes(stage === 'discovery' ? 2 : 1);
        expect(vi.mocked(f.backend.invoke).mock.calls
          .filter(([row]) => row.operation === 'team.roster.replace')).toHaveLength(1);
        expect(vi.mocked(f.backend.invoke).mock.calls
          .filter(([row]) => row.operation === 'team.roster.read'))
          .toHaveLength(stage === 'configuration' ? 3 : 2);
      } finally {
        release();
        await pending.catch(() => {});
      }
    }
  );

  it('a failed capture keeps the command signature reserved against a changed payload or target', async () => {
    const f = fixture(), request = settingsRequest();
    vi.mocked(f.backend.getConnections).mockRejectedValueOnce(new Error('TEST first capture'));
    await expect(f.teams.updateMemberSettings(request)).rejects.toThrow('TEST first capture');
    for (const changed of [
      { ...request, settings: { ...request.settings, role: 'TEST different role' } },
      { ...request, teamName: childKey },
    ])
      await expect(f.teams.updateMemberSettings(changed)).rejects.toMatchObject({
        code: 'intent-conflict', outcome: 'not-dispatched',
      });
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
    expect(f.backend.invoke).not.toHaveBeenCalled();
    expect(await f.teams.updateMemberSettings(request)).toMatchObject({ outcome: 'completed' });
  });

  it('a revoked resolved owner is refused instead of rediscovering another owner after a read failure', async () => {
    const f = fixture(), request = settingsRequest();
    vi.mocked(f.backend.invoke).mockRejectedValueOnce(new Error('TEST first roster read'));
    await expect(f.teams.updateMemberSettings(request)).rejects.toThrow('TEST first roster read');
    Object.assign(f.bindings[0]!.handle, { handleId: 'TEST-other-owner' });
    vi.mocked(f.backend.invoke).mockResolvedValue({
      ok: false, code: 'forbidden', outcome: 'not-dispatched',
    });
    await expect(f.teams.updateMemberSettings(request)).rejects.toThrow('forbidden');
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.backend.invoke).mock.calls).toHaveLength(2);
    for (const [operation] of vi.mocked(f.backend.invoke).mock.calls)
      expect(operation).toMatchObject({ handle: rootHandle, operation: 'team.roster.read' });
  });

  it.each(['discovery', 'configuration'] as const)(
    'a new valid scope cannot replace the original scope after failed %s capture',
    async (stage) => {
      const f = fixture(), request = settingsRequest();
      if (stage === 'discovery')
        vi.mocked(f.backend.getConnections).mockRejectedValueOnce(new Error('TEST first capture'));
      else vi.mocked(f.backend.invoke).mockRejectedValueOnce(new Error('TEST first capture'));
      await expect(f.teams.updateMemberSettings(request)).rejects.toThrow('TEST first capture');
      const reads = vi.mocked(f.backend.invoke).mock.calls.length;
      f.replaceScope();
      await expect(f.teams.updateMemberSettings(request)).rejects.toMatchObject({
        code: 'context-changed', outcome: 'not-dispatched',
      });
      expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.backend.invoke).mock.calls).toHaveLength(reads);
      expect(await f.teams.updateMemberSettings(settingsRequest('TEST-new-scope-command')))
        .toMatchObject({ outcome: 'completed' });
    }
  );

  it('refuses scope loss during resolve before reading the roster, including an identical retry', async () => {
    const f = fixture();
    let current = true;
    const resolve = vi.fn(async () => {
      current = false;
      return { handle: { ...rootHandle } };
    });
    const edits = createHostDefinitionEdits({
      backend: f.backend,
      captureScope: () => () => current,
      resolve,
      invalidateReads: vi.fn(),
    });
    const request = settingsRequest();
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(edits.updateMemberSettings(request)).rejects.toMatchObject({
        code: 'context-changed', outcome: 'not-dispatched',
      });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });

  it.each(['replace', 'receipt'] as const)(
    'an unknown %s response retains the successful original capture and recovers its receipt',
    async (stage) => {
      const f = fixture(), request = settingsRequest();
      const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
      let accepted: Awaited<ReturnType<AgentBackendApi['invoke']>> | undefined;
      let effects = 0, lookups = 0;
      vi.mocked(f.backend.invoke).mockImplementation(async (operation) => {
        if (operation.operation === 'team.roster.replace') {
          // The controlled owner replays its existing receipt without applying the edit again.
          if (accepted) return structuredClone(accepted);
          accepted = await invoke(operation);
          effects++;
          if (stage === 'replace') throw new Error('TEST lost mutation response');
          return accepted;
        }
        if (operation.operation === 'team.roster.lookup' && lookups++ === 0)
          return { ok: false, code: 'hold', outcome: 'unknown' };
        return invoke(operation);
      });
      await expect(f.teams.updateMemberSettings(request)).rejects.toMatchObject({
        code: stage === 'replace' ? 'transport-unavailable' : 'hold',
        outcome: 'unknown', commandId: request.commandId,
      });
      expect(f.configuration.revision).toBe(nextRevision);
      expect(effects).toBe(1);
      expect(vi.mocked(f.backend.invoke).mock.calls
        .filter(([row]) => row.operation === 'team.roster.read')).toHaveLength(1);
      vi.mocked(f.backend.getConnections).mockRejectedValue(new Error('TEST owner already captured'));

      const completed = await f.teams.updateMemberSettings(request);
      expect(completed).toMatchObject({
        outcome: 'completed', previousFingerprint: request.expectedFingerprint,
        currentFingerprint: 'e'.repeat(64), replayed: true,
      });
      const replacements = vi.mocked(f.backend.invoke).mock.calls
        .filter(([row]) => row.operation === 'team.roster.replace').map(([row]) => row);
      expect(replacements).toHaveLength(2);
      expect(replacements[1]).toEqual(replacements[0]);
      expect(replacements[0]).toMatchObject({
        handle: rootHandle, commandId: request.commandId,
        payload: {
          expectedRevision: revision,
          memberSettingsRelaunch: {
            expectedTeamSettingsFingerprint: revision,
            baseline: [
              { memberName: 'team-lead', expectedFingerprint: 'c'.repeat(64) },
              { memberName: 'alice', expectedFingerprint: 'd'.repeat(64) },
            ],
          },
        },
      });
      const receipts = vi.mocked(f.backend.invoke).mock.calls
        .filter(([row]) => row.operation === 'team.roster.lookup').map(([row]) => row);
      expect(receipts).toHaveLength(2);
      for (const receipt of receipts)
        expect(receipt).toMatchObject({ handle: rootHandle, commandId: request.commandId });
      expect(receipts[0]!.payload).toEqual(stage === 'replace'
        ? { expected: replacements[0]!.payload } : {});
      expect(receipts[1]!.payload).toEqual({});
      expect(vi.mocked(f.backend.invoke).mock.calls
        .filter(([row]) => row.operation === 'team.roster.read')).toHaveLength(2);
      expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
      expect(effects).toBe(1);

      const calls = vi.mocked(f.backend.invoke).mock.calls.length;
      expect(await f.teams.updateMemberSettings(request)).toEqual({ ...completed, replayed: true });
      expect(vi.mocked(f.backend.invoke).mock.calls).toHaveLength(calls);
      expect(effects).toBe(1);
    }
  );
  it.each(['target_conflict', 'completed'] as const)(
    'keeps terminal %s results replayable without exhausting the unresolved settings-intent cap',
    async (outcome) => {
      const f = fixture();
      let originalRequest: ReturnType<typeof settingsRequest> | undefined;
      let originalResult: Awaited<ReturnType<typeof f.teams.updateMemberSettings>> | undefined;

      // More than the former lifetime limit, all through the existing Host facade.
      for (let index = 0; index < 1026; index++) {
        const request = settingsRequest(`TEST-terminal-${outcome}-${index}`);
        if (outcome === 'target_conflict') request.memberName = 'TEST-missing-member';
        else request.expectedFingerprint = (index === 0 ? 'd' : 'e').repeat(64);
        const result = await f.teams.updateMemberSettings(request);
        expect(result.outcome).toBe(outcome);
        if (index === 0) {
          originalRequest = request;
          originalResult = result;
        }
      }

      // An old terminal command still returns its exact original outcome without
      // recapturing another Team or invoking a second roster mutation.
      const before = vi.mocked(f.backend.invoke).mock.calls.length;
      expect(await f.teams.updateMemberSettings(originalRequest!)).toEqual({
        ...originalResult!, replayed: true,
      });
      expect(vi.mocked(f.backend.invoke)).toHaveBeenCalledTimes(before);
      await expect(f.teams.updateMemberSettings({
        ...originalRequest!, expectedFingerprint: 'f'.repeat(64),
      })).rejects.toThrow('intent-conflict');
      expect(vi.mocked(f.backend.invoke)).toHaveBeenCalledTimes(before);

      if (outcome === 'target_conflict') {
        // A terminal refusal cannot poison unrelated future valid saves.
        expect(await f.teams.updateMemberSettings(settingsRequest('TEST-after-1026-refusals')))
          .toMatchObject({ outcome: 'completed' });
      }
    }
  );

});
