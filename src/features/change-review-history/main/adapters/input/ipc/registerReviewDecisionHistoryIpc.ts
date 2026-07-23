import {
  REVIEW_CLEAR_DECISIONS,
  REVIEW_DECISION_HISTORY_IPC_CHANNELS,
  REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES,
  REVIEW_LOAD_DECISIONS,
  REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE,
  REVIEW_SAVE_DECISIONS,
} from '@features/change-review-history/contracts';

import type { ReviewHistoryIpcHandlerWrapper } from './types';
import type { ReviewDecisionHistoryApplication } from '../../../../core/application/ReviewDecisionHistoryApplication';
import type {
  HunkDecision,
  ReviewConflictResolution,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types/review';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export function registerReviewDecisionHistoryIpc(
  ipcMain: IpcMain,
  application: ReviewDecisionHistoryApplication,
  wrapHandler: ReviewHistoryIpcHandlerWrapper
): void {
  ipcMain.handle(
    REVIEW_LOAD_DECISIONS,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string | null = null
    ) => wrapHandler('loadDecisions', () => application.load(teamName, scopeKey, scopeToken))
  );
  ipcMain.handle(
    REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES,
    (_event: IpcMainInvokeEvent, teamName: string, scopeKey: string, scopeToken: string) =>
      wrapHandler('loadDecisionConflictCandidates', () =>
        application.loadConflictCandidates(teamName, scopeKey, scopeToken)
      )
  );
  ipcMain.handle(
    REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string,
      resolution: ReviewConflictResolution,
      expectedCurrentRevision: number
    ) =>
      wrapHandler('resolveDecisionConflictCandidate', () =>
        application.resolveConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          candidateId,
          resolution,
          expectedCurrentRevision
        )
      )
  );
  ipcMain.handle(
    REVIEW_SAVE_DECISIONS,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      hunkDecisions: Record<string, HunkDecision>,
      fileDecisions: Record<string, HunkDecision>,
      hunkContextHashesByFile: Record<string, Record<number, string>> | null = null,
      reviewActionHistory: ReviewUndoAction[] = [],
      expectedRevision: number | undefined = undefined,
      reviewRedoHistory: ReviewRedoAction[] = []
    ) =>
      wrapHandler('saveDecisions', () =>
        application.save(
          teamName,
          scopeKey,
          scopeToken,
          hunkDecisions,
          fileDecisions,
          hunkContextHashesByFile,
          reviewActionHistory,
          expectedRevision,
          reviewRedoHistory
        )
      )
  );
  ipcMain.handle(
    REVIEW_CLEAR_DECISIONS,
    (
      _event: IpcMainInvokeEvent,
      teamName: string,
      scopeKey: string,
      scopeToken: string | null = null,
      expectedRevision: number | undefined = undefined
    ) =>
      wrapHandler('clearDecisions', () =>
        application.clear(teamName, scopeKey, scopeToken, expectedRevision)
      )
  );
}

export function removeReviewDecisionHistoryIpc(ipcMain: IpcMain): void {
  for (const channel of REVIEW_DECISION_HISTORY_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
