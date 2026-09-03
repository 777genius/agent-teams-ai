import type { EnhancedChunk } from '@main/types';

export interface TaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

export type BoardTaskRefKind = 'canonical' | 'display' | 'unknown';
export type BoardTaskResolution = 'resolved' | 'deleted' | 'unresolved' | 'ambiguous';
export type BoardTaskActivityLinkKind = 'execution' | 'lifecycle' | 'board_action';
export type BoardTaskActivityTargetRole = 'subject' | 'related';
export type BoardTaskActivityPhase = 'work' | 'review';
export type BoardTaskActorRelation = 'same_task' | 'other_active_task' | 'idle' | 'ambiguous';
export type BoardTaskActivityStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type BoardTaskActivityRelationship = 'blocked-by' | 'blocks' | 'related';
export type BoardTaskActivityCategory =
  | 'status'
  | 'review'
  | 'comment'
  | 'assignment'
  | 'read'
  | 'attachment'
  | 'relationship'
  | 'clarification'
  | 'other';
export type BoardTaskRelationshipPerspective = 'outgoing' | 'incoming' | 'symmetric';

export interface BoardTaskLocator {
  ref: string;
  refKind: BoardTaskRefKind;
  canonicalId?: string;
}

export interface BoardTaskActivityTaskRef {
  locator: BoardTaskLocator;
  resolution: BoardTaskResolution;
  taskRef?: TaskRef;
}

export interface BoardTaskActivityActor {
  memberName?: string;
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  agentId?: string;
  isSidechain: boolean;
}

export interface BoardTaskActivityAction {
  canonicalToolName?: string;
  toolUseId?: string;
  category: BoardTaskActivityCategory;
  peerTask?: BoardTaskActivityTaskRef;
  relationshipPerspective?: BoardTaskRelationshipPerspective;
  details?: {
    status?: BoardTaskActivityStatus;
    owner?: string | null;
    clarification?: 'lead' | 'user' | null;
    reviewer?: string;
    relationship?: BoardTaskActivityRelationship;
    commentId?: string;
    attachmentId?: string;
    filename?: string;
  };
}

export interface BoardTaskActivityActorContext {
  relation: BoardTaskActorRelation;
  activeTask?: BoardTaskActivityTaskRef;
  activePhase?: BoardTaskActivityPhase;
  activeExecutionSeq?: number;
}

export interface BoardTaskActivityEntry {
  id: string;
  timestamp: string;
  task: BoardTaskActivityTaskRef;
  linkKind: BoardTaskActivityLinkKind;
  targetRole: BoardTaskActivityTargetRole;
  actor: BoardTaskActivityActor;
  actorContext: BoardTaskActivityActorContext;
  action?: BoardTaskActivityAction;
  source: {
    messageUuid: string;
    filePath: string;
    toolUseId?: string;
    sourceOrder: number;
  };
}

export interface BoardTaskActivityDetailMetadataRow {
  label: string;
  value: string;
}

export interface BoardTaskActivityDetail {
  entryId: string;
  summaryLabel: string;
  actorLabel: string;
  timestamp: string;
  contextLines: string[];
  metadataRows: BoardTaskActivityDetailMetadataRow[];
  logDetail?: BoardTaskExactLogDetail;
}

export type BoardTaskActivityDetailResult =
  | {
      status: 'ok';
      detail: BoardTaskActivityDetail;
    }
  | {
      status: 'missing';
    };

export interface BoardTaskExactLogActor {
  memberName?: string;
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  agentId?: string;
  isSidechain: boolean;
}

export interface BoardTaskExactLogSource {
  filePath: string;
  messageUuid: string;
  toolUseId?: string;
  sourceOrder: number;
}

interface BoardTaskExactLogSummaryBase {
  id: string;
  timestamp: string;
  actor: BoardTaskExactLogActor;
  source: BoardTaskExactLogSource;
  anchorKind: 'tool' | 'message';
  actionLabel: string;
  actionCategory?: BoardTaskActivityCategory;
  canonicalToolName?: string;
  linkKinds: BoardTaskActivityLinkKind[];
}

export type BoardTaskExactLogSummary =
  | (BoardTaskExactLogSummaryBase & {
      canLoadDetail: true;
      sourceGeneration: string;
    })
  | (BoardTaskExactLogSummaryBase & {
      canLoadDetail: false;
    });

export interface BoardTaskExactLogDetail {
  id: string;
  chunks: EnhancedChunk[];
}

export interface BoardTaskExactLogSummariesResponse {
  items: BoardTaskExactLogSummary[];
}

export type BoardTaskExactLogDetailResult =
  | { status: 'ok'; detail: BoardTaskExactLogDetail }
  | { status: 'stale' }
  | { status: 'missing' };

export interface BoardTaskLogActor {
  memberName?: string;
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  agentId?: string;
  isSidechain: boolean;
}

export interface BoardTaskLogParticipant {
  key: string;
  label: string;
  role: 'member' | 'lead' | 'unknown';
  isLead: boolean;
  isSidechain: boolean;
}

export interface BoardTaskLogSegment {
  id: string;
  participantKey: string;
  actor: BoardTaskLogActor;
  startTimestamp: string;
  endTimestamp: string;
  chunks: EnhancedChunk[];
}

export interface BoardTaskLogStreamRuntimeProjection {
  provider: 'opencode' | 'codex_native';
  mode: 'attribution' | 'heuristic' | 'trace';
  attributionRecordCount: number;
  projectedMessageCount: number;
  boardMcpToolCount?: number;
  nativeToolCount?: number;
  fallbackReason?:
    | 'no_attribution_records'
    | 'attribution_no_projected_messages'
    | 'task_tool_markers'
    | 'codex_native_trace';
  markerMatchCount?: number;
  markerSpanCount?: number;
  traceFileCount?: number;
  traceRunCount?: number;
  dedupedNativeToolCount?: number;
}

export interface BoardTaskLogStreamResponse {
  participants: BoardTaskLogParticipant[];
  defaultFilter: 'all' | string;
  segments: BoardTaskLogSegment[];
  source?:
    | 'transcript'
    | 'opencode_runtime_fallback'
    | 'opencode_runtime_attribution'
    | 'codex_native_trace_fallback'
    | 'mixed_transcript_codex_native_trace'
    | 'mixed_transcript_opencode_runtime';
  runtimeProjection?: BoardTaskLogStreamRuntimeProjection;
}

export interface BoardTaskLogStreamSummary {
  segmentCount: number;
}
