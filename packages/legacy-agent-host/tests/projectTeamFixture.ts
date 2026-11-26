import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamRegistry } from '../dist/team-registry/TeamRegistry.js';
import { FileTeamRegistryStore } from '../dist/adapters/team-registry/FileTeamRegistryStore.js';
import { admitRegistryTeamNamespace } from '../dist/adapters/team-registry/admitRegistryTeamNamespace.js';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { HostTeamProjectContexts } from '../dist/team-project-context/HostTeamProjectContexts.js';
import { HostProjectDefinitionEdits } from '../dist/team-project-context/HostProjectDefinitionEdits.js';
import { createHostProjectReviewFlowComposition } from '../dist/composition/createHostProjectReviewFlowComposition.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { replaceRosterPayloadSchema } from '../dist/team/rosterSchema.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { HostedTeamDefinition } from '../dist/team-registry/definition.js';
import type { TeamRegistryRecord } from '../dist/team-registry/contracts.js';
import type { TeamSavedSettings } from '../dist/team/rosterSchema.js';
import type { LiveRosterOperation } from '../dist/composition/executeLiveRosterMembership.js';
import type { TestContext } from 'node:test';

export function openProjectTeamFixture(root: string, options: {
  executeLive?(input: LiveRosterOperation): Promise<unknown>;
  synchronizeHistory?(logical: HostedTeam, execution: HostedTeam, commandId: string): void;
} = {}) {
  const contextId = 'TEST-context', principalId = 'TEST-user';
  const lease = acquireProfileWriterLease(root), teams = new Map<string, HostedTeam>();
  const stores = new Map<string, TeamOwnerStore>(), live = new Set<string>();
  const profile = { schemaVersion: 1, owner: { ownerId: 'TEST-owner', profileId: 'TEST-profile', revision: 'TEST-revision',
    storageRoot: root, protocolVersion: 1, buildId: 'TEST-build', nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    principalId, teams: [], creation: { contextIds: [contextId] } } satisfies TeamHostProfile;
  const assertCurrent = () => lease.assertCurrent();
  const assertStopped = (team: HostedTeam) => { if (live.has(team.definition.binding.teamId)) throw new TeamOwnerError('hold'); };
  const attach = (definition: HostedTeamDefinition) => {
    if (teams.has(definition.binding.teamId)) return;
    const store = new TeamOwnerStore(root, definition.binding.teamName);
    const owner = createFilesystemTeamOwner({ root, store, binding: definition.binding,
      ...(definition.savedSettings ? { savedSettings: definition.savedSettings } : {}),
      members: definition.members.map(({ delivery, ...member }) => ({
        ...member, ...(delivery === undefined ? {} : { delivery }),
      })),
      grants: definition.grants.map(({ revoked, ...grant }) => ({
        ...grant, ...(revoked === undefined ? {} : { revoked }),
      })),
      assertRosterEditable: () => { const team = teams.get(definition.binding.teamId); if (team) assertStopped(team); } });
    const connection = owner.connect(principalId);
    connection.readRoster(); stores.set(definition.binding.teamId, store);
    teams.set(definition.binding.teamId, { definition, owner, connection, operatorPrincipalId: principalId });
  };
  const registry = new TeamRegistry({ ownerId: profile.owner.ownerId, profileId: profile.owner.profileId,
    principalId, contextIds: [contextId], staticTeams: [], store: new FileTeamRegistryStore(root, assertCurrent),
    assertWriter: assertCurrent, admit: (definition, fresh, published) => admitRegistryTeamNamespace(root, definition.binding, fresh, published), attach });
  registry.restore();
  const review = createHostProjectReviewFlowComposition({ profile, teams, stores, registry: () => registry, assertCurrent });
  const target = (record: TeamRegistryRecord) => ({ team: teams.get(record.teamId)!, handleId: record.binding.handleId });
  const contexts = new HostTeamProjectContexts({ principalId, registry, team: id => teams.get(id),
    store: team => stores.get(team.definition.binding.teamId)!, assertCurrent, assertStopped,
    synchronizeHistory: options.synchronizeHistory ?? review.synchronizeHistory,
    reconcileDefinition: target => definitions.reconcileStopped(target) });
  const definitions = new HostProjectDefinitionEdits({ principalId, teams, stores, registry: () => registry,
    assertCurrent, assertStopped, assertNotLaunching: target => contexts.assertDefinitionAdmission(target),
    executeLive: options.executeLive ?? (async input => {
      const team = teams.get(input.teamId)!;
      if (input.conversation.phase === 'read') return { ok: true,
        value: team.connection.lookupRoster(input.commandId, (input.payload as { expected: never }).expected) };
      const request = { ...replaceRosterPayloadSchema.parse(input.payload), commandId: input.commandId };
      const authored = team.owner.nativeRoster.replaceAuthored(principalId, request);
      return { ok: true, value: authored ?? team.connection.replaceRoster(request) };
    }) });
  const project = join(root, 'TEST-project'); mkdirSync(project, { recursive: true });
  const create = (name = 'TEST-logical', mode: 'shared' | 'per_project' = 'per_project', extra: Partial<TeamSavedSettings> = {}) => {
    const draft = { contextId, teamName: name, savedSettings: { cwd: project, projectContextMode: mode,
      displayName: name, prompt: 'TEST authored prompt', ...extra },
      members: [{ name: 'alice', memberSettings: { role: 'Researcher' } }] };
    return registry.lookup(`TEST-create:${name}`, contextId, draft) ?? registry.create(`TEST-create:${name}`, draft);
  };
  const prepare = (record: TeamRegistryRecord, commandId: string, projectPath = project) => contexts.prepare(target(record), commandId,
    { projectPath, expectedRevision: teams.get(record.teamId)!.connection.readRoster().revision });
  const child = (record: TeamRegistryRecord, projectPath = project) => {
    const view = contexts.read(target(record), { projectPath }).view;
    if (view.mode !== 'per_project' || view.state !== 'ready') throw new Error('TEST project not ready');
    return registry.list(contextId).teams.find(row => row.binding.handleId === view.executionHandleId)!;
  };
  return { root, profile, contextId, principalId, lease, registry, teams, stores, live, review, contexts, definitions,
    project, target, create, prepare, child, close: () => lease.release() };
}
export function projectTeamFixture(t: TestContext, options: Parameters<typeof openProjectTeamFixture>[1] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-project-team-')));
  const fixture = openProjectTeamFixture(root, options);
  t.after(() => { fixture.close(); rmSync(root, { recursive: true, force: true }); });
  return fixture;
}
