import * as interactionAdapters from './adapters/changeReviewDialogInteractionAdapters';
import * as actionHistoryAdapters from './adapters/createChangeReviewActionHistoryPorts';
import * as bulkDecisionAdapters from './adapters/createChangeReviewBulkDecisionPorts';
import * as conflictAdapters from './adapters/createChangeReviewConflictPorts';
import * as conflictStateAdapters from './adapters/createChangeReviewConflictStateBridge';
import * as lifecycleAdapters from './adapters/createChangeReviewDialogLifecyclePorts';
import * as dialogViewAdapters from './adapters/createChangeReviewDialogViewPorts';
import * as draftHistoryAdapters from './adapters/createChangeReviewDraftHistoryPort';
import * as fileDecisionAdapters from './adapters/createChangeReviewFileDecisionPorts';
import * as fileDraftAdapters from './adapters/createChangeReviewFileDraftPorts';
import * as historyMutationAdapters from './adapters/createChangeReviewHistoryMutationPorts';
import * as hunkDecisionAdapters from './adapters/createChangeReviewHunkDecisionPorts';

import type {
  ChangeReviewActionHistoryStorePort,
  ChangeReviewDecisionPersistencePort,
  ChangeReviewDecisionPersistenceSnapshot,
} from './ports/changeReviewActionHistoryPorts';
import type {
  ChangeReviewBulkDecisionCommandPort,
  ChangeReviewBulkDecisionEditorPort,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionStateSnapshot,
  ChangeReviewBulkDecisionStatusPort,
  ChangeReviewBulkDecisionWriteEvidencePort,
} from './ports/changeReviewBulkDecisionPorts';
import type {
  ChangeReviewConflictCommandPort,
  ChangeReviewConflictQueryPort,
} from './ports/changeReviewConflictPorts';
import type {
  ChangeReviewCollapsedFilesStoragePort,
  ChangeReviewDialogEditorActions,
  ChangeReviewDialogKeyboardInteractionPort,
  ChangeReviewExternalFileWatcherPort,
  ChangeReviewRecentWrite,
} from './ports/changeReviewDialogInteractionPorts';
import type {
  ChangeReviewDialogLifecycleCommandPort,
  ChangeReviewDialogLifecycleEditorPort,
  ChangeReviewDialogLifecycleSessionPort,
  ChangeReviewDialogLifecycleStatePort,
  ChangeReviewDialogLifecycleStateSnapshot,
  ChangeReviewDialogLifecycleStatusPort,
  ChangeReviewDialogLifecycleWriteEvidencePort,
} from './ports/changeReviewDialogLifecyclePorts';
import type { ChangeReviewDraftHistoryPort } from './ports/changeReviewDraftHistoryPort';
import type {
  ChangeReviewFileDecisionCommandPort,
  ChangeReviewFileDecisionEditorPort,
  ChangeReviewFileDecisionStatePort,
  ChangeReviewFileDecisionStateSnapshot,
  ChangeReviewFileDecisionStatusPort,
  ChangeReviewFileDecisionWriteEvidencePort,
} from './ports/changeReviewFileDecisionPorts';
import type {
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftStatePort,
  ChangeReviewFileDraftStateSnapshot,
  ChangeReviewFileDraftStatusPort,
  ChangeReviewFileDraftWriteEvidencePort,
} from './ports/changeReviewFileDraftPorts';
import type {
  ChangeReviewHistoryMutationCommandPort,
  ChangeReviewHistoryMutationStatePort,
  ChangeReviewHistoryMutationViewPort,
  ChangeReviewHistoryPersistenceScope,
  ChangeReviewHistoryStateSnapshot,
} from './ports/changeReviewHistoryMutationPorts';
import type {
  ChangeReviewHunkDecisionCommandPort,
  ChangeReviewHunkDecisionEditorPort,
  ChangeReviewHunkDecisionStatePort,
  ChangeReviewHunkDecisionStateSnapshot,
  ChangeReviewHunkDecisionStatusPort,
  ChangeReviewHunkDecisionWriteEvidencePort,
} from './ports/changeReviewHunkDecisionPorts';
import type { EditorView } from '@codemirror/view';
import type { ReviewSerializedEditorState } from '@features/change-review-history/contracts';
import type {
  ApplyReviewResult,
  FileChangeSummary,
  FileChangeWithContent,
  HunkDecision,
  ReviewDecisionSnapshot,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
} from '@shared/types';
import type { ReviewAPI } from '@shared/types/api';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

type ExternalFileReviewApi = Pick<
  ReviewAPI,
  'checkConflict' | 'onExternalFileChange' | 'unwatchFiles' | 'watchFiles'
>;

export function createChangeReviewExternalFileWatcherPort(
  getReviewApi: () => ExternalFileReviewApi
): ChangeReviewExternalFileWatcherPort {
  return interactionAdapters.createChangeReviewExternalFileWatcherPort(getReviewApi);
}

export const browserChangeReviewCollapsedFilesStorage: ChangeReviewCollapsedFilesStoragePort = {
  read: (storageKey) =>
    interactionAdapters.browserChangeReviewCollapsedFilesStorage.read(storageKey),
  write: (storageKey, filePaths) =>
    interactionAdapters.browserChangeReviewCollapsedFilesStorage.write(storageKey, filePaths),
};

interface ChangeReviewActionHistoryStore {
  setReviewActionHistory(history: ReviewUndoAction[]): void;
  setReviewRedoHistory(history: import('@shared/types').ReviewRedoAction[]): void;
}

interface CreateChangeReviewActionHistoryStorePortInput {
  getStore: () => ChangeReviewActionHistoryStore;
  clearLegacyUndoStack: () => void;
}

export function createChangeReviewActionHistoryStorePort(
  input: CreateChangeReviewActionHistoryStorePortInput
): ChangeReviewActionHistoryStorePort {
  return actionHistoryAdapters.createChangeReviewActionHistoryStorePort(input);
}

interface ChangeReviewDecisionPersistenceStore extends ChangeReviewDecisionPersistenceSnapshot {
  loadDecisionsFromDisk(teamName: string, scopeKey: string, scopeToken: string): Promise<void>;
  persistDecisions(teamName: string, scopeKey: string, scopeToken: string): void;
  flushDecisionsToDisk(teamName: string, scopeKey: string, scopeToken: string): Promise<boolean>;
  clearDecisionsFromDisk(teamName: string, scopeKey: string, scopeToken?: string): Promise<boolean>;
}

interface CreateChangeReviewDecisionPersistencePortInput {
  getStore: () => ChangeReviewDecisionPersistenceStore;
  setApplyError: (message: string | null) => void;
}

export function createChangeReviewDecisionPersistencePort(
  input: CreateChangeReviewDecisionPersistencePortInput
): ChangeReviewDecisionPersistencePort {
  return actionHistoryAdapters.createChangeReviewDecisionPersistencePort(input);
}

interface ChangeReviewBulkDecisionStore extends ChangeReviewBulkDecisionStateSnapshot {
  acceptAllFile(filePath: string): boolean;
  rejectAllFile(filePath: string): void;
  invalidateResolvedFileContent(filePath: string): void;
  applyReview(
    teamName: string,
    taskId?: string,
    memberName?: string
  ): ReturnType<ChangeReviewBulkDecisionCommandPort['applyReview']>;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
}

interface CreateChangeReviewBulkDecisionStatePortInput {
  getStore: () => ChangeReviewBulkDecisionStore;
  restoreDecisionSnapshot: (snapshot: ReviewDecisionSnapshot) => void;
}

export function createChangeReviewBulkDecisionStatePort(
  input: CreateChangeReviewBulkDecisionStatePortInput
): ChangeReviewBulkDecisionStatePort {
  return bulkDecisionAdapters.createChangeReviewBulkDecisionStatePort(input);
}

interface CreateChangeReviewBulkDecisionCommandPortInput {
  getStore: () => ChangeReviewBulkDecisionStore;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export function createChangeReviewBulkDecisionCommandPort(
  input: CreateChangeReviewBulkDecisionCommandPortInput
): ChangeReviewBulkDecisionCommandPort {
  return bulkDecisionAdapters.createChangeReviewBulkDecisionCommandPort(input);
}

type ReviewConflictQueryApi = Pick<
  ReviewAPI,
  'loadDecisionConflictCandidates' | 'loadDraftHistoryConflictCandidates'
>;
type ReviewConflictCommandApi = Pick<ReviewAPI, 'resolveDecisionConflictCandidate'>;

export function createChangeReviewConflictQueryPort(
  getReviewApi: () => ReviewConflictQueryApi
): ChangeReviewConflictQueryPort {
  return conflictAdapters.createChangeReviewConflictQueryPort(getReviewApi);
}

export function createChangeReviewConflictCommandPort(
  getReviewApi: () => ReviewConflictCommandApi
): ChangeReviewConflictCommandPort {
  return conflictAdapters.createChangeReviewConflictCommandPort(getReviewApi);
}

interface ChangeReviewConflictStateSnapshot {
  applyError: string | null;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: string;
}

interface CreateChangeReviewConflictStateBridgeInput {
  getSnapshot: () => ChangeReviewConflictStateSnapshot;
  setApplyError: (message: string | null) => void;
}

export interface ChangeReviewConflictStateBridge {
  clearReportedLoadError(): void;
  reportError(message: string): void;
  clearResolutionError(): void;
  isDecisionHydrationLoaded(hydrationKey: string): boolean;
}

export function createChangeReviewConflictStateBridge(
  input: CreateChangeReviewConflictStateBridgeInput
): ChangeReviewConflictStateBridge {
  return conflictStateAdapters.createChangeReviewConflictStateBridge(input);
}

interface ChangeReviewDialogLifecycleStore extends ChangeReviewDialogLifecycleStateSnapshot {
  applyError: string | null;
  resetAllReviewState(): void;
  clearChangeReviewCache(): void;
  fetchAgentChanges(teamName: string, memberName: string): Promise<void>;
  fetchTaskChanges(
    teamName: string,
    taskId: string,
    options: NonNullable<Parameters<ReviewAPI['getTaskChanges']>[2]>
  ): Promise<void>;
  clearDecisionsFromDisk(
    teamName: string,
    scopeKey: string,
    scopeToken?: string,
    forceDiscard?: boolean
  ): Promise<boolean>;
  applyReview(
    teamName: string,
    taskId?: string,
    memberName?: string
  ): Promise<ApplyReviewResult | null>;
}

interface CreateChangeReviewDialogLifecycleStatePortInput {
  getStore: () => ChangeReviewDialogLifecycleStore;
  reportError: (message: string | null) => void;
  completeSavedStateDiscard: (markDecisionHydrationLoaded: boolean) => void;
}

export function createChangeReviewDialogLifecycleStatePort(
  input: CreateChangeReviewDialogLifecycleStatePortInput
): ChangeReviewDialogLifecycleStatePort {
  return lifecycleAdapters.createChangeReviewDialogLifecycleStatePort(input);
}

interface CreateChangeReviewDialogLifecycleCommandPortInput {
  getStore: () => ChangeReviewDialogLifecycleStore;
  getReviewApi: () => Pick<ReviewAPI, 'retryMutationRecovery'>;
  hydrateDecisions: ChangeReviewDialogLifecycleCommandPort['hydrateDecisions'];
}

export function createChangeReviewDialogLifecycleCommandPort(
  input: CreateChangeReviewDialogLifecycleCommandPortInput
): ChangeReviewDialogLifecycleCommandPort {
  return lifecycleAdapters.createChangeReviewDialogLifecycleCommandPort(input);
}

interface FileMutationStatusDependencies {
  fileApplyInFlightRef: MutableRefObject<Set<string>>;
  setFilesApplying: Dispatch<SetStateAction<Set<string>>>;
  setDiscardCounters: Dispatch<SetStateAction<Record<string, number>>>;
}

interface LifecycleStatusDependencies {
  undoInFlightRef: MutableRefObject<boolean>;
  closingRef: MutableRefObject<boolean>;
  pendingApplyCleanupKeyRef: MutableRefObject<string | null>;
  expectedDraftHistoryKeyRef: MutableRefObject<string | null>;
  setUndoing: Dispatch<SetStateAction<boolean>>;
  setClosing: Dispatch<SetStateAction<boolean>>;
}

interface CreateChangeReviewDialogViewPortsInput
  extends FileMutationStatusDependencies, LifecycleStatusDependencies {
  editorViewMapRef: MutableRefObject<Map<string, EditorView>>;
  editorActions: ChangeReviewDialogEditorActions;
  subscribeToRejectCurrentHunk: (callback: () => void) => (() => void) | undefined;
  recentReviewWritesRef: MutableRefObject<Map<string, ChangeReviewRecentWrite>>;
  handleSerializedStateChanged: (
    filePath: string,
    editorState: ReviewSerializedEditorState
  ) => void;
  addReviewFile(
    file: FileChangeSummary,
    options?: { index?: number; content?: FileChangeWithContent }
  ): void;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
  navigateToHistoryAction(action: ReviewUndoAction): void;
}

export interface ChangeReviewDialogViewPorts {
  bulkDecision: {
    editor: ChangeReviewBulkDecisionEditorPort;
    status: ChangeReviewBulkDecisionStatusPort;
    writeEvidence: ChangeReviewBulkDecisionWriteEvidencePort;
  };
  fileDecision: {
    editor: ChangeReviewFileDecisionEditorPort;
    status: ChangeReviewFileDecisionStatusPort;
    writeEvidence: ChangeReviewFileDecisionWriteEvidencePort;
  };
  fileDraft: {
    status: ChangeReviewFileDraftStatusPort;
    writeEvidence: ChangeReviewFileDraftWriteEvidencePort;
  };
  historyMutation: ChangeReviewHistoryMutationViewPort;
  keyboardInteraction: ChangeReviewDialogKeyboardInteractionPort;
  hunkDecision: {
    editor: ChangeReviewHunkDecisionEditorPort;
    status: ChangeReviewHunkDecisionStatusPort;
    writeEvidence: ChangeReviewHunkDecisionWriteEvidencePort;
  };
  lifecycle: {
    editor: ChangeReviewDialogLifecycleEditorPort;
    session: ChangeReviewDialogLifecycleSessionPort;
    status: ChangeReviewDialogLifecycleStatusPort;
    writeEvidence: ChangeReviewDialogLifecycleWriteEvidencePort;
  };
}

export function createChangeReviewDialogViewPorts(
  input: CreateChangeReviewDialogViewPortsInput
): ChangeReviewDialogViewPorts {
  return dialogViewAdapters.createChangeReviewDialogViewPorts(input);
}

type ReviewDraftHistoryApi = Pick<
  ReviewAPI,
  | 'loadDraftHistory'
  | 'saveDraftHistoryEntry'
  | 'clearDraftHistory'
  | 'checkConflict'
  | 'replaceDraftHistoryConflictCandidate'
  | 'resolveDraftHistoryConflictCandidate'
>;

export function createChangeReviewDraftHistoryPort(
  getReviewApi: () => ReviewDraftHistoryApi
): ChangeReviewDraftHistoryPort {
  return draftHistoryAdapters.createChangeReviewDraftHistoryPort(getReviewApi);
}

interface ChangeReviewFileDecisionStore extends ChangeReviewFileDecisionStateSnapshot {
  acceptAllFile(filePath: string): boolean;
  rejectAllFile(filePath: string): void;
  clearReviewFileExternalChange(filePath: string): void;
  invalidateResolvedFileContent(filePath: string): void;
  applySingleFileDecision(
    teamName: string,
    filePath: string,
    taskId?: string,
    memberName?: string
  ): ReturnType<ChangeReviewFileDecisionCommandPort['applySingleFileDecision']>;
  quiesceDecisionPersistence(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<boolean>;
  recordDecisionRevision(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    revision: number
  ): void;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
}

interface CreateChangeReviewFileDecisionStatePortInput {
  getStore: () => ChangeReviewFileDecisionStore;
  applyRestoredDecisionState: (file: FileChangeSummary) => void;
  restoreFileDecisions: (file: FileChangeSummary, snapshot: ReviewDecisionSnapshot) => void;
  reportError: (message: string | null) => void;
}

export function createChangeReviewFileDecisionStatePort(
  input: CreateChangeReviewFileDecisionStatePortInput
): ChangeReviewFileDecisionStatePort {
  return fileDecisionAdapters.createChangeReviewFileDecisionStatePort(input);
}

interface CreateChangeReviewFileDecisionCommandPortInput {
  getStore: () => ChangeReviewFileDecisionStore;
  getReviewApi: () => Pick<ReviewAPI, 'checkConflict' | 'executeMutation'>;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export function createChangeReviewFileDecisionCommandPort(
  input: CreateChangeReviewFileDecisionCommandPortInput
): ChangeReviewFileDecisionCommandPort {
  return fileDecisionAdapters.createChangeReviewFileDecisionCommandPort(input);
}

interface ChangeReviewFileDraftStore {
  activeChangeSet: {
    files: readonly ChangeReviewFileDraftStateSnapshot['activeFiles'][number][];
  } | null;
  editedContents: ChangeReviewFileDraftStateSnapshot['editedContents'];
  reviewExternalChangesByFile: ChangeReviewFileDraftStateSnapshot['reviewExternalChangesByFile'];
  hunkDecisions: ChangeReviewFileDraftStateSnapshot['hunkDecisions'];
  fileDecisions: ChangeReviewFileDraftStateSnapshot['fileDecisions'];
  hunkContextHashesByFile: ChangeReviewFileDraftStateSnapshot['hunkContextHashesByFile'];
  decisionRevision: number;
  changeSetEpoch: number;
  updateEditedContent(filePath: string, content: string): void;
  discardFileEdits(filePath: string): void;
  clearReviewFileExternalChange(filePath: string): void;
  reloadReviewFileFromDisk(filePath: string): void;
  saveEditedFile: ChangeReviewFileDraftCommandPort['saveEditedFile'];
  quiesceDecisionPersistence(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<boolean>;
  recordDecisionRevision(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    revision: number
  ): void;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
}

interface CreateChangeReviewFileDraftStatePortInput {
  getStore: () => ChangeReviewFileDraftStore;
  applyReloadedReviewState: (state: ReviewPersistedStateSnapshot) => void;
  reportError: (message: string | null) => void;
}

export function createChangeReviewFileDraftStatePort(
  input: CreateChangeReviewFileDraftStatePortInput
): ChangeReviewFileDraftStatePort {
  return fileDraftAdapters.createChangeReviewFileDraftStatePort(input);
}

interface CreateChangeReviewFileDraftCommandPortInput {
  getStore: () => ChangeReviewFileDraftStore;
  getReviewApi: () => Pick<ReviewAPI, 'checkConflict' | 'executeMutation'>;
}

export function createChangeReviewFileDraftCommandPort(
  input: CreateChangeReviewFileDraftCommandPortInput
): ChangeReviewFileDraftCommandPort {
  return fileDraftAdapters.createChangeReviewFileDraftCommandPort(input);
}

type ChangeReviewHistoryMutationApi = Pick<
  ReviewAPI,
  'executeMutation' | 'restoreHistory' | 'retryMutationRecovery'
>;

export function createChangeReviewHistoryMutationCommandPort(
  getReviewApi: () => ChangeReviewHistoryMutationApi
): ChangeReviewHistoryMutationCommandPort {
  return historyMutationAdapters.createChangeReviewHistoryMutationCommandPort(getReviewApi);
}

interface CreateChangeReviewHistoryMutationStatePortInput {
  getSnapshot: () => ChangeReviewHistoryStateSnapshot;
  quiesceDecisionPersistence: (scope: ChangeReviewHistoryPersistenceScope) => Promise<boolean>;
  recordDecisionRevision(scope: ChangeReviewHistoryPersistenceScope, revision: number): void;
  applyDecisionState: ChangeReviewHistoryMutationStatePort['applyDecisionState'];
  applyPersistedState(state: ReviewPersistedStateSnapshot, applyError: string | null): void;
  reportError(message: string): void;
  clearExternalChange(filePath: string): void;
  invalidateResolvedFileContent(filePath: string): void;
}

export function createChangeReviewHistoryMutationStatePort(
  input: CreateChangeReviewHistoryMutationStatePortInput
): ChangeReviewHistoryMutationStatePort {
  return historyMutationAdapters.createChangeReviewHistoryMutationStatePort(input);
}

interface ChangeReviewHunkDecisionStore extends ChangeReviewHunkDecisionStateSnapshot {
  setHunkDecision(filePath: string, hunkIndex: number, decision: HunkDecision): number;
  clearHunkDecisionByOriginalIndex(filePath: string, originalIndex: number): void;
  invalidateResolvedFileContent(filePath: string): void;
  applySingleFileDecision(
    teamName: string,
    filePath: string,
    taskId?: string,
    memberName?: string
  ): Promise<ApplyReviewResult | null>;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
}

export function createChangeReviewHunkDecisionStatePort(
  getStore: () => ChangeReviewHunkDecisionStore
): ChangeReviewHunkDecisionStatePort {
  return hunkDecisionAdapters.createChangeReviewHunkDecisionStatePort(getStore);
}

interface CreateChangeReviewHunkDecisionCommandPortInput {
  getStore: () => ChangeReviewHunkDecisionStore;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export function createChangeReviewHunkDecisionCommandPort(
  input: CreateChangeReviewHunkDecisionCommandPortInput
): ChangeReviewHunkDecisionCommandPort {
  return hunkDecisionAdapters.createChangeReviewHunkDecisionCommandPort(input);
}
export type { ChangeReviewActionHistoryController } from './hooks/useChangeReviewActionHistoryController';
export { useChangeReviewActionHistoryController } from './hooks/useChangeReviewActionHistoryController';
export type { ChangeReviewBulkDecisionController } from './hooks/useChangeReviewBulkDecisionController';
export { useChangeReviewBulkDecisionController } from './hooks/useChangeReviewBulkDecisionController';
export type { ChangeReviewConflictDiscoveryController } from './hooks/useChangeReviewConflictDiscoveryController';
export { useChangeReviewConflictDiscoveryController } from './hooks/useChangeReviewConflictDiscoveryController';
export type { ChangeReviewConflictInteractionController } from './hooks/useChangeReviewConflictInteractionController';
export { useChangeReviewConflictInteractionController } from './hooks/useChangeReviewConflictInteractionController';
export { useChangeReviewDecisionAutoPersistence } from './hooks/useChangeReviewDecisionAutoPersistence';
export type {
  ChangeReviewAutoClearResult,
  ChangeReviewDecisionPersistenceController,
  ChangeReviewDecisionPersistenceDiagnostics,
} from './hooks/useChangeReviewDecisionPersistenceController';
export {
  CHANGE_REVIEW_PERSISTENCE_ERROR,
  useChangeReviewDecisionPersistenceController,
} from './hooks/useChangeReviewDecisionPersistenceController';
export type { ChangeReviewDialogKeyboardInteractions } from './hooks/useChangeReviewDialogKeyboardInteractions';
export { useChangeReviewDialogKeyboardInteractions } from './hooks/useChangeReviewDialogKeyboardInteractions';
export type { ChangeReviewDialogLifecycleController } from './hooks/useChangeReviewDialogLifecycleController';
export { useChangeReviewDialogLifecycleController } from './hooks/useChangeReviewDialogLifecycleController';
export type {
  ChangeReviewDialogViewState,
  ChangeReviewDialogViewStatePolicy,
} from './hooks/useChangeReviewDialogViewState';
export { useChangeReviewDialogViewState } from './hooks/useChangeReviewDialogViewState';
export type {
  ChangeReviewDraftHistoryController,
  ChangeReviewDraftHistoryDiagnostics,
} from './hooks/useChangeReviewDraftHistoryController';
export { useChangeReviewDraftHistoryController } from './hooks/useChangeReviewDraftHistoryController';
export type { ChangeReviewExternalChangeController } from './hooks/useChangeReviewExternalChangeController';
export { useChangeReviewExternalChangeController } from './hooks/useChangeReviewExternalChangeController';
export { useChangeReviewExternalFileWatcher } from './hooks/useChangeReviewExternalFileWatcher';
export type { ChangeReviewFileDecisionController } from './hooks/useChangeReviewFileDecisionController';
export { useChangeReviewFileDecisionController } from './hooks/useChangeReviewFileDecisionController';
export type { ChangeReviewFileDraftController } from './hooks/useChangeReviewFileDraftController';
export { useChangeReviewFileDraftController } from './hooks/useChangeReviewFileDraftController';
export type { ChangeReviewKeyboardEditorContext } from './hooks/useChangeReviewHistoryKeyboardShortcuts';
export { useChangeReviewHistoryKeyboardShortcuts } from './hooks/useChangeReviewHistoryKeyboardShortcuts';
export type {
  ChangeReviewHistoryMutationController,
  ChangeReviewHistoryRestorePreview,
} from './hooks/useChangeReviewHistoryMutationController';
export { useChangeReviewHistoryMutationController } from './hooks/useChangeReviewHistoryMutationController';
export type { ChangeReviewHunkDecisionController } from './hooks/useChangeReviewHunkDecisionController';
export { useChangeReviewHunkDecisionController } from './hooks/useChangeReviewHunkDecisionController';
export { useChangeReviewLifecycleRegistration } from './hooks/useChangeReviewLifecycleRegistration';
export type { ChangeReviewMutationGuards } from './hooks/useChangeReviewMutationGuards';
export { useChangeReviewMutationGuards } from './hooks/useChangeReviewMutationGuards';
export { useChangeReviewOperationGeneration } from './hooks/useChangeReviewOperationGeneration';
export type {
  ChangeReviewOperationState,
  ChangeReviewOperationViewPortBindings,
} from './hooks/useChangeReviewOperationState';
export { useChangeReviewOperationState } from './hooks/useChangeReviewOperationState';
export { useChangeReviewScopeIdentity } from './hooks/useChangeReviewScopeIdentity';
export type {
  ChangeReviewActionHistoryStorePort,
  ChangeReviewDecisionPersistencePort,
  ChangeReviewDecisionPersistenceScope,
  ChangeReviewDecisionPersistenceSnapshot,
} from './ports/changeReviewActionHistoryPorts';
export type {
  BuildBulkRejectDiskSnapshot,
  ChangeReviewBulkDecisionCommandPort,
  ChangeReviewBulkDecisionEditorPort,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionStateSnapshot,
  ChangeReviewBulkDecisionStatusPort,
  ChangeReviewBulkDecisionWriteEvidencePort,
} from './ports/changeReviewBulkDecisionPorts';
export type {
  ChangeReviewConflictCommandPort,
  ChangeReviewConflictQueryPort,
  ChangeReviewConflictScope,
} from './ports/changeReviewConflictPorts';
export type {
  ChangeReviewCollapsedFilesStoragePort,
  ChangeReviewDialogEditorActions,
  ChangeReviewDialogKeyboardInteractionPort,
  ChangeReviewExternalFileWatcherPort,
  ChangeReviewRecentWrite,
} from './ports/changeReviewDialogInteractionPorts';
export type {
  ChangeReviewDialogLifecycleApplyOutcome,
  ChangeReviewDialogLifecycleAutoClearResult,
  ChangeReviewDialogLifecycleCommandPort,
  ChangeReviewDialogLifecycleDecisionPersistencePort,
  ChangeReviewDialogLifecycleDraftHistoryPort,
  ChangeReviewDialogLifecycleEditorPort,
  ChangeReviewDialogLifecyclePersistenceScope,
  ChangeReviewDialogLifecycleSessionPort,
  ChangeReviewDialogLifecycleStatePort,
  ChangeReviewDialogLifecycleStateSnapshot,
  ChangeReviewDialogLifecycleStatusPort,
  ChangeReviewDialogLifecycleWriteEvidencePort,
} from './ports/changeReviewDialogLifecyclePorts';
export type {
  ChangeReviewDraftHistoryEntryInput,
  ChangeReviewDraftHistoryPort,
  ChangeReviewDraftHistoryScope,
  ChangeReviewDraftHistoryVersion,
} from './ports/changeReviewDraftHistoryPort';
export type {
  ChangeReviewFileDecisionCommandPort,
  ChangeReviewFileDecisionEditorPort,
  ChangeReviewFileDecisionHistoryPort,
  ChangeReviewFileDecisionPersistenceScope,
  ChangeReviewFileDecisionPolicy,
  ChangeReviewFileDecisionStatePort,
  ChangeReviewFileDecisionStateSnapshot,
  ChangeReviewFileDecisionStatusPort,
  ChangeReviewFileDecisionWriteEvidencePort,
} from './ports/changeReviewFileDecisionPorts';
export type {
  ChangeReviewFileDraftActionHistoryPort,
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftHistoryPort,
  ChangeReviewFileDraftPersistenceScope,
  ChangeReviewFileDraftStatePort,
  ChangeReviewFileDraftStateSnapshot,
  ChangeReviewFileDraftStatusPort,
  ChangeReviewFileDraftWriteEvidencePort,
  ChangeReviewSaveEditedFileResult,
  CommitChangeReviewExternalReloadInput,
} from './ports/changeReviewFileDraftPorts';
export type {
  ChangeReviewHistoryMutationCommandPort,
  ChangeReviewHistoryMutationScope,
  ChangeReviewHistoryMutationStatePort,
  ChangeReviewHistoryMutationViewPort,
  ChangeReviewHistoryPersistenceScope,
  ChangeReviewHistoryStateSnapshot,
} from './ports/changeReviewHistoryMutationPorts';
export type {
  CaptureChangeReviewHunkOperationScope,
  ChangeReviewHunkDecisionApplyOutcome,
  ChangeReviewHunkDecisionCommandPort,
  ChangeReviewHunkDecisionEditorPort,
  ChangeReviewHunkDecisionHistoryPort,
  ChangeReviewHunkDecisionPolicy,
  ChangeReviewHunkDecisionStatePort,
  ChangeReviewHunkDecisionStateSnapshot,
  ChangeReviewHunkDecisionStatusPort,
  ChangeReviewHunkDecisionWriteEvidencePort,
} from './ports/changeReviewHunkDecisionPorts';
export type {
  RegisterChangeReviewAppCloseParticipant,
  RegisterChangeReviewLifecycleOwner,
} from './ports/changeReviewLifecyclePorts';
export type {
  ChangeReviewExternalChangePolicy,
  ChangeReviewExternalChangeStatePort,
  ChangeReviewExternalChangeStateSnapshot,
  ChangeReviewExternalChangeType,
  ChangeReviewOperationStatePort,
  ChangeReviewOperationStateSnapshot,
} from './ports/changeReviewMutationSafetyPorts';
export {
  ChangeReviewConflictDiscardDialog,
  ChangeReviewConflictNotices,
} from './ui/ChangeReviewConflictNotices';
export type { ChangeReviewSidebarProps } from './ui/ChangeReviewSidebar';
export { ChangeReviewSidebar } from './ui/ChangeReviewSidebar';
export type { TaskChangesEmptyStateProps } from './ui/TaskChangesEmptyState';
export { TaskChangesEmptyState } from './ui/TaskChangesEmptyState';
export type {
  ReviewActionPersistenceStatus,
  ReviewUndoActionInput,
} from './utils/changeReviewActionHistory';
export {
  appendOrderedReviewAction,
  createReviewUndoAction,
  filterReviewActionHistoryForFile,
  isReviewActionPersistenceBlocking,
  popOrderedReviewAction,
  replaceLatestReviewAction,
} from './utils/changeReviewActionHistory';
export type { ReviewConflictCandidateSelection } from './utils/changeReviewConflicts';
export {
  CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX,
  describeReviewConflictCandidate,
  describeReviewConflictDiscard,
  selectLatestReviewConflictCandidate,
} from './utils/changeReviewConflicts';
export type {
  ChangeReviewActionLockState,
  ChangeReviewCloseReadiness,
  ChangeReviewCloseReadinessInput,
  ChangeReviewDecisionWriteDiagnostics,
  ChangeReviewDraftWriteDiagnostics,
} from './utils/changeReviewDialogLifecycle';
export {
  evaluateChangeReviewCloseReadiness,
  getReviewCloseBlockReason,
  hasUnscopedLocalReviewState,
  isReviewActionLocked,
  shouldRequestReviewCloseForEscape,
} from './utils/changeReviewDialogLifecycle';
export type { ReviewHistoryRecoveryDisposition } from './utils/changeReviewHistoryMutation';
export {
  areReviewPersistedStatesEqual,
  classifyReviewHistoryRecovery,
  createReviewRedoAction,
  getReviewActionAffectedPaths,
  getReviewDiskMutationExpectedContent,
  resolveReviewFile,
} from './utils/changeReviewHistoryMutation';
export type {
  BuildChangeReviewScopeProjectionInput,
  ChangeReviewScopeProjection,
  ReviewDecisionHydrationGuard,
  ReviewDecisionHydrationStatus,
  ReviewDraftHistoryHydrationState,
} from './utils/changeReviewScope';
export {
  buildChangeReviewScopeProjection,
  getReviewDecisionHydrationGuard,
} from './utils/changeReviewScope';
export { markChangeReviewMutationDiskPostimages } from './utils/changeReviewWriteEvidence';
export type { ReviewOperationScopeToken } from './utils/reviewOperationGeneration';
export {
  createReviewOperationScopeToken,
  isReviewOperationScopeCurrent,
} from './utils/reviewOperationGeneration';
export type {
  ChangeReviewChangeSet,
  GlobalDiffLoadingState,
  ReviewChangeStats,
  ReviewStats,
  TaskChangesEmptyStatePresentation,
} from './view-models/changeReviewPresentation';
export {
  buildChangeReviewTitle,
  buildGlobalDiffLoadingState,
  buildReviewChangeStats,
  buildReviewFileLabels,
  buildReviewStats,
  buildTaskChangesEmptyStatePresentation,
  buildWatchedReviewFilePathsKey,
  findActiveReviewFile,
  isTaskChangeSetV2,
  resolveReviewFileLabel,
  shouldShowTaskScopeBanner,
  sortChangeReviewFiles,
  toTaskChangeSetV2,
} from './view-models/changeReviewPresentation';
