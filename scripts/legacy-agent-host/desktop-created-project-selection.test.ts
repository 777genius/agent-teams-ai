import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { projectTeamFixture } from '../../packages/legacy-agent-host/tests/projectTeamFixture.ts';
import { storedTeamCreationSchema } from '../../packages/legacy-agent-host/dist/team-registry/state.js';
import { effectId } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { assertDesktopMembershipProjectBindings, createDesktopSelectedProjectReadPort, desktopProjectSelectionExpression, selectDesktopProjectExecution } from './desktop-created-project-selection.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';

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
