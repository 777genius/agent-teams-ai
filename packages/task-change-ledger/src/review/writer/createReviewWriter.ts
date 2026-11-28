import { createReviewCommandJournal } from './reviewCommandJournal.js';
import { captureReviewApplier } from './captureReviewApplier.js';
import { ReviewDecisionStore } from '../storage/ReviewDecisionStore.js';
import { ReviewDraftHistoryStore } from '../storage/ReviewDraftHistoryStore.js';
import { ReviewMutationJournalStore } from '../storage/ReviewMutationJournalStore.js';
import { createReviewPersistenceLocks } from '../storage/ReviewPersistenceScopeLock.js';
import { ReviewMutationCoordinator } from './ReviewMutationCoordinator.js';
import type { ReviewWriterOptions, ReviewWriterContext } from './ports.js';
import {
  handleCheckConflict,
  handleRejectHunks,
  handleRejectFile,
  handlePreviewReject,
} from './reject.js';
import { handleApplyDecisions } from './apply.js';
import { handleExecuteReviewMutation, handleRestoreReviewHistory } from './historyMutations.js';
import {
  handleGetFileContent,
  handleSaveEditedFile,
  handleDeleteEditedFile,
  handleRestoreRejectedRename,
  handleReapplyRejectedRename,
} from './contentMutations.js';
import { handleRetryReviewMutationRecovery } from './recovery.js';
import {
  handleLoadDecisions,
  handleLoadDecisionConflictCandidates,
  handleResolveDecisionConflictCandidate,
  handleSaveDecisions,
  handleClearDecisions,
} from './decisions.js';
import {
  handleLoadDraftHistory,
  handleLoadDraftHistoryConflictCandidates,
  handleResolveDraftHistoryConflictCandidate,
  handleReplaceDraftHistoryConflictCandidate,
  handleSaveDraftHistoryEntry,
  handleClearDraftHistory,
} from './drafts.js';

/** One captured owner owns every review token, queue, persistence root and mutation protocol. */
export function createReviewWriter(options: ReviewWriterOptions) {
  const captured = {
    ...options,
    commandReceipts: options.commandReceipts
      ? {
          capture: options.commandReceipts.capture.bind(options.commandReceipts),
          committed: options.commandReceipts.committed.bind(options.commandReceipts),
          uncertain: options.commandReceipts.uncertain?.bind(options.commandReceipts),
        }
      : undefined,
    authorization: {
      ...options.authorization,
      assertTeam: options.authorization.assertTeam.bind(options.authorization),
      getConfig: options.authorization.getConfig.bind(options.authorization),
      assertCurrent: options.authorization.assertCurrent?.bind(options.authorization),
    },
    changes: {
      getTaskChanges: options.changes.getTaskChanges.bind(options.changes),
      getAgentChanges: options.changes.getAgentChanges.bind(options.changes),
    },
    content: {
      getFileContent: options.content.getFileContent.bind(options.content),
      invalidateFile: options.content.invalidateFile.bind(options.content),
    },
    events: options.events
      ? { invalidateFile: options.events.invalidateFile.bind(options.events) }
      : undefined,
  };
  const logger = captured.logger ?? { debug() {}, warn() {}, error() {} };
  let disposed = false;
  const assertActive = () => {
    if (disposed) throw new Error('Review writer is disposed');
    captured.authorization.assertCurrent?.();
  };
  const authorization = {
    ...captured.authorization,
    async getConfig(teamName: string) {
      assertActive();
      captured.authorization.assertTeam(teamName);
      const result = await captured.authorization.getConfig(teamName);
      assertActive();
      return result;
    },
  };
  const journal = new ReviewMutationJournalStore(captured.teamsRoot);
  const decisions = new ReviewDecisionStore(captured.teamsRoot, logger);
  const content = {
    getFileContent: captured.content.getFileContent.bind(captured.content),
    invalidateFile(filePath: string) {
      captured.content.invalidateFile(filePath);
      captured.events?.invalidateFile(filePath);
    },
  };
  const env: ReviewWriterContext = {
    markStandaloneUncertain() {
      assertActive();
      captured.commandReceipts?.uncertain?.();
    },
    changes: captured.changes,
    content,
    authorization,
    applier: captureReviewApplier(captured.applier),
    assertActive,
    decisions,
    drafts: new ReviewDraftHistoryStore(captured.teamsRoot, logger),
    journal,
    coordinator: new ReviewMutationCoordinator(
      createReviewCommandJournal(journal, decisions, captured.commandReceipts, assertActive)
    ),
    locks: createReviewPersistenceLocks(captured.teamsRoot, captured.processStartProbe),
    queues: new Map(),
    snapshots: new Map(),
    logger,
  };
  const guard =
    <A extends unknown[], R>(action: (...args: A) => Promise<R>, resolveTeam = true) =>
    async (...args: A): Promise<R> => {
      assertActive();
      const input = args[0];
      const scope = input && typeof input === 'object' && 'scope' in input ? input.scope : input;
      const team =
        typeof scope === 'string'
          ? scope
          : scope && typeof scope === 'object' && 'teamName' in scope
            ? scope.teamName
            : undefined;
      if (resolveTeam && typeof team === 'string') captured.authorization.assertTeam(team);
      const result = await action(...args);
      assertActive();
      return result;
    };
  return {
    checkConflict: guard(handleCheckConflict.bind(null, env)),
    rejectHunks: guard(handleRejectHunks.bind(null, env)),
    rejectFile: guard(handleRejectFile.bind(null, env)),
    previewReject: guard(handlePreviewReject.bind(null, env), false),
    applyDecisions: guard(handleApplyDecisions.bind(null, env)),
    executeReviewMutation: guard(handleExecuteReviewMutation.bind(null, env)),
    restoreReviewHistory: guard(handleRestoreReviewHistory.bind(null, env)),
    getFileContent: guard(handleGetFileContent.bind(null, env)),
    saveEditedFile: guard(handleSaveEditedFile.bind(null, env)),
    deleteEditedFile: guard(handleDeleteEditedFile.bind(null, env)),
    restoreRejectedRename: guard(handleRestoreRejectedRename.bind(null, env)),
    reapplyRejectedRename: guard(handleReapplyRejectedRename.bind(null, env)),
    retryReviewMutationRecovery: guard(handleRetryReviewMutationRecovery.bind(null, env)),
    loadDecisions: guard(handleLoadDecisions.bind(null, env)),
    loadDecisionConflictCandidates: guard(handleLoadDecisionConflictCandidates.bind(null, env)),
    resolveDecisionConflictCandidate: guard(handleResolveDecisionConflictCandidate.bind(null, env)),
    saveDecisions: guard(handleSaveDecisions.bind(null, env)),
    clearDecisions: guard(handleClearDecisions.bind(null, env)),
    loadDraftHistory: guard(handleLoadDraftHistory.bind(null, env)),
    loadDraftHistoryConflictCandidates: guard(
      handleLoadDraftHistoryConflictCandidates.bind(null, env)
    ),
    resolveDraftHistoryConflictCandidate: guard(
      handleResolveDraftHistoryConflictCandidate.bind(null, env)
    ),
    replaceDraftHistoryConflictCandidate: guard(
      handleReplaceDraftHistoryConflictCandidate.bind(null, env)
    ),
    saveDraftHistoryEntry: guard(handleSaveDraftHistoryEntry.bind(null, env)),
    clearDraftHistory: guard(handleClearDraftHistory.bind(null, env)),
    dispose() {
      disposed = true;
      env.snapshots.clear();
    },
  };
}

export type ReviewWriter = ReturnType<typeof createReviewWriter>;
