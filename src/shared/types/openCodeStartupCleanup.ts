export const OPEN_CODE_STARTUP_CLEANUP_STATUS = 'app:openCodeStartupCleanupStatus';
export const OPEN_CODE_STARTUP_CLEANUP_RETRY = 'app:retryOpenCodeStartupCleanup';

export interface OpenCodeStartupCleanupRecoveryStatus {
  state: 'unavailable' | 'pending' | 'unknown' | 'partial' | 'complete' | 'stopped';
  requestId?: string;
}

export interface OpenCodeStartupCleanupRecoveryAPI {
  getOpenCodeCleanupStatus(): Promise<OpenCodeStartupCleanupRecoveryStatus>;
  retryOpenCodeCleanup(): Promise<OpenCodeStartupCleanupRecoveryStatus>;
}
