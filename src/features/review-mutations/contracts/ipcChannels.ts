export const REVIEW_EXECUTE_MUTATION = 'review:executeMutation';
export const REVIEW_RETRY_MUTATION_RECOVERY = 'review:retryMutationRecovery';
export const REVIEW_RESTORE_HISTORY = 'review:restoreHistory';

export const REVIEW_MUTATION_RECOVERY_IPC_CHANNELS = [
  REVIEW_EXECUTE_MUTATION,
  REVIEW_RETRY_MUTATION_RECOVERY,
  REVIEW_RESTORE_HISTORY,
] as const;
