import React, { useMemo } from 'react';

import {
  buildChangeReviewTitle,
  buildReviewChangeStats,
  buildReviewStats,
  ChangeReviewConflictDiscardDialog,
  ChangeReviewConflictNotices,
  ChangeReviewSidebar,
  shouldShowTaskScopeBanner,
  TaskChangesEmptyState,
  toTaskChangeSetV2,
} from '@features/change-review/renderer';
import { EditorSelectionMenu } from '@renderer/components/team/editor/EditorSelectionMenu';
import { buildSelectionAction } from '@renderer/utils/buildSelectionAction';
import { X } from 'lucide-react';

import { ChangesLoadingAnimation } from './ChangesLoadingAnimation';
import { ContinuousScrollView } from './ContinuousScrollView';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { buildPathChangeLabels } from './pathChangeLabels';
import { ReviewToolbar } from './ReviewToolbar';
import { SavedReviewStateRecoveryGate } from './SavedReviewStateRecoveryGate';
import { ScopeWarningBanner } from './ScopeWarningBanner';
import { ViewedProgressBar } from './ViewedProgressBar';

import type { ChangeReviewDecisionActions } from './useChangeReviewDecisionActions';
import type {
  ChangeReviewActionHistoryController,
  ChangeReviewConflictDiscoveryController,
  ChangeReviewConflictInteractionController,
  ChangeReviewDecisionPersistenceController,
  ChangeReviewDialogKeyboardInteractions,
  ChangeReviewDialogLifecycleController,
  ChangeReviewDialogViewState,
  ChangeReviewDraftHistoryController,
  ChangeReviewExternalChangeController,
  ChangeReviewFileDraftController,
  ChangeReviewHistoryMutationController,
  ChangeReviewMutationGuards,
  ChangeReviewOperationState,
  ReviewActionPersistenceStatus,
} from '@features/change-review/renderer';
import type {
  AgentChangeSet,
  GlobalTask,
  ReviewRedoAction,
  ReviewUndoAction,
  TaskChangeSet,
  TaskChangeSetV2,
} from '@shared/types';
import type { EditorSelectionAction } from '@shared/types/editor';

type ContinuousScrollProps = React.ComponentProps<typeof ContinuousScrollView>;
type ReviewChangeSet = AgentChangeSet | TaskChangeSet | TaskChangeSetV2;

interface ChangeReviewDialogHydrationViewState {
  decisionKey: string | null;
  decisionReady: boolean;
  decisionPending: boolean;
  decisionFailed: boolean;
  draftReady: boolean;
  draftPending: boolean;
  draftFailed: boolean;
}

interface ChangeReviewDialogViewProps {
  open: boolean;
  teamName: string;
  mode: 'agent' | 'task';
  memberName: string | undefined;
  taskId: string | undefined;
  globalTasks: GlobalTask[];
  activeChangeSet: ReviewChangeSet | null;
  changeSetLoading: boolean;
  changeSetError: string | null;
  fileContents: ContinuousScrollProps['fileContents'];
  fileContentsLoading: ContinuousScrollProps['fileContentsLoading'];
  hunkDecisions: ContinuousScrollProps['hunkDecisions'];
  fileDecisions: ContinuousScrollProps['fileDecisions'];
  fileChunkCounts: Record<string, number>;
  hunkContextHashesByFile: ContinuousScrollProps['hunkContextHashesByFile'];
  editedContents: ContinuousScrollProps['editedContents'];
  reviewExternalChangesByFile: ContinuousScrollProps['reviewExternalChangesByFile'];
  collapseUnchanged: boolean;
  setCollapseUnchanged: (collapse: boolean) => void;
  applyError: string | null;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  reviewActionPersistenceStatus: ReviewActionPersistenceStatus;
  isMacElectron: boolean;
  hydration: ChangeReviewDialogHydrationViewState;
  canAcceptAll: boolean;
  canRejectAll: boolean;
  instantApply: boolean;
  editedCount: number;
  discardCounters: ContinuousScrollProps['discardCounters'];
  fetchFileContent: ContinuousScrollProps['fetchFileContent'];
  onEditorAction: ((action: EditorSelectionAction) => void) | undefined;
  actionHistory: ChangeReviewActionHistoryController;
  conflictDiscovery: ChangeReviewConflictDiscoveryController;
  conflictInteraction: ChangeReviewConflictInteractionController;
  decisionPersistence: ChangeReviewDecisionPersistenceController;
  decisionActions: ChangeReviewDecisionActions;
  dialogLifecycle: ChangeReviewDialogLifecycleController;
  dialogViewState: ChangeReviewDialogViewState;
  draftHistory: ChangeReviewDraftHistoryController;
  externalChange: ChangeReviewExternalChangeController;
  fileDraftActions: ChangeReviewFileDraftController;
  historyMutation: ChangeReviewHistoryMutationController;
  keyboard: ChangeReviewDialogKeyboardInteractions;
  mutationGuards: ChangeReviewMutationGuards;
  operation: ChangeReviewOperationState;
}

export const ChangeReviewDialogView = ({
  open,
  teamName,
  mode,
  memberName,
  taskId,
  globalTasks,
  activeChangeSet,
  changeSetLoading,
  changeSetError,
  fileContents,
  fileContentsLoading,
  hunkDecisions,
  fileDecisions,
  fileChunkCounts,
  hunkContextHashesByFile,
  editedContents,
  reviewExternalChangesByFile,
  collapseUnchanged,
  setCollapseUnchanged,
  applyError,
  reviewActionHistory,
  reviewRedoHistory,
  reviewActionPersistenceStatus,
  isMacElectron,
  hydration,
  canAcceptAll,
  canRejectAll,
  instantApply,
  editedCount,
  discardCounters,
  fetchFileContent,
  onEditorAction,
  actionHistory,
  conflictDiscovery,
  conflictInteraction,
  decisionPersistence,
  decisionActions,
  dialogLifecycle,
  dialogViewState,
  draftHistory,
  externalChange,
  fileDraftActions,
  historyMutation,
  keyboard,
  mutationGuards,
  operation,
}: ChangeReviewDialogViewProps): React.ReactElement | null => {
  const pathChangeLabels = useMemo(
    () => buildPathChangeLabels(activeChangeSet?.files ?? [], fileContents),
    [activeChangeSet, fileContents]
  );
  const reviewStats = useMemo(
    () =>
      buildReviewStats({
        changeSet: activeChangeSet,
        hunkDecisions,
        fileDecisions,
        fileChunkCounts,
      }),
    [activeChangeSet, hunkDecisions, fileDecisions, fileChunkCounts]
  );
  const changeStats = useMemo(() => buildReviewChangeStats(activeChangeSet), [activeChangeSet]);
  const taskChangeSet = toTaskChangeSetV2(activeChangeSet);
  const hasReviewFiles = (activeChangeSet?.files.length ?? 0) > 0;
  const shouldShowScopeBanner = shouldShowTaskScopeBanner({ mode, changeSet: taskChangeSet });
  const title = useMemo(
    () => buildChangeReviewTitle({ mode, memberName, taskId, globalTasks }),
    [globalTasks, memberName, mode, taskId]
  );
  if (!open) return null;

  const {
    activeFile,
    activeFilePath,
    autoViewed,
    clearSelection,
    collapsedFiles,
    containerRect,
    diffContentRef,
    editorViewMapRef,
    globalDiffLoadingState,
    handleFullyViewed,
    handleHistoryActionNavigation,
    handleSelectionChange,
    handleTreeFileClick,
    handleVisibleFileChange,
    isProgrammaticScroll,
    resolveReviewFileLabel,
    scrollContainerRef,
    selectionInfo,
    setAutoViewed,
    setTimelineOpen,
    sortedFiles,
    timelineOpen,
    toggleCollapsedFile,
    viewedCount,
    viewedProgress,
    viewedSet,
    viewedTotalCount,
  } = dialogViewState;
  const { diffNav, reviewHunkOrder } = keyboard;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div
        className="flex items-center justify-between border-b border-border bg-surface-sidebar px-4 py-3"
        style={
          {
            paddingLeft: isMacElectron
              ? 'var(--macos-traffic-light-padding-left, 72px)'
              : undefined,
            WebkitAppRegion: isMacElectron ? 'drag' : undefined,
          } as React.CSSProperties
        }
      >
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-text">{title}</h2>
          {activeChangeSet && (
            <ViewedProgressBar
              viewed={viewedCount}
              total={viewedTotalCount}
              progress={viewedProgress}
            />
          )}
        </div>
        <button
          type="button"
          aria-label="Close Changes"
          onClick={() => void dialogLifecycle.requestClose()}
          disabled={
            mutationGuards.reviewCloseBusy || hydration.decisionPending || hydration.draftPending
          }
          className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <X className="size-4" />
        </button>
      </div>

      <KeyboardShortcutsHelp
        open={diffNav.showShortcutsHelp}
        onOpenChange={diffNav.setShowShortcutsHelp}
      />

      <ChangeReviewConflictDiscardDialog
        pendingDiscard={conflictInteraction.pendingDiscard}
        resolvingCandidateId={conflictInteraction.resolvingCandidateId}
        onOpenChange={conflictInteraction.onDiscardOpenChange}
        onConfirm={conflictInteraction.confirmPendingDiscard}
      />

      {!changeSetLoading &&
        !changeSetError &&
        hydration.decisionReady &&
        hydration.draftReady &&
        activeChangeSet &&
        hasReviewFiles && (
          <ReviewToolbar
            stats={reviewStats}
            changeStats={changeStats}
            collapseUnchanged={collapseUnchanged}
            applying={mutationGuards.reviewActionsBusy}
            autoViewed={autoViewed}
            onAutoViewedChange={setAutoViewed}
            onAcceptAll={decisionActions.acceptAll}
            onRejectAll={decisionActions.rejectAll}
            onApply={dialogLifecycle.apply}
            onCollapseUnchangedChange={setCollapseUnchanged}
            canAcceptAll={canAcceptAll}
            canRejectAll={canRejectAll}
            instantApply={instantApply}
            editedCount={editedCount}
            canUndo={actionHistory.undoDepth > 0}
            onUndo={() => void historyMutation.undoLatest()}
            canRedo={actionHistory.redoDepth > 0}
            onRedo={() => void historyMutation.redoLatest()}
            mutationBlocked={externalChange.reviewMutationBlockedByExternalChange}
            undoHistory={reviewActionHistory}
            redoHistory={reviewRedoHistory}
            resolveFileLabel={resolveReviewFileLabel}
            historyPersistenceStatus={
              mutationGuards.reviewMutationBusy ? 'saving' : reviewActionPersistenceStatus
            }
            onRetryHistoryPersistence={() => void decisionPersistence.persistLatest()}
            onNavigateToHistoryAction={handleHistoryActionNavigation}
            onRestoreHistory={historyMutation.restoreHistory}
            onRecoverFailedRestore={historyMutation.recoverFailedHistory}
            getRestoreHistoryPreview={historyMutation.getRestorePreview}
            restoreHistoryDisabled={
              mutationGuards.reviewActionsBusy ||
              editedCount > 0 ||
              externalChange.reviewMutationBlockedByExternalChange ||
              reviewActionPersistenceStatus !== 'saved'
            }
            undoDisabledReason={
              editedCount > 0
                ? 'Save or discard manual edits before undoing a review action.'
                : undefined
            }
            redoDisabledReason={
              editedCount > 0
                ? 'Save or discard manual edits before redoing a review action.'
                : undefined
            }
          />
        )}

      {shouldShowScopeBanner && taskChangeSet && (
        <ScopeWarningBanner
          warnings={taskChangeSet.warnings}
          confidence={taskChangeSet.scope.confidence}
          sourceKind={taskChangeSet.provenance?.sourceKind}
        />
      )}

      <ChangeReviewConflictNotices
        loadError={conflictDiscovery.loadError}
        refreshPending={conflictDiscovery.refreshPending}
        activeCandidate={conflictInteraction.activeCandidate}
        activeCandidateRecoverable={conflictInteraction.activeCandidateRecoverable}
        candidateCount={conflictDiscovery.candidateCount}
        resolvingCandidateId={conflictInteraction.resolvingCandidateId}
        onRetry={conflictDiscovery.refresh}
        onRequestDiscard={conflictInteraction.requestDiscard}
        onRecover={() => conflictInteraction.resolveActiveCandidate('recover-candidate')}
      />

      {applyError && (
        <div
          role="alert"
          className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-400"
        >
          {applyError}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {(changeSetLoading || hydration.decisionPending || hydration.draftPending) && (
          <ChangesLoadingAnimation />
        )}

        {changeSetError && (
          <div className="flex w-full items-center justify-center text-sm text-red-400">
            {changeSetError}
          </div>
        )}

        {!changeSetLoading &&
          !changeSetError &&
          hydration.decisionReady &&
          hydration.draftReady &&
          activeChangeSet &&
          hasReviewFiles && (
            <>
              <ChangeReviewSidebar
                files={activeChangeSet.files}
                pathChangeLabels={pathChangeLabels}
                decisionState={{ hunkDecisions, fileDecisions, fileChunkCounts }}
                activeFilePath={activeFilePath}
                viewedSet={viewedSet}
                onSelectFile={handleTreeFileClick}
                timeline={activeFile?.timeline ?? null}
                timelineOpen={timelineOpen}
                onToggleTimeline={() => setTimelineOpen(!timelineOpen)}
                onTimelineEventClick={(index) => diffNav.goToHunk(index)}
                activeSnippetIndex={diffNav.currentHunkIndex}
              />

              <div
                ref={diffContentRef}
                className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <ContinuousScrollView
                  files={sortedFiles}
                  fileContents={fileContents}
                  fileContentsLoading={fileContentsLoading}
                  globalDiffLoadingState={globalDiffLoadingState}
                  reviewExternalChangesByFile={reviewExternalChangesByFile}
                  viewedSet={viewedSet}
                  editedContents={editedContents}
                  draftHistoryEntries={draftHistory.entries}
                  hunkDecisions={hunkDecisions}
                  fileDecisions={fileDecisions}
                  hunkContextHashesByFile={hunkContextHashesByFile}
                  collapseUnchanged={collapseUnchanged}
                  applying={mutationGuards.reviewActionsBusy}
                  filesApplying={operation.filesApplying}
                  autoViewed={autoViewed}
                  discardCounters={discardCounters}
                  onHunkAccepted={decisionActions.acceptHunk}
                  onHunkRejected={decisionActions.rejectHunk}
                  onFullyViewed={handleFullyViewed}
                  onContentChanged={fileDraftActions.contentChanged}
                  onSerializedStateChanged={draftHistory.handleSerializedStateChanged}
                  onSerializedStateRestoreError={draftHistory.handleSerializedStateRestoreError}
                  onDiscard={fileDraftActions.discardFile}
                  onSave={fileDraftActions.saveFile}
                  onReloadFromDisk={fileDraftActions.reloadFromDisk}
                  onKeepDraft={fileDraftActions.keepDraft}
                  onAcceptFile={decisionActions.acceptFile}
                  onRejectFile={decisionActions.rejectFile}
                  onRestoreMissingFile={fileDraftActions.restoreMissingFile}
                  pathChangeLabels={pathChangeLabels}
                  collapsedFiles={collapsedFiles}
                  onToggleCollapse={toggleCollapsedFile}
                  onVisibleFileChange={handleVisibleFileChange}
                  scrollContainerRef={scrollContainerRef}
                  editorViewMapRef={editorViewMapRef}
                  isProgrammaticScroll={isProgrammaticScroll}
                  teamName={teamName}
                  memberName={memberName}
                  fetchFileContent={fetchFileContent}
                  onSelectionChange={onEditorAction ? handleSelectionChange : undefined}
                  globalHunkOffsets={reviewHunkOrder.offsets}
                  totalReviewHunks={reviewHunkOrder.total}
                />
                {selectionInfo && onEditorAction && (
                  <EditorSelectionMenu
                    info={selectionInfo}
                    containerRect={containerRect}
                    onSendMessage={() => {
                      onEditorAction(buildSelectionAction('sendMessage', selectionInfo));
                      clearSelection();
                    }}
                    onCreateTask={() => {
                      onEditorAction(buildSelectionAction('createTask', selectionInfo));
                      clearSelection();
                    }}
                  />
                )}
              </div>
            </>
          )}

        {!changeSetLoading &&
          !changeSetError &&
          hydration.decisionReady &&
          hydration.draftReady &&
          activeChangeSet &&
          !hasReviewFiles && <TaskChangesEmptyState changeSet={taskChangeSet} />}

        {(hydration.decisionFailed || hydration.draftFailed) && (
          <SavedReviewStateRecoveryGate
            key={hydration.decisionKey ?? 'unscoped'}
            decisionStateUnreadable={hydration.decisionFailed}
            draftHistoryUnreadable={hydration.draftFailed}
            busy={mutationGuards.reviewMutationBusy}
            onRetry={() => void dialogLifecycle.retrySavedReviewState()}
            onDiscard={dialogLifecycle.discardSavedDecisionState}
          />
        )}
      </div>
    </div>
  );
};
