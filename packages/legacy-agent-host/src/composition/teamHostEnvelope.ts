import { z } from 'zod';
import { localModelReadinessPreparationSchema } from '../management/commandRecords.js';
import { localModelReadinessTransferSchema } from './prepareTeamModelReadiness.js';
import { localModelReadinessCaptureSchema } from '../team-launch/launchReadiness.js';
import { liveRosterPrivateInputSchema, parseLiveRosterPrivateInput } from '../team/liveRosterMembership.js';
import type { HostedTeam } from './MemberEntry.js';
import { teamRegistryScopeSchema } from '../team-registry/contracts.js';
import type { JsonValue } from '../contracts.js';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const hostOwnerSchema = z.object({
  ownerId: id, revision: id, storageRoot: id, profileId: id,
  protocolVersion: z.literal(1), buildId: id, nodeSha256: hash, hostEntrySha256: hash,
}).strict();
export const envelopeSchema = z.object({
  commandId: id,
  binding: z.object({ schemaVersion: z.literal(1), handleId: id,
    owner: hostOwnerSchema, scope: teamRegistryScopeSchema }).strict(),
  payload: z.unknown(),
}).strict();
export const preparationEnvelopeSchema = envelopeSchema.extend({
  localModelReadinessOrigin: localModelReadinessPreparationSchema.optional(),
  localModelReadinessTransfer: localModelReadinessTransferSchema.optional(),
  localModelReadinessCapture: localModelReadinessCaptureSchema.optional(),
  liveRoster: liveRosterPrivateInputSchema.optional(),
}).strict();
export const creationEnvelopeSchema = z.object({
  owner: hostOwnerSchema, commandId: id, payload: z.unknown(),
}).strict();
export const creationPreparationEnvelopeSchema = creationEnvelopeSchema.extend({
  localModelReadinessOrigin: localModelReadinessPreparationSchema.optional(),
  localModelReadinessRemainingMs: z.number().int().min(1).max(100000).optional(),
  localModelReadinessCapture: localModelReadinessCaptureSchema.optional(),
}).strict();
export function parsePreparationEnvelope(raw: unknown, operation: string | boolean): z.infer<typeof preparationEnvelopeSchema> {
  const method = operation === true ? 'team.launch.probe.start' : operation === false ? '' : operation;
  const input = preparationEnvelopeSchema.parse(raw);
  const { localModelReadinessOrigin: origin, localModelReadinessTransfer: transfer,
    localModelReadinessCapture: capture, liveRoster } = input;
  if (origin && !['team.launch.probe.start', 'team.launch.start', 'runtime.open',
    'team.member.action.execute', 'team.roster.replace'].includes(method) ||
    transfer && method !== 'team.launch.capture' || capture && method !== 'team.launch.configuration.read' ||
    origin && method === 'team.member.action.execute' &&
      !(input.payload && typeof input.payload === 'object' && 'action' in input.payload && input.payload.action === 'restart') ||
    origin && (transfer || capture) || liveRoster && (transfer || capture))
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Unexpected private preparation' }]);
  if (liveRoster) {
    if (method !== 'team.roster.replace' && method !== 'team.roster.lookup')
      throw new z.ZodError([{ code: 'custom', path: [], message: 'Unexpected roster phase' }]);
    parseLiveRosterPrivateInput(method, liveRoster, origin);
  } else if (origin && method === 'team.roster.replace')
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Missing original roster phase' }]);
  return input;
}
export function parseCreationEnvelope(raw: unknown, operation: string | boolean): z.infer<typeof creationPreparationEnvelopeSchema> {
  const method = operation === true ? 'team.creation.prepare' : operation === false ? '' : operation;
  const input = creationPreparationEnvelopeSchema.parse(raw);
  if (input.localModelReadinessOrigin && method !== 'team.creation.prepare' ||
    input.localModelReadinessRemainingMs !== undefined && method !== 'team.creation.capture' ||
    input.localModelReadinessCapture && method !== 'team.creation.submit' ||
    method === 'team.creation.capture' && input.localModelReadinessRemainingMs === undefined)
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Unexpected creation preparation' }]);
  return input;
}
/** Same original Team/owner/scope join shared by the existing finite Host routes. */
export function selectBoundHostTeam(input: z.infer<typeof envelopeSchema>,
  owner: z.infer<typeof hostOwnerSchema>, teams: ReadonlyMap<string, HostedTeam>): HostedTeam | undefined {
  const selected = teams.get(input.binding.scope.teamId);
  return selected && equalFields(input.binding.owner, owner) && equalFields(input.binding.scope, selected.definition.scope)
    ? selected : undefined;
}
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
export function equalFields(a: object, b: object): boolean {
  const left = Object.entries(a).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(left) === JSON.stringify(right);
}
