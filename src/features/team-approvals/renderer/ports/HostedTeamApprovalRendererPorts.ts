import type {
  HostedTeamApprovalDecision,
  HostedTeamApprovalDecisionReceipt,
  HostedTeamApprovalId,
  HostedTeamApprovalIdempotencyKey,
  HostedTeamApprovalItem,
  HostedTeamApprovalPreview,
} from '../../contracts';
import type { HostedTeamApprovalTransport } from './HostedTeamApprovalTransportPorts';
import type { Cursor } from '@shared/contracts/hosted';

export type HostedTeamApprovalRendererLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface HostedTeamApprovalRendererPendingDecision {
  readonly approvalId: HostedTeamApprovalId;
  readonly decision: HostedTeamApprovalDecision;
  readonly generation: HostedTeamApprovalItem['generation'];
}

export interface HostedTeamApprovalRendererFocusRequest {
  readonly sequence: number;
  readonly approvalId: HostedTeamApprovalId | null;
}

export interface HostedTeamApprovalRendererState {
  readonly mounted: boolean;
  readonly items: readonly HostedTeamApprovalItem[];
  readonly nextCursor: Cursor | null;
  readonly pageStatus: HostedTeamApprovalRendererLoadStatus;
  readonly pageError: string | null;
  readonly selectedApprovalId: HostedTeamApprovalId | null;
  readonly preview: HostedTeamApprovalPreview | null;
  readonly previewStatus: HostedTeamApprovalRendererLoadStatus;
  readonly previewError: string | null;
  readonly pendingDecision: HostedTeamApprovalRendererPendingDecision | null;
  readonly decisionReceipt: HostedTeamApprovalDecisionReceipt | null;
  readonly decisionError: string | null;
  readonly focusRequest: HostedTeamApprovalRendererFocusRequest | null;
}

export interface HostedTeamApprovalRendererSlice {
  getSnapshot(): HostedTeamApprovalRendererState;
  subscribe(listener: () => void): () => void;
  mount(): () => void;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
  selectApproval(approvalId: HostedTeamApprovalId | null): Promise<void>;
  allow(): Promise<void>;
  deny(): Promise<void>;
}

export interface HostedTeamApprovalRendererRefreshPort {
  subscribe(listener: () => void): () => void;
}

export interface HostedTeamApprovalRendererReconnectPort {
  subscribe(listener: () => void): () => void;
}

export interface HostedTeamApprovalIdempotencyKeyPort {
  create(input: {
    readonly approvalId: HostedTeamApprovalId;
    readonly decision: HostedTeamApprovalDecision;
    readonly generation: HostedTeamApprovalItem['generation'];
  }): HostedTeamApprovalIdempotencyKey;
}

export interface HostedTeamApprovalRendererSliceDependencies {
  readonly teamId: HostedTeamApprovalItem['teamId'];
  readonly transport: HostedTeamApprovalTransport;
  readonly refresh: HostedTeamApprovalRendererRefreshPort;
  readonly reconnect: HostedTeamApprovalRendererReconnectPort;
  readonly idempotencyKeys: HostedTeamApprovalIdempotencyKeyPort;
  readonly pageLimit?: number;
  /** Bounded authoritative refresh used when no push channel is available. */
  readonly pollIntervalMs?: number;
}
