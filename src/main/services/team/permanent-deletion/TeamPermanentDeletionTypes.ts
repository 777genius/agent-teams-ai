export {
  PERMANENT_DELETION_TARGETS,
  BackupPublicationFencedError,
  assertSafeTeamName,
  isExactDurablePathIdentity,
  isDurablePathIdentity,
  isPermanentDeletionTargetObservation,
  isPermanentDeletionTargetRemovalProof,
} from '@agent-teams/legacy-agent-host/lifecycle';
export type {
  PermanentDeletionTarget,
  PermanentDeletionTargetObservation,
  PermanentDeletionTargetRemovalProof,
  TeamPermanentDeletionIntent,
  PermanentDeletionTargetCurrentCheck,
  PermanentDeletionTargetProofHookFactory,
  PermanentDeletionTargetCompletedCheck,
} from '@agent-teams/legacy-agent-host/lifecycle';
