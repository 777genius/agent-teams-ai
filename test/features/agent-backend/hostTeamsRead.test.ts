import { describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { translateHostTaskReferences } from '../../../src/features/agent-backend/renderer/translateHostTaskReferences';
import {
  buildTaskLinkHref,
  createEncodedTaskReference,
  extractTaskRefsFromText,
  parseTaskLinkHref,
} from '../../../src/renderer/utils/taskReferenceUtils';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
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
      ...member, memberId: `TEST-member-${index}`, settings: {},
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

describe('ordinary Host team read selection', () => {
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
      expect(f.backend.invoke).toHaveBeenCalledWith(expect.objectContaining({
        handle: { handleId: 'TEST-original-A' }, operation: 'team.roster.read', payload: {},
      }));
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
