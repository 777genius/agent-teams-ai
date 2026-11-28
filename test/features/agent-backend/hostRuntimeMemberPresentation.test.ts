import { describe, expect, it, vi } from 'vitest';

import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';
import { projectHostMemberSpawnStatuses } from '../../../src/features/agent-backend/renderer/createHostMemberSpawnStatuses';
import { formatTeamModelSummary } from '../../../src/renderer/components/team/dialogs/teamModelSummary';
import { selectResolvedMembersForTeamName } from '../../../src/renderer/store/team/teamResolvedMembers';
import {
  attachmentTargetForMember,
  getMemberAttachmentUnavailableReason,
  validateAttachmentPayloadsForMember,
} from '../../../src/renderer/utils/attachmentRecipientCapabilities';
import { resolveMemberRuntimeSummary } from '../../../src/renderer/utils/memberRuntimeSummary';

import type {
  BackendLaunchConfigurationView,
  BackendLaunchSnapshot,
} from '../../../src/features/agent-backend/contracts/launch';
import type {
  AgentBackendApi,
  BackendRuntimeSnapshot,
} from '../../../src/features/agent-backend/contracts/operations';
import type { BackendRosterConfiguration } from '../../../src/features/agent-backend/contracts/roster';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamsAPI } from '../../../src/shared/types/api';

function fixture(provider: 'claude' | 'codex' | 'opencode' = 'claude') {
  const handle = { handleId: 'TEST-runtime-member-owner' };
  const key = hostTeamSelectionKey(handle.handleId);
  const providerId = provider === 'claude' ? 'anthropic' : provider;
  const configuration: BackendRosterConfiguration = {
    revision: 'TEST-saved-revision',
    savedSettings: {
      cwd: '/TEST/project',
      providerId,
      model: 'TEST-next-model',
      effort: 'low',
      fastMode: 'off',
    },
    members: [
      { memberId: 'TEST-lead-id', name: 'TEST-lead', role: 'lead', settings: {} },
      {
        memberId: 'TEST-worker-id',
        name: 'TEST-worker',
        role: 'member',
        settings: {},
        settingsFingerprint: 'TEST-settings',
      },
    ],
    removedMembers: [],
  };
  const snapshot: BackendTeamSnapshot = {
    teamName: 'TEST-team',
    revision: 'TEST-products',
    configurationRevision: configuration.revision,
    feed: { streamId: 'TEST-stream', sequence: 0, cursor: 'TEST-cursor' },
    members: configuration.members.map(({ name, role }) => ({ name, role })),
    tasks: [],
    messages: [],
    kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {} },
  };
  const launch: BackendLaunchSnapshot = {
    launchId: 'TEST-launch',
    rosterRevision: 'TEST-captured-roster',
    status: 'ready',
    ready: 2,
    expected: 2,
    startedAtMs: 100,
    observedAtMs: 200,
    retryCapability: 'same-binding-no-allocation-only',
    members: configuration.members.map(({ memberId }) => ({
      memberId,
      generation: 'TEST-generation',
      attemptId: 'TEST-attempt',
      status: 'ready',
      nativeReady: true,
      usable: true,
      controlAvailable: true,
      noAllocation: false,
      reason: 'context-applied',
    })),
  };
  const capture: BackendLaunchConfigurationView = {
    launch: structuredClone(launch),
    members: configuration.members.map(({ memberId, name, role }) => ({
      memberId,
      label: name,
      role,
      selected: {
        provider,
        model: 'TEST-running-model',
        workspace: '/TEST/original-project',
        capabilities: [
          'model',
          'effort',
          ...(provider === 'opencode' ? [] : (['fastMode'] as const)),
        ],
        effort: 'high',
        ...(provider === 'opencode'
          ? { qualifiedModel: 'openai/TEST-running-model' }
          : { fastMode: true }),
      },
    })),
  };
  const runtimes: BackendRuntimeSnapshot[] = launch.members.map(({ memberId, generation }) => ({
    memberId,
    generation: generation!,
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    attached: true,
    inputs: [],
    interactions: [],
    attachmentCapabilities: { images: true, documents: true, textFiles: true },
  }));
  let current = true,
    launched = true;
  const legacy = { getData: vi.fn(), getSavedRequest: vi.fn() } as unknown as TeamsAPI;
  const backend: AgentBackendApi = {
    getConnections: vi.fn().mockResolvedValue({
      state: 'ready',
      bindings: [{ handle, label: 'TEST-team', members: [] }],
    }),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      const value =
        request.operation === 'team.roster.read'
          ? configuration
          : request.operation === 'team.launch.read'
            ? launched
              ? launch
              : null
            : request.operation === 'team.launch.configuration.read'
              ? capture
              : request.operation === 'runtime.read'
                ? runtimes.find((row) => row.memberId === request.payload.memberId)!
                : request.operation === 'process.list'
                  ? []
                  : snapshot;
      return { ok: true, value: structuredClone(value) };
    }),
  };
  const order = new TeamProductReadOrder();
  const teams = createHostTeamsApi(legacy, backend, () => () => current, order);
  return {
    key,
    handle,
    configuration,
    snapshot,
    launch,
    capture,
    runtimes,
    legacy,
    backend,
    teams,
    order,
    revoke() {
      current = false;
    },
    neverLaunched() {
      launched = false;
      snapshot.runtimeNeverLaunched = true;
    },
  };
}

async function read(f: ReturnType<typeof fixture>) {
  const data = await f.teams.getData(f.key);
  const members = selectResolvedMembersForTeamName(
    {
      selectedTeamName: f.key,
      selectedTeamData: data,
      teamDataCacheByName: { [f.key]: data },
      memberActivityMetaByTeam: {},
    },
    f.key
  );
  return { data, worker: members.find((member) => member.name === 'TEST-worker')! };
}

describe('Host captured member presentation', () => {
  it.each(['claude', 'codex', 'opencode'] as const)(
    'uses the captured %s selection without materializing authored inheritance',
    async (provider) => {
      const f = fixture(provider);
      const { data, worker } = await read(f);
      expect(worker).toMatchObject({
        providerId: provider === 'claude' ? 'anthropic' : provider,
        model: provider === 'opencode' ? 'openai/TEST-running-model' : 'TEST-running-model',
        effort: 'high',
        cwd: '/TEST/original-project',
        hostMemberId: 'TEST-worker-id',
        configuredSettingsFingerprint: 'TEST-settings',
        nativeInboxAttachmentsSupported: true,
      });
      expect(worker.configuredRuntimeSettings).toEqual({
        providerId: undefined,
        providerBackendId: undefined,
        model: undefined,
        effort: undefined,
        fastMode: undefined,
      });
      expect(data.config.members?.[1].providerId).toBeUndefined();
      expect(data.config.members?.[1].model).toBeUndefined();
      expect(worker.selectedFastMode).toBeUndefined();
      expect(worker.resolvedFastMode).toBe(provider === 'opencode' ? undefined : true);
      expect(getMemberAttachmentUnavailableReason(worker)).toBeNull();
      expect(
        validateAttachmentPayloadsForMember({
          member: worker,
          resolveDeclaration: () => ({ declaredInputModalities: ['image'] }),
          attachments: [
            { id: 'TEST-image', filename: 'TEST.png', mimeType: 'image/png', size: 1, data: '' },
          ],
        })
      ).toBeNull();
      expect((await f.teams.getSavedRequest(f.key))?.members).toEqual([{ name: 'TEST-worker' }]);
      expect(f.backend.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: f.handle,
          operation: 'team.launch.configuration.read',
          payload: { launchId: 'TEST-launch' },
        })
      );
      expect(f.legacy.getData).not.toHaveBeenCalled();
    }
  );

  it('keeps running and newly authored mixed-provider settings separate', async () => {
    const f = fixture('codex');
    f.configuration.members[1].settings = {
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      model: 'openrouter/TEST-next',
      effort: 'low',
      fastMode: 'inherit',
      cwd: '/TEST/next-workspace',
    };
    const { worker } = await read(f);
    expect(worker).toMatchObject({
      providerId: 'codex',
      model: 'TEST-running-model',
      effort: 'high',
      cwd: '/TEST/original-project',
      selectedFastMode: 'inherit',
      resolvedFastMode: true,
    });
    expect(worker.providerBackendId).toBeUndefined();
    expect(worker.configuredRuntimeSettings).toEqual({
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      model: 'openrouter/TEST-next',
      effort: 'low',
      fastMode: 'inherit',
    });
  });

  it.each([
    'launchId',
    'rosterRevision',
    'generation',
    'attemptId',
    'label',
    'memberId',
    'role',
    'unavailable',
  ] as const)(
    'does not borrow an effective model or media declaration across a changed %s',
    async (field) => {
      const f = fixture();
      f.configuration.members[1].settings = { providerId: 'codex', model: 'TEST-new-default' };
      if (field === 'launchId' || field === 'rosterRevision') f.capture.launch[field] = 'TEST-new';
      else if (field === 'generation' || field === 'attemptId')
        f.capture.launch.members[1][field] = 'TEST-new';
      else if (field === 'role') f.capture.members[1].role = 'lead';
      else if (field === 'unavailable') f.capture.members[1].selected = null;
      else f.capture.members[1][field] = 'TEST-new';
      const { data, worker } = await read(f);
      expect(data.members).toHaveLength(2);
      expect(worker.providerId).toBeUndefined();
      expect(worker.model).toBeUndefined();
      expect(worker.cwd).toBeUndefined();
      expect(worker.nativeInboxAttachmentsSupported).toBeUndefined();
      expect(worker.configuredRuntimeSettings?.model).toBe('TEST-new-default');
      expect(data.warnings).toContain(
        'Captured runtime settings are unavailable for some team members.'
      );
    }
  );

  it('resolves saved-only inheritance without declaring runtime capability', async () => {
    const f = fixture('codex');
    f.neverLaunched();
    const { worker } = await read(f);
    expect(worker).toMatchObject({
      providerId: 'codex',
      model: 'TEST-next-model',
      effort: 'low',
      cwd: '/TEST/project',
    });
    expect(worker.nativeInboxAttachmentsSupported).toBeUndefined();
    expect(worker.resolvedFastMode).toBeUndefined();
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.some(([r]) => r.operation === 'team.launch.configuration.read')
    ).toBe(false);
  });

  it.each(['disabled-sync', 'different-provider', 'explicit-model'] as const)(
    'respects saved member overrides for %s',
    async (override) => {
      const f = fixture('codex');
      f.neverLaunched();
      if (override === 'disabled-sync') f.configuration.savedSettings!.syncModelsWithLead = false;
      if (override === 'different-provider')
        f.configuration.members[1].settings.providerId = 'anthropic';
      if (override === 'explicit-model')
        f.configuration.members[1].settings.model = 'TEST-own-model';
      const { worker } = await read(f);
      expect(worker.model).toBe(override === 'explicit-model' ? 'TEST-own-model' : undefined);
      expect(worker.effort).toBeUndefined();
      expect(worker.nativeInboxAttachmentsSupported).toBeUndefined();
    }
  );

  it('keeps authoring available when capture read fails and refuses a newer capture that stopped', async () => {
    const f = fixture();
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
      request.operation === 'team.launch.configuration.read'
        ? { ok: false, code: 'unavailable', outcome: 'not-dispatched' }
        : invoke(request)
    );
    const missing = await read(f);
    expect(missing.worker.configuredSettingsFingerprint).toBe('TEST-settings');
    expect(missing.worker.providerId).toBeUndefined();
    expect(missing.worker.nativeInboxAttachmentsSupported).toBeUndefined();
    vi.mocked(f.backend.invoke).mockImplementation(invoke);
    f.capture.launch.members[1].usable = false;
    const stopped = await read(f);
    expect(stopped.worker.providerId).toBe('anthropic');
    expect(stopped.worker.nativeInboxAttachmentsSupported).toBeUndefined();
  });

  it('leaves an unqualified OpenCode capture metadata-unknown', async () => {
    const f = fixture('opencode');
    delete f.capture.members[1].selected!.qualifiedModel;
    f.capture.members[1].selected!.model = 'foreign/TEST-model';
    const { worker } = await read(f);
    expect(worker.providerId).toBe('opencode');
    expect(worker.model).toBeUndefined();
    expect(
      validateAttachmentPayloadsForMember({
        member: worker,
        resolveDeclaration: () => ({ declaredInputModalities: null }),
        attachments: [
          { id: 'TEST-image', filename: 'TEST.png', mimeType: 'image/png', size: 1, data: '' },
        ],
      })
    ).toContain('unknown image');
  });

  it('uses the captured workspace for attachment declarations after the saved workspace changes', async () => {
    const f = fixture('opencode');
    f.configuration.savedSettings!.cwd = '/TEST/next-workspace';
    const { data, worker } = await read(f);
    expect(data.config.projectPath).toBe('/TEST/next-workspace');
    expect(attachmentTargetForMember(worker, data.config.projectPath!)).toEqual({
      model: 'openai/TEST-running-model',
      projectPath: '/TEST/original-project',
    });
    expect(
      attachmentTargetForMember({ ...worker, cwd: undefined }, data.config.projectPath!).projectPath
    ).toBeNull();
    expect(
      attachmentTargetForMember({ ...worker, runtimeOwner: undefined }, data.config.projectPath!)
        .projectPath
    ).toBe('/TEST/next-workspace');
  });

  it.each(['openai', 'gemini-custom', 'codex-custom'])(
    'keeps %s OpenCode models in pending and live member summaries',
    async (source) => {
      const f = fixture('opencode'),
        selected = f.capture.members[1].selected!;
      selected.model = 'gpt-5';
      selected.qualifiedModel = `${source}/gpt-5`;
      const { worker } = await read(f);
      const runtime = (await f.teams.getTeamAgentRuntime(f.key)).members[worker.name];
      expect(runtime).toMatchObject({
        providerId: 'opencode',
        runtimeModel: `${source}/gpt-5`,
        cwd: '/TEST/original-project',
      });
      f.capture.launch.status = 'partial';
      f.capture.launch.ready = 1;
      Object.assign(f.capture.launch.members[1], { status: 'pending-human', usable: false });
      const pending = projectHostMemberSpawnStatuses(f.handle.handleId, f.capture).statuses[
        worker.name
      ];
      expect(pending.runtimeModel).toBe(`${source}/gpt-5`);
      const nextDraft = {
        providerId: 'codex' as const,
        model: 'TEST-next',
        effort: 'low' as const,
        limitContext: false,
      };
      expect(resolveMemberRuntimeSummary(worker, nextDraft, pending, runtime, true)).toBe(
        formatTeamModelSummary('opencode', `${source}/gpt-5`, 'high')
      );
      expect(
        resolveMemberRuntimeSummary(
          worker,
          nextDraft,
          { ...pending, runtimeModel: 'claude-TEST-stale' },
          {
            ...runtime,
            providerId: 'anthropic',
            runtimeModel: 'claude-TEST-stale',
            runtimeGeneration: 'TEST-old-generation',
          },
          true
        )
      ).toBe(formatTeamModelSummary('opencode', `${source}/gpt-5`, 'high'));
      expect(
        resolveMemberRuntimeSummary(
          { ...worker, agentType: 'team-lead' },
          nextDraft,
          undefined,
          runtime,
          true
        )
      ).toBe(formatTeamModelSummary('opencode', `${source}/gpt-5`, 'high'));
    }
  );

  it.each(['generation', 'attemptId'] as const)(
    'rejects mixed runtime/selection %s in the existing runtime API',
    async (field) => {
      const f = fixture('opencode');
      f.capture.launch.members[1][field] = 'TEST-new-capture';
      await expect(f.teams.getTeamAgentRuntime(f.key)).rejects.toMatchObject({
        code: 'runtime-unavailable',
      });
    }
  );

  it.each(['scope', 'read-fence'] as const)(
    'rejects a stale %s after the additional captured-selection await',
    async (reason) => {
      const f = fixture();
      const original = vi.mocked(f.backend.invoke).getMockImplementation()!;
      vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
        const result = await original(request);
        if (request.operation === 'team.launch.configuration.read') {
          if (reason === 'scope') f.revoke();
          else f.order.invalidateReads(f.handle.handleId);
        }
        return result;
      });
      await expect(f.teams.getData(f.key)).rejects.toThrow();
      expect(f.legacy.getData).not.toHaveBeenCalled();
    }
  );
});
