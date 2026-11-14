import { ManagementCommandError } from '../management/commandRecords.js';
import { runtimeDigest } from '../runtime/identity.js';
import { publishRuntimeSourceSchema, runtimeSourceGrantSchema } from './runtimeSourceContracts.js';
import type { FileRuntimeSourceIndex } from '../adapters/profile/FileRuntimeSourceIndex.js';
import type { ManagementCommandStore, StoredRuntimeSourceCommand } from '../management/commandRecords.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { PublishRuntimeSource, RuntimeSourceGrant, RuntimeSourceCandidate, RuntimeSourceTeamScope } from './runtimeSourceContracts.js';

const held = (): never => { throw new ManagementCommandError('held'); };

/** Only current private recipe/authority absence may isolate already validated original history. */
export class RuntimeSourceUnavailable extends ManagementCommandError {
  constructor() { super('held'); }
}

export interface RuntimeSourceSeedProfile {
  owner: { ownerId: string; revision: string };
  teams: readonly { scope: RuntimeSourceTeamScope }[];
  management?: readonly ProviderManagementProfile[] | undefined;
}

/** The same private seed/grant predicate serves Host publication and independent Main admission. */
export function selectRuntimeSourceSeed(
  profile: RuntimeSourceSeedProfile, raw: RuntimeSourceGrant, retained = false
): ProviderManagementProfile {
  const unavailable = (): never => {
    if (retained) throw new RuntimeSourceUnavailable();
    throw new ManagementCommandError('conflict');
  };
  const grant = runtimeSourceGrantSchema.parse(raw);
  if (grant.ownerId !== profile.owner.ownerId || grant.ownerRevision !== profile.owner.revision)
    return unavailable();
  if (grant.teamScopes.some(scope => !profile.teams.some(team =>
    team.scope.teamId === scope.teamId && team.scope.projectId === scope.projectId &&
    team.scope.workspaceId === scope.workspaceId))) return unavailable();
  const seeds = profile.management?.filter(row => row.profileId === grant.profileId &&
    row.configRevision === grant.configRevision && row.provider === grant.runtimeId) ?? [];
  if (seeds.length > 1) throw new ManagementCommandError('conflict');
  const seed = seeds[0];
  if (!seed || (grant.projectPath !== null && grant.projectPath !== seed.cwd)) return unavailable();
  return seed;
}

export function runtimeSourceNativeIdentityMatches(
  seed: ProviderManagementProfile, candidate: RuntimeSourceCandidate,
  identity: { nativeVersion?: string | undefined; seedNativeVersion?: string | undefined } | undefined
): boolean {
  return candidate.nativeCli !== undefined && identity?.nativeVersion === candidate.nativeCli.version &&
    (seed.provider !== 'claude' || candidate.executable.sha256 === seed.executable.sha256 ||
      identity?.seedNativeVersion === candidate.nativeCli.version);
}

/** Shared original Team/project association; a current source pointer supplies no authority. */
export function runtimeSourceGrantMatchesScope(
  grant: RuntimeSourceGrant, scope: RuntimeSourceTeamScope, projectPath: string
): boolean {
  return (grant.projectPath === null || grant.projectPath === projectPath) &&
    (grant.teamScopes.some(row => row.teamId === scope.teamId &&
      row.projectId === scope.projectId && row.workspaceId === scope.workspaceId) ||
      (scope.projectId === grant.contextId && scope.workspaceId === grant.contextId));
}

export function assertRuntimeSourceScopeAvailable(
  profile: { creation?: { contextIds: readonly string[] } | undefined },
  grant: RuntimeSourceGrant, scope: RuntimeSourceTeamScope, projectPath: string
): void {
  if (!runtimeSourceGrantMatchesScope(grant, scope, projectPath)) held();
  if (!grant.teamScopes.some(row => row.teamId === scope.teamId &&
    row.projectId === scope.projectId && row.workspaceId === scope.workspaceId) &&
    !profile.creation?.contextIds.includes(grant.contextId)) throw new RuntimeSourceUnavailable();
}

/** Aliases may repeat a scope; every other authority field and the exact scope set must match. */
export function sameRuntimeSourceGrantAuthority(a: RuntimeSourceGrant, b: RuntimeSourceGrant): boolean {
  const normalize = ({ teamScopes, ...identity }: RuntimeSourceGrant) => ({
    ...identity,
    teamScopes: [...new Set(teamScopes.map(scope =>
      JSON.stringify([scope.teamId, scope.projectId, scope.workspaceId])))].sort(),
  });
  return runtimeDigest(normalize(a)) === runtimeDigest(normalize(b));
}

/** Structural history only. Its recorded selection digest never supplies a missing private seed. */
export function readStoredRuntimeSourcePublication(saved: StoredRuntimeSourceCommand): PublishRuntimeSource {
  if (!saved.publicationJson) return held();
  let input: PublishRuntimeSource;
  try { input = publishRuntimeSourceSchema.parse(JSON.parse(saved.publicationJson)); }
  catch { return held(); }
  if (
    input.commandId !== saved.commandId ||
    input.expectedRevision !== saved.expectedRevision ||
    runtimeDigest(input) !== saved.fingerprint ||
    saved.sourceId !== input.grant.targetId ||
    saved.resourceId !== input.grant.targetId ||
    saved.profileId !== input.grant.profileId ||
    saved.configRevision !== input.grant.configRevision ||
    saved.providerId !== input.grant.runtimeId ||
    saved.revision !== runtimeDigest({
      previousRevision: input.expectedRevision,
      commandId: input.commandId,
      grant: input.grant,
      candidate: input.candidate,
      ...(input.intent ? { intent: input.intent } : {}),
    })
  ) return held();
  return input;
}

/** Original replay requires the same current private seed as well as intact recorded identity. */
export function readOriginalRuntimeSourcePublication(
  saved: StoredRuntimeSourceCommand,
  seedFor: (grant: RuntimeSourceGrant) => ProviderManagementProfile
): PublishRuntimeSource {
  const input = readStoredRuntimeSourcePublication(saved);
  const seed = seedFor(input.grant);
  if (saved.profileId !== seed.profileId || saved.configRevision !== seed.configRevision ||
      saved.providerId !== seed.provider ||
      saved.selectionDigest !== runtimeDigest({ grant: input.grant, seed })) return held();
  return input;
}

/** Validate every original record and pointer, including currently ineligible sources. */
export function validateRuntimeSourceHistory(
  index: ReturnType<FileRuntimeSourceIndex['read']>,
  commands: Pick<ManagementCommandStore, 'read'>
): void {
  const previous = new Map<string, string>(), grants = new Map<string, string>(),
    selections = new Map<string, string>();
  for (const record of index.records) {
    const sourceId = record.grant.targetId, grantDigest = runtimeDigest(record.grant),
      receipt = commands.read(record.commandId);
    if (!receipt || receipt.kind !== 'runtime.source') return held();
    if (receipt.publicationJson) readStoredRuntimeSourcePublication(receipt);
    if (
      (grants.has(sourceId) && grants.get(sourceId) !== grantDigest) ||
      (selections.has(sourceId) && selections.get(sourceId) !== receipt.selectionDigest) ||
      record.previousRevision !== (previous.get(sourceId) ?? receipt.selectionDigest) ||
      receipt.resourceHeld || receipt.phase === 'held' || receipt.phase === 'verifying' ||
      (record.candidate.nativeCli && (!['verified', 'published'].includes(receipt.phase) ||
        receipt.nativeVersion !== record.candidate.nativeCli.version)) ||
      receipt.revision !== record.revision || receipt.sourceId !== sourceId ||
      receipt.resourceId !== sourceId || receipt.profileId !== record.grant.profileId ||
      receipt.configRevision !== record.grant.configRevision ||
      receipt.providerId !== record.grant.runtimeId ||
      receipt.expectedRevision !== record.previousRevision ||
      receipt.fingerprint !== runtimeDigest({
        grant: record.grant, commandId: record.commandId,
        expectedRevision: record.previousRevision, candidate: record.candidate,
        ...(record.intent ? { intent: record.intent } : {}),
      })
    ) held();
    grants.set(sourceId, grantDigest);
    selections.set(sourceId, receipt.selectionDigest);
    previous.set(sourceId, record.revision);
  }
  if (previous.size !== index.current.length ||
      index.current.some(pointer => previous.get(pointer.sourceId) !== pointer.revision)) held();
}
