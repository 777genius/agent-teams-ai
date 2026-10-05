import { api } from '@renderer/api';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import { IpcError, unwrapIpc } from '@renderer/utils/unwrapIpc';

import {
  areInboxMessageArraysEquivalent,
  getTeamMessagesCacheEntry,
  pruneOptimisticMessages,
} from './teamMessagesCache';

import type { TeamSlice } from '../slices/teamSlice';
import type { AppState } from '../types';
import type {
  RefreshTeamMessagesHeadResult,
  TeamMessagesCacheEntry,
  TeamMessagesRequestScope,
} from './teamMessagesCache';
import type { StateCreator } from 'zustand';

type MessageActions = Pick<TeamSlice, 'refreshTeamMessagesHead' | 'loadOlderTeamMessages'>;
interface MessageActionPorts {
  set: Parameters<StateCreator<AppState>>[0];
  get: () => AppState;
  captureTeamRequestScope: (get: () => AppState, teamName: string) => TeamMessagesRequestScope;
  isTeamRequestScopeCurrent: (
    get: () => AppState,
    teamName: string,
    scope: TeamMessagesRequestScope
  ) => boolean;
  inFlightTeamMessagesHeadRequests: Map<string, Promise<RefreshTeamMessagesHeadResult>>;
  inFlightTeamMessagesOlderRequests: Map<string, Promise<void>>;
  queuedTeamMessagesHeadRefreshesAfterOlder: Map<string, Promise<RefreshTeamMessagesHeadResult>>;
  pendingFreshTeamMessagesHeadRefreshes: Set<string>;
}

/** Paging is fire-and-forget in the UI; expected head IPC failures already have a scoped notice. */
async function observeHeadForPaging(
  request: Promise<RefreshTeamMessagesHeadResult>
): Promise<boolean> {
  try {
    await request;
    return true;
  } catch (error) {
    if (error instanceof IpcError) return false;
    throw error;
  }
}

/** Head and explicitly requested history share the existing incarnation-scoped single-flight. */
export function createTeamMessagesProvenanceActions(ports: MessageActionPorts): MessageActions {
  const {
    set,
    get,
    captureTeamRequestScope,
    isTeamRequestScopeCurrent,
    inFlightTeamMessagesHeadRequests,
    inFlightTeamMessagesOlderRequests,
    queuedTeamMessagesHeadRefreshesAfterOlder,
    pendingFreshTeamMessagesHeadRefreshes,
  } = ports;
  const hasCurrentProvenance = (teamName: string, entry: TeamMessagesCacheEntry): boolean => {
    // Legacy entries have no page claims; their canonical array is treated as one head.
    if (!entry.provenance) return true;
    return (
      isTeamRequestScopeCurrent(get, teamName, entry.provenance.requestScope) &&
      entry.provenance.pages.every(
        (page) =>
          page.sourceRevision === entry.feedRevision &&
          isTeamRequestScopeCurrent(get, teamName, page.requestScope)
      )
    );
  };
  return {
    refreshTeamMessagesHead: async (teamName: string) => {
      const existingRequest = inFlightTeamMessagesHeadRequests.get(teamName);
      if (existingRequest) {
        pendingFreshTeamMessagesHeadRefreshes.add(teamName);
        return existingRequest;
      }
      const queuedAfterOlder = queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName);
      if (queuedAfterOlder) {
        return queuedAfterOlder;
      }

      const existingOlderRequest = inFlightTeamMessagesOlderRequests.get(teamName);
      if (existingOlderRequest) {
        const queuedScope = captureTeamRequestScope(get, teamName);
        const queuedRequest: Promise<RefreshTeamMessagesHeadResult> = existingOlderRequest
          .then(() => {
            if (!isTeamRequestScopeCurrent(get, teamName, queuedScope)) {
              return {
                feedChanged: false,
                headChanged: false,
                feedRevision: null,
              };
            }
            if (queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName) === queuedRequest) {
              queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
            } else {
              return {
                feedChanged: false,
                headChanged: false,
                feedRevision: null,
              };
            }
            return get().refreshTeamMessagesHead(teamName);
          })
          .finally(() => {
            if (queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName) === queuedRequest) {
              queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
            }
          });
        queuedTeamMessagesHeadRefreshesAfterOlder.set(teamName, queuedRequest);
        return queuedRequest;
      }

      const requestRef: { current: Promise<RefreshTeamMessagesHeadResult> | null } = {
        current: null,
      };
      requestRef.current = (async (): Promise<RefreshTeamMessagesHeadResult> => {
        const requestScope = captureTeamRequestScope(get, teamName);
        const startingRevision = getTeamMessagesCacheEntry(get(), teamName).feedRevision;
        set((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...getTeamMessagesCacheEntry(state, teamName),
              loadingHead: true,
            },
          },
        }));

        try {
          const page = await unwrapIpc('team:getMessagesPage', () =>
            api.teams.getMessagesPage(teamName, { limit: 50 })
          );
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesHeadRequests.get(teamName) !== requestRef.current
          ) {
            return {
              feedChanged: false,
              headChanged: false,
              feedRevision: null,
            };
          }

          const previousEntry = getTeamMessagesCacheEntry(get(), teamName);
          if (previousEntry.feedRevision !== startingRevision) {
            set((state) => ({
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: { ...getTeamMessagesCacheEntry(state, teamName), loadingHead: false },
              },
            }));
            return { feedChanged: false, headChanged: false, feedRevision: null };
          }
          const feedChanged =
            !previousEntry.headHydrated || previousEntry.feedRevision !== page.feedRevision;
          const previousHeadSlice =
            previousEntry.provenance?.head ?? previousEntry.canonicalMessages;
          const headChanged = !areInboxMessageArraysEquivalent(previousHeadSlice, page.messages);

          set((state) => {
            const current = getTeamMessagesCacheEntry(state, teamName);
            // Revisions hash all sources. Overlap cannot prove append-only history.
            const oldPages = current.provenance?.pages ?? [];
            const pages =
              current.feedRevision === page.feedRevision &&
              hasCurrentProvenance(teamName, current) &&
              // Live lead overlays are not included in feedRevision. Cursor continuity is
              // needed as well, otherwise the new head can leave an unseen durable gap.
              page.nextCursor === oldPages[0]?.inputCursor &&
              oldPages.every(
                (loaded) =>
                  loaded.requestScope.contextId === requestScope.contextId &&
                  loaded.requestScope.contextEpoch === requestScope.contextEpoch &&
                  loaded.requestScope.teamStateEpoch === requestScope.teamStateEpoch
              )
                ? oldPages
                : [];
            const historyReloadRequired = oldPages.length > 0 && pages.length === 0;
            const projected =
              pages.length > 0
                ? mergeTeamMessages(...pages.map((loaded) => loaded.messages), page.messages)
                : page.messages;
            const nextCanonical = areInboxMessageArraysEquivalent(
              current.canonicalMessages,
              projected
            )
              ? current.canonicalMessages
              : projected;
            const historyError = historyReloadRequired
              ? page.hasMore
                ? 'Message history changed. Load older messages again to refresh it.'
                : 'Message history changed. Showing the current history.'
              : current.historyReloadRequired
                ? current.messagesError
                : null;
            const nextOptimistic = pruneOptimisticMessages(
              current.optimisticMessages,
              nextCanonical
            );
            const nextEntry: TeamMessagesCacheEntry = {
              ...current,
              provenance: { head: page.messages, pages, requestScope },
              historyReloadRequired:
                (historyReloadRequired || current.historyReloadRequired) && page.hasMore,
              messagesError: historyError,
              canonicalMessages: nextCanonical,
              optimisticMessages: nextOptimistic,
              feedRevision: page.feedRevision,
              nextCursor: pages.length > 0 ? current.nextCursor : page.nextCursor,
              hasMore: pages.length > 0 ? current.hasMore : page.hasMore,
              lastFetchedAt: Date.now(),
              loadingHead: false,
              headHydrated: true,
            };
            return {
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: nextEntry,
              },
            };
          });

          return {
            feedChanged,
            headChanged,
            feedRevision: page.feedRevision,
          };
        } catch (error) {
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesHeadRequests.get(teamName) !== requestRef.current
          ) {
            return {
              feedChanged: false,
              headChanged: false,
              feedRevision: null,
            };
          }
          const revisionIsCurrent =
            getTeamMessagesCacheEntry(get(), teamName).feedRevision === startingRevision;
          set((state) => ({
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...getTeamMessagesCacheEntry(state, teamName),
                loadingHead: false,
                messagesError: revisionIsCurrent
                  ? error instanceof Error
                    ? error.message
                    : String(error)
                  : getTeamMessagesCacheEntry(state, teamName).messagesError,
              },
            },
          }));
          if (!revisionIsCurrent)
            return { feedChanged: false, headChanged: false, feedRevision: null };
          throw error;
        } finally {
          if (inFlightTeamMessagesHeadRequests.get(teamName) === requestRef.current) {
            inFlightTeamMessagesHeadRequests.delete(teamName);
            if (
              pendingFreshTeamMessagesHeadRefreshes.delete(teamName) &&
              isTeamRequestScopeCurrent(get, teamName, requestScope)
            ) {
              void get()
                .refreshTeamMessagesHead(teamName)
                .catch(() => undefined);
            }
          }
        }
      })();

      const request = requestRef.current;
      inFlightTeamMessagesHeadRequests.set(teamName, request);
      return request;
    },

    loadOlderTeamMessages: async (teamName: string) => {
      const requestedScope = captureTeamRequestScope(get, teamName);
      const existingRequest = inFlightTeamMessagesOlderRequests.get(teamName);
      if (existingRequest) {
        return existingRequest;
      }

      const existingHeadRequest = inFlightTeamMessagesHeadRequests.get(teamName);
      if (existingHeadRequest) {
        if (!(await observeHeadForPaging(existingHeadRequest))) return;
        if (!isTeamRequestScopeCurrent(get, teamName, requestedScope)) {
          return;
        }
      }

      let entry = getTeamMessagesCacheEntry(get(), teamName);
      if (!entry.headHydrated || !hasCurrentProvenance(teamName, entry)) {
        if (!(await observeHeadForPaging(get().refreshTeamMessagesHead(teamName)))) return;
        if (!isTeamRequestScopeCurrent(get, teamName, requestedScope)) {
          return;
        }
        entry = getTeamMessagesCacheEntry(get(), teamName);
      }

      if (
        !entry.headHydrated ||
        !hasCurrentProvenance(teamName, entry) ||
        !entry.nextCursor ||
        entry.loadingOlder ||
        entry.loadingHead
      ) {
        return;
      }

      const inputCursor = entry.nextCursor;
      let refreshRequired = false;
      const requestRef: { current: Promise<void> | null } = { current: null };
      requestRef.current = (async (): Promise<void> => {
        const requestScope = captureTeamRequestScope(get, teamName);
        set((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...getTeamMessagesCacheEntry(state, teamName),
              loadingOlder: true,
            },
          },
        }));

        try {
          const baseFeedRevision = entry.feedRevision;
          const page = await unwrapIpc('team:getMessagesPage', () =>
            api.teams.getMessagesPage(teamName, {
              cursor: inputCursor,
              limit: 50,
            })
          );
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesOlderRequests.get(teamName) !== requestRef.current
          ) {
            return;
          }

          const current = getTeamMessagesCacheEntry(get(), teamName);
          if (current.feedRevision !== baseFeedRevision) {
            set((state) => ({
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: {
                  ...getTeamMessagesCacheEntry(state, teamName),
                  loadingOlder: false,
                  historyReloadRequired: true,
                  messagesError:
                    'Message history changed. Load older messages again to refresh it.',
                },
              },
            }));
            refreshRequired = true;
            return;
          }

          if (current.feedRevision && current.feedRevision !== page.feedRevision) {
            set((state) => ({
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: {
                  ...getTeamMessagesCacheEntry(state, teamName),
                  loadingOlder: false,
                  historyReloadRequired: true,
                  messagesError:
                    'Message history changed. Load older messages again to refresh it.',
                },
              },
            }));
            refreshRequired = true;
            return;
          }

          set((state) => {
            const liveEntry = getTeamMessagesCacheEntry(state, teamName);
            const head = liveEntry.provenance?.head ?? liveEntry.canonicalMessages;
            const pages = [
              ...(liveEntry.provenance?.pages ?? []),
              {
                messages: page.messages,
                inputCursor,
                outputCursor: page.nextCursor,
                hasMore: page.hasMore,
                sourceRevision: page.feedRevision,
                requestScope,
              },
            ];
            const mergedCanonical = mergeTeamMessages(
              ...pages.map((loaded) => loaded.messages),
              head
            );
            return {
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: {
                  ...liveEntry,
                  provenance: { head, pages, requestScope },
                  canonicalMessages: mergedCanonical,
                  optimisticMessages: pruneOptimisticMessages(
                    liveEntry.optimisticMessages,
                    mergedCanonical
                  ),
                  historyReloadRequired: false,
                  messagesError: null,
                  nextCursor: page.nextCursor,
                  hasMore: page.hasMore,
                  feedRevision: page.feedRevision,
                  loadingOlder: false,
                },
              },
            };
          });
        } catch (error) {
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesOlderRequests.get(teamName) !== requestRef.current
          ) {
            return;
          }
          const revisionIsCurrent =
            getTeamMessagesCacheEntry(get(), teamName).feedRevision === entry.feedRevision;
          set((state) => ({
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...getTeamMessagesCacheEntry(state, teamName),
                loadingOlder: false,
                historyReloadRequired:
                  revisionIsCurrent ||
                  getTeamMessagesCacheEntry(state, teamName).historyReloadRequired,
                messagesError: revisionIsCurrent
                  ? error instanceof Error
                    ? error.message
                    : String(error)
                  : getTeamMessagesCacheEntry(state, teamName).messagesError,
              },
            },
          }));
        } finally {
          if (inFlightTeamMessagesOlderRequests.get(teamName) === requestRef.current) {
            inFlightTeamMessagesOlderRequests.delete(teamName);
          }
        }
      })();

      const request = requestRef.current;
      inFlightTeamMessagesOlderRequests.set(teamName, request);
      await request;
      if (refreshRequired && isTeamRequestScopeCurrent(get, teamName, requestedScope)) {
        await observeHeadForPaging(get().refreshTeamMessagesHead(teamName));
      }
    },
  };
}
