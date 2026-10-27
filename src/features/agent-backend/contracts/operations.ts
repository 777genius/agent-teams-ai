import type {
  BackendAttachmentChunk,
  BackendAttachmentMetadata,
  BackendMessageAttachmentRead,
  BackendMessageAttachmentsRead,
  BackendTaskAttachmentRead,
} from './attachments';
import type { BackendMemberCheckpoints } from './checkpoints';
import type { AgentBackendConnectionsApi } from './connections';
import type {
  BackendCrossTeamLookup,
  BackendCrossTeamOperationPayloads,
  BackendCrossTeamOutbox,
  BackendCrossTeamReceipt,
} from './crossTeam';
import type { BackendGroupPayloads, BackendGroupValue } from './groupChats';
import type { BackendHandle } from './index';
import type {
  BackendLaunchConfiguration,
  BackendLaunchConfigurationView,
  BackendLaunchModelConfigurationView,
  BackendLaunchModelProbe,
  BackendLaunchModelSelection,
  BackendLaunchSnapshot,
} from './launch';
import type { BackendLeadActivity, BackendLeadContext } from './lead';
import type {
  BackendTeamActivityLogs,
  BackendTeamActivityLogsQuery,
  BackendTeamActivityStats,
} from './logStats';
import type {
  BackendMemberActionPayloads,
  BackendMemberActionRead,
  BackendMemberActionView,
} from './memberActions';
import type {
  BackendProcess,
  BackendProcessOperationPayloads,
  BackendProcessPending,
  BackendProcessReceipt,
} from './processes';
import type {
  BackendLaunchRestorations,
  BackendResumePreparation,
  BackendResumePrepareRequest,
} from './restorations';
import type { BackendReviewOperationPayloads, BackendReviewValue } from './review';
import type { AgentBackendReviewWatchApi } from './reviewWatch';
import type {
  BackendRosterConfiguration,
  BackendRosterReceipt,
  BackendRosterReplacement,
} from './roster';
import type { StoppedTeamImportApi } from './stoppedImport';
import type { BackendTeamChanges } from './teamChanges';
import type { BackendTeamLifecyclePayloads, BackendTeamLifecycleValue } from './teamLifecycle';
import type { BackendTeamSnapshot } from './teamSnapshot';
import type {
  BackendInteractionPreview,
  BackendToolApprovalPayloads,
  BackendToolApprovalSettingsView,
} from './toolApprovals';
import type { NativeAttachmentCapabilities } from '@agent-teams/legacy-agent-host/attachments/attachmentTypes';
import type {
  AttachmentReference,
  AttachmentUpload,
  AttachmentUploadResult,
} from '@agent-teams/legacy-agent-host/attachments/contracts';
import type { HostSubagentActivity } from '@shared/types/teamActivity';
export type { BackendCheckpointAvailabilityReason, BackendMemberCheckpoints } from './checkpoints';
export type {
  BackendLaunchRestorations,
  BackendResumeChoice,
  BackendResumePreparation,
  BackendResumePrepareRequest,
} from './restorations';

export const AGENT_BACKEND_INVOKE_CHANNEL = 'agentBackend:invoke';
export const AGENT_BACKEND_OPERATIONS_ROUTE = '/api/agent-backend/operations';

export interface BackendTaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

export interface BackendOperationPayloads
  extends
    BackendGroupPayloads,
    BackendReviewOperationPayloads,
    BackendTeamLifecyclePayloads,
    BackendToolApprovalPayloads,
    BackendCrossTeamOperationPayloads,
    BackendProcessOperationPayloads,
    BackendMemberActionPayloads {
  'attachment.upload': AttachmentUpload;
  'task.attachment.add': { taskId: string; attachment: AttachmentReference };
  'task.attachment.remove': { taskId: string; attachmentId: string };
  'task.attachment.read': BackendTaskAttachmentRead;
  'message.attachment.read': BackendMessageAttachmentRead;
  'message.attachments.read': BackendMessageAttachmentsRead;
  'task.create': {
    subject: string;
    groupChatId?: string;
    description?: string;
    owner?: string;
    blockedBy?: string[];
    related?: string[];
    prompt?: string;
    promptTaskRefs?: BackendTaskRef[];
    startImmediately?: boolean;
    descriptionTaskRefs?: BackendTaskRef[];
  };
  'task.update': { taskId: string; subject?: string; description?: string };
  'task.start': { taskId: string; notification: 'legacy' | 'user' };
  'task.board.clear': { taskId: string };
  'task.board.order': {
    columnId: 'todo' | 'in_progress' | 'done' | 'review' | 'approved';
    orderedTaskIds: string[];
  };
  'task.relationship': {
    taskId: string;
    targetId: string;
    type: 'blockedBy' | 'blocks' | 'related';
    action: 'add' | 'remove';
  };
  'task.clarification': { taskId: string; value: 'lead' | 'user' | null };
  'task.assign': { taskId: string; owner: string | null };
  'task.lifecycle': {
    taskId: string;
    action: 'start' | 'complete' | 'delete' | 'restore' | 'pending';
  };
  'task.review':
    | { taskId: string; action: 'request'; reviewer?: string }
    | { taskId: string; action: 'start' }
    | { taskId: string; action: 'disapprove' }
    | {
        taskId: string;
        action: 'approve';
        note?: string;
        notifyOwner?: boolean;
        suppressTaskComment?: boolean;
      }
    | { taskId: string; action: 'request_changes'; comment: string; taskRefs?: BackendTaskRef[] };
  'task.comment': {
    taskId: string;
    text: string;
    taskRefs?: BackendTaskRef[];
    attachments?: AttachmentReference[];
  };
  'message.send': {
    to: string;
    text: string;
    taskRefs?: BackendTaskRef[];
    messageId?: string;
    summary?: string;
    actionMode?: 'do' | 'ask' | 'delegate';
    attachments?: AttachmentReference[];
  };
  'team.activity.logs.read': BackendTeamActivityLogsQuery;
  'team.activity.stats.read': { memberName: string };
  'team.lead.activity.read': Record<string, never>;
  'team.lead.context.read': Record<string, never>;
  'task.get': { taskId: string };
  'tasks.list': Record<string, never>;
  'team.snapshot': Record<string, never>;
  'team.changes.read': { cursor?: string };
  'team.roster.read': Record<string, never>;
  'team.roster.lookup': { expected?: BackendRosterReplacement };
  'team.roster.replace': BackendRosterReplacement;
  'team.launch.capture': { rosterCommandId: string };
  'team.launch.read': { launchId?: string };
  'team.launch.configuration.read': { launchId?: string };
  'team.launch.model.configuration.read': Record<string, never>;
  'team.launch.restorations.read': { launchId: string };
  'team.launch.resume.prepare': BackendResumePrepareRequest;
  'team.launch.probe.start': BackendLaunchModelSelection;
  'team.launch.probe.read': BackendLaunchModelSelection;
  'team.launch.probe.cancel': BackendLaunchModelSelection;
  'team.launch.start': {
    launchId: string;
    rosterRevision: string;
    configuration?: BackendLaunchConfiguration;
  };
  'team.launch.retry': {
    launchId: string;
    rosterRevision: string;
    attemptId: string;
    memberIds: string[];
  };
  'command.lookup': Record<string, never>;
  'runtime.open': { memberId: string; expectedGeneration?: string };
  'runtime.read': { memberId: string; expectedGeneration?: string };
  'runtime.activity.snapshot': { memberId: string; expectedGeneration?: string };
  'runtime.activity.feed': { memberId: string; cursor: string; expectedGeneration?: string };
  'runtime.dispatch': { memberId: string; expectedGeneration?: string };
  'runtime.stop': { memberId: string; expectedGeneration?: string };
  'runtime.interrupt': { memberId: string; inputId: string; expectedGeneration?: string };
  'runtime.interaction': {
    memberId: string;
    expectedGeneration?: string;
    inputId: string;
    interactionRef: string;
    reply:
      | { kind: 'permission'; decision: 'allow' | 'deny' }
      | { kind: 'question'; answers: Record<string, string>; decision?: never }
      | { kind: 'question'; decision: 'deny'; answers?: never };
  };
  'runtime.reconcile': { memberId: string; expectedGeneration?: string };
  'runtime.checkpoint': { memberId: string; checkpointId: string; expectedGeneration?: string };
  'runtime.checkpoints.read': { memberId: string; expectedGeneration: string };
  'runtime.restore': {
    memberId: string;
    reference: string;
    expectedGeneration: string;
    resumeId?: string;
  };
}

export type BackendOperation = keyof BackendOperationPayloads;
export type BackendOperationRequest = {
  [Operation in BackendOperation]: {
    readonly handle: BackendHandle;
    /** Supplied once by the caller; read operations do not persist a command receipt. */
    readonly commandId: string;
    readonly operation: Operation;
    readonly payload: BackendOperationPayloads[Operation];
  };
}[BackendOperation];

export interface BackendComment {
  id: string;
  author?: string;
  text?: string;
  createdAt?: string;
  type?: string;
  taskRefs?: BackendTaskRef[];
  attachments?: BackendAttachmentMetadata[];
}

export interface BackendTask {
  groupChatId?: string;
  historyEvents?: import('@shared/types/team').TaskHistoryEvent[];
  id: string;
  status: string;
  needsClarification?: 'lead' | 'user';
  reviewState?: 'none' | 'review' | 'approved' | 'needsFix';
  subject?: string;
  description?: string;
  displayId?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  related?: string[];
  descriptionTaskRefs?: BackendTaskRef[];
  prompt?: string;
  promptTaskRefs?: BackendTaskRef[];
  comments?: BackendComment[];
  attachments?: BackendAttachmentMetadata[];
}

export type BackendTaskSubmissionCommand = {
  [K in 'task.create' | 'task.comment']: {
    commandId: string;
    operation: K;
    payload: BackendOperationPayloads[K];
  };
}['task.create' | 'task.comment'];

export interface BackendCommandReceipt {
  /** Strict projection of the actual original command; never a renderer-invented proof. */
  taskSubmission?: BackendTaskSubmissionCommand;
  /** Main verified the exact original policy marker, emitted only without product effects. */
  taskSubmissionNoEffect?: true;
  commandId: string;
  phase: 'prepared' | 'applying' | 'completed' | 'rejected' | 'held';
  operation:
    | 'task.create'
    | 'task.update'
    | 'task.assign'
    | 'task.start'
    | 'task.lifecycle'
    | 'task.comment'
    | 'task.attachment.add'
    | 'task.attachment.remove'
    | 'task.review'
    | 'task.board.clear'
    | 'task.board.order'
    | 'task.relationship'
    | 'task.clarification'
    | 'message.send';
  task?: BackendTask;
  comment?: BackendComment;
  messageId?: string;
  deliveryId?: string;
  notifiedOwner?: boolean;
}

export interface BackendRuntimeSnapshot {
  memberId: string;
  attachmentCapabilities?: NativeAttachmentCapabilities;
  generation?: string;
  phase: string;
  sealed: boolean;
  custody: 'owned' | 'released' | 'unknown';
  nativeReady: boolean;
  attached: boolean;
  inputs: { inputId: string; phase: string; terminal?: 'succeeded' | 'failed' | 'cancelled' }[];
  interactions: {
    interactionRef: string;
    inputId: string;
    kind: 'permission' | 'question';
    expiresAt: number;
    phase: string;
  }[];
  diagnostic?: string;
}

export interface BackendCheckpoint {
  checkpointId: string;
  status: 'published' | 'unsupported' | 'held';
  reference?: string;
}

/** Normalized content only; no provider envelopes, native IDs or technical operation refs. */
export type BackendActivityValue =
  | null
  | boolean
  | number
  | string
  | BackendActivityValue[]
  | { [key: string]: BackendActivityValue };

export interface BackendActivityState {
  phase: string;
  custody: 'owned' | 'released' | 'unknown';
  sealed: boolean;
  nativeReady: boolean;
  queuedInputs: number;
  activeInputs: number;
  partial: boolean;
  control: { inputId: string; phase: 'pending' | 'unknown' } | null;
  diagnostic: string | null;
  interactions: BackendRuntimeSnapshot['interactions'];
}

export type BackendActivityData =
  | HostSubagentActivity
  | {
      kind: 'text';
      messageRef: string;
      block: number;
      text: string;
      phase: 'snapshot' | 'complete';
    }
  | { kind: 'tool'; messageRef: string; toolRef: string; name: string; input: BackendActivityValue }
  | { kind: 'tool-result'; toolRef: string; content: BackendActivityValue; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number }
  | { kind: 'compaction'; sourceRef: string; reason: 'manual' | 'automatic' | 'unknown' }
  | { kind: 'result'; outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; code?: string }
  | {
      kind: 'interaction';
      interactionRef: string;
      request:
        | { kind: 'permission'; tool: string; input: BackendActivityValue }
        | { kind: 'question'; questions: BackendActivityValue };
    }
  | { kind: 'diagnostic'; code: string }
  | { kind: 'state'; state: BackendActivityState }
  | { kind: 'gap'; reason: BackendActivityGap['reason'] };

export interface BackendActivityEvent {
  sequence: number;
  eventId: string;
  inputId?: string;
  data: BackendActivityData;
}

export interface BackendActivityGap {
  reason:
    | 'retention'
    | 'incarnation'
    | 'cursor'
    | 'oversized'
    | 'unsupported'
    | 'unattributed'
    | 'storage'
    | 'state-unpublished';
}

export interface BackendActivityFeed {
  memberId: string;
  /** Opaque, resource-qualified continuation. Clients must not construct or alter it. */
  cursor: string;
  retainedFrom: number;
  events: BackendActivityEvent[];
  hasMore: boolean;
  gap?: BackendActivityGap;
}

export interface BackendActivitySnapshot extends BackendActivityFeed {
  state: BackendActivityState | null;
  latest: {
    text: BackendActivityEvent[];
    tools: BackendActivityEvent[];
    usage: BackendActivityEvent[];
    compaction: BackendActivityEvent | null;
    subagents?: BackendActivityEvent[];
    interactions: BackendActivityEvent[];
  };
}

export type BackendOperationResult =
  | {
      ok: true;
      value:
        | BackendGroupValue
        | BackendTeamLifecycleValue
        | BackendToolApprovalSettingsView
        | BackendInteractionPreview
        | AttachmentUploadResult
        | BackendAttachmentMetadata[]
        | BackendAttachmentChunk
        | BackendProcess[]
        | BackendMemberActionView
        | BackendMemberActionRead
        | BackendProcessReceipt
        | BackendProcessPending[]
        | BackendReviewValue
        | BackendCrossTeamReceipt
        | BackendCrossTeamOutbox
        | BackendCrossTeamLookup
        | BackendTeamActivityLogs
        | BackendTeamActivityStats
        | BackendLeadActivity
        | BackendLeadContext
        | BackendTeamSnapshot
        | BackendRosterConfiguration
        | BackendRosterReceipt
        | BackendTeamChanges
        | BackendLaunchSnapshot
        | BackendLaunchModelConfigurationView
        | BackendLaunchConfigurationView
        | BackendLaunchModelProbe
        | BackendTask
        | BackendTask[]
        | BackendCommandReceipt
        | BackendRuntimeSnapshot
        | BackendCheckpoint
        | BackendMemberCheckpoints
        | BackendLaunchRestorations
        | BackendResumePreparation
        | BackendActivityFeed
        | BackendActivitySnapshot
        | null;
    }
  | {
      ok: false;
      code:
        | 'invalid'
        | 'conflict'
        | 'forbidden'
        | 'hold'
        | 'busy'
        | 'unavailable'
        | 'shutting-down';
      outcome: 'not-dispatched' | 'rejected' | 'unknown';
    };

export interface AgentBackendApi
  extends AgentBackendConnectionsApi, Partial<AgentBackendReviewWatchApi>, StoppedTeamImportApi {
  invoke(request: BackendOperationRequest): Promise<BackendOperationResult>;
}

/** App API fragment shared by Electron preload and the HTTP-backed app client. */
export interface AgentBackendElectronApi {
  agentBackend: AgentBackendApi;
}
