import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { openProjectTeamFixture, projectTeamFixture } from '../../packages/legacy-agent-host/tests/projectTeamFixture.ts';
import { storedTeamCreationSchema } from '../../packages/legacy-agent-host/dist/team-registry/state.js';
import { effectId } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { hostTeamRunId } from '../../src/features/agent-backend/contracts/teamRunSelection.ts';
import { assertDesktopMembershipProjectBindings, createDesktopProjectLaunchRead, createDesktopProjectRunObserver, createDesktopSelectedProjectReadPort, desktopProjectSelectionExpression, observeDesktopProjectExecution, readDesktopProjectExecutionState, selectDesktopProjectExecution } from './desktop-created-project-selection.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { OwnerState } from '../../packages/legacy-agent-host/dist/team/ownerState.js';

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

test('Desktop project publication may be pending without adopting a foreign or unavailable owner', t => {
  const f = fixture(t);
  const pendingRecords = f.records.filter(value => value.record.teamId !== f.execution.teamId);
  const pendingDiscovery = { ...f.discovery, bindings: f.discovery.bindings.filter(value => value.handle.handleId !== f.execution.binding.handleId) };
  assert.equal(observeDesktopProjectExecution(pendingRecords, f.expected, f.logical.teamName, pendingDiscovery), undefined);
  assert.equal(observeDesktopProjectExecution(f.records, f.expected, f.logical.teamName, pendingDiscovery), undefined);
  assert.throws(() => selectDesktopProjectExecution(f.records, f.expected, f.logical.teamName, pendingDiscovery));
  const foreign = structuredClone(pendingDiscovery);
  foreign.bindings.find(value => value.handle.handleId === f.logical.binding.handleId)!.ownerResourceRef = 'TEST-foreign';
  assert.throws(() => observeDesktopProjectExecution(f.records, f.expected, f.logical.teamName, foreign));
  assert.throws(() => observeDesktopProjectExecution(f.records, f.expected, f.logical.teamName,
    { ...pendingDiscovery, unavailableOwners: [{ ownerResourceRef: f.expected.ownerResourceRef }] }));
  assert.deepEqual(observeDesktopProjectExecution(f.records, f.expected, f.logical.teamName, f.discovery),
    { logical: f.logical, execution: f.execution });
});

test('Desktop run observation permits one pending attempt and publication of the same captured run', () => {
  const observe = createDesktopProjectRunObserver('TEST-logical', 'TEST-execution');
  const pending = `pending:${hostTeamSelectionKey('TEST-logical')}:${randomUUID()}`;
  const run = hostTeamRunId('TEST-execution', 'TEST-launch', 'TEST-roster');
  assert.equal(observe({}, 'TEST-launch'), false);
  assert.equal(observe({ provisioning: pending }, 'TEST-launch'), false);
  assert.equal(observe({ runtime: run, provisioning: pending }, 'TEST-launch'), false);
  assert.equal(observe({ runtime: run, provisioning: run }, 'TEST-launch'), true);
  assert.equal(observe({ runtime: run, provisioning: run }, 'TEST-launch'), true);
  assert.throws(() => observe({ runtime: run, provisioning: pending }, 'TEST-launch'));
  assert.throws(() => observe({ provisioning: run }, 'TEST-launch'));
});

test('Desktop run observation accepts the original installer UUIDv4 attempt', () => {
  const observe = createDesktopProjectRunObserver('TEST-logical', 'TEST-execution');
  const pending = `pending:${hostTeamSelectionKey('TEST-logical')}:d14ac75f-f381-4c97-acec-462e6f47f74a`;
  const run = hostTeamRunId('TEST-execution', 'TEST-launch', 'TEST-roster');
  assert.equal(observe({ provisioning: pending }, 'TEST-launch'), false);
  assert.equal(observe({ runtime: run, provisioning: pending }, 'TEST-launch'), false);
  assert.equal(observe({ runtime: run, provisioning: run }, 'TEST-launch'), true);
});

for (const [reason, suffix] of [
  ['numeric', '1'],
  ['empty', ''],
  ['malformed', 'not-a-uuid'],
  ['truncated', 'd14ac75f-f381-4c97-acec-462e6f47f74'],
  ['wrong version', 'd14ac75f-f381-5c97-acec-462e6f47f74a'],
  ['wrong variant', 'd14ac75f-f381-4c97-ccec-462e6f47f74a'],
  ['uppercase', 'D14AC75F-F381-4C97-ACEC-462E6F47F74A'],
  ['leading space', ' d14ac75f-f381-4c97-acec-462e6f47f74a'],
  ['trailing space', 'd14ac75f-f381-4c97-acec-462e6f47f74a '],
  ['trailing LF', 'd14ac75f-f381-4c97-acec-462e6f47f74a\n'],
  ['trailing CR', 'd14ac75f-f381-4c97-acec-462e6f47f74a\r'],
  ['trailing CRLF', 'd14ac75f-f381-4c97-acec-462e6f47f74a\r\n'],
  ['trailing data', 'd14ac75f-f381-4c97-acec-462e6f47f74a-extra'],
  ['legacy startup sweep', 'opencode-startup-sweep'],
] as const) {
  test(`Desktop run observation rejects a ${reason} pending suffix`, () => {
    const observe = createDesktopProjectRunObserver('TEST-logical', 'TEST-execution');
    assert.throws(() => observe({ provisioning: `pending:${hostTeamSelectionKey('TEST-logical')}:${suffix}` }, 'TEST-launch'));
  });
}

test('Desktop run observation rejects a foreign logical attempt and a pending runtime ID', () => {
  const attemptId = randomUUID();
  const observe = createDesktopProjectRunObserver('TEST-logical', 'TEST-execution');
  assert.throws(() => observe({ provisioning: `pending:${hostTeamSelectionKey('TEST-other')}:${attemptId}` }, 'TEST-launch'));
  assert.throws(() => observe({ runtime: `pending:${hostTeamSelectionKey('TEST-logical')}:${attemptId}` }, 'TEST-launch'));
});

test('Desktop run observation rejects replacement or disappearance during partial publication', () => {
  const run = hostTeamRunId('TEST-execution', 'TEST-launch', 'TEST-roster');
  const replacement = hostTeamRunId('TEST-execution', 'TEST-launch', 'TEST-other-roster');
  const pending = `pending:${hostTeamSelectionKey('TEST-logical')}:${randomUUID()}`;
  for (const changed of [{ runtime: replacement, provisioning: replacement }, { provisioning: pending }]) {
    const observe = createDesktopProjectRunObserver('TEST-logical', 'TEST-execution');
    assert.equal(observe({ runtime: run, provisioning: pending }, 'TEST-launch'), false);
    assert.throws(() => observe(changed, 'TEST-launch'));
  }
  const observe = createDesktopProjectRunObserver('TEST-logical', 'TEST-execution');
  assert.equal(observe({ provisioning: pending }, 'TEST-launch'), false);
  const replacementPending = `pending:${hostTeamSelectionKey('TEST-logical')}:${randomUUID()}`;
  assert.notEqual(replacementPending, pending);
  assert.throws(() => observe({ provisioning: replacementPending }, 'TEST-launch'), {
    code: 'ERR_ASSERTION', message: /^same original pending launch attempt/,
    actual: replacementPending, expected: pending,
  });
  for (const foreign of [hostTeamRunId('TEST-other', 'TEST-launch', 'TEST-roster'),
    hostTeamRunId('TEST-execution', 'TEST-other-launch', 'TEST-roster')])
    assert.throws(() => createDesktopProjectRunObserver('TEST-logical', 'TEST-execution')({ runtime: foreign }, 'TEST-launch'));
});

test('Desktop launch read waits within its caller poll and pins the first published selection and capture', async () => {
  const binding = { backendId: 'TEST-host', teamId: 'TEST-execution', teamName: 'TEST-team' };
  const state: Record<string, unknown> = { binding, runtimeCaptures: [] };
  let published = false, observations = 0, reads = 0;
  const pins: Record<string, unknown> = {};
  const observer = createDesktopProjectRunObserver('TEST-logical', 'TEST-execution');
  const selection = { owner: { binding, workspace: '/TEST-workspace' },
    async assertCurrent() {}, async observeRun(launchId: unknown) { return observer(pins, launchId); } };
  const read = createDesktopProjectLaunchRead(async () => { observations++; return published ? selection : undefined; },
    async selected => { assert.equal(selected, selection); reads++; return structuredClone(state); });
  assert.equal(await read(), undefined); assert.equal(reads, 0);
  published = true; assert.equal(await read(), undefined);
  state.runtimeCaptures = [{ launchId: 'TEST-launch', fingerprint: 'TEST-original' }];
  pins.provisioning = `pending:${hostTeamSelectionKey('TEST-logical')}:${randomUUID()}`;
  assert.equal(await read(), undefined);
  pins.runtime = hostTeamRunId('TEST-execution', 'TEST-launch', 'TEST-roster');
  assert.equal(await read(), undefined);
  pins.provisioning = pins.runtime;
  assert.deepEqual(await read(), { selection, state });
  assert.equal(observations, 2); assert.equal(reads, 4);
});

test('Desktop launch read refuses changed capture, owner or context without replacing the first selection', async () => {
  const binding = { backendId: 'TEST-host', teamId: 'TEST-execution', teamName: 'TEST-team' };
  for (const changed of [[], [{ launchId: 'TEST-replacement' }],
    [{ launchId: 'TEST-launch', fingerprint: 'TEST-replacement' }], [{ launchId: 'TEST-launch' }, { launchId: 'TEST-second' }]]) {
    const state: Record<string, unknown> = { binding, runtimeCaptures: [{ launchId: 'TEST-launch' }] };
    const read = createDesktopProjectLaunchRead(async () => ({ owner: { binding, workspace: '/TEST-workspace' },
      async assertCurrent() {}, async observeRun() { return false; } }), async () => structuredClone(state));
    assert.equal(await read(), undefined);
    state.runtimeCaptures = changed;
    await assert.rejects(read);
  }
  let current = true;
  const state: Record<string, unknown> = { binding, runtimeCaptures: [] };
  const read = createDesktopProjectLaunchRead(async () => ({ owner: { binding, workspace: '/TEST-workspace' },
    async assertCurrent() { assert.ok(current); }, async observeRun() { return false; } }), async () => structuredClone(state));
  assert.equal(await read(), undefined);
  state.binding = { ...binding, teamId: 'TEST-foreign' };
  await assert.rejects(read);
  state.binding = binding; current = false;
  await assert.rejects(read);
});

function executionStateFixture(t: Parameters<typeof projectTeamFixture>[0]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-desktop-project-state-')));
  mkdirSync(join(root, 'hoststore'));
  const f = openProjectTeamFixture(join(root, 'hoststore'));
  t.after(() => { f.close(); rmSync(root, { recursive: true, force: true }); });
  const logical = f.create('test-created-native').record;
  f.prepare(logical, 'TEST-first-project');
  const first = f.child(logical);
  const projectPath = join(root, 'workspace'); mkdirSync(projectPath);
  f.prepare(logical, 'TEST-exact-project', projectPath);
  const execution = f.child(logical, projectPath);
  const profilePath = join(root, 'host-profile.json'), descriptorPath = join(root, 'desktop-descriptor.json');
  const handleId = 'TEST-original-seed', owner = { ownerId: f.profile.owner.ownerId, revision: f.profile.owner.revision };
  const profileBytes = JSON.stringify(f.profile), descriptorBytes = JSON.stringify({ schemaVersion: 1,
    handles: [{ handleId, contextId: f.contextId, owner }], creation: { owner, contextIds: [f.contextId] } });
  writeFileSync(profilePath, profileBytes, { mode: 0o600 });
  writeFileSync(descriptorPath, descriptorBytes, { mode: 0o600 });
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const files = { root, profilePath, descriptorPath, handleId,
    pins: { profileSha256: digest(profileBytes), descriptorSha256: digest(descriptorBytes) } };
  const ownerPath = (team: typeof logical) => join(f.root, 'teams', team.teamName, '.host-owner/state.json');
  const logicalPath = ownerPath(logical), executionPath = ownerPath(execution);
  const registryDirectory = join(f.root, '.host-team-registry/records');
  const sources = [profilePath, descriptorPath, logicalPath, ownerPath(first), executionPath,
    ...readdirSync(registryDirectory).map(name => join(registryDirectory, name))];
  return { files, logical, first, execution, projectPath, logicalPath, executionPath, sources,
    logicalState: JSON.parse(readFileSync(logicalPath, 'utf8')) as OwnerState,
    executionState: JSON.parse(readFileSync(executionPath, 'utf8')) as OwnerState,
    read: () => readDesktopProjectExecutionState(files, logical.teamName, projectPath) };
}

test('Desktop model reader selects the exact second project execution and preserves every original source', t => {
  const f = executionStateFixture(t);
  const before = new Map(f.sources.map(path => [path, readFileSync(path)]));
  const selected = f.read();
  assert.deepEqual(selected, f.executionState);
  assert.equal(selected.binding.teamId, f.execution.teamId);
  assert.notEqual(selected.binding.teamId, f.first.teamId);
  assert.notEqual(selected.binding.teamId, f.logical.teamId);
  assert.equal(selected.savedSettings?.projectContextMode, 'shared');
  assert.equal(selected.savedSettings?.cwd, f.projectPath);
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path);
});

test('Desktop model reader refuses changed pinned files and substituted project owner state without writing', t => {
  const f = executionStateFixture(t);
  const captured = { logicalHandleId: f.logical.binding.handleId, executionHandleId: f.execution.binding.handleId };
  assert.deepEqual(readDesktopProjectExecutionState(f.files, f.logical.teamName, f.projectPath, captured), f.executionState);
  for (const substituted of [
    { ...captured, logicalHandleId: 'TEST-foreign-logical' },
    { ...captured, executionHandleId: f.first.binding.handleId },
  ]) assert.throws(() => readDesktopProjectExecutionState(f.files, f.logical.teamName, f.projectPath, substituted));
  for (const path of [f.files.profilePath, f.files.descriptorPath]) {
    const before = readFileSync(path), changed = Buffer.concat([before, Buffer.from('\n')]);
    try {
      writeFileSync(path, changed);
      assert.throws(f.read);
      assert.deepEqual(readFileSync(path), changed);
    } finally { writeFileSync(path, before); }
  }
  const cases = [
    { path: f.executionPath, state: { ...f.executionState, binding: { ...f.executionState.binding, teamId: 'TEST-foreign-team' } } },
    { path: f.executionPath, state: { ...f.executionState, savedSettings: { ...f.executionState.savedSettings, cwd: f.files.root } } },
    { path: f.executionPath, state: { ...f.executionState, savedSettings: { ...f.executionState.savedSettings, projectContextMode: 'per_project' } } },
    { path: f.logicalPath, state: { ...f.logicalState, runtimeCaptures: [{ commandId: 'TEST-logical-capture',
      configurationRevision: 'TEST-revision', launchId: 'TEST-logical-launch', members: [],
      principalId: 'TEST-user', fingerprint: 'a'.repeat(64) }] } },
  ];
  for (const { path, state } of cases) {
    const before = readFileSync(path), changed = JSON.stringify(state);
    try {
      writeFileSync(path, changed);
      assert.throws(f.read);
      assert.equal(readFileSync(path, 'utf8'), changed);
    } finally { writeFileSync(path, before); }
  }
  for (const path of [f.logicalPath, f.executionPath]) {
    const source = path + '.TEST-original';
    renameSync(path, source);
    try { symlinkSync(source, path); assert.throws(f.read); }
    finally { rmSync(path, { force: true }); renameSync(source, path); }
  }
  assert.deepEqual(f.read(), f.executionState, 'all refusals leave the original readable source intact');
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

test('P11 cold discovery retains the seed and exact logical/execution registry pair without projecting a live roster', t => {
  const { logical, execution } = fixture(t), ownerResourceRef = 'a'.repeat(64);
  const original = [logical, execution].map(value => ({ handle: { handleId: value.binding.handleId },
    label: value.displayName || value.teamName, ownerResourceRef, teamResourceRef: effectId('TEST-public-team', value.teamId),
    projectContextMode: value.projectContextMode, members: value.members.map(member => ({ ...member })),
    ...(value.projectContext ? { projectContext: { logicalHandleId: value.projectContext.logicalHandleId,
      projectPath: value.projectContext.projectPath, workContextId: value.projectContext.workContextId } } : {}) }));
  const seedHandleId = 'TEST-original-seed', seed = { handle: { handleId: seedHandleId }, label: 'TEST seed',
    ownerResourceRef, teamResourceRef: effectId('TEST-public-team', seedHandleId), members: [{ label: 'seed', memberId: 'TEST-seed-member' }] };
  const bindings = [seed, ...original], captured = { logicalHandleId: logical.binding.handleId,
    executionHandleId: execution.binding.handleId, original: structuredClone(original) };
  const before = JSON.stringify({ bindings, captured });
  assertDesktopMembershipProjectBindings(bindings, seedHandleId, captured);
  assertDesktopMembershipProjectBindings([bindings[2]!, bindings[0]!, bindings[1]!], seedHandleId, captured);
  for (const mutate of [
    (value: typeof bindings) => { value.pop(); },
    (value: typeof bindings) => { value.push(structuredClone(value[2]!)); },
    (value: typeof bindings) => { value[0]!.ownerResourceRef = 'b'.repeat(64); },
    (value: typeof bindings) => { value[2]!.handle.handleId = 'TEST-foreign-execution'; },
    (value: typeof bindings) => { value[2]!.members.push({ label: 'carol', memberId: 'TEST-live-only-member' }); },
    (value: typeof bindings) => { Object.assign(value[2]!, { projectContextMode: 'per_project' }); },
    (value: typeof bindings) => { Object.assign(value[2]!, { projectContext: { ...original[1]!.projectContext, logicalHandleId: 'TEST-foreign-logical' } }); },
    (value: typeof bindings) => { Object.assign(value[2]!, { projectContext: { ...original[1]!.projectContext, projectPath: '/TEST-other-workspace' } }); },
    (value: typeof bindings) => { Object.assign(value[2]!, { projectContext: { ...original[1]!.projectContext, workContextId: 'TEST-foreign-context' } }); },
  ]) {
    const changed = structuredClone(bindings); mutate(changed);
    assert.throws(() => assertDesktopMembershipProjectBindings(changed, seedHandleId, captured));
  }
  assert.equal(JSON.stringify({ bindings, captured }), before, 'cold comparison never changes either retained catalog');
});

test('P11 project selection reads bind the focused logical tab and exact explicit flat or grouped workspace', () => {
  const identity = { contextId: 'TEST-original-context', ownerResourceRef: 'a'.repeat(64), projectPath: '/TEST-original-workspace' };
  const handleId = 'TEST-original-logical', key = hostTeamSelectionKey(handleId);
  const state = { activeContextId: identity.contextId,
    paneLayout: { focusedPaneId: 'TEST-pane', panes: [{ id: 'TEST-pane', activeTabId: 'TEST-tab',
      tabs: [{ id: 'TEST-tab', type: 'team', teamName: key }] }] },
    teamByName: { [key]: { projectContextMode: 'per_project', ownerResourceRef: identity.ownerResourceRef } },
    selectedProjectId: 'TEST-project' as string | null, activeProjectId: 'TEST-project',
    selectedWorktreeId: null as string | null, selectedRepositoryId: null as string | null,
    projects: [{ id: 'TEST-project', path: identity.projectPath }],
    repositoryGroups: [] as { id: string; worktrees: { id: string; path: string }[] }[] };
  const expression = desktopProjectSelectionExpression(identity, handleId);
  const evaluate = (value: typeof state) => runInNewContext(expression, { window: { __agentTeamsDevStore: { getState: () => value } } });
  const before = JSON.stringify(state);
  assert.equal(evaluate(state), true);
  for (const mutate of [
    (value: typeof state) => { value.activeContextId = 'TEST-other-context'; },
    (value: typeof state) => { value.paneLayout.focusedPaneId = 'TEST-other-pane'; },
    (value: typeof state) => { value.paneLayout.panes.push(structuredClone(value.paneLayout.panes[0]!)); },
    (value: typeof state) => { value.paneLayout.panes[0]!.tabs.push(structuredClone(value.paneLayout.panes[0]!.tabs[0]!)); },
    (value: typeof state) => { value.paneLayout.panes[0]!.tabs[0]!.teamName = hostTeamSelectionKey('TEST-foreign-logical'); },
    (value: typeof state) => { value.teamByName[key]!.ownerResourceRef = 'b'.repeat(64); },
    (value: typeof state) => { value.selectedProjectId = null; },
    (value: typeof state) => { value.activeProjectId = 'TEST-other-project'; },
    (value: typeof state) => { value.projects[0]!.path = '/TEST-other-workspace'; },
    (value: typeof state) => { value.projects.push(structuredClone(value.projects[0]!)); },
  ]) { const changed = structuredClone(state); mutate(changed); assert.equal(evaluate(changed), false); }
  const grouped = { ...structuredClone(state), selectedWorktreeId: 'TEST-project', selectedRepositoryId: 'TEST-repository',
    projects: [], repositoryGroups: [{ id: 'TEST-repository', worktrees: [{ id: 'TEST-project', path: identity.projectPath }] }] };
  assert.equal(evaluate(grouped), true);
  for (const mutate of [
    (value: typeof grouped) => { value.selectedRepositoryId = 'TEST-other-repository'; },
    (value: typeof grouped) => { value.repositoryGroups[0]!.worktrees[0]!.path = '/TEST-other-workspace'; },
    (value: typeof grouped) => { value.repositoryGroups[0]!.worktrees.push(structuredClone(value.repositoryGroups[0]!.worktrees[0]!)); },
  ]) { const changed = structuredClone(grouped); mutate(changed); assert.equal(evaluate(changed), false); }
  assert.equal(JSON.stringify(state), before, 'the generated selection expression is read-only');
});

for (const mode of ['selected', 'hydration-pending', 'switch-before-final-input'] as const) {
  test('P11 existing click budget keeps exact project ownership: ' + mode, async t => {
    const identity = { contextId: 'TEST-original-context', ownerResourceRef: 'a'.repeat(64), projectPath: '/TEST-original-workspace' };
    const handleId = 'TEST-original-logical', key = hostTeamSelectionKey(handleId);
    const state = { activeContextId: identity.contextId,
      paneLayout: { focusedPaneId: 'TEST-pane', panes: [{ id: 'TEST-pane', activeTabId: 'TEST-tab',
        tabs: [{ id: 'TEST-tab', type: 'team', teamName: key }] }] },
      teamByName: { [key]: { projectContextMode: 'per_project', ownerResourceRef: identity.ownerResourceRef } },
      selectedProjectId: mode === 'hydration-pending' ? null : 'TEST-project', activeProjectId: 'TEST-project',
      selectedWorktreeId: null, selectedRepositoryId: null,
      projects: [{ id: 'TEST-project', path: identity.projectPath }], repositoryGroups: [] };
    const button = { textContent: 'Launch', tagName: 'BUTTON',
      getBoundingClientRect() { return { x: 20, y: 20, width: 100, height: 40 }; },
      matches() { return false; }, closest() { return null; }, getAnimations() { return []; } };
    let reads = 0, owners = 0; const sends: string[] = [], deadlines: number[] = [];
    try {
      t.mock.timers.enable({ apis: ['Date'], now: 0 });
      t.mock.method(globalThis, 'setTimeout', (done: () => void, delay: number) => {
        t.mock.timers.setTime(Date.now() + delay); done(); return {} as ReturnType<typeof setTimeout>;
      });
      const cdp = {
        async evaluate(expression: string) {
          reads++;
          if (mode === 'switch-before-final-input' && reads === 5) state.activeContextId = 'TEST-foreign-context';
          const value: unknown = runInNewContext(expression, { window: { __agentTeamsDevStore: { getState: () => state } },
            document: { querySelectorAll(selector: string) { assert.equal(selector, 'button'); return [button]; },
              elementFromPoint() { return button; }, fonts: { status: 'loaded' } } });
          if (mode === 'hydration-pending' && reads === 1) { assert.equal(value, null); state.selectedProjectId = 'TEST-project'; }
          return value;
        },
        async send(method: string, params?: Record<string, unknown>) { sends.push(String(params?.type ?? method)); return {}; },
      };
      const ui = createDesktopUiControls(createDesktopSelectedProjectReadPort(cdp, identity, handleId),
        { assertOwnedRenderer() { owners++; }, step() {} });
      const readTiming = { begin() {}, check() {}, start() {}, end() {} };
      const timing = { start() {}, end() {}, deadline(value: number) { deadlines.push(value); },
        reads: { initial: readTiming, 'after-hover': readTiming, stable: readTiming } };
      const click = ui.click('button', 'open original Launch dialog once', 'Launch', undefined, undefined, timing);
      if (mode === 'switch-before-final-input') {
        await assert.rejects(click, assert.AssertionError);
        assert.deepEqual(sends, ['Page.bringToFront', 'mouseMoved'], 'final owner switch permits neither press nor release');
      } else {
        await click;
        assert.deepEqual(sends, ['Page.bringToFront', 'mouseMoved', 'mousePressed', 'mouseReleased']);
      }
      assert.deepEqual(deadlines, [30_000], 'only the original click budget is created');
      assert.equal(reads, mode === 'hydration-pending' ? 6 : 5, 'the wrapper adds no extra CDP reads');
      assert.ok(owners > 0);
    } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
  });
}
