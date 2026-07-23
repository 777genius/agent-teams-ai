import {
  REVIEW_CLEAR_DRAFT_HISTORY,
  REVIEW_DRAFT_HISTORY_IPC_CHANNELS,
  REVIEW_LOAD_DRAFT_HISTORY,
  REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES,
  REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
} from '@features/change-review-history/contracts';

import type { ReviewHistoryIpcHandlerWrapper } from './types';
import type { ReviewDraftHistoryApplication } from '../../../../core/application/ReviewDraftHistoryApplication';
import type { ReviewDraftHistoryEntry } from '@features/change-review-history/contracts';
import type { ReviewConflictResolution } from '@shared/types/review';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export type ReviewDraftHistoryIpcHandlerWrapper = ReviewHistoryIpcHandlerWrapper;

export function registerReviewDraftHistoryIpc(
  ipcMain: IpcMain,
  application: ReviewDraftHistoryApplication,
  wrapHandler: ReviewDraftHistoryIpcHandlerWrapper
): void {
  ipcMain.handle(
    REVIEW_LOAD_DRAFT_HISTORY,
    (_event: IpcMainInvokeEvent, teamName: string, scopeKey: string, scopeToken: string) =>
      wrapHandler('loadDraftHistory', () => application.load(teamName, scopeKey, scopeToken))
  );
  ipcMain.handle(
    REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES,
    (_event: IpcMainInvokeEvent, teamName: string, scopeKey: string, scopeToken: string) =>
      wrapHandler('loadDraftHistoryConflictCandidates', () =>
        application.loadConflictCandidates(teamName, scopeKey, scopeToken)
      )
  );
  ipcMain.handle(
    REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string,
      resolution: ReviewConflictResolution,
      expectedCurrentRevision: number,
      expectedCurrentGeneration: string | null
    ) =>
      wrapHandler('resolveDraftHistoryConflictCandidate', () =>
        application.resolveConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          candidateId,
          resolution,
          expectedCurrentRevision,
          expectedCurrentGeneration
        )
      )
  );
  ipcMain.handle(
    REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
      replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
      expectedCurrentRevision: number,
      expectedCurrentGeneration: string | null
    ) =>
      wrapHandler('replaceDraftHistoryConflictCandidate', () =>
        application.replaceConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          expectedEntry,
          replacementEntry,
          expectedCurrentRevision,
          expectedCurrentGeneration
        )
      )
  );
  ipcMain.handle(
    REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
      expectedRevision: number,
      expectedGeneration: string | null
    ) =>
      wrapHandler('saveDraftHistoryEntry', () =>
        application.saveEntry(
          teamName,
          scopeKey,
          scopeToken,
          entry,
          expectedRevision,
          expectedGeneration
        )
      )
  );
  ipcMain.handle(
    REVIEW_CLEAR_DRAFT_HISTORY,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      filePath: string | null = null,
      expectedRevision: number | null = null,
      expectedGeneration: string | null = null
    ) =>
      wrapHandler('clearDraftHistory', () =>
        application.clear(
          teamName,
          scopeKey,
          scopeToken,
          filePath,
          expectedRevision,
          expectedGeneration
        )
      )
  );
}

export function removeReviewDraftHistoryIpc(ipcMain: IpcMain): void {
  for (const channel of REVIEW_DRAFT_HISTORY_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
