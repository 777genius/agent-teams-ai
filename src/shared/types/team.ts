export interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  role?: string;
  color?: string;
  joinedAt?: number;
}

export interface TeamConfig {
  name: string;
  description?: string;
  members?: TeamMember[];
}

export interface TeamSummary {
  teamName: string;
  displayName: string;
  description: string;
  memberCount: number;
  taskCount: number;
  lastActivity: string | null;
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  status: TeamTaskStatus;
  blocks?: string[];
  blockedBy?: string[];
}

export interface InboxMessage {
  from: string;
  to?: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
  color?: string;
  messageId?: string;
}

export interface SendMessageRequest {
  member: string;
  text: string;
  summary?: string;
  from?: string;
}

export interface SendMessageResult {
  deliveredToInbox: boolean;
  messageId: string;
}

export type MemberStatus = 'active' | 'idle' | 'terminated' | 'unknown';

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';
export type KanbanReviewStatus = 'pending' | 'error';

export interface KanbanTaskState {
  column: Extract<KanbanColumnId, 'review' | 'approved'>;
  reviewStatus?: KanbanReviewStatus;
  reviewer?: string | null;
  errorDescription?: string;
  movedAt: string;
}

export interface KanbanState {
  teamName: string;
  reviewers: string[];
  tasks: Record<string, KanbanTaskState>;
}

export type UpdateKanbanPatch =
  | { op: 'set_column'; column: Extract<KanbanColumnId, 'review' | 'approved'> }
  | { op: 'remove' }
  | { op: 'request_changes'; comment?: string };

export interface ResolvedTeamMember {
  name: string;
  status: MemberStatus;
  currentTaskId: string | null;
  taskCount: number;
  lastActiveAt: string | null;
  messageCount: number;
  color?: string;
  agentType?: string;
}

export interface TeamData {
  teamName: string;
  config: TeamConfig;
  tasks: TeamTask[];
  members: ResolvedTeamMember[];
  messages: InboxMessage[];
  kanbanState: KanbanState;
  warnings?: string[];
}

export interface CreateTaskRequest {
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
}

export interface TeamChangeEvent {
  type: 'config' | 'inbox' | 'task';
  teamName: string;
  detail?: string;
}

export type TeamProvisioningState =
  | 'idle'
  | 'validating'
  | 'spawning'
  | 'monitoring'
  | 'verifying'
  | 'ready'
  | 'disconnected'
  | 'failed'
  | 'cancelled';

export interface TeamProvisioningMemberInput {
  name: string;
  role?: string;
}

export interface TeamCreateRequest {
  teamName: string;
  displayName?: string;
  description?: string;
  members: TeamProvisioningMemberInput[];
  cwd: string;
}

export interface TeamCreateResponse {
  runId: string;
}

export interface TeamProvisioningPrepareResult {
  ready: boolean;
  message: string;
  warnings?: string[];
}

export interface TeamProvisioningProgress {
  runId: string;
  teamName: string;
  state: Exclude<TeamProvisioningState, 'idle'>;
  message: string;
  startedAt: string;
  updatedAt: string;
  pid?: number;
  error?: string;
  warnings?: string[];
  cliLogsTail?: string;
}
