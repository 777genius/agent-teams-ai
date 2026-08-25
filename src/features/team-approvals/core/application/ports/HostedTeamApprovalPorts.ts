import type {
  HostedTeamApprovalDecision,
  HostedTeamApprovalDecisionCommand,
  HostedTeamApprovalDecisionReceipt,
  HostedTeamApprovalGeneration,
  HostedTeamApprovalId,
  HostedTeamApprovalItem,
  HostedTeamApprovalPreviewRef,
} from '../../../contracts/hosted';
import type { Cursor, QueryContext, RunId, TeamId } from '@shared/contracts/hosted';

export interface HostedTeamApprovalPageSourceRequest {
  readonly teamId: TeamId;
  readonly expectedRunId: RunId;
  readonly cursor: Cursor | null;
  readonly itemLimit: number;
  readonly byteLimit: number;
  readonly deadlineAtMs: number;
}

export interface HostedTeamApprovalPageCandidate {
  readonly item: HostedTeamApprovalItem;
  readonly cursorAfter: Cursor;
}

export type HostedTeamApprovalPageSourceResult =
  | {
      readonly kind: 'found';
      readonly teamId: TeamId;
      readonly candidates: readonly HostedTeamApprovalPageCandidate[];
      readonly hasMore: boolean;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedTeamApprovalPageSourcePort {
  readPage(
    request: HostedTeamApprovalPageSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPageSourceResult>;
}

export interface HostedTeamApprovalPreviewSourceRequest {
  readonly teamId: TeamId;
  readonly expectedRunId: RunId;
  readonly approvalId: HostedTeamApprovalId;
  readonly expectedGeneration: HostedTeamApprovalGeneration;
  readonly previewRef: HostedTeamApprovalPreviewRef;
  readonly byteLimit: number;
  readonly deadlineAtMs: number;
}

export type HostedTeamApprovalPreviewSourceResult =
  | {
      readonly kind: 'found';
      readonly preview: {
        readonly teamId: TeamId;
        readonly runId: RunId;
        readonly approvalId: HostedTeamApprovalId;
        readonly generation: HostedTeamApprovalGeneration;
        readonly content: string;
        readonly byteLength: number;
        readonly truncated: boolean;
        readonly isBinary: boolean;
      };
    }
  | {
      readonly kind: 'stale_generation';
      readonly currentGeneration: HostedTeamApprovalGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedTeamApprovalPreviewSourcePort {
  readPreview(
    request: HostedTeamApprovalPreviewSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPreviewSourceResult>;
}

export type HostedTeamApprovalDecisionAdmissionResult =
  | {
      readonly kind: 'committed' | 'idempotent_replay';
      readonly receipt: HostedTeamApprovalDecisionReceipt;
    }
  | {
      readonly kind: 'already_resolved';
      readonly generation: HostedTeamApprovalGeneration;
      readonly decision: HostedTeamApprovalDecision;
    }
  | {
      readonly kind: 'stale_generation';
      readonly currentGeneration: HostedTeamApprovalGeneration;
    }
  | { readonly kind: 'conflict'; readonly reason: 'idempotency_mismatch' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/** Owns atomic generation compare, idempotency matching, one-decision claim, and audit commit. */
export interface HostedTeamApprovalDecisionAdmissionPort {
  admit(
    command: HostedTeamApprovalDecisionCommand,
    context: QueryContext
  ): Promise<HostedTeamApprovalDecisionAdmissionResult>;
}

export interface HostedTeamApprovalClockPort {
  now(): number;
}
