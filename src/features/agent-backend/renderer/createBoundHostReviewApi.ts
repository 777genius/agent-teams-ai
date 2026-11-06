import { captureReviewWriterRequest } from '@agent-teams/task-change-ledger/review-transport';

import { hostTeamSelectionKey } from '../contracts/teamSelection';

import { HostReviewOperationError } from './HostReviewOperationError';
import { refreshHostReviewRecovery } from './refreshHostReviewRecovery';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { AgentBackendApi } from '../contracts/operations';
import type {
  BackendReviewOperation,
  BackendReviewOperationPayloads,
  BackendReviewValue,
} from '../contracts/review';
import type { AgentBackendReviewWatchApi } from '../contracts/reviewWatch';
import type {
  ReviewOriginScope,
  ReviewWriterInputMap,
  ReviewWriterMethod,
  ReviewWriterRequest,
  ReviewWriterResultMap,
} from '@agent-teams/task-change-ledger/review-transport';
import type { ReviewAPI } from '@shared/types/api';

type Connection = BackendConnectionSnapshot['bindings'][number];
type Backend = AgentBackendApi & Partial<AgentBackendReviewWatchApi>;

/** One originating view, one immutable Team selection and one retained owner handle. */
export function createBoundHostReviewApi(
  legacy: ReviewAPI,
  backend: Backend,
  selection: string,
  origin: Readonly<ReviewOriginScope>,
  captureScope: () => () => boolean
): ReviewAPI {
  const current = captureScope();
  const scope = Object.freeze({ ...origin });
  const watchId = crypto.randomUUID();
  let connection: Promise<Connection> | undefined;
  let captured: Connection | undefined;
  let watchRevision = 0;
  let watchSnapshotsInvalidated = false;
  function assertCurrent(): void {
    if (!current()) throw new Error('Review context changed');
  }
  function team(value: string): void {
    assertCurrent();
    if (value !== selection) throw new Error('Review Team changed');
  }
  function task(value: string): void {
    assertCurrent();
    if (scope.taskId !== undefined && scope.taskId !== value)
      throw new Error('Review Task changed');
  }
  function member(value: string | undefined): void {
    assertCurrent();
    if (scope.memberName !== undefined && value !== undefined && scope.memberName !== value)
      throw new Error('Review member changed');
  }
  async function target(): Promise<Connection> {
    assertCurrent();
    connection ??= backend.getConnections().then((state) => {
      assertCurrent();
      const found = state.bindings.find(
        (entry) => hostTeamSelectionKey(entry.handle.handleId) === selection
      );
      if (state.state !== 'ready' || !found) throw new Error('Host review unavailable');
      captured = structuredClone(found);
      return captured;
    });
    const result = await connection;
    assertCurrent();
    return result;
  }
  async function query<O extends BackendReviewOperation>(
    operation: O,
    payload: BackendReviewOperationPayloads[O]
  ): Promise<BackendReviewValue> {
    const capturedPayload = structuredClone(payload);
    const commandId = crypto.randomUUID();
    const selected = await target();
    assertCurrent();
    const request = {
      handle: selected.handle,
      commandId,
      operation,
      payload: capturedPayload,
    } as Parameters<AgentBackendApi['invoke']>[0];
    if (operation === 'review.invoke' && watchSnapshotsInvalidated) {
      throw new Error(
        'Review file watch connection was interrupted. Reopen Changes to verify the original files before continuing.'
      );
    }
    let result;
    try {
      result = await backend.invoke(request);
    } catch {
      throw new HostReviewOperationError('unavailable', 'unknown', request);
    }
    if (!current()) throw new HostReviewOperationError('forbidden', 'unknown', request);
    if (!result.ok) throw new HostReviewOperationError(result.code, result.outcome, request);
    if (!result.value || typeof result.value !== 'object' || !('kind' in result.value))
      throw new HostReviewOperationError('hold', 'unknown', request);
    return result.value as BackendReviewValue;
  }
  async function recover(requireSettled: boolean): Promise<void> {
    await refreshHostReviewRecovery(
      {
        async read() {
          const response = await query('review.recovery.read', { scope });
          if (response.kind !== 'review-recovery')
            throw new Error('Host review recovery unavailable');
          return response;
        },
        async lookup(commandId) {
          const selected = await target();
          const request: Parameters<AgentBackendApi['invoke']>[0] = {
            handle: selected.handle,
            commandId,
            operation: 'review.lookup',
            payload: { scope },
          };
          let response;
          try {
            response = await backend.invoke(request);
          } catch {
            throw new HostReviewOperationError('unavailable', 'unknown', request);
          }
          assertCurrent();
          if (!response.ok)
            throw new HostReviewOperationError(response.code, response.outcome, request);
          if (response.value === null) return null;
          if (!('kind' in response.value) || response.value.kind !== 'review-command')
            throw new HostReviewOperationError('hold', 'unknown', request);
          return response.value;
        },
      },
      requireSettled
    );
  }
  async function writer<M extends ReviewWriterMethod>(
    method: M,
    args: ReviewWriterInputMap[M]
  ): Promise<ReviewWriterResultMap[M]> {
    const request = captureReviewWriterRequest({ method, args } as ReviewWriterRequest, selection);
    const response = await query('review.invoke', { scope, request });
    if (response.kind !== 'review-writer' || response.method !== method)
      throw new Error('Invalid Host review method response');
    return response.result as ReviewWriterResultMap[M];
  }
  const result: ReviewAPI = {
    async getTaskChanges(name, taskId, options) {
      team(name);
      task(taskId);
      const result = await query('review.getTaskChanges', {
        taskId,
        ...(options === undefined ? {} : { options }),
      });
      if (result.kind !== 'review-task-changes') throw new Error('Invalid Host task changes');
      try {
        await recover(false);
      } catch (error) {
        // A held original WAL blocks hydration, while these authorized Task changes remain readable.
        if (!(error instanceof HostReviewOperationError) || error.code !== 'hold') throw error;
        assertCurrent();
      }
      return { ...result.value, teamName: selection };
    },
    async getTeamTaskChangeSummaries(name, requests) {
      team(name);
      const result = await query('review.getTaskSummaries', { requests });
      if (result.kind !== 'review-task-summaries') throw new Error('Invalid Host task summaries');
      return {
        ...result.value,
        teamName: selection,
        items: result.value.items.map((item) => ({
          ...item,
          changeSet: item.changeSet ? { ...item.changeSet, teamName: selection } : null,
        })),
      };
    },
    async getAgentChanges(name, memberName) {
      team(name);
      member(memberName);
      const result = await query('review.getAgentChanges', { memberName });
      if (result.kind !== 'review-agent-changes') throw new Error('Invalid Host agent changes');
      return { ...result.value, teamName: selection };
    },
    async getChangeStats(name, memberName) {
      team(name);
      member(memberName);
      const result = await query('review.getChangeStats', { memberName });
      if (result.kind !== 'review-change-stats') throw new Error('Invalid Host change stats');
      return result.value;
    },
    async invalidateTaskChangeSummaries(name, taskIds) {
      team(name);
      const result = await query('review.invalidateSummaries', { taskIds });
      if (result.kind !== 'review-invalidated') throw new Error('Invalid Host review invalidation');
    },
    getFileContent: (...args) => {
      team(args[0]);
      member(args[1]);
      return writer('getFileContent', args);
    },
    checkConflict: (...args) => writer('checkConflict', args),
    rejectHunks: (...args) => writer('rejectHunks', args),
    rejectFile: (...args) => writer('rejectFile', args),
    previewReject: (...args) => writer('previewReject', args),
    applyDecisions: (...args) => writer('applyDecisions', args),
    executeMutation: (...args) => writer('executeReviewMutation', args),
    restoreHistory: (...args) => writer('restoreReviewHistory', args),
    saveEditedFile: (...args) => writer('saveEditedFile', args),
    deleteEditedFile: (...args) => writer('deleteEditedFile', args),
    restoreRejectedRename: (...args) => writer('restoreRejectedRename', args),
    reapplyRejectedRename: (...args) => writer('reapplyRejectedRename', args),
    async retryMutationRecovery(...args) {
      const response = await writer('retryReviewMutationRecovery', args);
      await recover(true);
      return response;
    },
    async loadDecisions(...args) {
      const response = await writer('loadDecisions', args);
      await recover(true);
      return response;
    },
    async loadDecisionConflictCandidates(...args) {
      const response = await writer('loadDecisionConflictCandidates', args);
      await recover(true);
      return response;
    },
    resolveDecisionConflictCandidate: (...args) => writer('resolveDecisionConflictCandidate', args),
    saveDecisions: (...args) => writer('saveDecisions', args),
    clearDecisions: (...args) => writer('clearDecisions', args),
    loadDraftHistory: (...args) => writer('loadDraftHistory', args),
    async loadDraftHistoryConflictCandidates(...args) {
      const response = await writer('loadDraftHistoryConflictCandidates', args);
      await recover(true);
      return response;
    },
    resolveDraftHistoryConflictCandidate: (...args) =>
      writer('resolveDraftHistoryConflictCandidate', args),
    replaceDraftHistoryConflictCandidate: (...args) =>
      writer('replaceDraftHistoryConflictCandidate', args),
    saveDraftHistoryEntry: (...args) => writer('saveDraftHistoryEntry', args),
    async clearDraftHistory(...args) {
      await writer('clearDraftHistory', args);
    },
    async getGitFileLog(projectPath, filePath) {
      const result = await query('review.getGitFileLog', {
        scope,
        projectPath,
        filePath,
      });
      if (result.kind !== 'review-git-log') throw new Error('Invalid Host Git history');
      return result.value;
    },
    async watchFiles(projectPath, filePaths) {
      const revision = ++watchRevision;
      const paths = [...filePaths];
      const selected = await target();
      if (revision !== watchRevision) return;
      if (!backend.watchReviewFiles) throw new Error('Scoped Host review watcher unavailable');
      assertCurrent();
      await backend.watchReviewFiles({
        handle: selected.handle,
        watchId,
        scope,
        projectPath,
        filePaths: paths,
      });
      assertCurrent();
    },
    async unwatchFiles() {
      const revision = ++watchRevision;
      // Await only a lookup already started by this view; never select a new owner during cleanup.
      const selected =
        captured ?? (connection ? await connection.catch(() => undefined) : undefined);
      if (revision !== watchRevision || !selected || !backend.unwatchReviewFiles) return;
      await backend.unwatchReviewFiles({ handle: selected.handle, watchId });
    },
    onExternalFileChange(callback) {
      if (!backend.onReviewFileChange) throw new Error('Scoped Host review watcher unavailable');
      return backend.onReviewFileChange((event) => {
        if (
          current() &&
          captured &&
          event.handleId === captured.handle.handleId &&
          event.watchId === watchId
        ) {
          if (event.type === 'resync-required') {
            watchSnapshotsInvalidated = true;
            return;
          }
          callback({ path: event.path, type: event.type });
        }
      });
    },
    ...(legacy.onCmdN
      ? {
          onCmdN: (callback: () => void) => legacy.onCmdN!.call(legacy, callback),
        }
      : {}),
  };
  return result;
}
