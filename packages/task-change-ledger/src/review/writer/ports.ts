import type { ReviewCommandReceiptObserver } from './reviewCommandJournal.js';
import type {
  AgentChangeSet,
  TaskChangeSetV2,
  FileChangeWithContent,
  SnippetDiff,
} from '../../contracts.js';
import type { ReviewApplier } from '../apply/ReviewApplier.js';
import type { ReviewDecisionStore } from '../storage/ReviewDecisionStore.js';
import type { ReviewDraftHistoryStore } from '../storage/ReviewDraftHistoryStore.js';
import type {
  ReviewMutationJournalStore,
  ReviewMutationJournalRecord,
  PrepareReviewMutationInput,
} from '../storage/ReviewMutationJournalStore.js';
import type {
  createReviewPersistenceLocks,
  ReviewProcessStartProbe,
} from '../storage/ReviewPersistenceScopeLock.js';
import type { ReviewMutationCoordinator } from './ReviewMutationCoordinator.js';
import type { DisplayedReviewSnapshot } from './displayedSnapshots.js';

export interface ReviewConfiguredTeam {
  projectPath?: unknown;
  members?: readonly { cwd?: unknown }[];
}

export interface ReviewChangesPort {
  getTaskChanges(teamName: string, taskId: string): Promise<TaskChangeSetV2>;
  getAgentChanges(teamName: string, memberName: string): Promise<AgentChangeSet>;
}

export interface ReviewContentPort {
  getFileContent(
    teamName: string,
    memberName: string,
    filePath: string,
    snippets: SnippetDiff[]
  ): Promise<FileChangeWithContent>;
  invalidateFile(filePath: string): void;
}

export interface ReviewAuthorizationPort {
  /** Must reject a Team outside the immutable captured owner; never selects a replacement. */
  assertTeam(teamName: string): void;
  assertCurrent?(): void;
  getConfig(teamName: string): Promise<ReviewConfiguredTeam | null>;
}

export interface ReviewWriterLogger {
  debug(message: string, ...values: unknown[]): void;
  warn(message: string, ...values: unknown[]): void;
  error(message: string, ...values: unknown[]): void;
}

export type ReviewApplierPort = Pick<ReviewApplier, keyof ReviewApplier>;

export interface ReviewWriterOptions {
  teamsRoot: string;
  commandReceipts?: ReviewCommandReceiptObserver;
  changes: ReviewChangesPort;
  content: ReviewContentPort;
  authorization: ReviewAuthorizationPort;
  applier?: ReviewApplierPort | null;
  processStartProbe: ReviewProcessStartProbe;
  logger?: ReviewWriterLogger;
  events?: { invalidateFile(filePath: string): void };
}

export interface ReviewWriterContext {
  markStandaloneUncertain?: () => void;
  assertActive(): void;
  changes: ReviewChangesPort;
  content: ReviewContentPort;
  authorization: ReviewAuthorizationPort;
  applier: Pick<ReviewApplier, keyof ReviewApplier>;
  decisions: ReviewDecisionStore;
  drafts: ReviewDraftHistoryStore;
  journal: ReviewMutationJournalStore;
  coordinator: ReviewMutationCoordinator<ReviewMutationJournalRecord, PrepareReviewMutationInput>;
  locks: ReturnType<typeof createReviewPersistenceLocks>;
  queues: Map<string, Promise<void>>;
  snapshots: Map<string, DisplayedReviewSnapshot>;
  logger: ReviewWriterLogger;
}
