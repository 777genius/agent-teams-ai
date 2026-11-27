import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { TeamRegistry } from '../../packages/legacy-agent-host/dist/team-registry/TeamRegistry.js';
import { storedTeamCreationSchema } from '../../packages/legacy-agent-host/dist/team-registry/state.js';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { parseHostTeamRunId } from '../../src/features/agent-backend/contracts/teamRunSelection.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { StoredTeamCreation } from '../../packages/legacy-agent-host/dist/team-registry/state.js';
import type { OwnerState } from '../../packages/legacy-agent-host/dist/team/ownerState.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
const rows = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(row); };
const one = (values: Row[], select: (value: Row) => boolean) => {
  const found = values.filter(select); assert.equal(found.length, 1, 'one exact original binding'); return found[0]!;
};
type Expected = { profile: TeamHostProfile; contextId: string; ownerResourceRef: string; projectPath: string };
type ProjectFixtureFiles = Pick<Awaited<ReturnType<typeof prepareDesktopBackendFixture>>,
  'root' | 'profilePath' | 'descriptorPath' | 'handleId'> & {
  pins: Pick<Awaited<ReturnType<typeof prepareDesktopBackendFixture>>['pins'], 'profileSha256' | 'descriptorSha256'>;
};
export interface DesktopProjectExecutionOwner {
  readonly binding: Readonly<{ backendId: string; teamId: string; teamName: string }>;
  readonly workspace: string;
}
export interface DesktopProjectBindingCapture {
  readonly logicalHandleId: string;
  readonly executionHandleId: string;
  readonly original: readonly Row[];
}

/** P11 keeps the original published bindings separate from its three-member live roster. */
export function assertDesktopMembershipProjectBindings(value: unknown, seedHandleId: string, captured: DesktopProjectBindingCapture) {
  const bindings = rows(value), expected = rows(captured.original);
  assert.equal(expected.length, 2); assert.equal(bindings.length, 3);
  const handles = [seedHandleId, captured.logicalHandleId, captured.executionHandleId];
  assert.equal(new Set(handles).size, 3);
  assert.deepEqual(bindings.map(value => row(value.handle).handleId).sort(), [...handles].sort());
  const logical = one(expected, value => row(value.handle).handleId === captured.logicalHandleId);
  const execution = one(expected, value => row(value.handle).handleId === captured.executionHandleId);
  assert.equal(logical.projectContextMode, 'per_project'); assert.equal(logical.projectContext, undefined);
  assert.equal(execution.projectContextMode, 'shared');
  assert.equal(row(execution.projectContext).logicalHandleId, captured.logicalHandleId);
  assert.equal(new Set(bindings.map(value => value.ownerResourceRef)).size, 1);
  assert.equal(new Set(bindings.map(value => value.teamResourceRef)).size, 3);
  for (const binding of bindings) {
    const handleId = row(binding.handle).handleId, seed = handleId === seedHandleId;
    assert.deepEqual(Object.keys(binding).sort(), ['handle', 'label', 'members', 'ownerResourceRef', 'teamResourceRef',
      ...(!seed ? ['projectContextMode'] : []), ...(handleId === captured.executionHandleId ? ['projectContext'] : [])].sort());
    assert.deepEqual(Object.keys(row(binding.handle)), ['handleId']);
    assert.match(String(binding.ownerResourceRef), /^[a-f0-9]{64}$/);
    assert.match(String(binding.teamResourceRef), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(typeof binding.label, 'string');
    const members = rows(binding.members); assert.equal(members.length, seed ? 1 : 2);
    for (const member of members) {
      assert.deepEqual(Object.keys(member).sort(), ['label', 'memberId']);
      assert.equal(typeof member.memberId, 'string'); assert.equal(typeof member.label, 'string');
    }
    assert.equal(new Set(members.map(member => member.memberId)).size, members.length);
    if (!seed) assert.deepEqual(binding, handleId === captured.logicalHandleId ? logical : execution);
  }
}

/** Read the exact ordinary focused Team/project tuple; never choose a project or mutate the store. */
export function desktopProjectSelectionExpression(identity: Readonly<Pick<Expected, 'contextId' | 'ownerResourceRef' | 'projectPath'>>, logicalHandleId: string) {
  const key = hostTeamSelectionKey(logicalHandleId);
  return `(()=>{const s=window.__agentTeamsDevStore?.getState();
        if(!s||s.activeContextId!==${JSON.stringify(identity.contextId)})return false;
        const panes=s.paneLayout?.panes?.filter(p=>p.id===s.paneLayout.focusedPaneId);if(panes?.length!==1)return false;
        const tabs=panes[0].tabs?.filter(t=>t.id===panes[0].activeTabId);if(tabs?.length!==1)return false;
        const t=tabs[0],team=s.teamByName?.[${JSON.stringify(key)}];
        if(t.type!=='team'||t.taskDetail||t.teamName!==${JSON.stringify(key)}||team?.projectContextMode!=='per_project'||
          team.ownerResourceRef!==${JSON.stringify(identity.ownerResourceRef)})return false;
        const id=s.selectedProjectId;if(typeof id!=='string'||!id||s.activeProjectId!==id||
          !Array.isArray(s.projects)||!Array.isArray(s.repositoryGroups))return false;
        if(s.selectedWorktreeId===null&&s.selectedRepositoryId===null){const p=s.projects.filter(p=>p.id===id);
          return p.length===1&&p[0].path===${JSON.stringify(identity.projectPath)}}
        if(s.selectedWorktreeId!==id||typeof s.selectedRepositoryId!=='string'||!s.selectedRepositoryId||
          s.repositoryGroups.some(g=>!g||!Array.isArray(g.worktrees))||s.repositoryGroups.filter(g=>g.id===s.selectedRepositoryId).length!==1)return false;
        const w=s.repositoryGroups.flatMap(g=>g.worktrees.filter(w=>w.id===id).map(w=>({repositoryId:g.id,path:w.path})));
        return w.length===1&&w[0].repositoryId===s.selectedRepositoryId&&w[0].path===${JSON.stringify(identity.projectPath)}})()`;
}

/** Fence only the caller's existing passive click reads; original input and deadline stay in its UI controls. */
export function createDesktopSelectedProjectReadPort(cdp: UiCdpPort,
  identity: Readonly<Pick<Expected, 'contextId' | 'ownerResourceRef' | 'projectPath'>>, logicalHandleId: string): UiCdpPort {
  const selected = desktopProjectSelectionExpression(identity, logicalHandleId);
  return { send: (method, params) => cdp.send(method, params),
    evaluate: expression => cdp.evaluate(`(${selected}) ? (${expression}) : null`) };
}

/** Read-only original registry validation; none of these ports can create or attach a Team. */
function observeDesktopProjectRegistryExecution(records: StoredTeamCreation[],
  expected: Pick<Expected, 'profile' | 'contextId' | 'projectPath'>, logicalName: string) {
  const refuse = (): never => { throw new Error('TEST read-only project oracle cannot write or attach'); };
  const profile = expected.profile;
  const registry = new TeamRegistry({ ownerId: profile.owner.ownerId, profileId: profile.owner.profileId,
    principalId: profile.principalId, contextIds: profile.creation?.contextIds ?? [], staticTeams: profile.teams,
    store: { readAll: () => records.map(value => storedTeamCreationSchema.parse(value)), write: refuse, fenced: action => action() },
    assertWriter() {}, admit: refuse, attach: refuse });
  const catalog = registry.list(expected.contextId);
  const logicalRows = catalog.teams.filter(value => value.teamName === logicalName && !value.projectContext);
  assert.equal(logicalRows.length, 1, 'one exact published logical Create');
  const logical = logicalRows[0]!;
  assert.equal(logical.projectContextMode, 'per_project');
  const relationMatches = (value: typeof logical) => value.projectContext &&
    (value.projectContext.logicalTeamId === logical.teamId || value.projectContext.logicalHandleId === logical.binding.handleId);
  assert.equal(catalog.held.some(value => relationMatches(value.record)), false, 'no held original project copy');
  const children = catalog.teams.filter(relationMatches);
  for (const child of children) {
    assert.equal(child.projectContext!.logicalTeamId, logical.teamId);
    assert.equal(child.projectContext!.logicalHandleId, logical.binding.handleId);
    assert.equal(child.contextId, expected.contextId);
  }
  const selected = children.filter(value => value.projectContext!.projectPath === expected.projectPath);
  assert.ok(selected.length <= 1, 'at most one exact selected canonical workspace, never first child');
  const execution = selected[0];
  if (!execution) return { logical: structuredClone(logical), execution: undefined };
  assert.notEqual(execution.teamId, logical.teamId); assert.notEqual(execution.binding.handleId, logical.binding.handleId);
  assert.equal(execution.projectContextMode, 'shared');
  return { logical: structuredClone(logical), execution: structuredClone(execution) };
}

export function selectDesktopProjectRegistryExecution(records: StoredTeamCreation[],
  expected: Pick<Expected, 'profile' | 'contextId' | 'projectPath'>, logicalName: string) {
  const selected = observeDesktopProjectRegistryExecution(records, expected, logicalName);
  assert.ok(selected.execution, 'one exact selected canonical workspace, never first child');
  return { logical: selected.logical, execution: selected.execution };
}

/** Absence may be observed passively; a held, malformed or substituted source still refuses immediately. */
export function observeDesktopProjectExecution(records: StoredTeamCreation[], expected: Expected, logicalName: string, discovery: unknown) {
  const { logical, execution } = observeDesktopProjectRegistryExecution(records, expected, logicalName);
  const source = row(discovery); assert.equal(source.state, 'ready');
  const bindings = rows(source.bindings);
  const original = one(bindings, value => row(value.handle).handleId === logical.binding.handleId);
  assert.equal(original.ownerResourceRef, expected.ownerResourceRef);
  assert.equal(original.projectContextMode, 'per_project'); assert.equal(original.projectContext, undefined);
  assert.equal(rows(source.unavailableOwners ?? []).some(value => value.ownerResourceRef === expected.ownerResourceRef), false);
  if (!execution) return undefined;
  const children = bindings.filter(value => row(value.handle).handleId === execution.binding.handleId);
  assert.ok(children.length <= 1, 'at most one original project binding');
  const child = children[0];
  if (!child) return undefined;
  assert.equal(child.ownerResourceRef, expected.ownerResourceRef);
  assert.equal(child.projectContextMode, 'shared');
  assert.ok(typeof original.teamResourceRef === 'string' && typeof child.teamResourceRef === 'string');
  assert.notEqual(original.teamResourceRef, child.teamResourceRef);
  assert.deepEqual(child.projectContext, { logicalHandleId: logical.binding.handleId,
    projectPath: expected.projectPath, workContextId: execution.projectContext!.workContextId });
  return { logical: structuredClone(logical), execution: structuredClone(execution) };
}

export function selectDesktopProjectExecution(records: StoredTeamCreation[], expected: Expected, logicalName: string, discovery: unknown) {
  const selected = observeDesktopProjectExecution(records, expected, logicalName, discovery);
  assert.ok(selected, 'one exact published project execution and binding');
  return selected;
}

/** Only the first original pending attempt can precede publication of the exact captured run. */
export function createDesktopProjectRunObserver(logicalHandleId: string, executionHandleId: string) {
  const prefix = `pending:${hostTeamSelectionKey(logicalHandleId)}:`;
  let pending: string | undefined, published: string | undefined;
  const publishedFields = new Set<'runtime' | 'provisioning'>();
  return (value: unknown, launchId: unknown): boolean => {
    const pins = row(value);
    let ready = true;
    for (const field of ['runtime', 'provisioning'] as const) {
      const id = pins[field];
      if (id === undefined || id === null) { assert.equal(publishedFields.has(field), false, 'published field cannot disappear'); ready = false; continue; }
      assert.equal(typeof id, 'string');
      const runId = id as string;
      if (field === 'provisioning' && runId.startsWith(prefix)) {
        assert.match(runId.slice(prefix.length), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        assert.equal(publishedFields.has(field), false, 'published field cannot return to pending');
        if (pending === undefined) pending = runId;
        assert.equal(runId, pending, 'same original pending launch attempt');
        ready = false; continue;
      }
      const run = parseHostTeamRunId(runId);
      assert.equal(run.handleId, executionHandleId); assert.equal(run.launchId, launchId);
      published ??= runId;
      assert.equal(runId, published, 'same original published run');
      publishedFields.add(field);
    }
    if (ready) {
      assert.equal(pins.runtime, pins.provisioning, 'runtime and provisioning publish the same roster');
      published = pins.runtime as string;
    }
    return ready;
  };
}

/** The caller's existing poll observes one publication and capture; this port cannot launch or retry. */
export function createDesktopProjectLaunchRead<T extends {
  owner: DesktopProjectExecutionOwner;
  assertCurrent(): Promise<void>;
  observeRun(launchId: unknown): Promise<boolean>;
}>(observe: () => Promise<T | undefined>, read: (selection: T) => Promise<Row>) {
  let selected: T | undefined, originalCapture: Row | undefined;
  return async () => {
    selected ??= await observe();
    if (!selected) return undefined;
    await selected.assertCurrent();
    const state = await read(selected);
    assert.deepEqual(state.binding, selected.owner.binding, 'same original execution owner');
    const captures = rows(state.runtimeCaptures ?? []);
    assert.ok(captures.length <= 1, 'at most one original runtime capture');
    if (captures.length === 0) {
      assert.equal(originalCapture, undefined, 'original runtime capture cannot disappear');
      return undefined;
    }
    const launchId = captures[0]!.launchId;
    assert.ok(typeof launchId === 'string' && launchId.length > 0);
    originalCapture ??= structuredClone(captures[0]!);
    assert.deepEqual(captures[0], originalCapture, 'same original runtime capture');
    if (!(await selected.observeRun(launchId))) return undefined;
    await selected.assertCurrent();
    return { selection: selected, state };
  };
}

function projectOwnerJson(path: string, expectedSha256?: string): Row {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert.ok(before.size <= 8 * 1024 * 1024, 'bounded original owner source');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    for (const after of [fstatSync(fd), lstatSync(path)]) {
      assert.ok(after.isFile() && !after.isSymbolicLink() && after.nlink === 1);
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(after[key], before[key]);
    }
    assert.equal(length, before.size, 'original owner source did not change during the read');
    const content = bytes.subarray(0, length);
    if (expectedSha256) assert.equal(createHash('sha256').update(content).digest('hex'), expectedSha256);
    return row(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)));
  } finally { closeSync(fd); }
}

/** Model callbacks read the exact registry-owned project execution, without creating or recovering it. */
export function readDesktopProjectExecutionState(fixture: ProjectFixtureFiles, logicalName: string,
  requestedProject: string, captured?: Pick<DesktopProjectBindingCapture, 'logicalHandleId' | 'executionHandleId'>): OwnerState {
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  assert.equal(profile.owner.storageRoot, join(fixture.root, 'hoststore'));
  const descriptor = projectOwnerJson(fixture.descriptorPath, fixture.pins.descriptorSha256);
  const seeded = one(rows(descriptor.handles), value => value.handleId === fixture.handleId);
  const contextId = String(seeded.contextId), projectPath = realpathSync(requestedProject);
  assert.deepEqual(seeded.owner, { ownerId: profile.owner.ownerId, revision: profile.owner.revision });
  assert.deepEqual(row(descriptor.creation).owner, seeded.owner);
  assert.ok(profile.creation?.contextIds.includes(contextId));
  assert.ok((row(descriptor.creation).contextIds as unknown[]).includes(contextId));
  const directory = join(profile.owner.storageRoot, '.host-team-registry/records');
  assert.equal(realpathSync(directory), directory);
  const entries = readdirSync(directory, { withFileTypes: true });
  assert.ok(entries.length <= 256, 'bounded TEST registry');
  const records = entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry.name)).map(entry => {
    assert.ok(entry.isFile() && !entry.isSymbolicLink());
    return storedTeamCreationSchema.parse(projectOwnerJson(join(directory, entry.name)));
  });
  const { logical, execution } = selectDesktopProjectRegistryExecution(records, { profile, contextId, projectPath }, logicalName);
  if (captured) {
    assert.equal(logical.binding.handleId, captured.logicalHandleId);
    assert.equal(execution.binding.handleId, captured.executionHandleId);
  }
  const readOwner = (team: typeof logical) => {
    const ownerDirectory = join(profile.owner.storageRoot, 'teams', team.teamName, '.host-owner');
    assert.equal(realpathSync(ownerDirectory), ownerDirectory);
    const state = projectOwnerJson(join(ownerDirectory, 'state.json'));
    assert.deepEqual(state.binding, { backendId: profile.owner.ownerId, teamId: team.teamId, teamName: team.teamName });
    return state;
  };
  const definition = readOwner(logical);
  assert.equal(row(definition.savedSettings).projectContextMode, 'per_project');
  assert.deepEqual(definition.runtimeCaptures ?? [], [], 'logical definition never owns native captures');
  const state = readOwner(execution);
  assert.equal(row(state.savedSettings).projectContextMode, 'shared');
  assert.equal(row(state.savedSettings).cwd, projectPath);
  return state as unknown as OwnerState;
}

/** Capture the pinned TEST owner and original context before the existing Create or Launch action. */
export async function captureDesktopProjectOracle(cdp: UiCdpPort,
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>, requestedProject: string) {
  const profileSha256 = fixture.pins.profileSha256, descriptorSha256 = fixture.pins.descriptorSha256;
  const profile = readTeamHostProfile(fixture.profilePath, profileSha256);
  assert.equal(profile.owner.storageRoot, join(fixture.root, 'hoststore'));
  assert.equal(await fileDigest(fixture.descriptorPath), descriptorSha256);
  const descriptor = row(JSON.parse(await readFile(fixture.descriptorPath, 'utf8')));
  const seeded = one(rows(descriptor.handles), value => value.handleId === fixture.handleId);
  const contextId = String(seeded.contextId);
  assert.deepEqual(seeded.owner, { ownerId: profile.owner.ownerId, revision: profile.owner.revision });
  assert.deepEqual(row(descriptor.creation).owner, seeded.owner);
  assert.ok(profile.creation?.contextIds.includes(contextId));
  assert.ok((row(descriptor.creation).contextIds as unknown[]).includes(contextId));
  const discovery = row(await cdp.evaluate('window.electronAPI.agentBackend.getConnections()'));
  assert.equal(discovery.state, 'ready');
  const seed = one(rows(discovery.bindings), value => row(value.handle).handleId === fixture.handleId);
  assert.ok(typeof seed.ownerResourceRef === 'string' && seed.ownerResourceRef.length > 0);
  const expected: Expected = { profile: structuredClone(profile), contextId,
    ownerResourceRef: seed.ownerResourceRef, projectPath: await realpath(requestedProject) };
  async function originalSources() {
    assert.equal(await fileDigest(fixture.profilePath), profileSha256, 'same original Host profile');
    assert.equal(await fileDigest(fixture.descriptorPath), descriptorSha256, 'same original Desktop owner');
    const directory = join(profile.owner.storageRoot, '.host-team-registry/records');
    const records = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async name => storedTeamCreationSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))));
    return { records, discovery: await cdp.evaluate('window.electronAPI.agentBackend.getConnections()') };
  }
  return {
    identity: Object.freeze({ contextId: expected.contextId, ownerResourceRef: expected.ownerResourceRef,
      projectPath: expected.projectPath }),
    selectedProjectReads(logicalHandleId: string): UiCdpPort {
      return createDesktopSelectedProjectReadPort(cdp, expected, logicalHandleId);
    },
    async assertSelected(logicalHandleId: string) {
      assert.equal(await cdp.evaluate(desktopProjectSelectionExpression(expected, logicalHandleId)), true,
        'original focused logical Team and canonical selected project');
    },
    async observe(logicalName: string) {
      const source = await originalSources();
      const selected = observeDesktopProjectExecution(source.records, expected, logicalName, source.discovery);
      if (!selected) return undefined;
      const logicalRoot = join(profile.owner.storageRoot, 'teams', selected.logical.teamName);
      const executionRoot = join(profile.owner.storageRoot, 'teams', selected.execution.teamName);
      const bindings = rows(row(source.discovery).bindings);
      const capturedBindings = [selected.logical, selected.execution].map(team => {
        const binding = structuredClone(one(bindings, value => row(value.handle).handleId === team.binding.handleId));
        Object.freeze(row(binding.handle)); rows(binding.members).forEach(Object.freeze); Object.freeze(binding.members);
        if (binding.projectContext) Object.freeze(row(binding.projectContext));
        return Object.freeze(binding);
      });
      const bindingCapture: DesktopProjectBindingCapture = Object.freeze({ logicalHandleId: selected.logical.binding.handleId,
        executionHandleId: selected.execution.binding.handleId, original: Object.freeze(capturedBindings) });
      const owner: DesktopProjectExecutionOwner = Object.freeze({ binding: Object.freeze({ backendId: profile.owner.ownerId,
        teamId: selected.execution.teamId, teamName: selected.execution.teamName }), workspace: expected.projectPath });
      const runPublished = createDesktopProjectRunObserver(selected.logical.binding.handleId, selected.execution.binding.handleId);
      const observeRun = async (launchId: unknown) => {
        const key = hostTeamSelectionKey(selected.logical.binding.handleId);
        return runPublished(await cdp.evaluate(`(()=>{const s=window.__agentTeamsDevStore?.getState();return {
          runtime:s?.currentRuntimeRunIdByTeam?.[${JSON.stringify(key)}],
          provisioning:s?.currentProvisioningRunIdByTeam?.[${JSON.stringify(key)}]}})()`), launchId);
      };
      return { ...selected, logicalRoot, executionRoot, owner, bindingCapture,
        taskRoot: join(profile.owner.storageRoot, 'tasks', selected.execution.teamName),
        async assertCurrent() {
          const fresh = await originalSources();
          assert.deepEqual(selectDesktopProjectExecution(fresh.records, expected, logicalName, fresh.discovery), selected,
            'original logical/project association stays immutable');
        },
        observeRun,
        async assertRun(launchId: unknown) { assert.equal(await observeRun(launchId), true, 'original captured run is published'); },
      };
    },
    async select(logicalName: string) {
      const selected = await this.observe(logicalName);
      assert.ok(selected, 'one exact published project execution and binding');
      return selected;
    },
  };
}
