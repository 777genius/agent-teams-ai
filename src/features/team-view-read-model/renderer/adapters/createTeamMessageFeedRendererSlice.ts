import {
  defaultTeamMessageFeedCoordinator,
  type TeamMessageFeedCoordinator,
} from '../utils/teamMessageFeedCoordinator';

import { createTeamMessageFeedTransport } from './createTeamMessageFeedTransport';

import type {
  RefreshTeamMessagesHeadResult,
  TeamMessageFeedActionsPort,
  TeamMessageFeedActivityPolicyPort,
  TeamMessageFeedCachePolicyPort,
  TeamMessageFeedPendingReplyPolicyPort,
  TeamMessageFeedRendererSliceActions,
  TeamMessageFeedRendererState,
  TeamMessageFeedRequestScopePort,
  TeamMessageFeedStatePort,
  TeamMessageFeedTransportPort,
} from '../ports/TeamMessageFeedRendererPorts';

export interface TeamMessageFeedRendererSlice
  extends TeamMessageFeedRendererState, TeamMessageFeedRendererSliceActions {}

export interface TeamMessageFeedRendererSliceDependencies<TScope> {
  actions: TeamMessageFeedActionsPort;
  activityPolicy: TeamMessageFeedActivityPolicyPort;
  cachePolicy: TeamMessageFeedCachePolicyPort;
  pendingReplyPolicy: TeamMessageFeedPendingReplyPolicyPort;
  requestScope: TeamMessageFeedRequestScopePort<TScope>;
  state: TeamMessageFeedStatePort;
  coordinator?: TeamMessageFeedCoordinator;
  transport?: TeamMessageFeedTransportPort;
}

function unchangedHeadResult(): RefreshTeamMessagesHeadResult {
  return {
    feedChanged: false,
    headChanged: false,
    feedRevision: null,
  };
}

export function createTeamMessageFeedRendererSlice<TScope>(
  dependencies: TeamMessageFeedRendererSliceDependencies<TScope>
): TeamMessageFeedRendererSlice {
  const coordinator = dependencies.coordinator ?? defaultTeamMessageFeedCoordinator;
  const transport = dependencies.transport ?? createTeamMessageFeedTransport();

  const refreshTeamMessagesHead = async (
    teamName: string
  ): Promise<RefreshTeamMessagesHeadResult> => {
    const existingRequest = coordinator.getHeadRequest(teamName);
    if (existingRequest) {
      coordinator.markFreshHeadRefreshPending(teamName);
      return existingRequest;
    }
    const queuedAfterOlder = coordinator.getQueuedHeadRequest(teamName);
    if (queuedAfterOlder) return queuedAfterOlder;

    const existingOlderRequest = coordinator.getOlderRequest(teamName);
    if (existingOlderRequest) {
      const queuedScope = dependencies.requestScope.capture(teamName);
      const queuedRequest = existingOlderRequest
        .then(() => {
          if (!dependencies.requestScope.isCurrent(teamName, queuedScope)) {
            return unchangedHeadResult();
          }
          if (!coordinator.deleteQueuedHeadRequest(teamName, queuedRequest)) {
            return unchangedHeadResult();
          }
          return dependencies.actions.getActions().refreshTeamMessagesHead(teamName);
        })
        .finally(() => {
          coordinator.deleteQueuedHeadRequest(teamName, queuedRequest);
        });
      coordinator.setQueuedHeadRequest(teamName, queuedRequest);
      return queuedRequest;
    }

    const requestScope = dependencies.requestScope.capture(teamName);
    dependencies.state.setState((state) => ({
      teamMessagesByName: {
        ...state.teamMessagesByName,
        [teamName]: {
          ...dependencies.cachePolicy.getEntry(state, teamName),
          loadingHead: true,
        },
      },
    }));

    const requestRef: { current: Promise<RefreshTeamMessagesHeadResult> | null } = {
      current: null,
    };
    requestRef.current = (async (): Promise<RefreshTeamMessagesHeadResult> => {
      try {
        const page = await transport.getMessagesPage(teamName, { limit: 50 });
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) {
          return unchangedHeadResult();
        }

        const previousEntry = dependencies.cachePolicy.getEntry(
          dependencies.state.getState(),
          teamName
        );
        const feedChanged =
          !previousEntry.headHydrated || previousEntry.feedRevision !== page.feedRevision;
        const previousHeadSlice = dependencies.cachePolicy.getCanonicalHeadSlice(
          previousEntry.canonicalMessages,
          page.messages.length
        );
        const headChanged = !dependencies.cachePolicy.areMessageArraysEquivalent(
          previousHeadSlice,
          page.messages
        );

        dependencies.state.setState((state) => {
          const current = dependencies.cachePolicy.getEntry(state, teamName);
          const retainedOlderTail = dependencies.cachePolicy.extractRetainedOlderTail(
            current.canonicalMessages,
            page.messages
          );
          const preserveLoadedOlderTail =
            Array.isArray(retainedOlderTail) && retainedOlderTail.length > 0;
          const nextCanonical = headChanged
            ? preserveLoadedOlderTail
              ? dependencies.cachePolicy.mergeMessages(retainedOlderTail, page.messages)
              : page.messages
            : current.canonicalMessages;
          const nextOptimistic = dependencies.cachePolicy.pruneOptimisticMessages(
            current.optimisticMessages,
            nextCanonical
          );
          return {
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...current,
                canonicalMessages: nextCanonical,
                optimisticMessages: nextOptimistic,
                feedRevision: page.feedRevision,
                nextCursor: preserveLoadedOlderTail ? current.nextCursor : page.nextCursor,
                hasMore: preserveLoadedOlderTail ? current.hasMore : page.hasMore,
                lastFetchedAt: Date.now(),
                loadingHead: false,
                headHydrated: true,
              },
            },
          };
        });

        return {
          feedChanged,
          headChanged,
          feedRevision: page.feedRevision,
        };
      } catch (error) {
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) {
          return unchangedHeadResult();
        }
        dependencies.state.setState((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...dependencies.cachePolicy.getEntry(state, teamName),
              loadingHead: false,
            },
          },
        }));
        throw error;
      } finally {
        const currentRequest = requestRef.current;
        if (currentRequest && coordinator.deleteHeadRequest(teamName, currentRequest)) {
          if (
            coordinator.consumeFreshHeadRefresh(teamName) &&
            dependencies.requestScope.isCurrent(teamName, requestScope)
          ) {
            void dependencies.actions.getActions().refreshTeamMessagesHead(teamName);
          }
        }
      }
    })();

    const request = requestRef.current;
    coordinator.setHeadRequest(teamName, request);
    return request;
  };

  const loadOlderTeamMessages = async (teamName: string): Promise<void> => {
    const requestedScope = dependencies.requestScope.capture(teamName);
    const existingRequest = coordinator.getOlderRequest(teamName);
    if (existingRequest) return existingRequest;

    const existingHeadRequest = coordinator.getHeadRequest(teamName);
    if (existingHeadRequest) {
      await existingHeadRequest;
      if (!dependencies.requestScope.isCurrent(teamName, requestedScope)) return;
    }

    let entry = dependencies.cachePolicy.getEntry(dependencies.state.getState(), teamName);
    if (!entry.headHydrated) {
      await dependencies.actions.getActions().refreshTeamMessagesHead(teamName);
      if (!dependencies.requestScope.isCurrent(teamName, requestedScope)) return;
      entry = dependencies.cachePolicy.getEntry(dependencies.state.getState(), teamName);
    }
    if (!entry.headHydrated || !entry.nextCursor || entry.loadingOlder || entry.loadingHead) return;

    const requestScope = dependencies.requestScope.capture(teamName);
    dependencies.state.setState((state) => ({
      teamMessagesByName: {
        ...state.teamMessagesByName,
        [teamName]: {
          ...dependencies.cachePolicy.getEntry(state, teamName),
          loadingOlder: true,
        },
      },
    }));

    const requestRef: { current: Promise<void> | null } = { current: null };
    requestRef.current = (async (): Promise<void> => {
      let shouldRefreshHead = false;
      try {
        const baseFeedRevision = entry.feedRevision;
        const page = await transport.getMessagesPage(teamName, {
          cursor: entry.nextCursor ?? undefined,
          limit: 50,
        });
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) return;

        const current = dependencies.cachePolicy.getEntry(dependencies.state.getState(), teamName);
        if (
          current.feedRevision !== baseFeedRevision ||
          (current.feedRevision && current.feedRevision !== page.feedRevision)
        ) {
          dependencies.state.setState((state) => ({
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...dependencies.cachePolicy.getEntry(state, teamName),
                loadingOlder: false,
              },
            },
          }));
          shouldRefreshHead = true;
        } else {
          dependencies.state.setState((state) => {
            const liveEntry = dependencies.cachePolicy.getEntry(state, teamName);
            return {
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: {
                  ...liveEntry,
                  canonicalMessages: dependencies.cachePolicy.mergeMessages(
                    liveEntry.canonicalMessages,
                    page.messages
                  ),
                  nextCursor: page.nextCursor,
                  hasMore: page.hasMore,
                  feedRevision: page.feedRevision,
                  loadingOlder: false,
                },
              },
            };
          });
        }
      } catch {
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) return;
        dependencies.state.setState((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...dependencies.cachePolicy.getEntry(state, teamName),
              loadingOlder: false,
            },
          },
        }));
      } finally {
        const currentRequest = requestRef.current;
        if (currentRequest) coordinator.deleteOlderRequest(teamName, currentRequest);
      }

      if (
        shouldRefreshHead &&
        !coordinator.getQueuedHeadRequest(teamName) &&
        dependencies.requestScope.isCurrent(teamName, requestScope)
      ) {
        try {
          await dependencies.actions.getActions().refreshTeamMessagesHead(teamName);
        } catch {
          // Revision recovery is best-effort; load-older historically contains refresh failures.
        }
      }
    })();

    const request = requestRef.current;
    coordinator.setOlderRequest(teamName, request);
    return request;
  };

  const refreshMemberActivityMeta = async (teamName: string): Promise<void> => {
    const entry = dependencies.cachePolicy.getEntry(dependencies.state.getState(), teamName);
    if (!entry.headHydrated) return;

    const existingRequest = coordinator.getMemberActivityRequest(teamName);
    if (existingRequest) {
      coordinator.markFreshMemberActivityRefreshPending(teamName);
      return existingRequest;
    }

    const requestScope = dependencies.requestScope.capture(teamName);
    const requestRef: { current: Promise<void> | null } = { current: null };
    requestRef.current = (async (): Promise<void> => {
      try {
        const meta = await transport.getMemberActivityMeta(teamName);
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) return;

        dependencies.state.setState((state) => {
          const currentFeedRevision = dependencies.cachePolicy.getEntry(
            state,
            teamName
          ).feedRevision;
          if (currentFeedRevision && meta.feedRevision !== currentFeedRevision) return {};
          const existing = state.memberActivityMetaByTeam[teamName];
          if (existing?.feedRevision === meta.feedRevision) return {};
          const sharedMembers = dependencies.activityPolicy.structurallyShareMembers(
            existing?.members,
            meta.members
          );
          const nextMeta =
            existing?.members === sharedMembers &&
            existing.feedRevision === meta.feedRevision &&
            existing.computedAt === meta.computedAt
              ? existing
              : { ...meta, members: sharedMembers };
          return {
            memberActivityMetaByTeam: {
              ...state.memberActivityMetaByTeam,
              [teamName]: nextMeta,
            },
          };
        });
      } catch (error) {
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) return;
        throw error;
      } finally {
        const currentRequest = requestRef.current;
        if (currentRequest && coordinator.deleteMemberActivityRequest(teamName, currentRequest)) {
          if (
            coordinator.consumeFreshMemberActivityRefresh(teamName) &&
            dependencies.requestScope.isCurrent(teamName, requestScope)
          ) {
            void dependencies.actions.getActions().refreshMemberActivityMeta(teamName);
          }
        }
      }
    })();

    const request = requestRef.current;
    coordinator.setMemberActivityRequest(teamName, request);
    return request;
  };

  const syncTeamPendingReplyRefresh = (
    teamName: string,
    sourceId: string,
    enabled: boolean,
    delayMs = 10_000
  ): void => {
    coordinator.clearPendingReplyTimer(teamName);
    if (!dependencies.pendingReplyPolicy.setEnabled(teamName, sourceId, enabled)) return;

    const timer = setTimeout(() => {
      if (!coordinator.deletePendingReplyTimer(teamName, timer)) return;
      void (async () => {
        try {
          const headResult = await dependencies.actions
            .getActions()
            .refreshTeamMessagesHead(teamName);
          if (
            headResult.feedChanged ||
            dependencies.activityPolicy.isStale(dependencies.state.getState(), teamName)
          ) {
            await dependencies.actions.getActions().refreshMemberActivityMeta(teamName);
          }
        } catch {
          // Best-effort delayed refresh while waiting for replies.
        }
      })();
    }, delayMs);
    coordinator.setPendingReplyTimer(teamName, timer);
  };

  return {
    teamMessagesByName: {},
    memberActivityMetaByTeam: {},
    loadOlderTeamMessages,
    refreshMemberActivityMeta,
    refreshTeamMessagesHead,
    syncTeamPendingReplyRefresh,
  };
}
