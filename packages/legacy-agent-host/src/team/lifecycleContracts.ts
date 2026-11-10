import { retainedDeliveryCancellationSchema } from './retainedDeliverySchema.js';
import { z } from 'zod';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import type { OwnerState } from './ownerState.js';
import type { TeamBinding, RuntimeMemberBinding } from './contracts.js';
import type { RetainedDeliveryCancellation } from './cancelRetainedDeliveries.js';

const id = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.object({ backendId: id, teamId: id, teamName: id }).strict();
const runtime = z.object({ backendId: id, teamId: id, runId: id, memberId: id, generation: id }).strict();
const state = z.object({ deletedAt: id.optional(), cleanupCommandId: id, cleanupPending: z.boolean() }).strict();
export const teamLifecycleInput = z.object({ commandId: id, operation: z.enum(['trash', 'restore']), expectedRevision: hash }).strict();
const receipt = z.object({ schemaVersion: z.literal(1), family: z.literal('lifecycle'), binding,
  commandId: id, principalId: id, fingerprint: hash, captureDigest: hash, authorityRevision: z.number().int().min(1),
  operation: z.enum(['trash', 'restore']), createdAt: id, phase: z.enum(['prepared', 'completed', 'held']),
  before: state.nullable(), after: state,
  targets: z.array(retainedDeliveryCancellationSchema).max(4096),
  runtimeBindings: z.array(runtime).max(4096) }).strict();
export interface TeamLifecycleState { deletedAt?: string; cleanupCommandId: string; cleanupPending: boolean }
export interface LifecycleOwnerState extends OwnerState { lifecycle?: TeamLifecycleState }
export interface TeamLifecycleReceipt {
  schemaVersion: 1; family: 'lifecycle'; binding: TeamBinding; commandId: string; principalId: string;
  fingerprint: string; captureDigest: string; authorityRevision: number; operation: 'trash' | 'restore'; createdAt: string;
  phase: 'prepared' | 'completed' | 'held'; before: TeamLifecycleState | null; after: TeamLifecycleState;
  targets: RetainedDeliveryCancellation[]; runtimeBindings: RuntimeMemberBinding[];
}
export function validateTeamLifecycleReceipt(raw: unknown): TeamLifecycleReceipt {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > 32 * 1024 * 1024) throw new Error('Receipt too large');
    const value = receipt.parse(raw);
    if (value.fingerprint !== digest({ binding: value.binding, principalId: value.principalId,
      input: { commandId: value.commandId, operation: value.operation, expectedRevision: digest(value.before) } })) throw new Error('Lifecycle fingerprint mismatch');
    if (value.captureDigest !== digest({ intents: value.targets.map(target => target.intent), runtimeBindings: value.runtimeBindings })) throw new Error('Lifecycle capture mismatch');
    const expected = value.operation === 'trash' ? { deletedAt: value.before?.deletedAt ?? value.createdAt, cleanupCommandId: value.commandId, cleanupPending: true }
      : value.before?.deletedAt ? { cleanupCommandId: value.before.cleanupCommandId, cleanupPending: value.before.cleanupPending } : null;
    if (digest(value.after) !== digest(expected)) throw new Error('Lifecycle decision mismatch');
    if (value.operation === 'restore' && (value.targets.length || value.runtimeBindings.length)) throw new Error('Restore cannot select runtime');
    for (const target of value.targets) if (target.intent.binding.backendId !== value.binding.backendId || target.intent.binding.teamId !== value.binding.teamId || target.intent.binding.teamName !== value.binding.teamName || target.intent.inputId !== target.intent.deliveryId) throw new Error('Wrong original target');
    for (const target of value.runtimeBindings) if (target.backendId !== value.binding.backendId || target.teamId !== value.binding.teamId) throw new Error('Wrong runtime scope');
    return value as TeamLifecycleReceipt;
  } catch { throw new TeamOwnerError('hold'); }
}
