import { z } from 'zod';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { FileTeamRegistryStore } from '../adapters/team-registry/FileTeamRegistryStore.js';
import { FileStoppedSnapshotResolver } from '../stopped-team-import/FileStoppedSnapshotResolver.js';
import { FileStoppedTeamImport } from '../stopped-team-import/FileStoppedTeamImport.js';
import { stoppedTeamImportRoutes } from '../stopped-team-import/stoppedTeamImportRoutes.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostMethod } from '../index.js';
import type { HostedTeamDefinition } from '../team-registry/definition.js';
import type { StoppedImportContext } from '../stopped-team-import/contracts.js';
import type { JsonValue } from '../contracts.js';

const id = z.string().min(1).max(256);
const envelope = z.object({ owner: z.unknown(), commandId: id, payload: z.unknown() }).strict();
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
/** Composition only: one existing publisher owns all immutable intent/product writes. */
export function createStoppedImportComposition(options: {
  profile: TeamHostProfile;
  assertCurrent(): void;
  assertLifecycleWriter?(): void;
  attach(definition: HostedTeamDefinition): void;
  isRetired?(definition: HostedTeamDefinition): boolean;
  /** Same save-only product admission as create: validate target owner/scope and no live delivery.
   * Preserve configured settings even when the future native recipe is unavailable. */
  validateConfiguration(definition: HostedTeamDefinition): void;
}) {
  const { profile } = options;
  if (!profile.creation) return undefined;
  const root = profile.owner.storageRoot,
    contextIds = profile.creation.contextIds;
  const creations = new FileTeamRegistryStore(root, options.assertCurrent);
  const origins = new Map<string, StoppedImportContext>();
  const publisher = new FileStoppedTeamImport({
    root,
    ownerId: profile.owner.ownerId,
    profileId: profile.owner.profileId,
    principalId: profile.principalId,
    contextIds,
    assertWriter: options.assertCurrent,
    ...(options.assertLifecycleWriter ? { assertLifecycleWriter: options.assertLifecycleWriter } : {}),
    existingRecords: () => [
      ...profile.teams.map((team) => ({
        teamId: team.binding.teamId,
        teamName: team.binding.teamName,
      })),
      ...creations.readAll().map((entry) => entry.record),
    ],
    bindOrigin: (record, origin) => {
      options.assertCurrent();
      origins.set(record.teamId, structuredClone(origin));
    },
    validateConfiguration: options.validateConfiguration,
    attach: options.attach,
    ...(options.isRetired ? { isRetired: options.isRetired } : {}),
  });
  const snapshots = new FileStoppedSnapshotResolver({
    root,
    ownerId: profile.owner.ownerId,
    profileId: profile.owner.profileId,
    principalId: profile.principalId,
    contextIds,
    assertCurrent: options.assertCurrent,
  });
  const routes = stoppedTeamImportRoutes(publisher, snapshots);
  const methods: Record<string, HostMethod> = {};
  for (const operation of ['publish', 'lookup', 'retry', 'list'] as const)
    methods[`team.import.${operation}`] = {
      lane: operation === 'publish' || operation === 'retry' ? 'work' : 'control',
      async handle(raw): Promise<JsonValue> {
        try {
          options.assertCurrent();
          const input = envelope.parse(raw);
          if (digest(input.owner) !== digest(profile.owner)) throw new TeamOwnerError('forbidden');
          const result =
            operation === 'list'
              ? routes.list(input.payload)
              : routes[operation](input.commandId, input.payload);
          return { ok: true, value: json(result) };
        } catch (error) {
          return {
            ok: false,
            code:
              error instanceof TeamOwnerError
                ? error.code
                : error instanceof z.ZodError
                  ? 'invalid'
                  : 'hold',
            outcome:
              operation === 'publish' || operation === 'retry' ? 'unknown' : 'not-dispatched',
          };
        }
      },
    };
  return {
    publication: publisher.publication.bind(publisher),
    methods,
    catalog: () => publisher.catalog(),
    readTaskAttachment: (teamId: string, currentTask: unknown, payload: unknown) =>
      publisher.readTaskAttachment(teamId, currentTask, payload),
    restorePublished: () => {
      try {
        publisher.attachPublished();
      } catch {
        /* Unknown import metadata never authorizes touching a namespace. */
      }
    },
    origin(teamId: string, contextId: string) {
      const durable = publisher.readOrigin(teamId, contextId);
      if (durable && origins.has(teamId) && digest(origins.get(teamId)) !== digest(durable))
        throw new TeamOwnerError('hold');
      return durable;
    },
  };
}
