import type { InboxMessage, MessagesPage, TeamMemberActivityMeta } from '@shared/types';

export interface TeamMessagesCacheEntry {
  canonicalMessages: InboxMessage[];
  optimisticMessages: InboxMessage[];
  feedRevision: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  lastFetchedAt: number | null;
  loadingHead: boolean;
  loadingOlder: boolean;
  headHydrated: boolean;
}

export interface RefreshTeamMessagesHeadResult {
  feedChanged: boolean;
  headChanged: boolean;
  feedRevision: string | null;
}

export interface TeamMessageFeedRendererState {
  memberActivityMetaByTeam: Record<string, TeamMemberActivityMeta>;
  teamMessagesByName: Record<string, TeamMessagesCacheEntry>;
}

export interface TeamMessageFeedStatePort {
  getState(): TeamMessageFeedRendererState;
  setState(
    update:
      | Partial<TeamMessageFeedRendererState>
      | ((state: TeamMessageFeedRendererState) => Partial<TeamMessageFeedRendererState>)
  ): void;
}

export interface TeamMessageFeedTransportPort {
  getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta>;
  getMessagesPage(
    teamName: string,
    options: { cursor?: string; limit: number }
  ): Promise<MessagesPage>;
}

export interface TeamMessageFeedRequestScopePort<TScope> {
  capture(teamName: string): TScope;
  isCurrent(teamName: string, scope: TScope): boolean;
}

export interface TeamMessageFeedActionsPort {
  getActions(): Pick<
    TeamMessageFeedRendererSliceActions,
    'refreshMemberActivityMeta' | 'refreshTeamMessagesHead'
  >;
}

export interface TeamMessageFeedRendererSliceActions {
  loadOlderTeamMessages(teamName: string): Promise<void>;
  refreshMemberActivityMeta(teamName: string): Promise<void>;
  refreshTeamMessagesHead(teamName: string): Promise<RefreshTeamMessagesHeadResult>;
  syncTeamPendingReplyRefresh(
    teamName: string,
    sourceId: string,
    enabled: boolean,
    delayMs?: number
  ): void;
}

export interface TeamMessageFeedCachePolicyPort {
  areMessageArraysEquivalent(
    left: readonly InboxMessage[],
    right: readonly InboxMessage[]
  ): boolean;
  extractRetainedOlderTail(
    canonicalMessages: readonly InboxMessage[],
    freshHeadMessages: readonly InboxMessage[]
  ): InboxMessage[] | null;
  getCanonicalHeadSlice(
    canonicalMessages: readonly InboxMessage[],
    headLength: number
  ): readonly InboxMessage[];
  getEntry(state: TeamMessageFeedRendererState, teamName: string): TeamMessagesCacheEntry;
  mergeMessages(left: readonly InboxMessage[], right: readonly InboxMessage[]): InboxMessage[];
  pruneOptimisticMessages(
    optimistic: readonly InboxMessage[],
    canonical: readonly InboxMessage[]
  ): InboxMessage[];
}

export interface TeamMessageFeedActivityPolicyPort {
  isStale(state: TeamMessageFeedRendererState, teamName: string): boolean;
  structurallyShareMembers(
    previous: TeamMemberActivityMeta['members'] | undefined,
    next: TeamMemberActivityMeta['members']
  ): TeamMemberActivityMeta['members'];
}

export interface TeamMessageFeedPendingReplyPolicyPort {
  setEnabled(teamName: string, sourceId: string, enabled: boolean): boolean;
}

export interface TeamMessageFeedCoordinatorPort {
  getHeadRequest(teamName: string): Promise<RefreshTeamMessagesHeadResult> | undefined;
  setHeadRequest(teamName: string, request: Promise<RefreshTeamMessagesHeadResult>): void;
  deleteHeadRequest(teamName: string, request: Promise<RefreshTeamMessagesHeadResult>): boolean;
  markFreshHeadRefreshPending(teamName: string): void;
  consumeFreshHeadRefresh(teamName: string): boolean;
  getOlderRequest(teamName: string): Promise<void> | undefined;
  setOlderRequest(teamName: string, request: Promise<void>): void;
  deleteOlderRequest(teamName: string, request: Promise<void>): boolean;
  getQueuedHeadRequest(teamName: string): Promise<RefreshTeamMessagesHeadResult> | undefined;
  setQueuedHeadRequest(teamName: string, request: Promise<RefreshTeamMessagesHeadResult>): void;
  deleteQueuedHeadRequest(
    teamName: string,
    request: Promise<RefreshTeamMessagesHeadResult>
  ): boolean;
  getMemberActivityRequest(teamName: string): Promise<void> | undefined;
  setMemberActivityRequest(teamName: string, request: Promise<void>): void;
  deleteMemberActivityRequest(teamName: string, request: Promise<void>): boolean;
  markFreshMemberActivityRefreshPending(teamName: string): void;
  consumeFreshMemberActivityRefresh(teamName: string): boolean;
  setPendingReplyTimer(teamName: string, timer: ReturnType<typeof setTimeout>): void;
  deletePendingReplyTimer(teamName: string, timer: ReturnType<typeof setTimeout>): boolean;
  clearPendingReplyTimer(teamName: string): void;
}

export interface TeamMessageFeedRendererSlice
  extends TeamMessageFeedRendererState, TeamMessageFeedRendererSliceActions {}

export interface TeamMessageFeedRendererSliceDependencies<TScope> {
  actions: TeamMessageFeedActionsPort;
  activityPolicy: TeamMessageFeedActivityPolicyPort;
  cachePolicy: TeamMessageFeedCachePolicyPort;
  pendingReplyPolicy: TeamMessageFeedPendingReplyPolicyPort;
  requestScope: TeamMessageFeedRequestScopePort<TScope>;
  state: TeamMessageFeedStatePort;
  coordinator?: TeamMessageFeedCoordinatorPort;
  transport: TeamMessageFeedTransportPort;
}
