import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { FileRuntimeSourceIndex } from '../adapters/profile/FileRuntimeSourceIndex.js';
import { FileManagementCommandStore } from '../adapters/providers/FileManagementCommandStore.js';
import { nativeProfilePathSchema } from '../composition/nativeProcessProfile.js';
import { runtimeProfileSchema } from '../composition/runtimeProfile.js';
import { runtimeSourceGrantSchema } from '../composition/runtimeSourceContracts.js';
import { assertRuntimeSourceQualification } from '../composition/verifyRuntimeSourceCandidate.js';
import { readOriginalRuntimeSourcePublication, runtimeSourceNativeIdentityMatches,
  sameRuntimeSourceGrantAuthority, selectRuntimeSourceSeed, validateRuntimeSourceHistory,
  RuntimeSourceUnavailable } from '../composition/runtimeSourceGrantAuthority.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { providerManagementProfileSchema } from '../management/profile.js';
import { runtimeDigest } from '../runtime/identity.js';

import type { RuntimeSourceRecord } from '../adapters/profile/FileRuntimeSourceIndex.js';
import type { PublishRuntimeSource, RuntimeSourceGrant } from '../composition/runtimeSourceContracts.js';
import type { StoredRuntimeSourceCommand } from '../management/commandRecords.js';
import type { ProviderManagementProfile } from '../management/profile.js';

/** Only existing source authority fields; this does not instantiate a Host or acquire a writer. */
export const runtimeSourceProcessContextSchema = z.object({
  owner: z.object({ ownerId: runtimeSourceGrantSchema.shape.ownerId,
    revision: runtimeSourceGrantSchema.shape.ownerRevision, storageRoot: nativeProfilePathSchema }),
  // This private profile projection drops run/member/generation; the original grant remains strict.
  teams: z.array(z.object({ scope: z.object(runtimeSourceGrantSchema.shape.teamScopes.element.shape) })).max(256),
  creation: z.object({ contextIds: z.array(runtimeSourceGrantSchema.shape.contextId).max(256) }).optional(),
  management: z.array(providerManagementProfileSchema).max(256).optional(),
  runtime: runtimeProfileSchema.optional(),
});
export type RuntimeSourceProcessContext = z.infer<typeof runtimeSourceProcessContextSchema>;
export interface RetainedRuntimeSourceSelection {
  record: RuntimeSourceRecord;
  seed: ProviderManagementProfile;
}

const held = (): never => { throw new ManagementCommandError('held'); };
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function readHistory(profile: RuntimeSourceProcessContext, assertCurrent: () => void) {
  assertCurrent();
  const root = profile.owner.storageRoot;
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) held();
  const index = present(join(root, 'runtime-sources'))
    ? new FileRuntimeSourceIndex(root, assertCurrent, true).read()
    : { schemaVersion: 1 as const, records: [], current: [] };
  const commands = present(join(root, 'management-commands'))
    ? new FileManagementCommandStore(root, true) : undefined;
  validateRuntimeSourceHistory(index, { read: id => commands?.read(id) });
  // Match the Host's constructor: a successful receipt without its original published record is held.
  for (const receipt of commands?.list() ?? []) if (receipt.kind === 'runtime.source' &&
    receipt.phase === 'published' && !index.records.some(record =>
      record.commandId === receipt.commandId && record.revision === receipt.revision)) held();
  assertCurrent();
  return { index, commands };
}

/** Read the original published history; no directory creation, write, cleanup, native probe or retry. */
export function readRetainedRuntimeSourceSelections(
  profile: RuntimeSourceProcessContext,
  grants: readonly RuntimeSourceGrant[],
  assertCurrent: () => void
): RetainedRuntimeSourceSelection[] {
  const { index, commands } = readHistory(profile, assertCurrent);
  const selected: RetainedRuntimeSourceSelection[] = [];
  for (const record of index.records) {
    if (!grants.some(grant => sameRuntimeSourceGrantAuthority(grant, record.grant))) continue;
    let seed: ProviderManagementProfile;
    try { seed = selectRuntimeSourceSeed(profile, record.grant, true); }
    catch (error) { if (error instanceof RuntimeSourceUnavailable) continue; throw error; }
    const receipt = commands?.read(record.commandId);
    if (!receipt || receipt.kind !== 'runtime.source') return held();
    if (receipt.selectionDigest !== runtimeDigest({ grant: record.grant, seed }))
      continue; // The Host likewise isolates a changed private seed without retargeting its history.
    // Older already-published receipts have the same validated record/fingerprint but no replay JSON.
    if (receipt.publicationJson) readOriginalRuntimeSourcePublication(receipt,
      grant => selectRuntimeSourceSeed(profile, grant, true));
    assertRuntimeSourceQualification(seed, record.candidate);
    if (record.candidate.nativeCli && !runtimeSourceNativeIdentityMatches(seed, record.candidate, receipt)) held();
    selected.push({ record, seed });
  }
  assertCurrent();
  return selected;
}

/** Only explicit recovery of a prepared, never-allocated original command may need a new version read. */
export function readPreparedRuntimeSourcePublication(
  profile: RuntimeSourceProcessContext, grant: RuntimeSourceGrant, assertCurrent: () => void
): PublishRuntimeSource | undefined {
  const { commands } = readHistory(profile, assertCurrent);
  selectRuntimeSourceSeed(profile, grant);
  const unfinished = [...commands?.list() ?? []].filter((row): row is StoredRuntimeSourceCommand =>
    row.kind === 'runtime.source' && row.sourceId === grant.targetId && row.phase !== 'published' &&
    (row.phase !== 'held' || row.resourceHeld));
  if (unfinished.length > 1) held();
  const saved = unfinished[0];
  if (!saved) return;
  const original = readOriginalRuntimeSourcePublication(saved, value => selectRuntimeSourceSeed(profile, value));
  if (!sameRuntimeSourceGrantAuthority(original.grant, grant)) held();
  assertRuntimeSourceQualification(selectRuntimeSourceSeed(profile, original.grant), original.candidate);
  assertCurrent();
  return saved.phase === 'prepared' && !saved.resourceHeld ? original : undefined;
}

/** Configuration can recheck only the same original source, never choose a new CLI or latest pointer. */
export function readRuntimeSourceConfigurationVersion(
  profile: RuntimeSourceProcessContext, grant: RuntimeSourceGrant,
  request: { commandId: string; expectedRevision: string }, assertCurrent: () => void
): PublishRuntimeSource | undefined {
  const { index, commands } = readHistory(profile, assertCurrent);
  const seed = selectRuntimeSourceSeed(profile, grant);
  if (seed.provider !== 'opencode') held();
  const prior = commands?.read(request.commandId);
  if (prior) {
    if (prior.kind !== 'runtime.source') return held();
    const original = readOriginalRuntimeSourcePublication(prior, value => selectRuntimeSourceSeed(profile, value));
    if (!sameRuntimeSourceGrantAuthority(original.grant, grant) || original.intent !== 'configuration' ||
        original.expectedRevision !== request.expectedRevision) held();
    assertRuntimeSourceQualification(seed, original.candidate);
    assertCurrent();
    return prior.phase === 'prepared' && !prior.resourceHeld ? original : undefined;
  }
  const previous = readRetainedRuntimeSourceSelections(profile, [grant], assertCurrent)
    .find(value => value.record.revision === request.expectedRevision);
  if (!previous) {
    // A first captured-source configuration has no selected CLI and therefore needs no native read.
    if (index.records.some(record => record.grant.targetId === grant.targetId) ||
        request.expectedRevision !== runtimeDigest({ grant, seed })) held();
    return;
  }
  assertCurrent();
  // This is a finite version selection only; the Host still owns the actual configuration snapshot.
  return { grant: previous.record.grant, commandId: request.commandId,
    expectedRevision: request.expectedRevision, candidate: previous.record.candidate };
}
