import { z } from 'zod';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { teamRegistryScopeSchema } from '../team-registry/contracts.js';
import { projectFanoutJournal } from './projectFanoutJournal.js';
import type { TeamStore } from '../team/ports.js';

const id = z.string().min(1).max(256).refine(value => !!value.trim() && !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const projectLifecycleTargetSchema = z.object({
  teamId: id, teamName: id, handleId: id, scope: teamRegistryScopeSchema,
  authorityRevision: z.number().int().min(1), expectedRevision: hash, commandId: id,
}).strict();
const schema = z.object({
  schemaVersion: z.literal(1), family: z.literal('project-lifecycle'),
  ownerId: id, ownerDigest: hash, principalId: id, logicalTeamId: id, logicalHandleId: id,
  commandId: id, action: z.enum(['trash', 'restore', 'purge']), expectedRevision: hash,
  targets: z.array(projectLifecycleTargetSchema).min(1).max(129),
  fingerprint: hash, phase: z.enum(['prepared', 'completed']), sequence: z.number().int().min(1).max(4096),
}).strict();
export type ProjectLifecyclePlan = z.infer<typeof schema>;
export type ProjectLifecycleTarget = z.infer<typeof projectLifecycleTargetSchema>;
export const PROJECT_LIFECYCLE_DIRECTORY = 'project-lifecycle';
export function projectLifecycleFingerprint(value: Omit<ProjectLifecyclePlan, 'fingerprint' | 'sequence' | 'phase'>): string {
  const { fingerprint: _fingerprint, phase: _phase, sequence: _sequence, ...intent } =
    value as ProjectLifecyclePlan;
  return digest(intent);
}
export function validateProjectLifecyclePlan(raw: unknown): ProjectLifecyclePlan {
  try {
    const value = schema.parse(raw), last = value.targets.at(-1)!;
    if (value.fingerprint !== projectLifecycleFingerprint(value) ||
      last.teamId !== value.logicalTeamId || last.handleId !== value.logicalHandleId ||
      last.commandId !== value.commandId || last.expectedRevision !== value.expectedRevision ||
      new Set(value.targets.map(row => row.teamId)).size !== value.targets.length ||
      new Set(value.targets.map(row => row.commandId)).size !== value.targets.length ||
      value.targets.some(row => row.scope.teamId !== row.teamId)) throw new Error('Invalid original lifecycle plan');
    return value;
  } catch { throw new TeamOwnerError('hold'); }
}
export function projectLifecycleJournal(store: Pick<TeamStore, 'read' | 'write'>) {
  return projectFanoutJournal(store, PROJECT_LIFECYCLE_DIRECTORY, validateProjectLifecyclePlan);
}
export function assertProjectLifecycleIdle(store: Pick<TeamStore, 'read'>): void {
  const value = store.read<unknown>(`${PROJECT_LIFECYCLE_DIRECTORY}/current.json`);
  if (value !== undefined && validateProjectLifecyclePlan(value).phase !== 'completed')
    throw new TeamOwnerError('hold');
}
