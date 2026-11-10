import { z } from 'zod';
import { storedSkillCommandSchema } from '../skills/skillRecords.js';
import { managementCommandIdentityShape as common } from './commandIdentity.js';
import { storedExtensionCommandSchema } from '../extensions/extensionRecords.js';
import { modelProbeLimitsSchema } from './modelLimits.js';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const storedCredentialCommandSchema = z
  .object({
    ...common,
    kind: z.enum(['credential.set', 'credential.forget', 'credential.refresh']),
    phase: z.enum(['claimed', 'completed', 'held']),
    finishedAtMs: z.number().int().positive().safe().optional(),
    refreshCompletedAtMs: z.number().int().positive().safe().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.phase === 'claimed'
        ? value.resourceHeld && value.finishedAtMs === undefined
        : value.phase !== 'completed' || !value.resourceHeld) &&
      (value.refreshCompletedAtMs === undefined ||
        (value.kind === 'credential.refresh' &&
          value.phase === 'completed' &&
          value.finishedAtMs !== undefined &&
          value.refreshCompletedAtMs <= value.finishedAtMs))
  );
export type StoredCredentialCommand = z.infer<typeof storedCredentialCommandSchema>;

export const storedOAuthCommandSchema = z
  .object({
    ...common,
    kind: z.literal('oauth'),
    methodIndex: z.number().int().min(0).max(10000),
    phase: z.enum([
      'authorizing',
      'waiting-for-code',
      'waiting-for-browser',
      'completing',
      'cancelling',
      'completed',
      'cancelled',
      'held',
    ]),
    completionMethod: z.enum(['auto', 'code']).nullable(),
    completionCommandId: id.optional(),
    completionFingerprint: hash.optional(),
    sequence: z.number().int().min(1),
    expiresAt: z.number().int().positive(),
    reason: z.enum(['cancelled', 'expired', 'native-outcome-unknown', 'owner-changed']).optional(),
  })
  .strict()
  .refine((value) => {
    if (['completed', 'cancelled'].includes(value.phase) && value.resourceHeld) return false;
    if (!['completed', 'cancelled', 'held'].includes(value.phase) && !value.resourceHeld)
      return false;
    if ((value.completionCommandId === undefined) !== (value.completionFingerprint === undefined))
      return false;
    if (
      ['completing', 'completed'].includes(value.phase) &&
      (!value.completionCommandId || !value.completionMethod)
    )
      return false;
    return true;
  });
export type StoredOAuthCommand = z.infer<typeof storedOAuthCommandSchema>;

export const storedModelProbeSchema = z
  .object({
    ...common,
    kind: z.literal('model.probe'),
    modelId: id,
    effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    modelContext: z.enum(['model-default', 'one-million']).optional(),
    context: hash.optional(),
    limits: modelProbeLimitsSchema.optional(),
    phase: z.enum(['running', 'completed', 'cancelled', 'held']),
    expiresAt: z.number().int().positive(),
    ok: z.boolean(),
  })
  .strict()
  .refine((value) =>
    value.phase === 'running'
      ? value.resourceHeld && !value.ok
      : value.phase === 'completed'
        ? !value.resourceHeld
        : !value.ok && (value.phase !== 'cancelled' || !value.resourceHeld)
  );
export type StoredModelProbe = z.infer<typeof storedModelProbeSchema>;

export const storedManagementCommandSchema = z.union([
  storedSkillCommandSchema,
  storedCredentialCommandSchema,
  storedOAuthCommandSchema,
  storedModelProbeSchema,
  storedExtensionCommandSchema,
]);
export type StoredManagementCommand = z.infer<typeof storedManagementCommandSchema>;
export interface ManagementCommandStore {
  read(commandId: string): StoredManagementCommand | undefined;
  write(record: StoredManagementCommand): void;
  list(): Iterable<StoredManagementCommand>;
}
export interface ManagementTarget {
  profileId: string;
  configRevision: string;
  selectionDigest: string;
  resourceId: string;
}
export class ManagementCommandError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'busy' | 'held') {
    super(`Provider management command ${code}`);
  }
}
export function assertManagementTarget(saved: ManagementTarget, selected: ManagementTarget): void {
  if (
    saved.profileId !== selected.profileId ||
    saved.configRevision !== selected.configRevision ||
    saved.selectionDigest !== selected.selectionDigest ||
    saved.resourceId !== selected.resourceId
  )
    throw new ManagementCommandError('conflict');
}
