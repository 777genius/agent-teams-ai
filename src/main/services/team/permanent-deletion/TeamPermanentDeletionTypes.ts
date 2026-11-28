export type {
  PermanentDeletionTarget,
  PermanentDeletionTargetCompletedCheck,
  PermanentDeletionTargetCurrentCheck,
  PermanentDeletionTargetObservation,
  PermanentDeletionTargetProofHookFactory,
  PermanentDeletionTargetRemovalProof,
  TeamPermanentDeletionIntent,
} from '@agent-teams/legacy-agent-host/lifecycle';
export {
  assertSafeTeamName,
  BackupPublicationFencedError,
  isDurablePathIdentity,
  isExactDurablePathIdentity,
  isPermanentDeletionTargetObservation,
  isPermanentDeletionTargetRemovalProof,
  PERMANENT_DELETION_TARGETS,
} from '@agent-teams/legacy-agent-host/lifecycle';
