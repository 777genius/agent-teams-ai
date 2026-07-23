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
