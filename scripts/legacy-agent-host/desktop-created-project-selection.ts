import assert from 'node:assert/strict';
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

type Row = Record<string, unknown>;
const row = (value: unknown): Row => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
const rows = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(row); };
const one = (values: Row[], select: (value: Row) => boolean) => {
  const found = values.filter(select); assert.equal(found.length, 1, 'one exact original binding'); return found[0]!;
};
type Expected = { profile: TeamHostProfile; contextId: string; ownerResourceRef: string; projectPath: string };

/** Read-only original registry validation; none of these ports can create or attach a Team. */
export function selectDesktopProjectExecution(records: StoredTeamCreation[], expected: Expected, logicalName: string, discovery: unknown) {
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
  assert.equal(selected.length, 1, 'one exact selected canonical workspace, never first child');
  const execution = selected[0]!;
  assert.notEqual(execution.teamId, logical.teamId); assert.notEqual(execution.binding.handleId, logical.binding.handleId);
  assert.equal(execution.projectContextMode, 'shared');
  const source = row(discovery); assert.equal(source.state, 'ready');
  const bindings = rows(source.bindings);
  const original = one(bindings, value => row(value.handle).handleId === logical.binding.handleId);
  const child = one(bindings, value => row(value.handle).handleId === execution.binding.handleId);
  assert.equal(original.ownerResourceRef, expected.ownerResourceRef);
  assert.equal(original.projectContextMode, 'per_project'); assert.equal(original.projectContext, undefined);
  assert.equal(child.ownerResourceRef, expected.ownerResourceRef);
  assert.ok(typeof original.teamResourceRef === 'string' && typeof child.teamResourceRef === 'string');
  assert.notEqual(original.teamResourceRef, child.teamResourceRef);
  assert.deepEqual(child.projectContext, { logicalHandleId: logical.binding.handleId,
    projectPath: expected.projectPath, workContextId: execution.projectContext!.workContextId });
  assert.equal(rows(source.unavailableOwners ?? []).some(value => value.ownerResourceRef === expected.ownerResourceRef), false);
  return { logical: structuredClone(logical), execution: structuredClone(execution) };
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
    async select(logicalName: string) {
      const source = await originalSources();
      const selected = selectDesktopProjectExecution(source.records, expected, logicalName, source.discovery);
      const logicalRoot = join(profile.owner.storageRoot, 'teams', selected.logical.teamName);
      const executionRoot = join(profile.owner.storageRoot, 'teams', selected.execution.teamName);
      return { ...selected, logicalRoot, executionRoot,
        taskRoot: join(profile.owner.storageRoot, 'tasks', selected.execution.teamName),
        async assertCurrent() {
          const fresh = await originalSources();
          assert.deepEqual(selectDesktopProjectExecution(fresh.records, expected, logicalName, fresh.discovery), selected,
            'original logical/project association stays immutable');
        },
        async assertRun(launchId: unknown) {
          const key = hostTeamSelectionKey(selected.logical.binding.handleId);
          const pins = row(await cdp.evaluate(`(()=>{const s=window.__agentTeamsDevStore?.getState();return {
            runtime:s?.currentRuntimeRunIdByTeam?.[${JSON.stringify(key)}],
            provisioning:s?.currentProvisioningRunIdByTeam?.[${JSON.stringify(key)}]}})()`));
          assert.ok(typeof pins.runtime === 'string' && typeof pins.provisioning === 'string');
          for (const runId of [pins.runtime, pins.provisioning]) {
            const run = parseHostTeamRunId(runId);
            assert.equal(run.handleId, selected.execution.binding.handleId);
            assert.equal(run.launchId, launchId);
          }
        },
      };
    },
  };
}
