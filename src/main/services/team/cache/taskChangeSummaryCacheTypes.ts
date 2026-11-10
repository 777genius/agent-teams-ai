import type { TaskChangeSetV2 } from '@shared/types';
import type { TaskChangeStateBucket } from '@shared/utils/taskChangeState';

export const TASK_CHANGE_SUMMARY_CACHE_SCHEMA_VERSION = 1;

export type PersistedTaskChangeExtractorConfidence = Exclude<
  TaskChangeSetV2['confidence'],
  'low' | 'fallback'
>;

export interface PersistedTaskChangeSummaryEntry {
  version: typeof TASK_CHANGE_SUMMARY_CACHE_SCHEMA_VERSION;
  teamName: string;
  taskId: string;
  stateBucket: Extract<TaskChangeStateBucket, 'approved' | 'completed'>;
  taskSignature: string;
  sourceFingerprint: string;
  projectFingerprint: string;
  writtenAt: string;
  expiresAt: string;
  extractorConfidence: PersistedTaskChangeExtractorConfidence;
  summary: TaskChangeSetV2;
  debugMeta?: {
    sourceCount?: number;
    projectPathHash?: string;
  };
}
