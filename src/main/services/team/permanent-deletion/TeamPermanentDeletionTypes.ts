import type { DurablePathIdentity, DurablePathRemovalProofHooks } from '@main/utils/atomicWrite';

export type PermanentDeletionTarget =
  | 'team-data'
  | 'task-data'
  | 'message-attachments'
  | 'task-attachments';

export const PERMANENT_DELETION_TARGETS: readonly PermanentDeletionTarget[] = [
  'team-data',
  'task-data',
  'message-attachments',
  'task-attachments',
];

export class BackupPublicationFencedError extends Error {}

export type PermanentDeletionTargetObservation =
  | { status: 'absent' }
  | { status: 'present'; identity: DurablePathIdentity };

export interface PermanentDeletionTargetRemovalProof {
  version: 1;
  transactionId: string;
  target: PermanentDeletionTarget;
  targetIdentity: DurablePathIdentity;
  state: 'detached' | 'removed';
  detachedAt: string;
  removedAt?: string;
}

export interface TeamPermanentDeletionIntent {
  version: 2;
  teamName: string;
  identityId: string;
  transactionId: string;
  identityKind: 'team' | 'draft';
  targets: Record<PermanentDeletionTarget, PermanentDeletionTargetObservation>;
  targetRemovalProofs: Partial<
    Record<PermanentDeletionTarget, PermanentDeletionTargetRemovalProof>
  >;
  completedTargets: PermanentDeletionTarget[];
  cleanupCompleted: boolean;
  phase: 'prepared' | 'deleting' | 'deleted';
  requestedAt: string;
  updatedAt: string;
}

export type PermanentDeletionTargetCurrentCheck = (
  target?: PermanentDeletionTarget,
  detachedPath?: string
) => Promise<boolean>;

export type PermanentDeletionTargetProofHookFactory = (
  target: PermanentDeletionTarget
) => DurablePathRemovalProofHooks;

export type PermanentDeletionTargetCompletedCheck = (target: PermanentDeletionTarget) => boolean;

export function assertSafeTeamName(teamName: string): void {
  if (
    !teamName ||
    teamName === '.' ||
    teamName === '..' ||
    teamName.includes('/') ||
    teamName.includes('\\') ||
    teamName.includes('\0')
  ) {
    throw new Error(`Unsafe team name: ${JSON.stringify(teamName)}`);
  }
}

export function isExactDurablePathIdentity(
  left: DurablePathIdentity,
  right: DurablePathIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

export function isDurablePathIdentity(value: unknown): value is DurablePathIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<DurablePathIdentity>;
  return (
    typeof identity.dev === 'number' &&
    Number.isFinite(identity.dev) &&
    typeof identity.ino === 'number' &&
    Number.isFinite(identity.ino) &&
    typeof identity.birthtimeMs === 'number' &&
    Number.isFinite(identity.birthtimeMs)
  );
}

export function isPermanentDeletionTargetObservation(
  value: unknown
): value is PermanentDeletionTargetObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const observation = value as Partial<PermanentDeletionTargetObservation>;
  return (
    observation.status === 'absent' ||
    (observation.status === 'present' && isDurablePathIdentity(observation.identity))
  );
}

export function isPermanentDeletionTargetRemovalProof(
  value: unknown
): value is PermanentDeletionTargetRemovalProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Partial<PermanentDeletionTargetRemovalProof>;
  return (
    proof.version === 1 &&
    typeof proof.transactionId === 'string' &&
    proof.transactionId.length > 0 &&
    typeof proof.target === 'string' &&
    PERMANENT_DELETION_TARGETS.includes(proof.target) &&
    isDurablePathIdentity(proof.targetIdentity) &&
    (proof.state === 'detached' || proof.state === 'removed') &&
    typeof proof.detachedAt === 'string' &&
    Number.isFinite(Date.parse(proof.detachedAt)) &&
    (proof.state === 'removed'
      ? typeof proof.removedAt === 'string' && Number.isFinite(Date.parse(proof.removedAt))
      : proof.removedAt === undefined)
  );
}
