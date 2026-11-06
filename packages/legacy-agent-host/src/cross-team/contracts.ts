import type { TaskRef } from '../team/contracts.js';
export interface CrossTeamMessage {
  /** Optional Host-only hash of immutable pair, principals and grant revisions. */
  authorityFingerprint?: string;
  messageId: string;
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  toMember?: string;
  conversationId?: string;
  replyToConversationId?: string;
  text: string;
  taskRefs?: TaskRef[] | undefined;
  summary?: string | undefined;
  chainDepth: number;
  timestamp: string;
}
export interface RecipientMember {
  name: string;
  agentType?: string;
  role?: string;
  removedAt?: unknown;
}
export interface RecipientConfig {
  members?: readonly RecipientMember[];
}

/** Public application DTOs. Main resolves these opaque handles to the original pair. */
export interface CrossTeamHandle {
  readonly handleId: string;
}
export interface CrossTeamReference {
  taskId: string;
  displayId: string;
  team: 'source' | 'target';
}
export interface BackendCrossTeamSend {
  target: CrossTeamHandle;
  /** The authenticated source grant must name this actor; never a grant selector. */
  fromMember: string;
  toMember?: string;
  text: string;
  messageId: string;
  conversationId?: string;
  replyToConversationId?: string;
  timestamp?: string;
  summary?: string | undefined;
  actionMode?: 'do' | 'ask' | 'delegate';
  taskRefs?: CrossTeamReference[];
  chainDepth?: number;
}
export interface BackendCrossTeamReceipt {
  kind: 'cross-team-receipt';
  commandId: string;
  messageId: string;
  conversationId: string;
  toMember: string;
  phase: 'completed' | 'held';
  deduplicated: boolean;
}
export interface BackendCrossTeamOutboxRow {
  messageId: string;
  fromHandleId?: string;
  fromTeamResourceRef: string;
  fromMember: string;
  toHandleId?: string;
  toTeamResourceRef: string;
  fromTeamName: string;
  toTeamName: string;
  toMember: string;
  conversationId: string;
  replyToConversationId?: string;
  text: string;
  summary?: string | undefined;
  timestamp: string;
  chainDepth: number;
  taskRefs?: CrossTeamReference[];
}
export interface BackendCrossTeamOperationPayloads {
  'crossTeam.send': BackendCrossTeamSend;
  /** Uses outer commandId unchanged and performs only current read authorization. */
  'crossTeam.lookup': Record<string, never>;
  'crossTeam.outbox.read': Record<string, never>;
}
export interface BackendCrossTeamOutbox {
  kind: 'cross-team-outbox';
  rows: BackendCrossTeamOutboxRow[];
}

/** Private Host selection. Both bindings arrive from Main's retained binding store. */
export interface CapturedCrossTeamIdentity {
  ownerId: string;
  ownerRevision: string;
  ownerFingerprint: string;
  contextId?: string;
  source: CapturedCrossTeamSide;
  target: CapturedCrossTeamSide & {
    recipient: {
      memberId: string;
      name: string;
      runId: string;
      generation: string;
    };
  };
}
export interface CapturedCrossTeamSide {
  /** Host resource selection; never a display name or Desktop binding. */
  resourceRef: string;
  teamResourceRef: string;
  /** Navigation metadata only, absent for headless origins. */
  handleId?: string;
  scope: {
    projectId: string;
    workspaceId: string;
    teamId: string;
    runId: string;
    memberId: string | null;
    generation: string | number | null;
  };
  teamId: string;
  teamName: string;
  principalId: string;
  grantRevision: number;
  actor: string;
  runId?: string;
  /** Required for a native source actor, absent for the authenticated human. */
  sender?: { memberId: string; runId: string; generation: string };
}

/** Stored in the EXISTING source Team command receipt before target publication. */
export interface CapturedCrossTeamIntent {
  commandId: string;
  pair: CapturedCrossTeamIdentity;
  request: Omit<BackendCrossTeamSend, 'target' | 'conversationId'> & {
    conversationId: string;
  };
  timestamp: string;
  /** Hash of this original pair/run/recipient/principals + exact IDs and payload. */
  authorityFingerprint: string;
  targetCommandId: string;
}

export interface BackendCrossTeamLookup {
  kind: 'cross-team-lookup';
  commandId: string;
  phase: 'absent' | 'prepared' | 'completed' | 'held';
  messageId?: string;
  conversationId?: string;
  toMember?: string;
}
export type HostCrossTeamSend = Omit<BackendCrossTeamSend, 'target'> & {
  target: CrossTeamHandle | { resourceRef: string };
};
