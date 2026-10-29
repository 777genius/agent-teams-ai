import { expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { createHostGroupChatsApi } from '../../../src/features/agent-backend/renderer/createHostGroupChatsApi';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { createEncodedTaskReference } from '../../../src/renderer/utils/taskReferenceUtils';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { TeamGroupChatsAPI } from '../../../src/features/team-group-chats/contracts';
import type { TeamsAPI } from '../../../src/shared/types/api';
const id = '10000000-0000-4000-8000-000000000001';
const post = '20000000-0000-4000-8000-000000000001';
const key = hostTeamSelectionKey('TEST-opaque');
const group = {
  id,
  name: 'Release',
  createdAt: '2026-10-24T00:00:00.000Z',
  membership: { kind: 'fixed' as const, memberNames: ['lead', 'alice'] },
  archivedAt: null,
  memberNames: ['lead', 'alice'],
  availableRecipientNames: ['lead', 'alice'],
  canSend: true,
};
const canonical = {
  from: 'user',
  to: 'user',
  text: 'Original',
  timestamp: '2026-10-24T00:00:00.000Z',
  read: false,
  messageId: post,
  groupChatId: id,
  groupMessageId: post,
  groupChatName: 'Release',
  groupChatProtocolVersion: 1 as const,
  groupRecipientNames: ['lead', 'alice'],
  groupRecipientRunKeys: { lead: 'TEST-lead', alice: 'TEST-alice' },
};
function fixture() {
  const snapshot: BackendTeamSnapshot = {
    teamName: 'canonical-team',
    revision: 'a'.repeat(64),
    members: [
      { name: 'lead', role: 'lead' },
      { name: 'alice', role: 'member' },
    ],
    tasks: [],
    messages: [canonical],
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333',
      sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    kanbanState: { teamName: 'canonical-team', reviewers: [], tasks: {} },
  };
  const backend: AgentBackendApi = {
    getConnections: vi.fn().mockResolvedValue({
      state: 'ready',
      bindings: [{ handle: { handleId: 'TEST-opaque' }, label: 'Team', members: [] }],
    }),
    invoke: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
  };
  const legacy: TeamGroupChatsAPI = {
    list: vi.fn(),
    create: vi.fn(),
    setArchived: vi.fn(),
    send: vi.fn(),
    getReaction: vi.fn(),
    setReaction: vi.fn(),
  };
  return { snapshot, backend, legacy };
}
it('Main routes group actions through the captured owner, rejects raw selectors/actor/operation injection and projects no private proof', async () => {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  const raw = {
    kind: 'group-chat-command',
    commandId: 'TEST-create',
    operation: 'create',
    phase: 'completed',
    result: { ...group, privateRoot: '/TEST/private' },
    binding: { private: true },
  };
  router.request.mockResolvedValue({ ok: true, value: raw });
  const facade = new BackendOperationsFacade(router),
    request = {
      handle: { handleId: 'TEST-opaque' },
      commandId: 'TEST-create',
      operation: 'group.create',
      payload: {
        id,
        name: 'Release',
        selectedMemberNames: ['lead', 'alice'],
        excludedMemberNames: [],
        autoIncludeNewMembers: false,
      },
    };
  expect(await facade.invoke(request)).toEqual({
    ok: true,
    value: {
      kind: raw.kind,
      commandId: raw.commandId,
      operation: raw.operation,
      phase: raw.phase,
      result: group,
    },
  });
  expect(router.request).toHaveBeenCalledWith(
    request.handle,
    expect.objectContaining({
      method: 'team.group.create',
      payload: request.payload,
      control: false,
    })
  );
  for (const extra of [{ teamName: 'host-team:forged' }, { from: 'lead' }, { operation: 'send' }])
    expect(
      await facade.invoke({ ...request, payload: { ...request.payload, ...extra } })
    ).toMatchObject({ ok: false, outcome: 'not-dispatched' });
  expect(router.request).toHaveBeenCalledTimes(1);
});
it('renderer Host group transport retains legacy routing and resolves uncertainty with the original lookup only', async () => {
  const f = fixture();
  const invoke = vi.mocked(f.backend.invoke);
  invoke
    .mockRejectedValueOnce(new Error('lost response'))
    .mockImplementationOnce(async (request) => ({
      ok: true,
      value: {
        kind: 'group-chat-command',
        commandId: request.commandId,
        operation: 'create',
        phase: 'completed',
        result: group,
      },
    }));
  const api = createHostGroupChatsApi(f.legacy, f.backend, () => () => true);
  expect(
    await api.create({
      teamName: key,
      id,
      name: 'Release',
      selectedMemberNames: ['lead', 'alice'],
      excludedMemberNames: [],
      autoIncludeNewMembers: false,
    })
  ).toEqual(group);
  const calls = invoke.mock.calls.map(([request]) => request);
  expect(calls.map((request) => request.operation)).toEqual(['group.create', 'group.lookup']);
  expect(calls[1]!.commandId).toBe(calls[0]!.commandId);
  expect(f.legacy.create).not.toHaveBeenCalled();
  await api.list({ teamName: 'legacy-team' });
  expect(f.legacy.list).toHaveBeenCalledWith({ teamName: 'legacy-team' });
});
it('context changes during group-send preparation prevent mutation dispatch', async () => {
  const f = fixture();
  let current = true;
  vi.mocked(f.backend.invoke).mockImplementation(async () => {
    current = false;
    return { ok: true, value: f.snapshot };
  });
  const api = createHostGroupChatsApi(f.legacy, f.backend, () => () => current);
  await expect(
    api.send({ teamName: key, groupChatId: id, messageId: post, text: 'Original' })
  ).rejects.toThrow(/context-changed/);
  expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)).toEqual([
    'team.snapshot',
  ]);
});
it('snapshot/history preserve validated group envelopes, expose only logical group rows and bind cursors to group scope', async () => {
  const f = fixture();
  expect(projectTeamSnapshot(f.snapshot).messages[0]).toMatchObject(canonical);
  const extra = {
    ...canonical,
    groupRecipientRunKeys: {
      ...canonical.groupRecipientRunKeys,
      privateCredential: 'TEST-do-not-project',
    },
  };
  expect(
    projectTeamSnapshot({ ...f.snapshot, messages: [extra] }).messages[0]?.groupRecipientRunKeys
  ).toEqual(canonical.groupRecipientRunKeys);
  expect(() =>
    projectTeamSnapshot({ ...f.snapshot, messages: [{ ...canonical, groupRecipientRunKeys: {} }] })
  ).toThrow();
  f.snapshot.messages.push({
    ...canonical,
    messageId: `${post}:g:physical`,
    to: 'alice',
    groupRunKey: 'TEST-alice',
  });
  const earlier = {
    ...canonical,
    messageId: '30000000-0000-4000-8000-000000000001',
    groupMessageId: '30000000-0000-4000-8000-000000000001',
    timestamp: '2026-10-23T00:00:00.000Z',
  };
  f.snapshot.messages.push(earlier);
  const legacyRead = vi
    .fn<TeamsAPI['getMessagesPage']>()
    .mockRejectedValue(new Error('Host history must not use legacy IPC'));
  const legacy = {} as TeamsAPI;
  legacy.getMessagesPage = legacyRead;
  const api = createHostTeamsApi(legacy, f.backend, () => () => true);
  const page = await api.getMessagesPage(key, { groupChatId: id, limit: 1 });
  expect(page.messages.map((message) => message.messageId)).toEqual([post]);
  expect(page.hasMore).toBe(true);
  const next = await api.getMessagesPage(key, {
    groupChatId: id,
    limit: 1,
    cursor: page.nextCursor,
  });
  expect(next.messages.map((message) => message.messageId)).toEqual([earlier.messageId]);
  await expect(
    api.getMessagesPage(key, {
      groupChatId: '40000000-0000-4000-8000-000000000001',
      cursor: page.nextCursor,
    })
  ).rejects.toThrow(/cursor expired/);
  expect(legacyRead).not.toHaveBeenCalled();
});

it('group Composer persists same-owner foreign Task refs as immutable metadata and reads their exact handle', async () => {
  const f = fixture();
  const target = hostTeamSelectionKey('TEST-target');
  const resource = '44444444-4444-5444-8444-444444444444';
  const bindings: BackendConnectionSnapshot['bindings'] = [
    {
      handle: { handleId: 'TEST-opaque' },
      label: 'A',
      members: [],
      ownerResourceRef: 'TEST-owner',
      teamResourceRef: '33333333-3333-5333-8333-333333333333',
    },
    {
      handle: { handleId: 'TEST-target' },
      label: 'B',
      members: [],
      ownerResourceRef: 'TEST-owner',
      teamResourceRef: resource,
    },
  ];
  vi.mocked(f.backend.getConnections).mockImplementation(async () => ({
    state: 'ready',
    bindings,
  }));
  const reference = { taskId: 'TEST-task', displayId: '7', teamName: target };
  const text = createEncodedTaskReference('7', reference.taskId, target);
  const stored = `host-ref:${resource}`;
  vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
    if (request.operation === 'team.snapshot')
      return { ok: true, value: projectTeamSnapshot(f.snapshot) };
    if (request.operation !== 'group.send') throw new Error('Unexpected group effect');
    expect(request.handle).toEqual(bindings[0]!.handle);
    expect(request.payload.taskRefs).toEqual([{ ...reference, teamName: stored }]);
    expect(request.payload.text).toBe(createEncodedTaskReference('7', reference.taskId, stored));
    expect(request.payload.summary).toBe(request.payload.text);
    f.snapshot.messages = [
      {
        ...canonical,
        text: request.payload.text,
        summary: request.payload.summary,
        taskRefs: request.payload.taskRefs,
      },
    ];
    return {
      ok: true,
      value: {
        kind: 'group-chat-command',
        commandId: request.commandId,
        operation: 'send',
        phase: 'completed',
        result: { saved: true, groupChatId: id, messageId: post, statusPersisted: true },
      },
    };
  });
  const api = createHostGroupChatsApi(f.legacy, f.backend, () => () => true);
  await api.send({
    teamName: key,
    groupChatId: id,
    messageId: post,
    text,
    summary: text,
    taskRefs: [reference],
  });
  const legacyRead = vi.fn<TeamsAPI['getMessagesPage']>();
  const teams = createHostTeamsApi(
    { getMessagesPage: legacyRead } as unknown as TeamsAPI,
    f.backend
  );
  expect((await teams.getMessagesPage(key, { groupChatId: id })).messages[0]).toMatchObject({
    text,
    summary: text,
    taskRefs: [reference],
  });
  bindings[1]!.ownerResourceRef = 'TEST-foreign-owner';
  vi.mocked(f.backend.invoke).mockClear();
  await expect(
    api.send({ teamName: key, groupChatId: id, messageId: post, text, taskRefs: [reference] })
  ).rejects.toMatchObject({ code: 'unsupported', outcome: 'not-dispatched' });
  expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)).toEqual([
    'team.snapshot',
  ]);
  expect(legacyRead).not.toHaveBeenCalled();
  expect(f.legacy.send).not.toHaveBeenCalled();
});
