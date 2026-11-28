// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGroupCatalogValue } from '@agent-teams/legacy-agent-host/group-chats/public-values';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { USER_ATTENTION_HTTP_ROUTE } from '../../../../src/features/user-attention/contracts';
import { buildAttentionModel } from '../../../../src/features/user-attention/core/domain/buildAttention';
import { registerUserAttentionHttp } from '../../../../src/features/user-attention/main/adapters/input/registerUserAttentionHttp';
import { createUserAttentionFeature } from '../../../../src/features/user-attention/main/composition/createUserAttentionFeature';
import { capturedHostTeamReadsFixture } from '../../agent-backend/fixtures/capturedHostTeamReadsFixture';

const fixtures: ReturnType<typeof capturedHostTeamReadsFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.dispose()));
function fixture() {
  const f = capturedHostTeamReadsFixture();
  fixtures.push(f);
  const legacy = {
    listTeams: vi.fn(async () => []),
    getUserAttentionTasks: vi.fn(async () => []),
    getMessageFeed: vi.fn(async (teamName: string) => ({
      teamName,
      feedRevision: '1',
      messages: [],
    })),
  };
  const feature = createUserAttentionFeature({
    getContextId: () => 'TEST-root',
    captureHost: f.capture,
    getTeamDataService: () => legacy as never,
  });
  return { f, legacy, feature };
}

function seed(
  f: ReturnType<typeof capturedHostTeamReadsFixture>,
  team: ReturnType<typeof f.addTeam>
) {
  const task = team.human.execute({
    commandId: 'TEST-awaiting-task',
    operation: 'task.create',
    payload: { subject: 'TEST question', owner: 'team-lead' },
  });
  team.human.execute({
    commandId: 'TEST-awaiting-update',
    operation: 'task.clarification',
    payload: { taskId: String(task.effects.taskId), value: 'user' },
  });
  const path = join(f.root, 'teams', team.binding.teamName, 'inboxes');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'user.json'),
    JSON.stringify([
      {
        messageId: 'TEST-direct-answer',
        from: 'alice',
        to: 'user',
        text: 'TEST unread answer',
        timestamp: '2026-11-25T12:00:00.000Z',
        read: false,
      },
    ])
  );
  return String(task.effects.taskId);
}

it('serves actual Host Tasks/messages over HTTP with no legacy Host-key lookup', async () => {
  const { f, feature, legacy } = fixture(),
    team = f.addTeam(),
    taskId = seed(f, team);
  const app = Fastify();
  registerUserAttentionHttp(app, feature);
  try {
    const response = await app.inject({
      method: 'GET',
      url: USER_ATTENTION_HTTP_ROUTE + '?teamName=' + encodeURIComponent(team.key),
    });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.teams).toHaveLength(1);
    const persisted = team.human.getTask(taskId);
    expect(typeof persisted.clarificationRequestedAt).toBe('string');
    expect(snapshot.teams[0].tasks[0]).toMatchObject({
      taskId,
      owner: 'team-lead',
      requestedAt: persisted.clarificationRequestedAt,
    });
    expect(snapshot.teams[0].messages[0].messageId).toBe('TEST-direct-answer');
    expect(legacy.getUserAttentionTasks).not.toHaveBeenCalled();
    expect(legacy.getMessageFeed).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('keeps a completed agent review readable while awaiting human approval', async () => {
  const { f, feature } = fixture();
  const team = f.addTeam({
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin', 'task.write', 'message.write'],
      },
      {
        principalId: 'alice',
        memberName: 'alice',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
  });
  team.human.execute({
    commandId: 'TEST-review-policy',
    operation: 'task.board.review-flow',
    payload: { settings: { reviewFlow: 'human_approval', reviewFlowPrompt: '' } },
  });
  const taskId = team.human.execute({
    commandId: 'TEST-create-review',
    operation: 'task.create',
    payload: { subject: 'TEST human approval', owner: 'team-lead' },
  }).effects.taskId;
  team.human.execute({
    commandId: 'TEST-finish-task',
    operation: 'task.lifecycle',
    payload: { taskId, action: 'complete' },
  });
  team.human.execute({
    commandId: 'TEST-request-review',
    operation: 'task.review',
    payload: { taskId, action: 'request', reviewer: 'alice' },
  });
  const reviewer = team.owner.connect('alice');
  const started = reviewer.execute({
    commandId: 'TEST-start-review',
    operation: 'task.review',
    payload: { taskId, action: 'start' },
  }).result as { reviewRequestId: string };
  reviewer.execute({
    commandId: 'TEST-complete-review',
    operation: 'task.review',
    payload: { taskId, action: 'complete', expectedReviewRequestId: started.reviewRequestId },
  });
  expect(team.human.getTask(taskId).reviewState).toBe('reviewed');
  const captured = await f.capture();
  if (!captured) throw new Error('Expected the captured TEST Host');
  expect((await captured.product(team.key)).data.tasks[0]).toMatchObject({
    id: taskId,
    reviewState: 'reviewed',
  });
  expect((await feature.getUserAttentionSnapshot(team.key)).complete).toBe(true);
});

it.each(['per_project', 'shared'] as const)(
  'keeps project navigation under the original %s logical Team while reading the retained execution child',
  async (projectContextMode) => {
    const { f, feature } = fixture();
    const logical = f.addTeam({ name: 'logical', projectContextMode });
    const child = f.addTeam({
      name: 'child',
      projectContext: {
        logicalHandleId: logical.connection.handle.handleId,
        workContextId: 'TEST-work-context',
        projectPath: join(f.root, 'TEST-child-project'),
      },
    });
    const taskId = seed(f, child);
    const result = await feature.getUserAttentionSnapshot(child.key);
    expect(result.complete).toBe(true);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]).toMatchObject({
      teamName: child.key,
      logicalTeamName: logical.key,
      projectPath: child.connection.projectContext?.projectPath,
    });
    expect(result.teams[0].tasks[0]).toMatchObject({ taskId, logicalTeamName: logical.key });
  }
);

it('hides a child when its logical Team is trashed before lifecycle fanout finishes', async () => {
  const { f, feature, legacy } = fixture();
  const logical = f.addTeam({ name: 'logical', projectContextMode: 'per_project' });
  const child = f.addTeam({
    name: 'child',
    projectContext: {
      logicalHandleId: logical.connection.handle.handleId,
      workContextId: 'TEST-retained-context',
      projectPath: join(f.root, 'TEST-retained-project'),
    },
  });
  seed(f, child);
  const lifecycle = logical.owner.lifecycleCommands('human');
  lifecycle.execute({
    commandId: 'TEST-trash-parent',
    operation: 'trash',
    expectedRevision: lifecycle.view().revision,
  });
  const result = await feature.getUserAttentionSnapshot();
  expect(result.complete).toBe(true);
  expect(result.teams).toEqual([]);
  expect(child.owner.lifecycleCommands('human').view().deletedAt).toBeNull();
  expect(legacy.getUserAttentionTasks).not.toHaveBeenCalled();
});

it('reports an inaccessible original owner as incomplete without falling back to legacy', async () => {
  const { f, feature, legacy } = fixture(),
    team = f.addTeam();
  team.human.revoke('human');
  const result = await feature.getUserAttentionSnapshot();
  expect(result.complete).toBe(false);
  expect(result.teams[0].error).toBeTruthy();
  expect(legacy.getUserAttentionTasks).not.toHaveBeenCalled();
});

it('rejects context revocation before publishing an HTTP result', async () => {
  const { f, feature } = fixture();
  f.addTeam();
  f.afterRead(() => f.revokeContext());
  const app = Fastify();
  registerUserAttentionHttp(app, feature);
  try {
    const response = await app.inject({ method: 'GET', url: USER_ATTENTION_HTTP_ROUTE });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('TEST-handle');
  } finally {
    await app.close();
  }
});

function seedRetainedGroups(
  f: ReturnType<typeof capturedHostTeamReadsFixture>,
  team: ReturnType<ReturnType<typeof capturedHostTeamReadsFixture>['addTeam']>
) {
  const groups = Array.from({ length: 1100 }, (_, index) => ({
    id: index.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001',
    name: 'TEST attention group ' + index + ' ' + 'x'.repeat(65),
    createdAt: '2026-11-28T00:00:00.000Z',
    membership: { kind: 'fixed', memberNames: ['team-lead', 'alice'] },
    archivedAt: index % 2 ? '2026-11-28T01:00:00.000Z' : null,
  }));
  const registry = join(f.root, 'teams', team.binding.teamName, 'group-chats.json');
  const bytes = JSON.stringify({ version: 1, groups });
  writeFileSync(registry, bytes);
  const chosen = groups.at(-1)!;
  const path = join(f.root, 'teams', team.binding.teamName, 'inboxes');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'user.json'),
    JSON.stringify([
      {
        messageId: 'TEST-attention-group-physical',
        groupMessageId: 'TEST-attention-group-physical',
        groupChatId: chosen.id,
        groupChatProtocolVersion: 1,
        from: 'alice',
        to: 'user',
        text: '@user TEST group reply',
        read: false,
        timestamp: '2026-11-28T00:00:00.000Z',
        groupRecipientNames: ['team-lead', 'alice'],
        groupRecipientRunKeys: { 'team-lead': 'TEST-lead-run', alice: 'TEST-alice-run' },
      },
    ])
  );
  return { groups, chosen, registry, bytes };
}

it('preserves full original group names and unread identity beyond the first Host catalog page', async () => {
  const { f, feature, legacy } = fixture(),
    team = f.addTeam();
  const { groups, chosen, registry, bytes } = seedRetainedGroups(f, team);
  const result = await feature.getUserAttentionSnapshot(team.key);
  const model = buildAttentionModel(
    result,
    () => ({ direct: new Set(), group: new Set() }),
    (message) => message.messageId ?? message.timestamp
  );
  expect(result.complete).toBe(true);
  expect(model.unreadMessageCount).toBe(1);
  expect(model.chats[0]?.latestUnread.messageId).toBe('TEST-attention-group-physical');
  expect(model.chats[0]?.name).toBe(chosen.name);
  expect(result.teams[0]?.groupNames).toEqual(
    Object.fromEntries(groups.map((row) => [row.id, row.name]))
  );
  expect(result.teams[0]?.groupNames?.[chosen.id]).toBe(chosen.name);
  expect(
    result.teams[0]?.messages.some(
      (message) =>
        message.messageId === 'TEST-attention-group-physical' && message.groupChatId === chosen.id
    )
  ).toBe(true);
  expect(
    f.router.request.mock.calls.filter(([, request]) => request.method === 'team.group.list').length
  ).toBeGreaterThan(1);
  const groupRequests = f.router.request.mock.calls.filter(
    ([, request]) => request.method === 'team.group.list'
  );
  expect(
    groupRequests.every(([handle]) => handle.handleId === team.connection.handle.handleId)
  ).toBe(true);
  const firstIndex = f.router.request.mock.calls.findIndex(
    ([, request]) => request.method === 'team.group.list'
  );
  const first = await f.router.request.mock.results[firstIndex]!.value;
  if (!first || typeof first !== 'object' || Array.isArray(first))
    throw new Error('Invalid TEST reply');
  const page = readGroupCatalogValue(first.value);
  if (Array.isArray(page)) throw new Error('Expected the real TEST Host page');
  expect(page.groups.some((row) => row.id === chosen.id)).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(240 * 1024);
  expect(readFileSync(registry, 'utf8')).toBe(bytes);
  expect(legacy.getMessageFeed).not.toHaveBeenCalled();
});

it('refuses changed group catalog and revoked Host context without a partial name map', async () => {
  for (const mode of ['revision', 'scope'] as const) {
    const { f, feature } = fixture(),
      team = f.addTeam();
    const saved = seedRetainedGroups(f, team);
    const captured = await f.capture();
    if (!captured) throw new Error('Missing original captured TEST Owner');
    let pages = 0;
    f.afterRead((method) => {
      if (method !== 'team.group.list' || ++pages !== 1) return;
      if (mode === 'scope') f.revokeContext();
      else
        writeFileSync(
          saved.registry,
          JSON.stringify({
            version: 1,
            groups: saved.groups.slice(0, -1),
          })
        );
    });
    await expect(captured.groupNames(team.key)).rejects.toThrow();
    expect(pages).toBeGreaterThanOrEqual(1);
    if (mode === 'revision') {
      expect(
        f.router.request.mock.calls.filter(([, request]) => request.method === 'team.group.list')
      ).toHaveLength(2);
      writeFileSync(saved.registry, saved.bytes);
      pages = 0;
      const snapshot = await feature.getUserAttentionSnapshot(team.key);
      expect(snapshot.teams[0]?.groupNames).toEqual({});
      expect(snapshot.teams[0]?.messages[0]?.messageId).toBe('TEST-attention-group-physical');
      expect(snapshot.complete).toBe(true);
    }
  }
});

it.each(['scope', 'owner'] as const)(
  'rejects attention publication when %s changes during a group continuation',
  async (mode) => {
    const { f, feature, legacy } = fixture(),
      team = f.addTeam();
    seedRetainedGroups(f, team);
    let pages = 0;
    f.afterRead((method) => {
      if (method !== 'team.group.list' || ++pages !== 2) return;
      if (mode === 'scope') f.revokeContext();
      else {
        const binding = f.snapshot().bindings[0];
        if (!binding) throw new Error('Missing original TEST binding');
        binding.ownerResourceRef = 'TEST-replacement-owner';
      }
    });
    await expect(feature.getUserAttentionSnapshot(team.key)).rejects.toThrow();
    expect(pages).toBe(2);
    expect(legacy.getMessageFeed).not.toHaveBeenCalled();
  }
);

it.each([0, 1])(
  'retains the complete %i-row group-name read and its request-local cache',
  async (count) => {
    const { f } = fixture(),
      team = f.addTeam();
    const saved = seedRetainedGroups(f, team);
    const groups = saved.groups.slice(0, count);
    const bytes = JSON.stringify({ version: 1, groups });
    writeFileSync(saved.registry, bytes);
    const captured = await f.capture();
    if (!captured) throw new Error('Expected the original TEST source');
    const expected = Object.fromEntries(groups.map((row) => [row.id, row.name]));
    await expect(captured.groupNames(team.key)).resolves.toEqual(expected);
    await expect(captured.groupNames(team.key)).resolves.toEqual(expected);
    expect(
      f.router.request.mock.calls.filter(([, request]) => request.method === 'team.group.list')
    ).toHaveLength(1);
    expect(readFileSync(saved.registry, 'utf8')).toBe(bytes);
  }
);
