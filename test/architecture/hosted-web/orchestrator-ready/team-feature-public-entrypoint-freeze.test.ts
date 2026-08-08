import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = process.cwd();
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'src');
const FEATURES_ROOT = resolve(SOURCE_ROOT, 'features');

const TARGET_FEATURES = [
  'team-lifecycle',
  'team-message-delivery',
  'team-provisioning',
  'team-runtime-operations',
  'team-task-board',
  'team-view-read-model',
] as const;
const PUBLIC_FEATURE_ENTRYPOINTS = new Set(['contracts', 'main', 'preload', 'renderer']);
const HOSTED_SECONDARY_FEATURE_ENTRYPOINTS: Readonly<
  Partial<Record<(typeof TARGET_FEATURES)[number], ReadonlySet<string>>>
> = {
  'team-lifecycle': new Set(['main/hosted']),
  'team-task-board': new Set(['main/hosted']),
};
const PROVIDER_SPECIFIC_VOCABULARY = /OpenCode|opencode|Claude/;
const FORBIDDEN_PROVIDER_MODULE_SPECIFIER = /OpenCode|opencode|Claude|Codex/;
const FORBIDDEN_PUBLIC_EXPORT_NAME =
  /OpenCode|opencode|Claude|Codex|TeamProviderId|ProcessSupervisor|ProcessSupervision|process-supervision|createTeamLifecycleCommandFeature|TeamLifecycleCommandFeature|TeamLifecycleCommandPort|TeamIpcHandlerApis|TeamProvisioningApis|LegacyOpenCode/;

const EXACT_PUBLIC_EXPORTS = {
  'src/features/team-provisioning/index.ts': {
    typeExports: [
      'ProvisioningProgressUpdatePlan',
      'RuntimeDeliveryApi',
      'RuntimeDeliveryStatus',
      'RuntimeMessageDeliveryAck',
      'RuntimeMessageDeliveryAckLocation',
      'RuntimeMessageDeliveryAckState',
      'TeamProvisioningProgressState',
      'TeamProvisioningRuntimeSnapshotApi',
      'TeamProvisioningStatusApi',
      'TeamProvisioningToolApprovalApi',
      'RespondToToolApprovalCommand',
      'UpdateToolApprovalSettingsCommand',
    ],
    valueExports: [
      'TEAM_CANCEL_PROVISIONING',
      'TEAM_CREATE',
      'TEAM_LAUNCH',
      'TEAM_LAUNCH_FAILURE_DIAGNOSTICS',
      'TEAM_PREPARE_PROVISIONING',
      'TEAM_PROVISIONING_PROGRESS',
      'TEAM_PROVISIONING_STATUS',
      'TEAM_VALIDATE_CLI_ARGS',
      'isActiveProvisioningState',
      'isTerminalProvisioningState',
      'planProvisioningProgressUpdate',
      'shouldIgnoreProvisioningProgressRegression',
    ],
  },
  'src/features/team-provisioning/contracts/index.ts': {
    typeExports: [
      'RespondToToolApprovalCommand',
      'RuntimeDeliveryApi',
      'RuntimeDeliveryStatus',
      'RuntimeMessageDeliveryAck',
      'RuntimeMessageDeliveryAckLocation',
      'RuntimeMessageDeliveryAckState',
      'TeamProvisioningApplicationApi',
      'TeamProvisioningRuntimeDeliveryApi',
      'TeamProvisioningRuntimeSnapshotApi',
      'TeamProvisioningStatusApi',
      'TeamProvisioningToolApprovalApi',
      'UpdateToolApprovalSettingsCommand',
    ],
    valueExports: [
      'TEAM_CANCEL_PROVISIONING',
      'TEAM_CREATE',
      'TEAM_LAUNCH',
      'TEAM_LAUNCH_FAILURE_DIAGNOSTICS',
      'TEAM_PREPARE_PROVISIONING',
      'TEAM_PROVISIONING_PROGRESS',
      'TEAM_PROVISIONING_STATUS',
      'TEAM_VALIDATE_CLI_ARGS',
    ],
  },
  'src/features/team-provisioning/main/index.ts': {
    typeExports: [
      'TeamProvisioningApplicationFeature',
      'TeamProvisioningApplicationFeatureDependencies',
      'TeamProvisioningFeature',
      'TeamProvisioningIpcRegistrar',
      'TeamProvisioningProgressSource',
      'TeamProvisioningStatusFeatureDeps',
      'TeamProvisioningStatusRun',
    ],
    valueExports: [
      'createTeamProvisioningApplicationFeature',
      'createTeamProvisioningFeature',
      'createTeamProvisioningStatusFeature',
      'registerTeamProvisioningIpc',
      'removeTeamProvisioningIpc',
    ],
  },
  'src/features/team-provisioning/renderer/index.ts': {
    typeExports: [
      'TeamLaunchAnalyticsCoordinatorDependencies',
      'TeamLaunchAnalyticsContext',
      'TeamLaunchParams',
      'TeamListProvisioningLaunchPort',
      'TeamListProvisioningPorts',
      'TeamProvisioningControlEffectsPort',
      'TeamProvisioningControlSlice',
      'TeamProvisioningControlSliceDependencies',
      'TeamProvisioningControlStatePort',
      'TeamProvisioningControlStoreState',
      'TeamProvisioningControlTransportPort',
      'TeamProvisioningDiagnosticsRendererPorts',
      'TeamProvisioningLaunchAnalyticsPort',
      'TeamProvisioningLaunchClockPort',
      'TeamProvisioningLaunchControlPort',
      'TeamProvisioningLaunchMessageEntry',
      'TeamProvisioningLaunchPersistencePort',
      'TeamProvisioningLaunchScopePort',
      'TeamProvisioningLaunchSlice',
      'TeamProvisioningLaunchSliceDependencies',
      'TeamProvisioningLaunchStatePort',
      'TeamProvisioningLaunchStoreState',
      'TeamProvisioningLaunchTransportPort',
      'TeamProvisioningPreparationRendererPort',
      'TeamProvisioningPreparationRendererPorts',
      'TeamProvisioningProgressAnalyticsPort',
      'TeamProvisioningProgressRefreshPort',
      'TeamProvisioningProgressRuntimePort',
      'TeamProvisioningProgressSlice',
      'TeamProvisioningProgressSliceDependencies',
      'TeamProvisioningProgressStatePort',
      'TeamProvisioningProgressStoreState',
      'TeamProvisioningRefreshFanoutNote',
      'TeamProvisioningSurfaceSnapshot',
      'TeamRuntimeObservationBackoffPort',
      'TeamRuntimeObservationMemberSpawnPolicyPort',
      'TeamRuntimeObservationRequestScopePort',
      'TeamRuntimeObservationSlice',
      'TeamRuntimeObservationSliceDependencies',
      'TeamRuntimeObservationSnapshotPolicyPort',
      'TeamRuntimeObservationStatePort',
      'TeamRuntimeObservationTransportPort',
      'TeamToolApprovalErrorLogPort',
      'TeamToolApprovalProjectionPort',
      'TeamToolApprovalRendererSlice',
      'TeamToolApprovalRendererSliceActions',
      'TeamToolApprovalRendererSliceDependencies',
      'TeamToolApprovalRendererSliceState',
      'TeamToolApprovalRendererState',
      'TeamToolApprovalRendererStatePort',
      'TeamToolApprovalRendererTransportPort',
      'TeamToolApprovalResponseTransportPort',
      'TeamToolApprovalSettingsLoadPort',
      'TeamToolApprovalSettingsSyncPort',
      'TeamWorktreeGitReadinessRendererPorts',
      'WorktreeGitReadinessState',
    ],
    valueExports: [
      'TeamRuntimeFreshnessCoordinator',
      'areTeamLaunchParamsEqual',
      'buildLaunchParamsFromRuntimeRequest',
      'createProductTeamLaunchAnalyticsCoordinator',
      'createTeamListProvisioningPorts',
      'createTeamProvisioningControlSlice',
      'createTeamProvisioningLaunchSlice',
      'createTeamProvisioningProgressSlice',
      'createTeamRuntimeObservationSlice',
      'createTeamToolApprovalRendererSlice',
      'extractBaseModel',
      'loadTeamToolApprovalSettingsIntoRenderer',
      'normalizePersistedTeamLaunchParams',
      'useWorktreeGitReadiness',
    ],
  },
  'src/features/team-view-read-model/index.ts': {
    typeExports: [],
    valueExports: ['TEAM_GET_DATA', 'TEAM_GET_MEMBER_ACTIVITY_META', 'TEAM_GET_MESSAGES_PAGE'],
  },
  'src/features/team-view-read-model/contracts/index.ts': {
    typeExports: [],
    valueExports: ['TEAM_GET_DATA', 'TEAM_GET_MEMBER_ACTIVITY_META', 'TEAM_GET_MESSAGES_PAGE'],
  },
  'src/features/team-view-read-model/main/index.ts': {
    typeExports: [
      'TeamLeadSessionMessageReaderParseCache',
      'TeamLeadSessionMessageReaderProjectResolver',
      'TeamProvisioningRunReadPort',
      'TeamViewMemberResolutionOptions',
      'TeamViewReadModelFeature',
      'TeamViewSnapshotAssemblerPorts',
      'TeamViewSnapshotRuntimeMeta',
      'TeamViewTaskChangeLogSourceSnapshot',
      'TeamViewTaskChangePresenceRead',
    ],
    valueExports: [
      'TeamLeadSessionMessageReader',
      'TeamPermanentDeletionTransactionCoordinator',
      'TeamViewSnapshotAssembler',
      'createTeamViewReadModelFeature',
      'registerTeamViewReadModelIpc',
      'removeTeamViewReadModelIpc',
    ],
  },
  'src/features/team-view-read-model/renderer/index.ts': {
    typeExports: [
      'GlobalTaskProjectionNotification',
      'RefreshTeamDataOptions',
      'RefreshTeamMessagesHeadResult',
      'SelectTeamOptions',
      'TeamBranchTrackingRegistration',
      'TeamBranchTrackingRendererPorts',
      'TeamDataSnapshotMode',
      'TeamDirectoryNotificationPort',
      'TeamDirectoryPathPort',
      'TeamDirectoryRefreshCoordinatorPort',
      'TeamDirectoryRendererSlice',
      'TeamDirectoryRendererSliceActions',
      'TeamDirectoryRendererSliceDependencies',
      'TeamDirectoryRendererSliceState',
      'TeamDirectoryRendererState',
      'TeamDirectoryRequestScopePort',
      'TeamDirectorySchedulerPort',
      'TeamDirectoryStatePort',
      'TeamDirectoryStructuralSharingPort',
      'TeamDirectoryTransportPort',
      'TeamListViewReadPorts',
      'TeamMessageFeedActionsPort',
      'TeamMessageFeedActivityPolicyPort',
      'TeamMessageFeedCachePolicyPort',
      'TeamMessageFeedPendingReplyPolicyPort',
      'TeamMessageFeedRendererSlice',
      'TeamMessageFeedRendererSliceActions',
      'TeamMessageFeedRendererSliceDependencies',
      'TeamMessageFeedRendererState',
      'TeamMessageFeedCoordinatorSnapshot',
      'TeamMessageFeedRequestScopePort',
      'TeamMessageFeedStatePort',
      'TeamMessageFeedTransportPort',
      'TeamMessagesCacheEntry',
      'TeamMessagesPanelMode',
      'TeamOperationalLogPage',
      'TeamOperationalLogQuery',
      'TeamOperationalReadRendererPorts',
      'TeamSummaryIndexes',
      'TeamViewDataActionsPort',
      'TeamViewDataDiagnosticsPort',
      'TeamViewDataGlobalTaskProjectionPort',
      'TeamViewDataLifecyclePort',
      'TeamViewDataRendererSlice',
      'TeamViewDataRendererSliceActions',
      'TeamViewDataRendererSliceDependencies',
      'TeamViewDataRendererSliceState',
      'TeamViewDataRendererState',
      'TeamViewDataRequestScopePort',
      'TeamViewDataSelectionEffectsPort',
      'TeamViewDataSnapshotPolicyPort',
      'TeamViewDataStatePort',
      'TeamViewDataTaskInvalidation',
      'TeamViewDataTaskPolicyPort',
      'TeamViewDataTransportPort',
      'TeamViewDataCoordinatorSnapshot',
      'TeamViewPreferencesPersistencePort',
      'TeamViewPreferencesRendererSlice',
      'TeamViewPreferencesRendererSliceActions',
      'TeamViewPreferencesRendererSliceDependencies',
      'TeamViewPreferencesRendererSliceState',
      'TeamViewPreferencesStatePort',
    ],
    valueExports: [
      'TeamBranchTrackingCoordinator',
      'TeamDirectoryRefreshCoordinator',
      'TeamMessageFeedCoordinator',
      'TeamViewDataCoordinator',
      'buildGlobalTaskProjectionNotification',
      'buildTeamSummaryIndexes',
      'createTeamDirectoryRendererSlice',
      'createTeamListViewReadPorts',
      'createTeamMessageFeedRendererSlice',
      'createTeamViewDataRendererSlice',
      'createTeamViewPreferencesRendererSlice',
      'defaultTeamMessageFeedCoordinator',
      'defaultTeamViewDataCoordinator',
      'getFullTeamDataRequestKey',
      'getTeamDataRequestKey',
      'getTeamDataRequestLabel',
      'getTeamDataSnapshotMode',
      'getThinTeamDataRequestKey',
      'isTeamDataRequestKeyForTeam',
      'normalizeTeamGetDataOptions',
      'removeProvisioningSnapshotsForTeams',
      'shouldIncludeMemberBranches',
    ],
  },
  'src/features/team-task-board/contracts/index.ts': {
    typeExports: [
      'AddTaskCommentRequest',
      'AttachmentMediaType',
      'CreateTaskRequest',
      'GlobalTask',
      'KanbanColumnId',
      'TaskAttachmentMeta',
      'TaskChangePresenceState',
      'TaskComment',
      'TaskRef',
      'TeamTask',
      'TeamTaskStatus',
      'TeamTaskWithKanban',
      'UpdateKanbanPatch',
    ],
    valueExports: [
      'TEAM_ADD_TASK_COMMENT',
      'TEAM_ADD_TASK_RELATIONSHIP',
      'TEAM_CREATE_TASK',
      'TEAM_DELETE_TASK_ATTACHMENT',
      'TEAM_GET_ALL_TASKS',
      'TEAM_GET_DELETED_TASKS',
      'TEAM_GET_TASK',
      'TEAM_GET_TASK_ATTACHMENT',
      'TEAM_GET_TASK_CHANGE_PRESENCE',
      'TEAM_REMOVE_TASK_RELATIONSHIP',
      'TEAM_REQUEST_REVIEW',
      'TEAM_RESTORE_TASK',
      'TEAM_SAVE_TASK_ATTACHMENT',
      'TEAM_SET_CHANGE_PRESENCE_TRACKING',
      'TEAM_SET_TASK_CLARIFICATION',
      'TEAM_SOFT_DELETE_TASK',
      'TEAM_START_TASK',
      'TEAM_START_TASK_BY_USER',
      'TEAM_UPDATE_KANBAN',
      'TEAM_UPDATE_KANBAN_COLUMN_ORDER',
      'TEAM_UPDATE_TASK_FIELDS',
      'TEAM_UPDATE_TASK_OWNER',
      'TEAM_UPDATE_TASK_STATUS',
    ],
  },
  'src/features/team-task-board/index.ts': {
    typeExports: [
      'AttachmentMediaType',
      'TaskAttachmentMeta',
      'TeamArtifactMaintenanceReconciliationPort',
      'TeamArtifactMaintenanceReconciliationRequest',
      'TeamArtifactReconciliationMonotonicClockPort',
      'TeamArtifactReconciliationPorts',
      'TeamArtifactReconciliationResult',
      'TeamArtifactReconciliationTrigger',
      'TeamArtifactReconciliationWarningLoggerPort',
    ],
    valueExports: [
      'TEAM_ADD_TASK_COMMENT',
      'TEAM_ADD_TASK_RELATIONSHIP',
      'TEAM_CREATE_TASK',
      'TEAM_DELETE_TASK_ATTACHMENT',
      'TEAM_GET_ALL_TASKS',
      'TEAM_GET_DELETED_TASKS',
      'TEAM_GET_TASK',
      'TEAM_GET_TASK_ATTACHMENT',
      'TEAM_GET_TASK_CHANGE_PRESENCE',
      'TEAM_REMOVE_TASK_RELATIONSHIP',
      'TEAM_REQUEST_REVIEW',
      'TEAM_RESTORE_TASK',
      'TEAM_SAVE_TASK_ATTACHMENT',
      'TEAM_SET_CHANGE_PRESENCE_TRACKING',
      'TEAM_SET_TASK_CLARIFICATION',
      'TEAM_SOFT_DELETE_TASK',
      'TEAM_START_TASK',
      'TEAM_START_TASK_BY_USER',
      'TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH',
      'TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES',
      'TEAM_UPDATE_KANBAN',
      'TEAM_UPDATE_KANBAN_COLUMN_ORDER',
      'TEAM_UPDATE_TASK_FIELDS',
      'TEAM_UPDATE_TASK_OWNER',
      'TEAM_UPDATE_TASK_STATUS',
      'TeamArtifactReconciliationCoordinator',
      'estimateTaskAttachmentDecodedBytes',
      'isCanonicalTaskAttachmentBase64',
      'isCanonicalTaskAttachmentId',
    ],
  },
  'src/features/team-task-board/main/index.ts': {
    typeExports: [
      'TaskMutationBoardPort',
      'TeamTaskBoardCompatibilityApi',
      'TeamTaskBoardFeature',
      'TeamTaskBoardIpcDependencies',
      'TeamTaskCreateOutcome',
      'TeamTaskMutationBoardPort',
      'TeamTaskMutationClockPort',
      'TeamTaskMutationCoordinatorPorts',
      'TeamTaskMutationIdentityPort',
      'TeamTaskMutationLeadContextPort',
      'TeamTaskMutationLeadRuntimeContext',
      'TeamTaskMutationProjectionPort',
      'TeamTaskStartBoardPort',
      'TeamTaskStartCoordinatorPorts',
      'UpdateTaskFieldsPort',
    ],
    valueExports: [
      'TeamTaskMutationCoordinator',
      'TeamTaskStartCoordinator',
      'createTeamTaskBoardFeature',
      'registerTeamTaskBoardIpc',
      'removeTeamTaskBoardIpc',
    ],
  },
  'src/features/team-task-board/main/hosted.ts': {
    typeExports: [
      'ExecuteHostedTaskMutationResult',
      'GetHostedTaskBoardPageResult',
      'HostedTaskBoardAuthorityMutationRequest',
      'HostedTaskBoardAuthorityMutationResult',
      'HostedTaskBoardAuthorityPort',
      'HostedTaskBoardAuthorityReadWindowRequest',
      'HostedTaskBoardAuthorityReadWindowResult',
      'HostedTaskBoardClockPort',
      'HostedTaskBoardColumn',
      'HostedTaskBoardItem',
      'HostedTaskBoardPage',
      'HostedTaskBoardPageCandidate',
      'HostedTaskBoardPageRequest',
      'HostedTaskBoardPageSourcePort',
      'HostedTaskBoardPageSourceRequest',
      'HostedTaskBoardPageSourceResult',
      'HostedTaskBoardSourceGeneration',
      'HostedTaskCommandId',
      'HostedTaskIdempotencyKey',
      'HostedTaskMutationAdmissionPort',
      'HostedTaskMutationAdmissionResult',
      'HostedTaskMutationCommand',
      'HostedTaskMutationCommittedReceipt',
      'HostedTaskMutationReceipt',
      'HostedTaskMutationReplayReceipt',
      'HostedTaskStatus',
      'HostedTeamTaskBoardContextFactory',
      'HostedTeamTaskBoardFeature',
      'HostedTeamTaskBoardHttpFacade',
      'HostedTeamTaskBoardOutputAdapters',
      'TaskId',
    ],
    valueExports: [
      'HOSTED_TASK_BOARD_COLUMNS',
      'HOSTED_TASK_BOARD_DEGRADED_REASONS',
      'HOSTED_TASK_BOARD_MUTATION_ROUTE',
      'HOSTED_TASK_BOARD_PAGE_ROUTE',
      'HOSTED_TASK_BOARD_SCHEMA_VERSION',
      'HOSTED_TASK_BOARD_TRUNCATION_REASONS',
      'HOSTED_TASK_RELATIONSHIP_KINDS',
      'HOSTED_TASK_STATUSES',
      'HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS',
      'HostedTaskBoardAuthorityAdapter',
      'createHostedTeamTaskBoardFeature',
      'createHostedTeamTaskBoardOutputAdapters',
      'createHostedTeamTaskBoardRouteContribution',
      'normalizeHostedTaskMutationReceipt',
      'parseHostedTaskBoardSourceGeneration',
      'parseHostedTaskCommandId',
      'parseHostedTaskId',
      'parseHostedTaskIdempotencyKey',
      'parseHostedTaskMutationCommand',
      'registerHostedTeamTaskBoardHttp',
    ],
  },
  'src/features/team-lifecycle/main/hosted.ts': {
    typeExports: [
      'HostedLifecycleAuthorizationGeneration',
      'HostedLifecycleCommand',
      'HostedLifecycleCommandAction',
      'HostedLifecycleCommandAuthorization',
      'HostedLifecycleCommandAuthorizationResult',
      'HostedLifecycleCommandConflict',
      'HostedLifecycleCommandContextFactory',
      'HostedLifecycleCommandExecutionResult',
      'HostedLifecycleCommandFeature',
      'HostedLifecycleCommandGatewayExecutionResult',
      'HostedLifecycleCommandGatewayPort',
      'HostedLifecycleCommandHttpFacade',
      'HostedLifecycleCommandId',
      'HostedLifecycleCommandNotFound',
      'HostedLifecycleCommandPublicResult',
      'HostedLifecycleCommandReceipt',
      'HostedLifecycleCommandRevalidationResult',
      'HostedLifecycleCommandUnavailable',
      'HostedLifecycleConflictReason',
      'HostedLifecycleControlState',
      'HostedLifecycleControlStateAction',
      'HostedLifecycleControlStateRequest',
      'HostedLifecycleControlStateResult',
      'HostedLifecycleGrantId',
      'HostedLifecycleIdempotencyKey',
      'OrchestratorLifecycleCommandClientOptions',
    ],
    valueExports: [
      'ExecuteHostedLifecycleCommand',
      'GetHostedLifecycleControlState',
      'HOSTED_LIFECYCLE_COMMAND_ACTIONS',
      'HOSTED_LIFECYCLE_COMMAND_ROUTES',
      'HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS',
      'HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION',
      'HOSTED_LIFECYCLE_CONFLICT_REASONS',
      'HOSTED_LIFECYCLE_CONTROL_STATE_ACTIONS',
      'HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR',
      'OrchestratorLifecycleCommandClient',
      'createHostedLifecycleCommandFeature',
      'createHostedLifecycleCommandRouteContribution',
      'isHostedLifecycleCommandAction',
      'parseHostedLifecycleCommand',
      'parseHostedLifecycleCommandId',
      'parseHostedLifecycleCommandPublicResult',
      'parseHostedLifecycleControlState',
      'parseHostedLifecycleControlStateRequest',
      'parseHostedLifecycleIdempotencyKey',
      'registerHostedLifecycleCommandHttp',
    ],
  },
  'src/features/team-task-board/renderer/index.ts': {
    typeExports: [
      'HostedTaskBoardFetchPort',
      'HostedTaskBoardHttpRequestInit',
      'HostedTaskBoardHttpResponse',
      'HostedTaskBoardPageProps',
      'HostedTaskBoardTransport',
      'HostedTaskBoardTransportDependencies',
      'HostedTaskBoardTransportOptions',
      'TeamTaskBoardTransport',
      'TaskChangeInvalidation',
      'TeamTaskArtifactAnalyticsAttachment',
      'TeamTaskArtifactFile',
      'TeamTaskArtifactsRendererSlice',
      'TeamTaskArtifactsRendererSliceDependencies',
      'TeamTaskArtifactsRendererState',
      'TeamTaskArtifactsTransport',
      'TeamTaskBoardRendererSlice',
      'TeamTaskBoardRendererSliceDependencies',
      'TeamTaskBoardRendererStoreContext',
      'TeamTaskDetailRendererPorts',
      'TeamTaskNotificationTransportPort',
    ],
    valueExports: [
      'HOSTED_TASK_BOARD_PAGE_HTTP_PATH',
      'HostedTaskBoardPage',
      'clearTeamTaskBoardAnalytics',
      'collectTaskChangeInvalidation',
      'createHostedTaskBoardTransport',
      'createTeamTaskArtifactsRendererSlice',
      'createTeamTaskBoardRendererSlice',
      'preserveKnownTaskChangePresence',
      'recordTeamTaskBoardSnapshotTransitions',
      'resetTeamTaskBoardAnalyticsForTests',
    ],
  },
  'src/features/team-message-delivery/contracts/index.ts': {
    typeExports: [
      'RuntimeDeliveryAttempt',
      'RuntimeDeliveryDebugDetails',
      'RuntimeDeliveryStatus',
      'RuntimeDeliveryUserVisibleImpact',
      'RuntimeDeliveryUserVisibleState',
    ],
    valueExports: [
      'TEAM_GET_ATTACHMENTS',
      'TEAM_GET_RUNTIME_DELIVERY_STATUS',
      'TEAM_PROCESS_ALIVE',
      'TEAM_PROCESS_SEND',
      'TEAM_SEND_MESSAGE',
    ],
  },
  'src/features/team-message-delivery/index.ts': {
    typeExports: [
      'RuntimeDeliveryAttempt',
      'RuntimeDeliveryDebugDetails',
      'RuntimeDeliveryStatus',
      'RuntimeDeliveryUserVisibleImpact',
      'RuntimeDeliveryUserVisibleState',
    ],
    valueExports: [
      'TEAM_GET_ATTACHMENTS',
      'TEAM_GET_RUNTIME_DELIVERY_STATUS',
      'TEAM_PROCESS_ALIVE',
      'TEAM_PROCESS_SEND',
      'TEAM_SEND_MESSAGE',
      'validateAttachmentSerializedPayload',
      'validateAttachments',
    ],
  },
  'src/features/team-message-delivery/main/index.ts': {
    typeExports: [
      'CreateHostedTeamMessageRouteContributionDependencies',
      'DesktopTeamMessageDeliveryCompatibilityHost',
      'DesktopTeamMessageDeliveryFeature',
      'DesktopTeamMessageDeliveryFeatureDependencies',
      'HostedTeamMessageRouteAccess',
      'HostedTeamMessageRouteContribution',
      'HostedTeamMessageRouteFactory',
      'TeamMessageDeliveryFeature',
      'TeamMessageDeliveryFeatureDependencies',
      'TeamMessageDeliveryIpcDependencies',
      'TeamMessageDeliveryIpcMainPort',
      'TeamMessageDeliveryRepositoryPort',
      'TeamMessageLeadResolutionPort',
      'TeamMessagePersistenceCoordinatorPorts',
      'TeamMessagePersistenceFacade',
      'TeamMessageSystemNotificationPort',
    ],
    valueExports: [
      'createDesktopTeamMessageDeliveryFeature',
      'createHostedTeamMessageRouteContribution',
      'createHostedTeamMessageRouteFactory',
      'createTeamMessageDeliveryFeature',
      'createTeamMessagePersistenceFacade',
      'registerTeamMessageDeliveryIpc',
      'removeTeamMessageDeliveryIpc',
    ],
  },
  'src/features/team-message-delivery/renderer/index.ts': {
    typeExports: [
      'CrossTeamMessageAnalyticsInput',
      'CrossTeamMessageDeliveryTransportPort',
      'HostedTeamMessageFetchPort',
      'HostedTeamMessageHttpRequestInit',
      'HostedTeamMessageHttpResponse',
      'HostedTeamMessagePanelProps',
      'HostedTeamMessageTransport',
      'HostedTeamMessageTransportDependencies',
      'HostedTeamMessageTransportOptions',
      'TeamMessageAttachmentReadPort',
      'TeamMessageAttachmentAnalyticsInput',
      'TeamMessageDeliveryAnalyticsPort',
      'TeamMessageDeliveryClockPort',
      'TeamMessageDeliveryDiagnosticsLogPort',
      'TeamMessageDeliveryDiagnosticsPort',
      'TeamMessageDeliveryDiagnosticsProjection',
      'TeamMessageDeliveryErrorPolicyPort',
      'TeamMessageDeliveryOptimisticMessagePort',
      'TeamMessageDeliveryRefreshPort',
      'TeamMessageDeliveryRendererSlice',
      'TeamMessageDeliveryRendererSliceActions',
      'TeamMessageDeliveryRendererSliceDependencies',
      'TeamMessageDeliveryRendererSliceState',
      'TeamMessageDeliveryRendererTransports',
      'TeamMessageDeliveryRequestScopePort',
      'TeamMessageDeliveryStatePort',
      'TeamMessageDeliveryTarget',
      'TeamMessageDeliveryTransportPort',
    ],
    valueExports: [
      'createHostedTeamMessageTransport',
      'createTeamMessageDeliveryRendererSlice',
      'HostedTeamMessagePanel',
    ],
  },
  'src/features/team-runtime-operations/contracts/index.ts': {
    typeExports: ['RetryFailedRuntimeLanesResult', 'RuntimeLogQuery', 'RuntimeLogResponse'],
    valueExports: [
      'TEAM_ALIVE_LIST',
      'TEAM_GET_AGENT_RUNTIME',
      'TEAM_GET_LOGS_FOR_TASK',
      'TEAM_GET_MEMBER_LOGS',
      'TEAM_GET_MEMBER_STATS',
      'TEAM_GET_RUNTIME_LOGS',
      'TEAM_KILL_PROCESS',
      'TEAM_LEAD_ACTIVITY',
      'TEAM_LEAD_CONTEXT',
      'TEAM_MEMBER_SPAWN_STATUSES',
      'TEAM_RESTART_MEMBER',
      'TEAM_RETRY_FAILED_RUNTIME_LANES',
      'TEAM_SKIP_MEMBER_FOR_LAUNCH',
      'TEAM_STOP',
    ],
  },
  'src/features/team-runtime-operations/index.ts': {
    typeExports: ['RetryFailedRuntimeLanesResult', 'RuntimeLogQuery', 'RuntimeLogResponse'],
    valueExports: [
      'TEAM_ALIVE_LIST',
      'TEAM_GET_AGENT_RUNTIME',
      'TEAM_GET_LOGS_FOR_TASK',
      'TEAM_GET_MEMBER_LOGS',
      'TEAM_GET_MEMBER_STATS',
      'TEAM_GET_RUNTIME_LOGS',
      'TEAM_KILL_PROCESS',
      'TEAM_LEAD_ACTIVITY',
      'TEAM_LEAD_CONTEXT',
      'TEAM_MEMBER_SPAWN_STATUSES',
      'TEAM_RESTART_MEMBER',
      'TEAM_RETRY_FAILED_RUNTIME_LANES',
      'TEAM_SKIP_MEMBER_FOR_LAUNCH',
      'TEAM_STOP',
    ],
  },
  'src/features/team-runtime-operations/main/index.ts': {
    typeExports: [
      'TeamRuntimeOperationsFeature',
      'TeamRuntimeOperationsHostPorts',
      'TeamRuntimeOperationsIpcRegistrar',
    ],
    valueExports: [
      'createTeamRuntimeLifecycleHostPort',
      'createTeamRuntimeOperationsFeature',
      'registerTeamRuntimeOperationsIpc',
      'removeTeamRuntimeOperationsIpc',
    ],
  },
  'src/features/team-runtime-operations/renderer/index.ts': {
    typeExports: [
      'TeamRuntimeOperationsActionsPort',
      'TeamRuntimeOperationsRefreshActions',
      'TeamRuntimeOperationsRendererSlice',
      'TeamRuntimeOperationsRendererSliceDependencies',
      'TeamRuntimeOperationsRendererTransportPort',
      'TeamRuntimeSecondaryLaneRetryResult',
    ],
    valueExports: ['createTeamRuntimeOperationsRendererSlice'],
  },
  'src/features/team-lifecycle/renderer/index.ts': {
    typeExports: [
      'HostedTeamLifecycleFetchPort',
      'HostedTeamLifecycleHttpResponse',
      'HostedTeamLifecycleListProps',
      'HostedTeamLifecycleTransportDependencies',
      'TeamLifecycleListItemViewModel',
      'TeamLifecycleListStatusLabelKey',
      'TeamLifecycleListStatusTone',
      'TeamLifecycleListViewModel',
      'TeamLifecycleMutationAnalyticsPort',
      'TeamLifecycleMutationCleanupPort',
      'TeamLifecycleMutationClockPort',
      'TeamLifecycleMutationKind',
      'TeamLifecycleMutationRefreshPort',
      'TeamLifecycleMutationSelectionState',
      'TeamLifecycleMutationSlice',
      'TeamLifecycleMutationSliceDependencies',
      'TeamLifecycleMutationStateCleanupDependencies',
      'TeamLifecycleMutationStatePort',
      'TeamLifecycleMutationTransportPort',
      'TeamListLifecyclePorts',
      'UseTeamLifecycleListResult',
    ],
    valueExports: [
      'HOSTED_TEAM_LIFECYCLE_TIMEOUT_MS',
      'HostedTeamLifecycleList',
      'LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL',
      'TEAM_LIFECYCLE_LIST_MAX_ITEMS',
      'TEAM_LIFECYCLE_LIST_MAX_PAGES',
      'createHostedTeamLifecycleTransport',
      'createTeamLifecycleMutationCleanup',
      'createTeamLifecycleMutationSlice',
      'createTeamListLifecyclePorts',
      'loadTeamLifecycleList',
      'toTeamLifecycleListItemViewModel',
      'toTeamLifecycleListViewModel',
      'useTeamLifecycleList',
    ],
  },
} as const;

const LEGACY_DEEP_IMPORT_BASELINE = new Set<string>();

const PORT_SOURCE =
  'src/features/team-view-read-model/core/application/ports/TeamViewReadModelPorts.ts';
const PORT_NAME = 'TeamProvisioningRunReadPort';
const PORT_CONSUMERS = {
  'src/features/team-view-read-model/main/adapters/output/FileSystemMissingTeamStateReader.ts':
    '../../../core/application/ports/TeamViewReadModelPorts',
  'src/features/team-view-read-model/main/composition/createTeamViewReadModelFeature.ts':
    '../../core/application/ports/TeamViewReadModelPorts',
} as const;

interface ModuleReference {
  specifier: string;
  line: number;
}

interface DeepImportViolation extends ModuleReference {
  importer: string;
  feature: (typeof TARGET_FEATURES)[number];
}

function toRepositoryPath(path: string): string {
  return path.split('\\').join('/');
}

function source(path: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');
}

function parseSource(path: string, contents = source(path)): ts.SourceFile {
  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, scriptKind);
}

function isProductionTypeScript(path: string): boolean {
  const normalized = toRepositoryPath(path);
  return (
    /\.tsx?$/.test(normalized) &&
    !/\.(?:spec|test)\.tsx?$/.test(normalized) &&
    !/(?:^|\/)__tests__(?:\/|$)/.test(normalized)
  );
}

function productionSourceFiles(directory = SOURCE_ROOT): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSourceFiles(absolutePath));
    } else if (entry.isFile()) {
      const repositoryPath = toRepositoryPath(relative(REPOSITORY_ROOT, absolutePath));
      if (isProductionTypeScript(repositoryPath)) {
        files.push(repositoryPath);
      }
    }
  }

  return files.sort();
}

function collectModuleReferences(path: string, contents = source(path)): ModuleReference[] {
  const sourceFile = parseSource(path, contents);
  const references: ModuleReference[] = [];

  const record = (literal: ts.StringLiteralLike): void => {
    references.push({
      specifier: literal.text,
      line: sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        record(argument.literal);
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      record(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function normalizeFeatureSubpath(parts: string[]): string[] {
  const normalized = [...parts];
  const lastIndex = normalized.length - 1;

  if (lastIndex >= 0) {
    normalized[lastIndex] = normalized[lastIndex].replace(/\.(?:[cm]?js|jsx|tsx?)$/, '');
  }
  if (normalized.at(-1) === 'index') {
    normalized.pop();
  }

  return normalized;
}

function targetFeatureImport(
  importer: string,
  specifier: string
): { feature: (typeof TARGET_FEATURES)[number]; subpath: string[] } | null {
  let featurePath: string;

  if (specifier.startsWith('@features/')) {
    featurePath = specifier.slice('@features/'.length);
  } else if (specifier.startsWith('.')) {
    const importedPath = resolve(dirname(resolve(REPOSITORY_ROOT, importer)), specifier);
    featurePath = toRepositoryPath(relative(FEATURES_ROOT, importedPath));
    if (featurePath === '..' || featurePath.startsWith('../')) {
      return null;
    }
  } else {
    return null;
  }

  const [feature, ...subpath] = featurePath.split('/');
  if (!TARGET_FEATURES.includes(feature as (typeof TARGET_FEATURES)[number])) {
    return null;
  }

  return {
    feature: feature as (typeof TARGET_FEATURES)[number],
    subpath: normalizeFeatureSubpath(subpath),
  };
}

function isInternalFeatureImport(
  importer: string,
  feature: (typeof TARGET_FEATURES)[number]
): boolean {
  return importer.startsWith(`src/features/${feature}/`);
}

function isPublicFeatureEntrypoint(
  feature: (typeof TARGET_FEATURES)[number],
  subpath: string[]
): boolean {
  const entrypoint = subpath.join('/');
  return (
    subpath.length === 0 ||
    PUBLIC_FEATURE_ENTRYPOINTS.has(entrypoint) ||
    HOSTED_SECONDARY_FEATURE_ENTRYPOINTS[feature]?.has(entrypoint) === true
  );
}

function findDeepImportViolations(
  importer: string,
  contents = source(importer)
): DeepImportViolation[] {
  const violations: DeepImportViolation[] = [];

  for (const reference of collectModuleReferences(importer, contents)) {
    const target = targetFeatureImport(importer, reference.specifier);
    if (
      !target ||
      isInternalFeatureImport(importer, target.feature) ||
      isPublicFeatureEntrypoint(target.feature, target.subpath)
    ) {
      continue;
    }

    violations.push({ importer, feature: target.feature, ...reference });
  }

  return violations;
}

function deepImportIdentity(violation: DeepImportViolation): string {
  return [violation.importer, violation.specifier].join('\0');
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
  );
}

function publicExportShape(
  path: string,
  contents = source(path)
): {
  unsupported: string[];
  typeExports: string[];
  valueExports: string[];
} {
  const sourceFile = parseSource(path, contents);
  const typeExports: string[] = [];
  const valueExports: string[] = [];
  const unsupported: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      unsupported.push(statement.isExportEquals ? 'export =' : 'export default');
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        unsupported.push(statement.getText(sourceFile));
        continue;
      }

      for (const element of statement.exportClause.elements) {
        const exports = statement.isTypeOnly || element.isTypeOnly ? typeExports : valueExports;
        exports.push(element.name.text);
      }
      continue;
    }

    if (!hasExportModifier(statement)) {
      continue;
    }

    if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      unsupported.push('export default');
      continue;
    }

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      typeExports.push(statement.name.text);
    } else if (
      (ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)) &&
      statement.name
    ) {
      valueExports.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          valueExports.push(declaration.name.text);
        } else {
          unsupported.push(declaration.getText(sourceFile));
        }
      }
    } else {
      unsupported.push(statement.getText(sourceFile));
    }
  }

  return {
    unsupported,
    typeExports: typeExports.sort(),
    valueExports: valueExports.sort(),
  };
}

function forbiddenPublicExportNames(path: string): string[] {
  const shape = publicExportShape(path);
  return [...shape.typeExports, ...shape.valueExports].filter((name) =>
    FORBIDDEN_PUBLIC_EXPORT_NAME.test(name)
  );
}

function forbiddenProviderModuleSpecifiers(path: string): string[] {
  return collectModuleReferences(path)
    .map(({ specifier }) => specifier)
    .filter((specifier) => FORBIDDEN_PROVIDER_MODULE_SPECIFIER.test(specifier));
}

function typeOnlyNamedImports(
  path: string,
  importedName: string
): Array<{ moduleSpecifier: string; typeOnly: boolean }> {
  const imports: Array<{ moduleSpecifier: string; typeOnly: boolean }> = [];

  for (const statement of parseSource(path).statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !statement.importClause.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }

    for (const element of statement.importClause.namedBindings.elements) {
      const localName = element.name.text;
      const sourceName = element.propertyName?.text ?? localName;
      if (sourceName === importedName) {
        imports.push({
          moduleSpecifier: statement.moduleSpecifier.text,
          typeOnly: statement.importClause.isTypeOnly || element.isTypeOnly,
        });
      }
    }
  }

  return imports;
}

function countTypeReferences(path: string, typeName: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === typeName
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(path));
  return count;
}

function countInlineProvisioningRunShapes(path: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeLiteralNode(node) &&
      node.members.some(
        (member) =>
          (ts.isMethodSignature(member) || ts.isPropertySignature(member)) &&
          ts.isIdentifier(member.name) &&
          member.name.text === 'hasProvisioningRun'
      )
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(path));
  return count;
}

describe('team feature public entrypoint freeze', () => {
  it('rejects export assignments as unsupported public surface widening', () => {
    expect(publicExportShape('synthetic.ts', 'export default value;')).toEqual({
      unsupported: ['export default'],
      typeExports: [],
      valueExports: [],
    });
    expect(publicExportShape('synthetic.ts', 'export = value;')).toEqual({
      unsupported: ['export ='],
      typeExports: [],
      valueExports: [],
    });
    expect(publicExportShape('synthetic.ts', 'export default class Foo {}')).toEqual({
      unsupported: ['export default'],
      typeExports: [],
      valueExports: [],
    });
  });

  it('freezes the complete provider-neutral public surface of orchestrator-ready team features', () => {
    expect(Object.keys(EXACT_PUBLIC_EXPORTS)).toHaveLength(23);

    for (const [entrypoint, expected] of Object.entries(EXACT_PUBLIC_EXPORTS)) {
      expect(publicExportShape(entrypoint), entrypoint).toEqual({
        unsupported: [],
        typeExports: [...expected.typeExports].sort(),
        valueExports: [...expected.valueExports].sort(),
      });
      expect(forbiddenPublicExportNames(entrypoint), entrypoint).toEqual([]);
      expect(forbiddenProviderModuleSpecifiers(entrypoint), entrypoint).toEqual([]);
    }
  });

  it('keeps generic and hosted secondary main facets separate', () => {
    expect(isPublicFeatureEntrypoint('team-lifecycle', ['main', 'hosted'])).toBe(true);
    expect(isPublicFeatureEntrypoint('team-task-board', ['main', 'hosted'])).toBe(true);
    expect(isPublicFeatureEntrypoint('team-message-delivery', ['main', 'hosted'])).toBe(false);

    for (const entrypoint of [
      'src/features/team-lifecycle/main/index.ts',
      'src/features/team-task-board/main/index.ts',
    ]) {
      expect(
        collectModuleReferences(entrypoint).map(({ specifier }) => specifier),
        entrypoint
      ).not.toContain('./hosted');
    }
  });

  it('publishes one provider-neutral provisioning-run read port', () => {
    const contents = source(PORT_SOURCE);
    const sourceFile = parseSource(PORT_SOURCE, contents);
    const port = sourceFile.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === PORT_NAME
    );

    expect(contents).not.toMatch(PROVIDER_SPECIFIC_VOCABULARY);
    expect(
      sourceFile.statements.some(
        (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === PORT_NAME
      )
    ).toBe(false);
    if (!port) {
      throw new Error(`${PORT_SOURCE} must declare ${PORT_NAME} as an interface`);
    }

    expect(port.members).toHaveLength(1);
    const method = port.members.find(
      (member): member is ts.MethodSignature =>
        ts.isMethodSignature(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'hasProvisioningRun'
    );
    if (!method) {
      throw new Error(`${PORT_NAME} must declare hasProvisioningRun`);
    }

    expect(method.parameters).toHaveLength(1);
    expect(method.parameters[0].type?.kind).toBe(ts.SyntaxKind.StringKeyword);
    expect(method.type?.kind).toBe(ts.SyntaxKind.BooleanKeyword);
  });

  it('uses the shared port in both real consumers without duplicate structural types', () => {
    for (const [consumer, expectedModuleSpecifier] of Object.entries(PORT_CONSUMERS)) {
      expect(typeOnlyNamedImports(consumer, PORT_NAME)).toContainEqual({
        moduleSpecifier: expectedModuleSpecifier,
        typeOnly: true,
      });
      expect(countTypeReferences(consumer, PORT_NAME)).toBeGreaterThan(0);
      expect(countInlineProvisioningRunShapes(consumer)).toBe(0);
      expect(source(consumer)).not.toMatch(PROVIDER_SPECIFIC_VOCABULARY);
    }
  });

  it('exports the shared port type-only from the main entrypoint', () => {
    const sourceFile = parseSource('src/features/team-view-read-model/main/index.ts');
    const exportDeclaration = sourceFile.statements.find(
      (statement): statement is ts.ExportDeclaration =>
        ts.isExportDeclaration(statement) &&
        !!statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => element.name.text === PORT_NAME)
    );

    expect(exportDeclaration?.isTypeOnly).toBe(true);
    expect(sourceFile.text).not.toMatch(PROVIDER_SPECIFIC_VOCABULARY);
  });

  it('recognizes every supported module edge without comments or strings becoming imports', () => {
    const importer = 'src/main/ipc/deepImportProbe.ts';
    const contents = `
      import { Hidden as Aliased } from '@features/team-view-read-model/core/domain/Hidden';
      import type { HiddenType } from '@features/team-provisioning/core/application/Hidden';
      export { Hidden as Reexported } from '@features/team-task-board/main/composition/Hidden';
      type Imported = import('@features/team-message-delivery/core/domain/Hidden').Hidden;
      const dynamicValue = import('@features/team-runtime-operations/renderer/internal/Hidden');
      const requiredValue = require('../../features/team-lifecycle/core/domain/Hidden');
      // import '@features/team-view-read-model/core/domain/CommentOnly';
      const text = "require('@features/team-provisioning/core/domain/StringOnly')";
    `;

    expect(collectModuleReferences(importer, contents).map(({ specifier }) => specifier)).toEqual([
      '@features/team-view-read-model/core/domain/Hidden',
      '@features/team-provisioning/core/application/Hidden',
      '@features/team-task-board/main/composition/Hidden',
      '@features/team-message-delivery/core/domain/Hidden',
      '@features/team-runtime-operations/renderer/internal/Hidden',
      '../../features/team-lifecycle/core/domain/Hidden',
    ]);
    expect(findDeepImportViolations(importer, contents)).toHaveLength(6);
  });

  it('exempts imports internal to the same target feature', () => {
    const importer =
      'src/features/team-view-read-model/main/composition/internalDeepImportProbe.ts';
    const contents = `
      import type { Internal } from '../../core/application/Internal';
      import type { AliasedInternal } from '@features/team-view-read-model/core/domain/Internal';
    `;

    expect(findDeepImportViolations(importer, contents)).toEqual([]);
  });

  it('scans all production TypeScript under src and freezes exact legacy deep-import edges', () => {
    const productionFiles = productionSourceFiles();

    expect(productionFiles).toContain('src/main/ipc/teamFeatureCapabilities.ts');
    expect(productionFiles.some((path) => !path.startsWith('src/features/'))).toBe(true);

    const violations = productionFiles.flatMap((path) => findDeepImportViolations(path));
    const violationIdentities = new Set(violations.map(deepImportIdentity));
    expect(
      [...violationIdentities].sort(),
      violations
        .map(
          ({ importer, line, specifier, feature }) =>
            `${importer}:${line} deep-imports ${feature} via ${specifier}`
        )
        .join('\n')
    ).toEqual([...LEGACY_DEEP_IMPORT_BASELINE].sort());
  }, 60_000);
});
