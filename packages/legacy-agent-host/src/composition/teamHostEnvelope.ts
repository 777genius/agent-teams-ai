import { z } from 'zod';
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
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
export function equalFields(a: object, b: object): boolean {
  const left = Object.entries(a).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(left) === JSON.stringify(right);
}
