import {
  createTeamMessageDeliveryRendererSlice,
  type TeamMessageDeliveryRendererSlice,
} from '@features/team-message-delivery/renderer';
import {
  collectTaskChangeInvalidation,
  createTeamTaskArtifactsRendererSlice,
  createTeamTaskArtifactsTransport,
  createTeamTaskBoardRendererSlice,
  preserveKnownTaskChangePresence,
  recordTeamTaskBoardSnapshotTransitions,
  type TeamTaskArtifactsRendererSlice,
  type TeamTaskBoardRendererSlice,
} from '@features/team-task-board/renderer';
import {
  buildGlobalTaskProjectionNotification,
  createTeamDirectoryRendererSlice,
  createTeamDirectoryTransport,
  createTeamMessageFeedRendererSlice,
  createTeamViewDataRendererSlice,
  defaultTeamMessageFeedCoordinator,
  defaultTeamViewDataCoordinator,
  type GlobalTaskProjectionNotification,
  type TeamDirectoryRefreshCoordinatorPort,
  type TeamDirectoryRendererSlice,
  type TeamMessageFeedRendererSlice,
  type TeamViewDataRendererSlice,
} from '@features/team-view-read-model/renderer';
import { classifyAnalyticsError } from '@renderer/analytics/productAnalytics';
import {
  getAttachmentMimeTypes,
  getAttachmentTotalSizeBytes,
} from '@renderer/analytics/teamAnalyticsMetadata';
import { api } from '@renderer/api';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import {
  buildOpenCodeRuntimeDeliveryDiagnostics,
  isOpenCodeRuntimeDeliveryHardUxFailure,
} from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import { getWorktreeNavigationState } from '../utils/stateResetHelpers';

import { recordLastResolvedTeamDataRefresh } from './teamDataRefreshTimestamps';
import { selectTeamDataForName } from './teamDataSelectors';
import {
  mapReviewError,
  mapSendMessageError,
  shouldInvalidateCachedTeamDataForError,
} from './teamErrorPolicies';
import {
  consumeFirstGlobalTasksFetchFlag,
  processGlobalTaskNotifications,
} from './teamGlobalTaskNotifications';
import { projectTeamSnapshotOntoGlobalTasks } from './teamGlobalTaskProjection';
import {
  isMemberActivityMetaStale,
  structurallyShareMemberActivityFacts,
} from './teamMemberActivityMeta';
import {
  areInboxMessageArraysEquivalent,
  extractRetainedCanonicalOlderTail,
  getCanonicalHeadSlice,
  getTeamMessagesCacheEntry,
  pruneOptimisticMessages,
  upsertOptimisticTeamMessage,
} from './teamMessagesCache';
import { setPendingReplyRefreshEnabled } from './teamPendingReplyWaits';
import { noteTeamRefreshBurst } from './teamRefreshBurstDiagnostics';
import { shouldPreserveSelectedTeamSnapshot } from './teamResolvedMembers';
import {
  structurallySharePlainValue,
  structurallyShareTeamSnapshot,
} from './teamSnapshotStructuralSharing';

import type { AppState } from '../types';
import type { ContextRequestScope, TeamRequestScope } from './TeamStateLifecycleCoordinator';
import type { ToolApprovalSettings } from '@shared/types';
import type { StoreApi } from 'zustand';

const TEAM_REFRESH_BURST_WINDOW_MS = 4_000;

export type TeamCollaborationDataSlice = TeamDirectoryRendererSlice &
  TeamViewDataRendererSlice &
  TeamMessageFeedRendererSlice &
  TeamMessageDeliveryRendererSlice &
  TeamTaskBoardRendererSlice &
  TeamTaskArtifactsRendererSlice;

export interface TeamCollaborationDataSliceDependencies {
  analytics: {
    recordAttachmentEnd(input: Record<string, unknown>): void;
    recordCrossTeamMessageSend(input: Record<string, unknown>): void;
  };
  clock: {
    nowIso(): string;
  };
  directoryCoordinator: TeamDirectoryRefreshCoordinatorPort<ContextRequestScope>;
  lifecycle: {
    isProvisioningActive(teamName: string): boolean;
  };
  log: {
    debug(message: string): void;
    error(message: string, error: unknown): void;
    warn(message: string): void;
  };
  requestScope: {
    captureContext(): ContextRequestScope;
    captureTeam(teamName: string): TeamRequestScope;
    isContextCurrent(scope: ContextRequestScope): boolean;
    isTeamCurrent(teamName: string, scope: TeamRequestScope): boolean;
  };
  settings: {
    loadToolApprovalSettings(teamName: string): ToolApprovalSettings;
  };
  state: {
    getState: StoreApi<AppState>['getState'];
    setState: StoreApi<AppState>['setState'];
  };
}

/**
 * App-store composition root for team collaboration data.
 * Feature slices own behavior; this boundary owns only their desktop adapters and shared ports.
 */
export function createTeamCollaborationDataSlice(
  dependencies: TeamCollaborationDataSliceDependencies
): TeamCollaborationDataSlice {
  const get = (): AppState => dependencies.state.getState();
  const set = dependencies.state.setState;

  return {
    ...createTeamDirectoryRendererSlice<AppState, ContextRequestScope>({
      coordinator: dependencies.directoryCoordinator,
      notifications: {
        consumeInitialFetch: consumeFirstGlobalTasksFetchFlag,
        process: processGlobalTaskNotifications,
      },
      paths: {
        normalize: normalizePath,
      },
      requestScope: {
        capture: () => dependencies.requestScope.captureContext(),
        isCurrent: (scope) => dependencies.requestScope.isContextCurrent(scope),
      },
      scheduler: {
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      state: {
        getState: get,
        setState: (update) => {
          if (typeof update === 'function') {
            set((state) => update(state));
            return;
          }
          set(update);
        },
      },
      structuralSharing: {
        share: (previous, next) => structurallySharePlainValue(previous, next),
      },
      transport: createTeamDirectoryTransport(),
    }),
    ...createTeamViewDataRendererSlice<TeamRequestScope, GlobalTaskProjectionNotification>({
      actions: {
        getActions: get,
      },
      coordinator: defaultTeamViewDataCoordinator,
      diagnostics: {
        debug: (message) => dependencies.log.debug(message),
        noteRefreshBurst: (teamName) =>
          noteTeamRefreshBurst(teamName, TEAM_REFRESH_BURST_WINDOW_MS),
        warn: (message) => dependencies.log.warn(message),
      },
      globalTasks: {
        buildNotification: buildGlobalTaskProjectionNotification,
        notify: processGlobalTaskNotifications,
        project: projectTeamSnapshotOntoGlobalTasks,
      },
      lifecycle: {
        isMemberActivityMetaStale: (teamName) => isMemberActivityMetaStale(get(), teamName),
        isProvisioningActive: (teamName) => dependencies.lifecycle.isProvisioningActive(teamName),
        recordLastResolvedRefresh: recordLastResolvedTeamDataRefresh,
        recordTaskBoardTransitions: recordTeamTaskBoardSnapshotTransitions,
        shouldInvalidateCachedData: shouldInvalidateCachedTeamDataForError,
      },
      requestScope: {
        capture: (teamName) => dependencies.requestScope.captureTeam(teamName),
        isCurrent: (teamName, scope) => dependencies.requestScope.isTeamCurrent(teamName, scope),
      },
      selectionEffects: {
        autoSelectProject: (projectPath) => {
          const state = get();
          const normalizedTeamPath = normalizePath(projectPath);
          const matchingProject = state.projects.find(
            (project) => normalizePath(project.path) === normalizedTeamPath
          );
          if (matchingProject && state.selectedProjectId !== matchingProject.id) {
            state.selectProject(matchingProject.id);
            return;
          }
          if (matchingProject) return;

          for (const repository of state.repositoryGroups) {
            const matchingWorktree = repository.worktrees.find(
              (worktree) => normalizePath(worktree.path) === normalizedTeamPath
            );
            if (!matchingWorktree) continue;
            if (state.selectedWorktreeId !== matchingWorktree.id) {
              set(getWorktreeNavigationState(repository.id, matchingWorktree.id));
              void get().fetchSessionsInitial(matchingWorktree.id);
            }
            break;
          }
        },
        loadToolApprovalSettings: (teamName) =>
          dependencies.settings.loadToolApprovalSettings(teamName),
        syncTabLabels: (teamName, displayName) => {
          const relatedTabs = get()
            .getAllPaneTabs()
            .filter(
              (tab) => (tab.type === 'team' || tab.type === 'graph') && tab.teamName === teamName
            );
          for (const tab of relatedTabs) {
            const nextLabel = tab.type === 'graph' ? `${displayName} Graph` : displayName;
            if (tab.label !== nextLabel) {
              get().updateTabLabel(tab.id, nextLabel);
            }
          }
        },
      },
      snapshots: {
        getForTeam: selectTeamDataForName,
        preserveKnownTaskChangePresence,
        shouldPreserveSelectedSnapshot: shouldPreserveSelectedTeamSnapshot,
        structurallyShare: structurallyShareTeamSnapshot,
      },
      state: {
        getState: get,
        setState: (update) => {
          if (typeof update === 'function') {
            set((state) => update(state));
            return;
          }
          set(update);
        },
      },
      tasks: {
        collectInvalidation: collectTaskChangeInvalidation,
      },
    }),
    ...createTeamMessageFeedRendererSlice<TeamRequestScope>({
      actions: {
        getActions: get,
      },
      activityPolicy: {
        isStale: isMemberActivityMetaStale,
        structurallyShareMembers: structurallyShareMemberActivityFacts,
      },
      cachePolicy: {
        areMessageArraysEquivalent: areInboxMessageArraysEquivalent,
        extractRetainedOlderTail: extractRetainedCanonicalOlderTail,
        getCanonicalHeadSlice,
        getEntry: getTeamMessagesCacheEntry,
        mergeMessages: mergeTeamMessages,
        pruneOptimisticMessages,
      },
      coordinator: defaultTeamMessageFeedCoordinator,
      pendingReplyPolicy: {
        setEnabled: setPendingReplyRefreshEnabled,
      },
      requestScope: {
        capture: (teamName) => dependencies.requestScope.captureTeam(teamName),
        isCurrent: (teamName, scope) => dependencies.requestScope.isTeamCurrent(teamName, scope),
      },
      state: {
        getState: get,
        setState: (update) => {
          if (typeof update === 'function') {
            set((state) => update(state));
            return;
          }
          set(update);
        },
      },
    }),
    ...createTeamMessageDeliveryRendererSlice<AppState, ContextRequestScope>({
      analytics: {
        classifyError: classifyAnalyticsError,
        recordAttachment: ({ attachments, success, errorClass }) =>
          dependencies.analytics.recordAttachmentEnd({
            source: 'message',
            success,
            fileCount: attachments.length,
            totalSizeBytes: getAttachmentTotalSizeBytes(attachments),
            mimeTypes: getAttachmentMimeTypes(attachments),
            errorClass,
          }),
        recordCrossTeamMessage: (input) =>
          dependencies.analytics.recordCrossTeamMessageSend({ ...input }),
      },
      clock: {
        nowIso: () => dependencies.clock.nowIso(),
      },
      crossTeamTransport: {
        listTargets: () => api.crossTeam.listTargets(),
        send: (request) => api.crossTeam.send(request),
      },
      diagnostics: {
        build: buildOpenCodeRuntimeDeliveryDiagnostics,
        isHardFailure: isOpenCodeRuntimeDeliveryHardUxFailure,
      },
      errors: {
        mapSendError: mapSendMessageError,
      },
      log: {
        recordCrossTeamTargetsFailure: (error) =>
          dependencies.log.error('fetchCrossTeamTargets failed', error),
      },
      optimisticMessages: {
        project: (state, teamName, message) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: upsertOptimisticTeamMessage(
              getTeamMessagesCacheEntry(state, teamName),
              message
            ),
          },
        }),
      },
      refresh: {
        refreshMessageHead: (teamName) => get().refreshTeamMessagesHead(teamName),
      },
      requestScope: {
        capture: () => dependencies.requestScope.captureContext(),
        isCurrent: (scope) => dependencies.requestScope.isContextCurrent(scope),
      },
      state: {
        getState: get,
        setState: (update) => {
          if (typeof update === 'function') {
            set((state) => update(state));
            return;
          }
          set(update);
        },
      },
      transport: {
        getRuntimeDeliveryStatus: (teamName, messageId) =>
          unwrapIpc('team:getOpenCodeRuntimeDeliveryStatus', () =>
            api.teams.getOpenCodeRuntimeDeliveryStatus(teamName, messageId)
          ),
        send: (teamName, request) =>
          unwrapIpc('team:sendMessage', () => api.teams.sendMessage(teamName, request)),
      },
    }),
    ...createTeamTaskBoardRendererSlice({
      getState: () => {
        const state = get();
        return {
          checkTaskHasChanges: state.checkTaskHasChanges,
          fetchAllTasks: () => state.fetchAllTasks(),
          getTeamData: (teamName) => selectTeamDataForName(state, teamName),
          invalidateTaskChangePresence: state.invalidateTaskChangePresence,
          refreshTeamData: (teamName) => state.refreshTeamData(teamName),
          selectedTeamData: state.selectedTeamData,
          selectedTeamName: state.selectedTeamName,
        };
      },
      mapReviewError,
      setState: (state) => set(state),
    }),
    ...createTeamTaskArtifactsRendererSlice<AppState, TeamRequestScope>({
      analytics: {
        classifyError: classifyAnalyticsError,
        recordAttachment: ({ attachments, source, success, errorClass }) =>
          dependencies.analytics.recordAttachmentEnd({
            source,
            success,
            fileCount: attachments.length,
            totalSizeBytes: getAttachmentTotalSizeBytes(attachments),
            mimeTypes: getAttachmentMimeTypes(attachments),
            errorClass,
          }),
      },
      ids: {
        randomUUID: () => crypto.randomUUID(),
      },
      refresh: {
        refreshTeamData: (teamName) => get().refreshTeamData(teamName),
      },
      requestScope: {
        capture: (teamName) => dependencies.requestScope.captureTeam(teamName),
        isCurrent: (teamName, scope) => dependencies.requestScope.isTeamCurrent(teamName, scope),
      },
      state: {
        getState: get,
        selectTeamData: (state, teamName) => selectTeamDataForName(state, teamName),
        setState: (update) => {
          if (typeof update === 'function') {
            set((state) => update(state));
            return;
          }
          set(update);
        },
      },
      transport: createTeamTaskArtifactsTransport(),
    }),
  };
}
