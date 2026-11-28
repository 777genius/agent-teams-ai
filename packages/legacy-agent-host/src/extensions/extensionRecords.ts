import { z } from 'zod';

import { managementCommandIdentityShape } from '../management/commandIdentity.js';

export const storedExtensionCommandSchema = z
  .object({
    ...managementCommandIdentityShape,
    kind: z.literal('extension.mutation'),
    action: z.enum(['plugin.install', 'plugin.uninstall', 'mcp.install', 'mcp.uninstall']),
    scope: z.enum(['user', 'global', 'project', 'local']),
    targetId: z.string().regex(/^[a-f0-9]{64}$/u),
    intentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    phase: z.enum(['claimed', 'completed', 'failed', 'held']),
    finishedAtMs: z.number().int().positive().safe().optional(),
  })
  .strict()
  .refine((row) =>
    row.phase === 'claimed'
      ? row.resourceHeld && row.finishedAtMs === undefined
      : !['completed', 'failed'].includes(row.phase) ||
        (!row.resourceHeld && row.finishedAtMs !== undefined)
  );
export type StoredExtensionCommand = z.infer<typeof storedExtensionCommandSchema>;
export interface ExtensionMutationReceipt {
  readonly commandId: string;
  readonly profileId: string;
  readonly configRevision: string;
  readonly targetId: string;
  readonly action: StoredExtensionCommand['action'];
  readonly scope: StoredExtensionCommand['scope'];
  readonly phase: 'completed' | 'failed' | 'held';
}
