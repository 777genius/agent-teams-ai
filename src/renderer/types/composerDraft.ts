import type { InlineChip } from '@renderer/types/inlineChip';
import type {
  AgentActionMode,
  AttachmentPayload,
  CrossTeamSendRequest,
  SendMessageRequest,
} from '@shared/types';

export type ComposerDraftTarget =
  | { readonly kind: 'team-feed' }
  | { readonly kind: 'direct'; readonly participant: string }
  | {
      readonly kind: 'cross-team';
      readonly toTeam: string;
      readonly toMember: string | null;
    };

export interface ComposerDraftAddress {
  readonly contextId: string;
  readonly teamName: string;
  readonly target: ComposerDraftTarget;
}

export interface MessageRevisionContext {
  readonly kind: 'revision';
  readonly originalMessageId: string;
  readonly recipient: string;
  readonly requestId: string;
}

export type ComposerEditorContext = { readonly kind: 'plain' } | MessageRevisionContext;

export interface ComposerRestoredOrigin {
  readonly kind: 'unconfirmed-send';
  readonly attemptId: string;
  readonly messageId?: string;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly chips: InlineChip[];
  readonly attachments: AttachmentPayload[];
  readonly actionMode: AgentActionMode;
  readonly restoredOrigin?: ComposerRestoredOrigin;
}

export interface ComposerWorkingRecord {
  readonly version: 2;
  readonly address: ComposerDraftAddress;
  readonly workingRevision: string;
  readonly content: ComposerDraftContent | null;
  readonly editorContext: ComposerEditorContext;
  readonly updatedAt: number;
}

export interface ComposerWorkingSummary {
  readonly version: 1;
  readonly address: ComposerDraftAddress;
  readonly workingRevision: string;
  readonly updatedAt: number;
  readonly preview: string;
  readonly attachmentCount: number;
  readonly chipCount: number;
  readonly editorKind: ComposerEditorContext['kind'];
}

export interface ComposerWorkingIndexRecord {
  readonly version: 1;
  readonly summaries: ComposerWorkingSummary[];
}

export type ComposerPreparedRequest =
  | { readonly kind: 'local'; readonly teamName: string; readonly request: SendMessageRequest }
  | { readonly kind: 'cross-team'; readonly request: CrossTeamSendRequest };

export type ComposerRecoveryReason =
  | 'pending-send'
  | 'accepted-awaiting-echo'
  | 'unconfirmed-send'
  | 'not-sent'
  | 'displaced-draft'
  | 'legacy-draft';

export type ComposerAttemptOutcome =
  | { readonly kind: 'accepted'; readonly messageId?: string }
  | { readonly kind: 'unconfirmed'; readonly messageId?: string; readonly detail?: string }
  | { readonly kind: 'not-sent'; readonly detail: string };

export interface ComposerRecoveryRecord {
  readonly version: 2;
  readonly id: string;
  readonly address: ComposerDraftAddress | null;
  readonly snapshot: {
    readonly content: ComposerDraftContent;
    readonly editorContext: ComposerEditorContext;
  };
  readonly preparedRequest: ComposerPreparedRequest | null;
  readonly reason: ComposerRecoveryReason;
  readonly outcome?: ComposerAttemptOutcome;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ComposerRecoverySummary {
  readonly id: string;
  readonly address: ComposerDraftAddress | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reason: ComposerRecoveryReason;
  readonly preview: string;
  readonly legacy: boolean;
}

export interface PreparedComposerAttempt {
  readonly attemptId: string;
  readonly snapshot: ComposerRecoveryRecord['snapshot'];
  readonly preparedRequest: ComposerPreparedRequest;
  readonly recoveryReason?: ComposerRecoveryReason;
  readonly createdAt: number;
}

export type ComposerPersistenceStatus = 'durable' | 'memory-only';

export type SaveWorkingResult =
  | { readonly kind: 'saved'; readonly workingRevision: string; readonly status: ComposerPersistenceStatus }
  | {
      readonly kind: 'conflict';
      readonly currentWorkingRevision: string;
      readonly status: ComposerPersistenceStatus;
    }
  | { readonly kind: 'blocked'; readonly status: ComposerPersistenceStatus; readonly error: string };

export type BeginAttemptResult =
  | {
      readonly kind: 'prepared';
      readonly workingCleared: boolean;
      readonly currentWorkingRevision: string;
      readonly status: ComposerPersistenceStatus;
    }
  | { readonly kind: 'already-exists'; readonly status: ComposerPersistenceStatus }
  | { readonly kind: 'blocked'; readonly status: ComposerPersistenceStatus; readonly error: string };

export type RestoreRecoveryResult =
  | { readonly kind: 'restored'; readonly working: ComposerWorkingRecord; readonly status: ComposerPersistenceStatus }
  | { readonly kind: 'conflict' | 'missing' | 'active'; readonly status: ComposerPersistenceStatus }
  | { readonly kind: 'blocked'; readonly status: ComposerPersistenceStatus; readonly error: string };

export type ReconcileRecoveryResult =
  | 'reconciled'
  | 'missing'
  | 'mismatch'
  | 'blocked';

export interface ComposerDraftRepositoryEvent {
  readonly kind: 'working' | 'recoveries' | 'working-index' | 'attempt-state';
  readonly address?: ComposerDraftAddress;
  readonly contextId: string;
  readonly teamName: string;
}

export interface ComposerDraftRepository {
  loadWorking(address: ComposerDraftAddress): Promise<{
    working: ComposerWorkingRecord;
    status: ComposerPersistenceStatus;
    readError?: string;
    writeBlocked?: boolean;
  }>;
  saveWorking(
    address: ComposerDraftAddress,
    expectedRevision: string,
    nextRevision: string,
    content: ComposerDraftContent | null,
    editorContext: ComposerEditorContext
  ): Promise<SaveWorkingResult>;
  listWorkingSummaries(contextId: string, teamName: string): Promise<{
    summaries: ComposerWorkingSummary[];
    status: ComposerPersistenceStatus;
    readError?: string;
  }>;
  discardWorking(
    address: ComposerDraftAddress,
    expectedRevision: string
  ): Promise<'discarded' | 'missing' | 'conflict' | 'blocked'>;
  moveWorkingAsNew(
    source: ComposerDraftAddress,
    expectedSourceRevision: string,
    destination: ComposerDraftAddress,
    expectedDestinationRevision: string
  ): Promise<RestoreRecoveryResult>;
  discardNamespace(
    contextId: string,
    teamName: string
  ): Promise<'discarded' | 'blocked'>;
  beginAttempt(
    address: ComposerDraftAddress,
    expectedRevision: string,
    attempt: PreparedComposerAttempt
  ): Promise<BeginAttemptResult>;
  settleAttempt(
    address: ComposerDraftAddress,
    id: string,
    outcome: ComposerAttemptOutcome
  ): Promise<ComposerPersistenceStatus>;
  reconcileRecovery(
    contextId: string,
    teamName: string,
    id: string,
    expectedMessageId: string
  ): Promise<ReconcileRecoveryResult>;
  stashWorking(
    address: ComposerDraftAddress,
    expectedRevision: string,
    id: string
  ): Promise<RestoreRecoveryResult>;
  listRecoveries(contextId: string, teamName: string): Promise<{
    recoveries: ComposerRecoverySummary[];
    status: ComposerPersistenceStatus;
    readError?: string;
  }>;
  loadRecovery(
    contextId: string,
    teamName: string,
    id: string
  ): Promise<ComposerRecoveryRecord | null>;
  restoreRecovery(
    sourceContextId: string,
    sourceTeamName: string,
    id: string,
    destination: ComposerDraftAddress,
    expectedDestinationRevision: string,
    options?: { readonly asNewMessage?: boolean }
  ): Promise<RestoreRecoveryResult>;
  discardRecovery(
    contextId: string,
    teamName: string,
    id: string
  ): Promise<'discarded' | 'missing' | 'active' | 'blocked'>;
  subscribe(listener: (event: ComposerDraftRepositoryEvent) => void): () => void;
  isAttemptActive(id: string): boolean;
  setAttemptActive(id: string, active: boolean, address?: ComposerDraftAddress): void;
}

export const PLAIN_COMPOSER_CONTEXT: ComposerEditorContext = { kind: 'plain' };

export function isComposerContentEmpty(content: ComposerDraftContent | null): boolean {
  return (
    content == null ||
    (content.text.length === 0 && content.chips.length === 0 && content.attachments.length === 0)
  );
}
