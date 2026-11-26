// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts';
import { normalizeOrganizationMapRequest } from '../../../src/features/organizations/contracts';
import { getAgentId, getTeamNodeId } from '../../../src/features/organizations/core/domain/organizationIds';
import { registerOrganizationsHttp } from '../../../src/features/organizations/main/adapters/input/http/registerOrganizationsHttp';
import { HostRoutedOrganizationSource } from '../../../src/features/organizations/main/adapters/output/HostRoutedOrganizationSource';
import { createOrganizationsFeature } from '../../../src/features/organizations/main/composition/createOrganizationsFeature';
import { JsonOrganizationStructureRepository } from '../../../src/features/organizations/main/infrastructure/JsonOrganizationStructureRepository';
import { setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';
import { capturedHostTeamReadsFixture } from '../agent-backend/fixtures/capturedHostTeamReadsFixture';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setClaudeBasePathOverride(null); vi.restoreAllMocks();
});
function fixture() {
  const host = capturedHostTeamReadsFixture(); cleanups.push(() => host.dispose());
  setClaudeBasePathOverride(join(host.root, '.claude'));
  const teamDataService = {
    listTeams: vi.fn(async () => [{ teamName: 'legacy', displayName: 'Legacy', description: '', memberCount: 0, taskCount: 0, lastActivity: null }]),
    getAllTasks: vi.fn(async () => []), listAliveProcessTeams: vi.fn(async () => []),
  };
  const crossTeamService = { getOutbox: vi.fn(async () => []) };
  const captureHost = vi.fn(host.capture), logger = { warn: vi.fn(), error: vi.fn() };
  const deps = { teamDataService, crossTeamService, captureHost, logger };
  const feature = createOrganizationsFeature(deps);
  return { ...host, deps, feature, captureHost, teamDataService, crossTeamService,
    map: () => feature.getOrganizationMap(normalizeOrganizationMapRequest({ scope: 'all' })) };
}
function task(team: ReturnType<ReturnType<typeof fixture>['addTeam']>, subject: string,
  active = false) {
  const taskId = team.human.execute({ operation: 'task.create', commandId: randomUUID(),
    payload: { subject, owner: 'alice' } }).effects.taskId;
  if (active) expect(team.human.execute({ operation: 'task.lifecycle', commandId: randomUUID(),
    payload: { taskId: String(taskId), action: 'start' } }).phase).toBe('completed');
  return taskId;
}

it('includes real Host tasks and saved members alongside the unchanged legacy directory', async () => {
  const f = fixture(), team = f.addTeam({ name: 'builders' });
  const taskId = task(team, 'TEST original task', true);
  task(team, 'TEST pending task');
  const map = await f.map();
  expect(map.degraded).toBe(false);
  const row = map.nodes.find(node => node.team?.teamName === team.key)!;
  expect(row.team).toMatchObject({ teamName: team.key, displayName: 'builders', memberCount: 2,
    taskCounts: { pending: 1, inProgress: 1, completed: 0 } });
  expect(row.team?.agents.find(agent => agent.name === 'alice')?.currentTasks).toContainEqual(
    expect.objectContaining({ id: taskId, subject: 'TEST original task' }));
  expect(map.nodes.some(node => node.team?.teamName === 'legacy')).toBe(true);
  expect(f.captureHost).toHaveBeenCalledTimes(1);
  expect(f.crossTeamService.getOutbox).toHaveBeenCalledExactlyOnceWith('legacy');
});

it('folds only verified same-owner project histories and retains each task execution key', async () => {
  const f = fixture(), logical = f.addTeam({ name: 'logical', projectContextMode: 'per_project' });
  const children = ['a', 'b'].map(id => f.addTeam({ name: 'history-' + id, projectContext: {
    logicalHandleId: logical.connection.handle.handleId, workContextId: 'TEST-work-' + id,
    projectPath: join(f.root, id),
  } }));
  for (const child of children) task(child, 'TEST ' + child.binding.teamName, true);
  const map = await f.map();
  const row = map.nodes.find(node => node.team?.teamName === logical.key)!;
  expect(row.team?.taskCounts.inProgress).toBe(2);
  expect(row.team?.agents.find(agent => agent.name === 'alice')?.currentTasks.map(value => value.executionTeamName).sort())
    .toEqual(children.map(child => child.key).sort());
  expect(map.nodes.filter(node => node.team && children.some(child => child.key === node.team?.teamName))).toEqual([]);
});

it('refuses a project relation to a different owner without querying legacy by the Host key', async () => {
  const f = fixture(), logical = f.addTeam({ name: 'logical', projectContextMode: 'per_project' });
  f.addTeam({ name: 'foreign', ownerResourceRef: 'TEST-other-owner', projectContext: {
    logicalHandleId: logical.connection.handle.handleId, workContextId: 'TEST-work', projectPath: f.root } });
  await expect(f.map()).rejects.toThrow('project owner changed');
  expect(f.crossTeamService.getOutbox).not.toHaveBeenCalled();
});

it('refuses an incomplete owner catalog rather than presenting it as an empty directory', async () => {
  const f = fixture(); f.addTeam();
  f.setSnapshot({ ...f.snapshot(), unavailableOwners: [{ kind: 'owner', ownerResourceRef: 'TEST-missing', code: 'unavailable', outcome: 'unknown' }] });
  await expect(f.map()).rejects.toThrow('catalog is incomplete');
});

it.each([new Error('TEST original failure'), 'TEST rejected value', undefined])(
  'retains a failed captured organization request without issuing another read (%s)',
  async (reason) => {
    const f = fixture();
    const directory = { listTeams: vi.fn().mockRejectedValue(reason) };
    const messages = { listRecentMessages: vi.fn(async () => []) };
    const host = await f.capture();
    if (!host) throw new Error('TEST Host read scope was not captured');
    const source = new HostRoutedOrganizationSource(host, directory, messages);
    await expect(source.listTeams({ includeDeletedTeams: false })).rejects.toBe(reason);
    let failure: unknown;
    try { source.assertCurrent(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (reason instanceof Error) expect(failure).toBe(reason);
    else expect((failure as Error).cause).toBe(reason);
    await expect(source.listTeams({ includeDeletedTeams: false })).rejects.toBe(failure);
    await expect(source.listRecentMessages({ teamNames: [], maxMessages: 1 })).rejects.toBe(failure);
    expect(directory.listTeams).toHaveBeenCalledTimes(1);
    expect(messages.listRecentMessages).not.toHaveBeenCalled();
  }
);

it('rejects the original read if its context is revoked during the actual Host snapshot', async () => {
  const f = fixture(); f.addTeam();
  f.afterRead(method => { if (method === 'team.snapshot') f.revokeContext(); });
  await expect(f.map()).rejects.toThrow('context changed');
});

it('rejects a captured binding takeover during the saved configuration read', async () => {
  const f = fixture(); f.addTeam();
  f.afterRead(method => { if (method === 'team.roster.read') f.snapshot().bindings[0]!.ownerResourceRef = 'TEST-replacement'; });
  await expect(f.map()).rejects.toThrow('context changed');
});

it('does not expose a restored team before its original cleanup debt is settled', async () => {
  const f = fixture(), team = f.addTeam(), lifecycle = team.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash', operation: 'trash', expectedRevision: lifecycle.view().revision });
  lifecycle.execute({ commandId: 'TEST-restore', operation: 'restore', expectedRevision: lifecycle.view().revision });
  await expect(f.map()).rejects.toThrow('lifecycle is pending');
});

it('uses distinct graph and agent identities for opaque handles with colliding normalized punctuation', async () => {
  const f = fixture(), first = f.addTeam({ name: 'first', handleId: 'TEST/x' }),
    second = f.addTeam({ name: 'second', handleId: 'TEST-2Fx' });
  expect(getTeamNodeId(first.key)).not.toBe(getTeamNodeId(second.key));
  expect(getAgentId(first.key, 'alice')).not.toBe(getAgentId(second.key, 'alice'));
  const map = await f.map();
  expect(map.nodes.filter(node => node.team && [first.key, second.key].includes(node.team.teamName))).toHaveLength(2);
});

it('keeps original ordinary-team graph IDs stable', () => {
  expect(getTeamNodeId('legacy')).toBe('team:legacy');
  expect(getAgentId('legacy', 'alice')).toBe('agent:legacy:alice');
  expect(getTeamNodeId(hostTeamSelectionKey('TEST/a'))).not.toBe(getTeamNodeId(hostTeamSelectionKey('TEST-2Fa')));
});

it('fences a structure mutation after loading when its original Host context was revoked', async () => {
  const f = fixture(); f.addTeam();
  const save = vi.spyOn(JsonOrganizationStructureRepository.prototype, 'saveStructure');
  vi.spyOn(JsonOrganizationStructureRepository.prototype, 'loadStructure').mockImplementation(async () => {
    f.revokeContext(); return null;
  });
  await expect(f.feature.createOrganization({ name: 'TEST original organization' })).rejects.toThrow('context changed');
  expect(save).not.toHaveBeenCalled();
});

it('saves the current original organization command and retains opaque team assignment through a cold read', async () => {
  const f = fixture(), team = f.addTeam({ name: 'current', handleId: 'TEST/team' });
  const created = await f.feature.createOrganization({ name: 'TEST Organization' });
  const organization = created.organizations[0]!;
  const assigned = await f.feature.assignTeamToUnit({ organizationId: organization.id,
    parentUnitId: organization.rootNodeId, teamName: team.key });
  expect(assigned.units).toContainEqual(expect.objectContaining({ teamName: team.key }));
  const cold = createOrganizationsFeature(f.deps);
  expect((await cold.getOrganizationStructure()).units).toContainEqual(expect.objectContaining({ teamName: team.key }));
});

it('preserves the legacy route when no Host scope is selected', async () => {
  const f = fixture(); f.addTeam();
  const feature = createOrganizationsFeature({ ...f.deps, captureHost: async () => undefined });
  const map = await feature.getOrganizationMap(normalizeOrganizationMapRequest({}));
  expect(map.nodes.filter(node => node.team).map(node => node.team!.teamName)).toEqual(['legacy']);
  expect(f.router.request).not.toHaveBeenCalled();
});

it('projects the real Host directory through the existing HTTP route', async () => {
  const f = fixture(), team = f.addTeam(); task(team, 'TEST HTTP task');
  const app = Fastify(); cleanups.push(() => app.close()); registerOrganizationsHttp(app, f.feature);
  const response = await app.inject({ method: 'GET', url: '/api/organizations/map?scope=all' });
  expect(response.statusCode).toBe(200);
  expect(response.json().nodes).toContainEqual(expect.objectContaining({ team: expect.objectContaining({ teamName: team.key }) }));
});

it('returns the existing degraded HTTP result without retained Host rows after revocation', async () => {
  const f = fixture(); f.addTeam();
  const app = Fastify(); cleanups.push(() => app.close()); registerOrganizationsHttp(app, f.feature);
  f.afterRead(method => { if (method === 'team.snapshot') f.revokeContext(); });
  const response = await app.inject({ method: 'GET', url: '/api/organizations/map' });
  expect(response.json()).toMatchObject({ degraded: true, nodes: [], relations: [] });
});
