import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import {
  HOSTED_MEMBER_LOG_MAX_CURSOR_HISTORY,
  HOSTED_MEMBER_LOG_MAX_PAGE_ITEMS,
  HOSTED_MEMBER_LOG_MAX_RENDERED_ENTRIES,
  HOSTED_MEMBER_LOG_SCHEMA_VERSION,
  type HostedMemberLogEntry,
  type HostedMemberLogSelectionId,
  type HostedMemberLogSourceGeneration,
} from '../../../contracts/hosted';

import type { HostedMemberLogTransport } from '../ports/HostedMemberLogRendererPorts';
import type { Cursor, Revision } from '@shared/contracts/hosted';

const DEFAULT_PAGE_LIMIT = 25;
const SAFE_LOAD_ERROR = 'Member log entries are temporarily unavailable. Refresh to try again.';

export interface UseHostedMemberLogInput {
  /** Authority-issued selection id; team and member authority never come from the renderer request. */
  readonly selectionId: HostedMemberLogSelectionId;
  readonly transport: HostedMemberLogTransport;
  readonly enabled?: boolean;
  readonly pageLimit?: number;
}

export interface UseHostedMemberLogResult {
  readonly entries: readonly HostedMemberLogEntry[];
  readonly sourceGeneration: HostedMemberLogSourceGeneration | null;
  readonly revision: Revision | null;
  readonly nextCursor: Cursor | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
}

interface HostedMemberLogViewState {
  /** The selection/transport incarnation that owns every retained value in this state. */
  readonly selectionEpoch: number;
  readonly entries: readonly HostedMemberLogEntry[];
  readonly sourceGeneration: HostedMemberLogSourceGeneration | null;
  readonly revision: Revision | null;
  readonly nextCursor: Cursor | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
}

interface CurrentSelection {
  readonly selectionId: HostedMemberLogSelectionId;
  readonly transport: HostedMemberLogTransport;
  readonly epoch: number;
}

interface MergedEntries {
  readonly entries: readonly HostedMemberLogEntry[];
  readonly atCapacity: boolean;
}

function initialState(selectionEpoch: number, loading: boolean): HostedMemberLogViewState {
  return Object.freeze({
    selectionEpoch,
    entries: Object.freeze([]),
    sourceGeneration: null,
    revision: null,
    nextCursor: null,
    loading,
    loadingMore: false,
    error: null,
  });
}

function mergeEntries(
  existing: readonly HostedMemberLogEntry[],
  incoming: readonly HostedMemberLogEntry[]
): MergedEntries {
  const seen = new Set<string>();
  const entries: HostedMemberLogEntry[] = [];
  for (const entry of [...existing, ...incoming]) {
    if (seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    if (entries.length >= HOSTED_MEMBER_LOG_MAX_RENDERED_ENTRIES) break;
    entries.push(entry);
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    atCapacity: entries.length >= HOSTED_MEMBER_LOG_MAX_RENDERED_ENTRIES,
  });
}

function validPageLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= HOSTED_MEMBER_LOG_MAX_PAGE_ITEMS;
}

/**
 * Loads authority-selected member-log pages with generation, selection, and bounded cursor fences.
 * A completion only commits when the same selection incarnation that started it is still current.
 */
export function useHostedMemberLog(input: UseHostedMemberLogInput): UseHostedMemberLogResult {
  const enabled = input.enabled ?? true;
  const pageLimit = input.pageLimit ?? DEFAULT_PAGE_LIMIT;
  if (!validPageLimit(pageLimit)) {
    throw new TypeError('hosted-member-log-renderer-page-limit-invalid');
  }

  const [state, setState] = useState<HostedMemberLogViewState>(() => initialState(0, enabled));
  const stateRef = useRef(state);
  const requestEpochRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const seenCursorsRef = useRef(new Set<Cursor>());
  const currentSelectionRef = useRef<CurrentSelection>({
    selectionId: input.selectionId,
    transport: input.transport,
    epoch: 0,
  });
  const renderedSelectionIsCurrent =
    currentSelectionRef.current.selectionId === input.selectionId &&
    currentSelectionRef.current.transport === input.transport;
  const selectionEpoch = currentSelectionRef.current.epoch + (renderedSelectionIsCurrent ? 0 : 1);
  /**
   * Mask prior data during render, before any effect can reset state, so member A can never render
   * for member B after a selection or transport change.
   */
  const visibleState =
    renderedSelectionIsCurrent && state.selectionEpoch === selectionEpoch
      ? state
      : initialState(selectionEpoch, enabled);

  const publish = useCallback((next: HostedMemberLogViewState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const isCurrent = useCallback(
    (
      requestEpoch: number,
      selectionEpoch: number,
      controller: AbortController,
      selectionId: HostedMemberLogSelectionId,
      transport: HostedMemberLogTransport
    ): boolean => {
      const currentSelection = currentSelectionRef.current;
      return (
        requestEpochRef.current === requestEpoch &&
        currentSelection.epoch === selectionEpoch &&
        currentSelection.selectionId === selectionId &&
        currentSelection.transport === transport &&
        !controller.signal.aborted
      );
    },
    []
  );

  const retainNextCursor = useCallback((cursor: Cursor | null): Cursor | null => {
    if (cursor === null) return null;
    const seen = seenCursorsRef.current;
    if (seen.has(cursor) || seen.size >= HOSTED_MEMBER_LOG_MAX_CURSOR_HISTORY) return null;
    seen.add(cursor);
    return cursor;
  }, []);

  const loadFirstPage = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const selection = currentSelectionRef.current;
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    inFlightRef.current = true;
    seenCursorsRef.current = new Set();
    const before = stateRef.current;
    publish(
      Object.freeze({
        ...before,
        selectionEpoch: selection.epoch,
        entries: Object.freeze([]),
        sourceGeneration: null,
        revision: null,
        nextCursor: null,
        loading: true,
        loadingMore: false,
        error: null,
      })
    );

    try {
      const result = await selection.transport.getPage(
        Object.freeze({
          schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
          selectionId: selection.selectionId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: pageLimit,
        }),
        Object.freeze({ signal: controller.signal })
      );
      if (
        !isCurrent(
          requestEpoch,
          selection.epoch,
          controller,
          selection.selectionId,
          selection.transport
        )
      ) {
        return;
      }
      inFlightRef.current = false;
      requestControllerRef.current = null;
      if (result.kind !== 'success' || result.page.selectionId !== selection.selectionId) {
        publish(
          Object.freeze({
            ...stateRef.current,
            loading: false,
            loadingMore: false,
            error: SAFE_LOAD_ERROR,
          })
        );
        return;
      }
      const merged = mergeEntries([], result.page.entries);
      const nextCursor = merged.atCapacity ? null : retainNextCursor(result.page.nextCursor);
      publish(
        Object.freeze({
          selectionEpoch: selection.epoch,
          entries: merged.entries,
          sourceGeneration: result.page.sourceGeneration,
          revision: result.page.revision,
          nextCursor,
          loading: false,
          loadingMore: false,
          error: null,
        })
      );
    } catch {
      if (
        !isCurrent(
          requestEpoch,
          selection.epoch,
          controller,
          selection.selectionId,
          selection.transport
        )
      ) {
        return;
      }
      inFlightRef.current = false;
      requestControllerRef.current = null;
      publish(
        Object.freeze({
          ...stateRef.current,
          loading: false,
          loadingMore: false,
          error: SAFE_LOAD_ERROR,
        })
      );
    }
  }, [enabled, isCurrent, pageLimit, publish, retainNextCursor]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!enabled || inFlightRef.current) return;
    const snapshot = stateRef.current;
    const currentSelection = currentSelectionRef.current;
    if (snapshot.selectionEpoch !== currentSelection.epoch) return;
    if (
      snapshot.nextCursor === null ||
      snapshot.sourceGeneration === null ||
      snapshot.revision === null
    ) {
      return;
    }
    if (
      snapshot.entries.length >= HOSTED_MEMBER_LOG_MAX_RENDERED_ENTRIES ||
      seenCursorsRef.current.size >= HOSTED_MEMBER_LOG_MAX_CURSOR_HISTORY
    ) {
      publish(Object.freeze({ ...snapshot, nextCursor: null, loadingMore: false }));
      return;
    }

    const selection = currentSelection;
    const requestCursor = snapshot.nextCursor;
    const expectedSourceGeneration = snapshot.sourceGeneration;
    const expectedRevision = snapshot.revision;
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    inFlightRef.current = true;
    publish(Object.freeze({ ...snapshot, loadingMore: true, error: null }));

    try {
      const result = await selection.transport.getPage(
        Object.freeze({
          schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
          selectionId: selection.selectionId,
          cursor: requestCursor,
          expectedSourceGeneration,
          limit: pageLimit,
        }),
        Object.freeze({ signal: controller.signal })
      );
      if (
        !isCurrent(
          requestEpoch,
          selection.epoch,
          controller,
          selection.selectionId,
          selection.transport
        )
      ) {
        return;
      }
      inFlightRef.current = false;
      requestControllerRef.current = null;
      if (result.kind === 'stale_generation') {
        void loadFirstPage();
        return;
      }
      if (
        result.kind !== 'success' ||
        result.page.selectionId !== selection.selectionId ||
        result.page.sourceGeneration !== expectedSourceGeneration ||
        result.page.revision !== expectedRevision ||
        (result.page.nextCursor !== null && seenCursorsRef.current.has(result.page.nextCursor))
      ) {
        if (result.kind === 'success') {
          void loadFirstPage();
          return;
        }
        publish(
          Object.freeze({
            ...stateRef.current,
            loading: false,
            loadingMore: false,
            error: SAFE_LOAD_ERROR,
          })
        );
        return;
      }
      const merged = mergeEntries(stateRef.current.entries, result.page.entries);
      const nextCursor = merged.atCapacity ? null : retainNextCursor(result.page.nextCursor);
      publish(
        Object.freeze({
          selectionEpoch: selection.epoch,
          entries: merged.entries,
          sourceGeneration: result.page.sourceGeneration,
          revision: result.page.revision,
          nextCursor,
          loading: false,
          loadingMore: false,
          error: null,
        })
      );
    } catch {
      if (
        !isCurrent(
          requestEpoch,
          selection.epoch,
          controller,
          selection.selectionId,
          selection.transport
        )
      ) {
        return;
      }
      inFlightRef.current = false;
      requestControllerRef.current = null;
      publish(
        Object.freeze({
          ...stateRef.current,
          loadingMore: false,
          error: SAFE_LOAD_ERROR,
        })
      );
    }
  }, [enabled, isCurrent, loadFirstPage, pageLimit, publish, retainNextCursor]);

  useLayoutEffect(() => {
    if (
      currentSelectionRef.current.selectionId !== input.selectionId ||
      currentSelectionRef.current.transport !== input.transport
    ) {
      currentSelectionRef.current = {
        selectionId: input.selectionId,
        transport: input.transport,
        epoch: selectionEpoch,
      };
    }
    requestEpochRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    inFlightRef.current = false;
    seenCursorsRef.current = new Set();
    publish(initialState(selectionEpoch, enabled));
    if (enabled) void loadFirstPage();
    return () => {
      requestEpochRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      inFlightRef.current = false;
    };
  }, [enabled, input.selectionId, input.transport, loadFirstPage, publish, selectionEpoch]);

  return Object.freeze({
    entries: visibleState.entries,
    sourceGeneration: visibleState.sourceGeneration,
    revision: visibleState.revision,
    nextCursor: visibleState.nextCursor,
    loading: visibleState.loading,
    loadingMore: visibleState.loadingMore,
    error: visibleState.error,
    reload: loadFirstPage,
    loadMore,
  });
}
