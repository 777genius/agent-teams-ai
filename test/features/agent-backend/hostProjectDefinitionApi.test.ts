import { describe, expect, it, vi } from 'vitest';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
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
  let current = true;
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
      return { ok: false, code: 'unsupported', outcome: 'not-dispatched' };
    }),
  };
  const legacy = { getProjectContextView: vi.fn(), updateConfig: vi.fn(), updateMemberSettings: vi.fn(), getMemberSettingsTarget: vi.fn(),
    definitionEdits: { updateConfig: vi.fn() } } as unknown as TeamsAPI;
  return { backend, legacy, configuration, bindings, current: () => current, revoke: () => { current = false; },
    teams: createHostTeamsApi(legacy, backend, () => () => current) };
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
      if (request.operation === 'team.project-context.read') f.bindings[0].handle.handleId = 'TEST-replacement';
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
});
