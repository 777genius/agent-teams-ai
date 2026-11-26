import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectTeamFixture } from '../../packages/legacy-agent-host/tests/projectTeamFixture.ts';
import { storedTeamCreationSchema } from '../../packages/legacy-agent-host/dist/team-registry/state.js';
import { selectDesktopProjectExecution } from './desktop-created-project-selection.ts';

function fixture(t: Parameters<typeof projectTeamFixture>[0]) {
  const f = projectTeamFixture(t), logical = f.create().record;
  f.prepare(logical, 'TEST-project-one');
  const projectPath = join(f.root, 'TEST-exact-project'); mkdirSync(projectPath);
  f.prepare(logical, 'TEST-project-two', projectPath);
  const execution = f.child(logical, projectPath);
  const directory = join(f.root, '.host-team-registry/records');
  const records = readdirSync(directory).map(name => storedTeamCreationSchema.parse(JSON.parse(readFileSync(join(directory, name), 'utf8'))));
  const discovery = { state: 'ready', bindings: f.registry.list(f.contextId).teams.map(value => ({
    handle: { handleId: value.binding.handleId }, ownerResourceRef: 'TEST-original-opaque-owner',
    teamResourceRef: `TEST-opaque-team:${value.teamId}`, projectContextMode: value.projectContextMode,
    ...(value.projectContext ? { projectContext: { logicalHandleId: value.projectContext.logicalHandleId,
      projectPath: value.projectContext.projectPath, workContextId: value.projectContext.workContextId } } : {}),
  })) };
  return { f, logical, execution, records, discovery,
    expected: { profile: f.profile, contextId: f.contextId, projectPath, ownerResourceRef: 'TEST-original-opaque-owner' } };
}

test('Desktop original oracle selects exact owner/logical/workspace child through the real registry contract', t => {
  const { logical, execution, records, expected, discovery } = fixture(t);
  const selected = selectDesktopProjectExecution(records, expected, logical.teamName, discovery);
  assert.deepEqual(selected.logical, logical);
  assert.deepEqual(selected.execution, execution);
  assert.notEqual(selected.logical.teamName, selected.execution.teamName);
});

test('Desktop original oracle refuses owner, relation, workspace, duplicate, held and original-context substitution', t => {
  const f = fixture(t);
  for (const mutate of [
    (value: typeof f.discovery) => { value.bindings.find(row => row.handle.handleId === f.execution.binding.handleId)!.ownerResourceRef = 'TEST-foreign'; },
    (value: typeof f.discovery) => { value.bindings.find(row => row.handle.handleId === f.execution.binding.handleId)!.projectContext!.logicalHandleId = 'TEST-other'; },
    (value: typeof f.discovery) => { value.bindings.find(row => row.handle.handleId === f.execution.binding.handleId)!.projectContext!.projectPath = f.f.project; },
    (value: typeof f.discovery) => { value.bindings.push(structuredClone(value.bindings.find(row => row.handle.handleId === f.execution.binding.handleId)!)); },
  ]) {
    const discovery = structuredClone(f.discovery); mutate(discovery);
    assert.throws(() => selectDesktopProjectExecution(f.records, f.expected, f.logical.teamName, discovery));
  }
  for (const field of ['ownerId', 'profileId', 'principalId'] as const) {
    const records = structuredClone(f.records);
    records.find(row => row.record.teamId === f.execution.teamId)![field] = 'TEST-foreign';
    assert.throws(() => selectDesktopProjectExecution(records, f.expected, f.logical.teamName, f.discovery));
  }
  const held = structuredClone(f.records);
  held.find(row => row.record.teamId === f.execution.teamId)!.phase = 'held';
  assert.throws(() => selectDesktopProjectExecution(held, f.expected, f.logical.teamName, f.discovery));
  assert.throws(() => selectDesktopProjectExecution(f.records, { ...f.expected, contextId: 'TEST-other-context' }, f.logical.teamName, f.discovery));
  assert.throws(() => selectDesktopProjectExecution(f.records, { ...f.expected, projectPath: join(f.f.root, 'TEST-absent-project') }, f.logical.teamName, f.discovery));
});
