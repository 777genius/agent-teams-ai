export interface TaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

export type BoardTaskRefKind = 'canonical' | 'display' | 'unknown';
export type BoardTaskResolution = 'resolved' | 'deleted' | 'unresolved' | 'ambiguous';
export type BoardTaskActivityLinkKind = 'execution' | 'lifecycle' | 'board_action';
export type BoardTaskActivityTargetRole = 'subject' | 'related';
export type BoardTaskActorRelation = 'same_task' | 'other_active_task' | 'idle' | 'ambiguous';

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
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  isSidechain: boolean;
}

export interface BoardTaskActivityActorContext {
  relation: BoardTaskActorRelation;
}

export interface BoardTaskActivityEntry {
  id: string;
  timestamp: string;
  task: BoardTaskActivityTaskRef;
  linkKind: BoardTaskActivityLinkKind;
  targetRole: BoardTaskActivityTargetRole;
  actor: BoardTaskActivityActor;
  actorContext: BoardTaskActivityActorContext;
  source: {
    messageUuid: string;
    filePath: string;
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
}

export type BoardTaskActivityDetailResult =
  | { status: 'ok'; detail: BoardTaskActivityDetail }
  | { status: 'missing' };

export interface BoardTaskExactLogActor {
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  isSidechain: boolean;
}

export interface BoardTaskExactLogSource {
  filePath: string;
  messageUuid: string;
  sourceOrder: number;
}

interface BoardTaskExactLogSummaryBase {
  id: string;
  timestamp: string;
  actor: BoardTaskExactLogActor;
  source: BoardTaskExactLogSource;
  anchorKind: 'tool' | 'message';
  actionLabel: string;
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

export interface BoardTaskExactLogSummariesResponse {
  items: BoardTaskExactLogSummary[];
}

/**
 * Core forwards parsed runtime chunks without inspecting their main-process shape.
 * The surrounding DTO remains feature-owned while this nested payload stays opaque.
 */
export type BoardTaskLogChunk = ReturnType<typeof JSON.parse>;

export interface BoardTaskExactLogDetail {
  id: string;
  chunks: BoardTaskLogChunk[];
}

export type BoardTaskExactLogDetailResult =
  | { status: 'ok'; detail: BoardTaskExactLogDetail }
  | { status: 'stale' }
  | { status: 'missing' };

export interface BoardTaskLogActor {
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
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
  chunks: BoardTaskLogChunk[];
}

export interface BoardTaskLogStreamResponse {
  participants: BoardTaskLogParticipant[];
  defaultFilter: 'all' | string;
  segments: BoardTaskLogSegment[];
}

export interface BoardTaskLogStreamSummary {
  segmentCount: number;
}
