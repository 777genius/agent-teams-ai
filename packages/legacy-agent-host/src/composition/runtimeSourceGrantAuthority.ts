import { ManagementCommandError } from '../management/commandRecords.js';
import { runtimeDigest } from '../runtime/identity.js';
import { publishRuntimeSourceSchema } from './runtimeSourceContracts.js';
import type { StoredRuntimeSourceCommand } from '../management/commandRecords.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { PublishRuntimeSource, RuntimeSourceGrant } from './runtimeSourceContracts.js';

const held = (): never => { throw new ManagementCommandError('held'); };

/** Aliases may repeat a scope; every other authority field and the exact scope set must match. */
export function sameRuntimeSourceGrantAuthority(a: RuntimeSourceGrant, b: RuntimeSourceGrant): boolean {
  const normalize = ({ teamScopes, ...identity }: RuntimeSourceGrant) => ({
    ...identity,
    teamScopes: [...new Set(teamScopes.map(scope =>
      JSON.stringify([scope.teamId, scope.projectId, scope.workspaceId])))].sort(),
  });
  return runtimeDigest(normalize(a)) === runtimeDigest(normalize(b));
}

/** Validate the immutable original representation before using it for any request or recovery. */
export function readOriginalRuntimeSourcePublication(
  saved: StoredRuntimeSourceCommand,
  seedFor: (grant: RuntimeSourceGrant) => ProviderManagementProfile
): PublishRuntimeSource {
  if (!saved.publicationJson) return held();
  let input: PublishRuntimeSource, seed: ProviderManagementProfile;
  try {
    input = publishRuntimeSourceSchema.parse(JSON.parse(saved.publicationJson));
    seed = seedFor(input.grant);
  } catch { return held(); }
  if (
    input.commandId !== saved.commandId ||
    input.expectedRevision !== saved.expectedRevision ||
    runtimeDigest(input) !== saved.fingerprint ||
    saved.sourceId !== input.grant.targetId ||
    saved.resourceId !== input.grant.targetId ||
    saved.profileId !== seed.profileId ||
    saved.configRevision !== seed.configRevision ||
    saved.providerId !== seed.provider ||
    saved.selectionDigest !== runtimeDigest({ grant: input.grant, seed }) ||
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
