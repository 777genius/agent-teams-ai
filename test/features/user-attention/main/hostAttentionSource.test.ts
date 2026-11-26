// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { USER_ATTENTION_HTTP_ROUTE } from '../../../../src/features/user-attention/contracts';
import { registerUserAttentionHttp } from '../../../../src/features/user-attention/main/adapters/input/registerUserAttentionHttp';
import { createUserAttentionFeature } from '../../../../src/features/user-attention/main/composition/createUserAttentionFeature';
import { capturedHostTeamReadsFixture } from '../../agent-backend/fixtures/capturedHostTeamReadsFixture';

const fixtures: ReturnType<typeof capturedHostTeamReadsFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.dispose()));
function fixture() {
  const f = capturedHostTeamReadsFixture();
  fixtures.push(f);
  const legacy = {
    listTeams: vi.fn(async () => []),
    getUserAttentionTasks: vi.fn(async () => []),
    getMessageFeed: vi.fn(async (teamName: string) => ({ teamName, feedRevision: '1', messages: [] })),
  };
  const feature = createUserAttentionFeature({ getContextId: () => 'TEST-root',
    captureHost: f.capture, getTeamDataService: () => legacy as never });
  return { f, legacy, feature };
}

function seed(f: ReturnType<typeof capturedHostTeamReadsFixture>, team: ReturnType<typeof f.addTeam>) {
  const task = team.human.execute({ commandId: 'TEST-awaiting-task', operation: 'task.create',
    payload: { subject: 'TEST question', owner: 'team-lead' } });
  team.human.execute({ commandId: 'TEST-awaiting-update', operation: 'task.clarification',
    payload: { taskId: String(task.effects.taskId), value: 'user' } });
  const path = join(f.root, 'teams', team.binding.teamName, 'inboxes');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'user.json'), JSON.stringify([{ messageId: 'TEST-direct-answer',
    from: 'alice', to: 'user', text: 'TEST unread answer',
    timestamp: '2026-11-25T12:00:00.000Z', read: false }]));
  return String(task.effects.taskId);
}

it('serves actual Host Tasks/messages over HTTP with no legacy Host-key lookup', async () => {
  const { f, feature, legacy } = fixture(), team = f.addTeam(), taskId = seed(f, team);
  const app = Fastify();
  registerUserAttentionHttp(app, feature);
  try {
    const response = await app.inject({ method: 'GET', url:
      USER_ATTENTION_HTTP_ROUTE + '?teamName=' + encodeURIComponent(team.key) });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.teams).toHaveLength(1);
    expect(snapshot.teams[0].tasks[0].taskId).toBe(taskId);
    expect(snapshot.teams[0].messages[0].messageId).toBe('TEST-direct-answer');
    expect(legacy.getUserAttentionTasks).not.toHaveBeenCalled();
    expect(legacy.getMessageFeed).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it.each(['per_project', 'shared'] as const)('keeps project navigation under the original %s logical Team while reading the retained execution child', async projectContextMode => {
  const { f, feature } = fixture();
  const logical = f.addTeam({ name: 'logical', projectContextMode });
  const child = f.addTeam({ name: 'child', projectContext: {
    logicalHandleId: logical.connection.handle.handleId, workContextId: 'TEST-work-context',
    projectPath: join(f.root, 'TEST-child-project') } });
  const taskId = seed(f, child);
  const result = await feature.getUserAttentionSnapshot(child.key);
  expect(result.complete).toBe(true);
  expect(result.teams).toHaveLength(1);
  expect(result.teams[0]).toMatchObject({ teamName: child.key, logicalTeamName: logical.key,
    projectPath: child.connection.projectContext?.projectPath });
  expect(result.teams[0].tasks[0]).toMatchObject({ taskId, logicalTeamName: logical.key });
});

it('hides a child when its logical Team is trashed before lifecycle fanout finishes', async () => {
  const { f, feature, legacy } = fixture();
  const logical = f.addTeam({ name: 'logical', projectContextMode: 'per_project' });
  const child = f.addTeam({ name: 'child', projectContext: {
    logicalHandleId: logical.connection.handle.handleId, workContextId: 'TEST-retained-context',
    projectPath: join(f.root, 'TEST-retained-project') } });
  seed(f, child);
  const lifecycle = logical.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash-parent', operation: 'trash',
    expectedRevision: lifecycle.view().revision });
  const result = await feature.getUserAttentionSnapshot();
  expect(result.complete).toBe(true);
  expect(result.teams).toEqual([]);
  expect(child.owner.lifecycleCommands('human').view().deletedAt).toBeNull();
  expect(legacy.getUserAttentionTasks).not.toHaveBeenCalled();
});

it('reports an inaccessible original owner as incomplete without falling back to legacy', async () => {
  const { f, feature, legacy } = fixture(), team = f.addTeam();
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
  } finally { await app.close(); }
});
