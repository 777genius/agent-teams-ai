import { describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { translateHostTaskReferences } from '../../../src/features/agent-backend/renderer/translateHostTaskReferences';
import { selectResolvedMembersForTeamName } from '../../../src/renderer/store/team/teamResolvedMembers';
import {
  buildTaskLinkHref,
  createEncodedTaskReference,
  extractTaskRefsFromText,
  parseTaskLinkHref,
} from '../../../src/renderer/utils/taskReferenceUtils';

import type { BackendLaunchSnapshot } from '../../../src/features/agent-backend/contracts/launch';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendRuntimeSnapshot } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendRosterConfiguration } from '../../../src/features/agent-backend/contracts/roster';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamsAPI } from '../../../src/shared/types/api';

function fixture() {
  const key = hostTeamSelectionKey('TEST-original-A');
  const snapshot: BackendTeamSnapshot = {
    teamName: 'same-display-team',
    revision: 'a'.repeat(64),
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333',
      sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    members: [{ name: 'alice', role: 'lead' }],
    processes: [
      {
        id: 'TEST-service',
        pid: 1001,
        label: 'TEST service',
        registeredAt: '2026-10-23',
        processRef: `p1:TEST-service:${'c'.repeat(64)}`,
        observation: 'unknown',
        canTerminate: false,
      },
    ],
    tasks: [
      {
        id: '1',
        subject: 'Actual task',
        owner: 'alice',
        status: 'in_progress',
        descriptionTaskRefs: [
          { taskId: '1', displayId: '1', teamName: 'same-display-team' },
          { taskId: '2', displayId: '2', teamName: 'other-team' },
        ],
      },
    ],
    messages: [
      {
        from: 'alice',
        text: 'actual reply',
        timestamp: '2026-01-01',
        read: false,
        messageId: 'm1',
      },
      { from: 'alice', text: 'new reply', timestamp: '2026-01-02', read: false, messageId: 'm2' },
    ],
    kanbanState: { teamName: 'same-display-team', reviewers: [], tasks: {} },
  };
  const legacy = {
    list: vi.fn().mockResolvedValue([
      {
        teamName: 'same-display-team',
        displayName: 'Legacy',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
      },
    ]),
    getData: vi.fn().mockResolvedValue({ legacy: true }),
    getTask: vi.fn(),
    getMessagesPage: vi.fn(),
    stop: vi.fn(),
    getAllTasks: vi.fn().mockResolvedValue([]),
  } as unknown as TeamsAPI;
  const backend: AgentBackendApi = {
    getConnections: vi.fn().mockResolvedValue({
      state: 'ready',
      bindings: [{ handle: { handleId: 'TEST-original-A' }, label: 'Host', members: [] }],
    }),
    invoke: vi.fn().mockImplementation(async (request) => ({
      ok: true,
      value:
        request.operation === 'team.launch.read'
          ? null
          : request.operation === 'process.list'
            ? structuredClone(snapshot.processes ?? [])
            : structuredClone(snapshot),
    })),
  };
  return { key, snapshot, legacy, backend };
}

function savedDescription(f: ReturnType<typeof fixture>) {
  const configuration: BackendRosterConfiguration = {
    revision: 'd'.repeat(64),
    savedSettings: { cwd: '/TEST', description: 'TEST saved description\nwith original detail' },
    members: f.snapshot.members.map((member, index) => ({
      ...member,
      memberId: `TEST-member-${index}`,
      settings: {},
    })),
    removedMembers: [],
  };
  f.snapshot.configurationRevision = configuration.revision;
  const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
  vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
    request.operation === 'team.roster.read'
      ? { ok: true, value: structuredClone(configuration) }
      : invoke(request)
  );
  return configuration;
}

function attachmentRuntime(f: ReturnType<typeof fixture>) {
  f.snapshot.members.push({ name: 'TEST-live-member', role: 'member' });
  const configuration = savedDescription(f);
  const member = configuration.members[1];
  const launch: BackendLaunchSnapshot = {
    launchId: 'TEST-launch',
    rosterRevision: 'TEST-runtime-definition-digest',
    status: 'ready',
    ready: 1,
    expected: 1,
    retryCapability: 'same-binding-no-allocation-only',
    members: [
      {
        memberId: member.memberId,
        generation: 'TEST-current-generation',
        attemptId: 'TEST-attempt',
        status: 'ready',
        nativeReady: true,
        usable: true,
        controlAvailable: true,
        noAllocation: false,
        reason: 'context-applied',
      },
    ],
  };
  const runtime: BackendRuntimeSnapshot = {
    memberId: member.memberId,
    generation: 'TEST-current-generation',
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    attached: true,
    inputs: [],
    interactions: [],
    attachmentCapabilities: { images: true, documents: true, textFiles: true },
  };
  let unknown = false;
  const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
  vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
    request.operation === 'team.launch.read'
      ? { ok: true, value: structuredClone(launch) }
      : request.operation === 'runtime.read'
        ? unknown
          ? { ok: false, code: 'unavailable', outcome: 'not-dispatched' }
          : { ok: true, value: structuredClone(runtime) }
        : invoke(request)
  );
  return {
    configuration,
    member,
    launch,
    runtime,
    setUnknown: () => {
      unknown = true;
    },
  };
}

describe('ordinary Host team read selection', () => {
  it.each([
    ['anthropic', true],
    ['codex', false],
  ] as const)(
    'hydrates the existing %s member attachment controls only from its exact current native declaration',
    async (providerId, textFiles) => {
      const f = fixture();
      const captured = attachmentRuntime(f);
      captured.member.settings = { providerId, model: 'TEST-configured-model' };
      captured.runtime.attachmentCapabilities = { images: true, documents: textFiles, textFiles };
      // A runtime-definition digest is not a saved configuration revision.
      expect(captured.launch.rosterRevision).not.toBe(captured.configuration.revision);
      const teams = createHostTeamsApi(f.legacy, f.backend);
      const data = await teams.getData(f.key);
      const resolved = selectResolvedMembersForTeamName(
        {
          selectedTeamName: f.key,
          selectedTeamData: data,
          teamDataCacheByName: { [f.key]: data },
          memberActivityMetaByTeam: {},
        },
        f.key
      );
      expect(resolved.find((row) => row.name === 'TEST-live-member')).toMatchObject({
        nativeInboxAttachmentsSupported: true,
        nativeInboxTextAttachmentsSupported: textFiles,
      });
      expect(f.backend.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: { handleId: 'TEST-original-A' },
          operation: 'runtime.read',
          payload: {
            memberId: captured.member.memberId,
            expectedGeneration: 'TEST-current-generation',
          },
        })
      );
      captured.runtime.attached = false;
      captured.runtime.custody = 'released';
      delete captured.runtime.attachmentCapabilities;
      const stopped = await teams.getData(f.key);
      expect(
        stopped.members.find((row) => row.name === 'TEST-live-member')
          ?.nativeInboxAttachmentsSupported
      ).toBeUndefined();
      expect(
        stopped.members.find((row) => row.name === 'TEST-live-member')
          ?.nativeInboxTextAttachmentsSupported
      ).toBeUndefined();
      expect(f.legacy.getData).not.toHaveBeenCalled();
    }
  );
  it.each([
    'no-declaration',
    'detached',
    'sealed',
    'unknown',
    'retired',
    'foreign-name',
    'unusable-capture',
  ] as const)(
    'keeps native attachment controls unavailable for %s runtime evidence',
    async (gap) => {
      const f = fixture();
      const captured = attachmentRuntime(f);
      captured.member.settings = { providerId: 'anthropic', model: 'TEST-configured-model' };
      if (gap === 'no-declaration') delete captured.runtime.attachmentCapabilities;
      if (gap === 'detached') captured.runtime.attached = false;
      if (gap === 'sealed') captured.runtime.sealed = true;
      if (gap === 'unknown') captured.setUnknown();
      if (gap === 'foreign-name') captured.member.name = 'TEST-foreign-name';
      if (gap === 'unusable-capture') captured.launch.members[0].usable = false;
      if (gap === 'retired') {
        captured.configuration.members = [captured.configuration.members[0]];
        captured.configuration.removedMembers = [
          {
            memberId: captured.member.memberId,
            name: captured.member.name,
            settings: captured.member.settings,
            removedAt: '2026-10-24T07:25:51.476Z',
          },
        ];
        f.snapshot.members = [f.snapshot.members[0]];
      }
      const data = await createHostTeamsApi(f.legacy, f.backend).getData(f.key);
      for (const member of data.members) {
        expect(member.nativeInboxAttachmentsSupported).toBeUndefined();
        expect(member.nativeInboxTextAttachmentsSupported).toBeUndefined();
      }
      expect(f.legacy.getData).not.toHaveBeenCalled();
    }
  );
  it.each(['memberId', 'generation'] as const)(
    'rejects a runtime %s mismatch without borrowing another native member capability',
    async (field) => {
      const f = fixture();
      const captured = attachmentRuntime(f);
      captured.runtime[field] = 'TEST-foreign';
      await expect(createHostTeamsApi(f.legacy, f.backend).getData(f.key)).rejects.toThrow(
        'invalid-result'
      );
      expect(f.legacy.getData).not.toHaveBeenCalled();
    }
  );

  it('projects coherent removed roster history into the existing member UI and clears it after restoration', async () => {
    const f = fixture();
    const configuration = savedDescription(f);
    const removedAt = '2026-10-24T07:25:51.476Z';
    const settings = { role: 'Developer', providerId: 'codex' as const, model: 'gpt-5.5' };
    configuration.removedMembers = [
      { memberId: 'TEST-retired', name: 'TEST-retired', removedAt, settings },
    ];
    f.snapshot.tasks.push({
      id: 'retired-task',
      subject: 'Historical task',
      owner: 'TEST-retired',
      status: 'in_progress',
    });
    const teams = createHostTeamsApi(f.legacy, f.backend);
    const removed = await teams.getData(f.key);
    expect(removed.members.find((member) => member.name === 'TEST-retired')).toMatchObject({
      name: 'TEST-retired',
      removedAt: Date.parse(removedAt),
      agentType: 'general-purpose',
      role: 'Developer',
      providerId: 'codex',
      model: 'gpt-5.5',
      currentTaskId: null,
      taskCount: 1,
    });
    expect(removed.config.members?.map((member) => member.name)).toEqual(['alice']);
    expect((await teams.list()).find((team) => team.teamName === f.key)?.memberCount).toBe(0);
    const resolved = selectResolvedMembersForTeamName(
      {
        selectedTeamName: f.key,
        selectedTeamData: removed,
        teamDataCacheByName: { [f.key]: removed },
        memberActivityMetaByTeam: {},
      },
      f.key
    );
    expect(resolved.filter((member) => member.removedAt).map((member) => member.name)).toEqual([
      'TEST-retired',
    ]);
    expect(
      resolved.find((member) => member.name === 'TEST-retired')?.configuredRuntimeSettings
    ).toMatchObject({ providerId: 'codex', model: 'gpt-5.5' });

    configuration.members.push({
      memberId: 'TEST-retired',
      name: 'TEST-retired',
      role: 'member',
      settings,
    });
    configuration.removedMembers = [];
    configuration.revision = 'e'.repeat(64);
    f.snapshot.configurationRevision = configuration.revision;
    f.snapshot.revision = 'f'.repeat(64);
    f.snapshot.feed.sequence++;
    f.snapshot.members.push({ name: 'TEST-retired', role: 'member' });
    const restored = await teams.getData(f.key);
    expect(restored.members.map((member) => member.name)).toEqual(['alice', 'TEST-retired']);
    expect(restored.members.find((member) => member.name === 'TEST-retired')).toMatchObject({
      providerId: 'codex',
      model: 'gpt-5.5',
    });
    expect(restored.members.some((member) => member.removedAt)).toBe(false);
    expect((await teams.list()).find((team) => team.teamName === f.key)?.memberCount).toBe(1);
    expect(f.legacy.getData).not.toHaveBeenCalled();
  });

  it.each(['revision', 'roster', 'unavailable', 'active-name', 'removed-name'] as const)(
    'does not expose removed members from a %s configuration read',
    async (gap) => {
      const f = fixture();
      const configuration = savedDescription(f);
      configuration.removedMembers = [
        {
          memberId: 'TEST-retired',
          name: 'TEST-retired',
          removedAt: '2026-10-24T07:25:51.476Z',
          settings: {},
        },
      ];
      if (gap === 'active-name') configuration.removedMembers[0].name = 'ALICE';
      if (gap === 'removed-name')
        configuration.removedMembers.push({
          ...configuration.removedMembers[0],
          memberId: 'TEST-other-retired',
          name: 'test-RETIRED',
        });
      if (gap === 'revision') configuration.revision = 'e'.repeat(64);
      if (gap === 'roster') configuration.members[0].name = 'TEST-foreign-lead';
      if (gap === 'unavailable') {
        const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
        vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
          request.operation === 'team.roster.read'
            ? { ok: false, code: 'hold', outcome: 'not-dispatched' }
            : invoke(request)
        );
      }
      const data = await createHostTeamsApi(f.legacy, f.backend).getData(f.key);
      expect(data.members.map((member) => member.name)).toEqual(['alice']);
      expect(data.warnings).toContain('Saved launch settings are unavailable.');
      expect(f.legacy.getData).not.toHaveBeenCalled();
    }
  );

  it.each(['configured', 'unversioned'] as const)(
    'projects original saved description for %s product snapshots',
    async (version) => {
      const f = fixture();
      const configuration = savedDescription(f);
      if (version === 'unversioned') delete f.snapshot.configurationRevision;
      expect(f.snapshot.revision).not.toBe(configuration.revision);
      const teams = createHostTeamsApi(f.legacy, f.backend);
      const summary = (await teams.list()).find((team) => team.teamName === f.key);
      expect(summary?.description).toBe(configuration.savedSettings!.description);
      expect(f.backend.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: { handleId: 'TEST-original-A' },
          operation: 'team.roster.read',
          payload: {},
        })
      );
    }
  );
  it.each(['revision', 'roster', 'unavailable'] as const)(
    'keeps product rows readable without stale description when settings are %s',
    async (gap) => {
      const f = fixture();
      const configuration = savedDescription(f);
      if (gap === 'revision') configuration.revision = 'e'.repeat(64);
      if (gap === 'roster') configuration.members[0].name = 'TEST-foreign-roster';
      if (gap === 'unavailable') {
        const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
        vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
          request.operation === 'team.roster.read'
            ? { ok: false, code: 'hold', outcome: 'not-dispatched' }
            : invoke(request)
        );
      }
      const teams = createHostTeamsApi(f.legacy, f.backend);
      const summary = (await teams.list()).find((team) => team.teamName === f.key);
      expect(summary).toMatchObject({ teamName: f.key, description: '', memberCount: 0 });
    }
  );
  it('rejects a description read after the original context changes', async () => {
    const f = fixture();
    savedDescription(f);
    let current = true;
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
      if (request.operation === 'team.roster.read') current = false;
      return invoke(request);
    });
    const teams = createHostTeamsApi(f.legacy, f.backend, () => () => current);
    await expect(teams.list()).rejects.toThrow('context changed');
  });

  it.each([0, 1, 2])(
    'counts %i teammates without dropping the lead roster identity',
    async (count) => {
      const f = fixture();
      f.snapshot.members.push(
        ...Array.from({ length: count }, (_, index) => ({
          name: `TEST-member-${index}`,
          role: 'member' as const,
        }))
      );
      const teams = createHostTeamsApi(f.legacy, f.backend);
      const summary = (await teams.list()).find((team) => team.teamName === f.key);
      expect(summary).toMatchObject({
        memberCount: count,
        leadName: 'alice',
        members: f.snapshot.members,
      });
    }
  );

  it('decorates frozen nonconfigurable contextBridge methods and preserves legacy receivers', async () => {
    const f = fixture();
    const bridge = Object.freeze({
      ...f.legacy,
      aliveList: function (this: TeamsAPI) {
        expect(this).toBe(bridge);
        return Promise.resolve(['legacy-alive']);
      },
    });
    expect(Object.getOwnPropertyDescriptor(bridge, 'aliveList')).toMatchObject({
      writable: false,
      configurable: false,
    });
    const teams = createHostTeamsApi(bridge, f.backend);
    expect(await teams.aliveList()).toEqual(['legacy-alive']);
    expect((await teams.list()).map((team) => team.teamName)).toEqual(['same-display-team', f.key]);
    expect((await teams.getData(f.key)).tasks[0].subject).toBe('Actual task');
    expect(await teams.getData('same-display-team')).toEqual({ legacy: true });
    await expect(teams.stop(f.key)).rejects.toThrow('unsupported');
    expect(f.legacy.stop).not.toHaveBeenCalled();
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  it('qualifies encoded and markdown task refs without losing opaque handle escaping', () => {
    const selection = hostTeamSelectionKey('TEST/% owner');
    const encoded = createEncodedTaskReference('1', 'task-1', 'actual-team');
    const href = buildTaskLinkHref({ taskId: 'task-1', displayId: '1', teamName: 'actual-team' });
    const mapped = translateHostTaskReferences(`${encoded} [task](${href})`, () => selection);
    expect(extractTaskRefsFromText(mapped, [])[0].teamName).toBe(selection);
    const mappedHref = mapped.match(/task:\/\/[^)]+/)![0];
    expect(parseTaskLinkHref(mappedHref)?.teamName).toBe(selection);
    const restored = translateHostTaskReferences(mapped, (team) => {
      expect(team).toBe(selection);
      return 'actual-team';
    });
    expect(extractTaskRefsFromText(restored, [])[0].teamName).toBe('actual-team');
  });

  it('merges sidebar discovery and loads actual roster/task board without adopting equal legacy names', async () => {
    const f = fixture();
    const teams = createHostTeamsApi(f.legacy, f.backend);
    expect((await teams.list()).map((team) => team.teamName)).toEqual(['same-display-team', f.key]);
    const data = await teams.getData(f.key);
    expect(data.config.name).toBe('Host');
    expect(data.tasks[0].subject).toBe('Actual task');
    expect(data.members[0]).toMatchObject({ name: 'alice', currentTaskId: '1', taskCount: 1 });
    expect(data.isAlive).toBeUndefined();
    expect(data.config.leadSessionId).toBeUndefined();
    expect(data.processes).toEqual(f.snapshot.processes);
    expect(f.backend.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: { handleId: 'TEST-original-A' },
        operation: 'process.list',
        payload: {},
      })
    );
    expect(f.backend.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: { handleId: 'TEST-original-A' },
        operation: 'team.snapshot',
        payload: {},
      })
    );
    expect(await teams.getData('same-display-team')).toEqual({ legacy: true });
  });
  it('keeps original owner-qualified refs, global board identity and cursor pages', async () => {
    const f = fixture();
    const teams = createHostTeamsApi(f.legacy, f.backend);
    const task = await teams.getTask(f.key, '1');
    expect(task?.descriptionTaskRefs?.[0].teamName).toBe(f.key);
    const cross = task!.descriptionTaskRefs![1].teamName;
    await expect(teams.getData(cross)).rejects.toThrow('unavailable');
    expect(f.legacy.getData).not.toHaveBeenCalled();
    expect((await teams.getAllTasks())[0].teamName).toBe(f.key);
    const page = await teams.getMessagesPage(f.key, { limit: 1 });
    expect(page.messages[0].messageId).toBe('m2');
    const older = await teams.getMessagesPage(f.key, { limit: 1, cursor: page.nextCursor });
    expect(older.messages[0].messageId).toBe('m1');
    f.snapshot.revision = 'b'.repeat(64);
    f.snapshot.feed.sequence++;
    await expect(teams.getMessagesPage(f.key, { cursor: page.nextCursor })).rejects.toThrow(
      'expired'
    );
  });
  it('fails closed for unknown/unavailable handles and unsupported operations, zero legacy fallback', async () => {
    const f = fixture();
    const teams = createHostTeamsApi(f.legacy, f.backend);
    await expect(teams.stop(f.key)).rejects.toThrow('unsupported');
    expect(f.legacy.stop).not.toHaveBeenCalled();
    await expect(teams.getData(hostTeamSelectionKey('TEST-B'))).rejects.toThrow('unavailable');
    vi.mocked(f.backend.invoke).mockResolvedValue({
      ok: false,
      code: 'unavailable',
      outcome: 'not-dispatched',
    });
    await expect(teams.getData(f.key)).rejects.toThrow('unavailable');
    expect(f.legacy.getData).not.toHaveBeenCalled();
  });
  it('drops a reply after the context epoch changes before UI store can consume it', async () => {
    const f = fixture();
    let valid = true;
    vi.mocked(f.backend.invoke).mockImplementation(async () => {
      valid = false;
      return { ok: true, value: f.snapshot };
    });
    const teams = createHostTeamsApi(f.legacy, f.backend, () => () => valid);
    await expect(teams.getData(f.key)).rejects.toThrow('context changed');
  });
  it('projects finite team.snapshot through existing guarded facade and omits private fields', async () => {
    const f = fixture();
    const raw = {
      ...f.snapshot,
      principalId: 'SECRET',
      storageRoot: '/SECRET',
      nativeSessionId: 'SECRET',
      tasks: [{ ...f.snapshot.tasks[0], projectPath: '/SECRET' }],
    };
    raw.messages[0] = { ...raw.messages[0], summary: 'Read-only', actionMode: 'ask' };
    const projected = projectTeamSnapshot(raw);
    expect(projected.messages[0]).toMatchObject({ summary: 'Read-only', actionMode: 'ask' });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    const request = vi.fn().mockResolvedValue({ ok: true, value: raw });
    const facade = new BackendOperationsFacade({ request, lookup: vi.fn() });
    const result = await facade.invoke({
      handle: { handleId: 'TEST-original-A' },
      commandId: 'TEST-read',
      operation: 'team.snapshot',
      payload: {},
    });
    expect(result).toEqual({ ok: true, value: projected });
    expect(request).toHaveBeenCalledWith(
      { handleId: 'TEST-original-A' },
      { method: 'team.snapshot', commandId: 'TEST-read', payload: {}, control: true }
    );
    expect(
      await facade.invoke({
        handle: { handleId: 'TEST-original-A' },
        commandId: 'TEST-read',
        operation: 'team.snapshot',
        payload: { root: '/SECRET' },
      })
    ).toMatchObject({ ok: false, code: 'invalid' });
  });
});
