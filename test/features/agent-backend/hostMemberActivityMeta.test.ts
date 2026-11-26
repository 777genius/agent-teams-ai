import { readTeamMemberActivity } from '@features/team-read-recovery/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';
import { MemberActivityMetaService } from '../../../src/main/services/team/MemberActivityMetaService';
import { selectResolvedMembersForTeamName } from '../../../src/renderer/store/team/teamResolvedMembers';

import { mockOwnerMessagesPage } from './hostMessagesPageFixture';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type {
  AgentBackendApi,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamMessageFeedService } from '../../../src/main/services/team/TeamMessageFeedService';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { InboxMessage, TeamViewSnapshot } from '../../../src/shared/types/team';

const logicalId = 'TEST-meta-logical';
const executionId = 'TEST-meta-project';
const teamName = hostTeamSelectionKey(executionId);

function message(index: number, from = 'alice', text = 'TEST authored message'): InboxMessage {
  return {
    from,
    to: 'user',
    text,
    read: false,
    messageId: `TEST-message-${index}`,
    timestamp: new Date(Date.UTC(2026, 10, 26, 12, 0, index)).toISOString(),
  };
}

function fixture(messages: InboxMessage[]) {
  const f = {
    active: true,
    afterRead: undefined as ((request: BackendOperationRequest, count: number) => void) | undefined,
    readCount: 0,
    connections: {
      state: 'ready',
      bindings: [
        {
          handle: { handleId: logicalId },
          label: 'TEST logical',
          members: [],
          ownerResourceRef: 'TEST-owner',
          teamResourceRef: 'TEST-logical-resource',
          projectContextMode: 'per_project',
        },
        {
          handle: { handleId: executionId },
          label: 'TEST execution',
          members: [],
          ownerResourceRef: 'TEST-owner',
          teamResourceRef: 'TEST-project-resource',
          projectContext: {
            logicalHandleId: logicalId,
            workContextId: 'TEST-project-context',
            projectPath: '/TEST/project',
          },
        },
      ],
    } as BackendConnectionSnapshot,
    snapshot: {
      teamName: 'TEST-original-native-team',
      revision: 'a'.repeat(64),
      feed: { streamId: 'TEST-feed', sequence: 1, cursor: 'TEST-feed-cursor' },
      members: [
        { name: 'alice', role: 'lead' },
        { name: 'bob', role: 'member' },
      ],
      tasks: [],
      messages,
      kanbanState: { teamName: 'TEST-original-native-team', reviewers: [], tasks: {} },
    } as BackendTeamSnapshot,
  };
  const legacyRead = vi
    .fn()
    .mockRejectedValue(new Error('TEST legacy member activity must not run'));
  const recoveryRead = vi.fn().mockRejectedValue(new Error('TEST legacy recovery must not run'));
  const legacy = {
    getMemberActivityMeta: legacyRead,
    readRecovery: { getMemberActivityMeta: recoveryRead },
  } as unknown as TeamsAPI;
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => structuredClone(f.connections)),
    invoke: vi.fn(async (request) => {
      if (request.operation !== 'team.messages.page')
        throw new Error(`TEST unexpected native/non-message operation: ${request.operation}`);
      expect(request.handle.handleId).toBe(executionId);
      const result = mockOwnerMessagesPage(f.snapshot, request.payload);
      f.readCount++;
      f.afterRead?.(request, f.readCount);
      return result;
    }),
  };
  const readOrder = new TeamProductReadOrder();
  const teams = createHostTeamsApi(legacy, backend, () => () => f.active, readOrder);
  vi.stubGlobal('window', { electronAPI: { teams } });
  return { ...f, source: f, backend, legacyRead, recoveryRead, readOrder, teams };
}

afterEach(() => vi.unstubAllGlobals());

describe('captured Host member activity through ordinary team read transport', () => {
  it('uses the original execution feed and the same newest-message facts as legacy', async () => {
    const messages = [
      message(0, 'alice', '{"type":"shutdown_approved"}'),
      message(1, 'bob'),
      message(2, 'user'),
      message(3, 'system'),
      message(4, 'alice', 'TEST later ordinary message'),
      message(5, 'bob', '{"type":"shutdown_response","approve":true}'),
      message(6, '  '),
    ];
    const f = fixture(messages);
    const before = Date.now();
    const meta = await readTeamMemberActivity(teamName);
    const after = Date.now();
    const head = await f.teams.getMessagesPage(teamName, { limit: 100 });
    const service = new MemberActivityMetaService({
      getPage: vi.fn().mockResolvedValue({ ...head, messages: head.messages.toReversed() }),
    } as unknown as TeamMessageFeedService);
    expect(meta.members).toEqual((await service.getMeta(teamName)).members);
    expect(meta).toMatchObject({
      teamName,
      feedRevision: head.feedRevision,
      members: {
        alice: {
          lastAuthoredMessageAt: messages[4].timestamp,
          messageCountExact: 2,
          latestAuthoredMessageSignalsTermination: false,
        },
        bob: {
          lastAuthoredMessageAt: messages[5].timestamp,
          messageCountExact: 2,
          latestAuthoredMessageSignalsTermination: true,
        },
      },
    });
    expect(Object.keys(meta.members)).toEqual(['alice', 'bob']);
    expect(Date.parse(meta.computedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(meta.computedAt)).toBeLessThanOrEqual(after);
    expect(f.legacyRead).not.toHaveBeenCalled();
    expect(f.recoveryRead).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.every(
          ([request]) =>
            request.operation === 'team.messages.page' && request.handle.handleId === executionId
        )
    ).toBe(true);

    const snapshot = {
      teamName,
      config: { name: teamName },
      tasks: [],
      members: [
        { name: 'alice', role: 'lead', taskCount: 0, currentTaskId: null },
        { name: 'bob', role: 'member', taskCount: 0, currentTaskId: null },
      ],
    } as unknown as TeamViewSnapshot;
    const members = selectResolvedMembersForTeamName(
      {
        selectedTeamName: teamName,
        selectedTeamData: snapshot,
        teamDataCacheByName: { [teamName]: snapshot },
        memberActivityMetaByTeam: { [teamName]: meta },
      },
      teamName
    );
    expect(members.find((member) => member.name === 'alice')).toMatchObject({
      messageCount: 2,
      lastActiveAt: messages[4].timestamp,
    });
    expect(members.find((member) => member.name === 'bob')?.status).toBe('terminated');
  });

  it('collects only the newest 200 records with signed pages capped at 100', async () => {
    const messages = Array.from({ length: 205 }, (_, index) => message(index));
    const f = fixture(messages);
    const meta = await readTeamMemberActivity(teamName);
    expect(meta.members.alice).toMatchObject({
      messageCountExact: 200,
      lastAuthoredMessageAt: messages[204].timestamp,
    });
    const calls = vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ operation: 'team.messages.page', payload: { limit: 100 } });
    expect(calls[1]).toMatchObject({ operation: 'team.messages.page', payload: { limit: 100 } });
    expect(calls[0].payload).not.toHaveProperty('cursor');
    expect(calls[1].payload).toHaveProperty('cursor', expect.any(String));
  });

  it('finishes an original fragmented message before interpreting its termination marker', async () => {
    const text = JSON.stringify({ type: 'shutdown_approved', TEST: 'x'.repeat(300_000) });
    const f = fixture([message(0), message(1, 'bob', text)]);
    const meta = await readTeamMemberActivity(teamName);
    expect(meta.members.bob).toMatchObject({
      messageCountExact: 1,
      latestAuthoredMessageSignalsTermination: true,
    });
    expect(meta.members.alice.messageCountExact).toBe(1);
    expect(f.source.readCount).toBeGreaterThan(1);
  });

  it('rejects a changed original feed instead of combining revisions or starting over', async () => {
    const f = fixture(Array.from({ length: 101 }, (_, index) => message(index)));
    f.source.afterRead = (_request, count) => {
      if (count === 1) f.source.snapshot.messages.push(message(200));
    };
    await expect(readTeamMemberActivity(teamName)).rejects.toThrow();
    expect(f.source.readCount).toBe(2);
    expect(vi.mocked(f.backend.invoke).mock.calls[1][0].payload).toHaveProperty('cursor');
  });

  it.each(['scope', 'mutation', 'owner', 'project'] as const)(
    'rejects an original %s boundary crossing without a legacy fallback',
    async (change) => {
      const f = fixture([message(0)]);
      f.source.afterRead = () => {
        if (change === 'scope') f.source.active = false;
        if (change === 'mutation') f.readOrder.invalidateReads(executionId);
        if (change === 'owner') {
          f.source.connections.bindings[0].ownerResourceRef = 'TEST-new-owner';
          f.source.connections.bindings[1].ownerResourceRef = 'TEST-new-owner';
        }
        if (change === 'project')
          f.source.connections.bindings[1].projectContext!.workContextId = 'TEST-new-project';
      };
      await expect(readTeamMemberActivity(teamName)).rejects.toThrow();
      expect(f.source.readCount).toBe(1);
      expect(f.legacyRead).not.toHaveBeenCalled();
      expect(f.recoveryRead).not.toHaveBeenCalled();
    }
  );

  it('returns an observed empty feed without inventing member or native state', async () => {
    const f = fixture([]);
    const meta = await readTeamMemberActivity(teamName);
    expect(meta.members).toEqual({});
    expect(meta.feedRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(meta).sort()).toEqual(['computedAt', 'feedRevision', 'members', 'teamName']);
    expect(f.source.readCount).toBe(1);
  });
});
