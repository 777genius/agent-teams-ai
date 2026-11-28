import { z } from 'zod';
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const managementCommandIdentityShape = {
  schemaVersion: z.literal(1),
  commandId: id,
  profileId: id,
  configRevision: id,
  providerId: id,
  fingerprint: hash,
  selectionDigest: hash,
  resourceId: hash,
  resourceHeld: z.boolean(),
};
