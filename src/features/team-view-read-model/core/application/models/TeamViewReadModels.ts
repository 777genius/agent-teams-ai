/** Durable/live message fields inspected by the read-model application layer. */
export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  messageId?: string;
}

export interface MessagesPage {
  messages: InboxMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  feedRevision: string;
}

export interface TeamMemberActivityMetaEntry {
  memberName: string;
  lastAuthoredMessageAt: string | null;
  messageCountExact: number;
  latestAuthoredMessageSignalsTermination: boolean;
}

export interface TeamMemberActivityMeta {
  teamName: string;
  computedAt: string;
  members: Record<string, TeamMemberActivityMetaEntry>;
  feedRevision: string;
}

export interface TeamGetDataOptions {
  includeMemberBranches?: boolean;
}

export interface TeamViewConfig {
  name: string;
  projectPath?: string;
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TeamViewTask {
  id: string;
  subject: string;
  status: TeamTaskStatus;
}

export interface TeamViewMember {
  name: string;
  currentTaskId: string | null;
  taskCount: number;
}

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

export interface TeamViewKanbanTaskState {
  column: Extract<KanbanColumnId, 'review' | 'approved'>;
  movedAt: string;
}

export interface TeamViewKanbanState {
  teamName: string;
  reviewers: string[];
  tasks: Record<string, TeamViewKanbanTaskState>;
  columnOrder?: Partial<Record<KanbanColumnId, string[]>>;
}

export interface TeamViewProcess {
  id: string;
  label: string;
  pid: number;
  registeredAt: string;
  stoppedAt?: string;
}

/** Feature-owned snapshot contract containing the stable fields returned across the boundary. */
export interface TeamViewSnapshot {
  teamName: string;
  config: TeamViewConfig;
  tasks: TeamViewTask[];
  members: TeamViewMember[];
  kanbanState: TeamViewKanbanState;
  processes: TeamViewProcess[];
  warnings?: string[];
  isAlive?: boolean;
}
