import type {
  ReviewWriterRequest,
  ReviewWriterResponse,
  ReviewOriginScope,
} from '@agent-teams/task-change-ledger/review-transport';
import type { TeamBinding } from './contracts.js';
export interface ReviewCommandReceipt {
  schemaVersion: 1;
  family: 'review';
  binding: TeamBinding;
  commandId: string;
  principalId: string;
  method: ReviewWriterRequest['method'];
  origin: ReviewOriginScope;
  requestDigest: string;
  fingerprint: string;
  authorityRevision: number;
  createdAt: string;
  phase: 'prepared' | 'held' | 'completed';
  /** Existing portable writer response, never an instruction to replay its effects. */
  response?: ReviewWriterResponse;
  responseDigest?: string;
  responseRef?: { sha256: string; sizeBytes: number };
  recoveryScopeRef?: { sha256: string; sizeBytes: number };
  commitProof?: { walId: string; kind: string; decisionRevision: number; actionId?: string };
  references?: { actionId?: string; decisionRevision?: number; walId?: string };
}
export type { ReviewCommandLookup } from '@agent-teams/task-change-ledger/review-transport';
