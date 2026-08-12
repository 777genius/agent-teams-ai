import {
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalDecision,
  type HostedTeamApprovalId,
  type HostedTeamApprovalItem,
} from '../../contracts';

import type {
  HostedTeamApprovalRendererSlice,
  HostedTeamApprovalRendererSliceDependencies,
  HostedTeamApprovalRendererState,
} from '../ports/HostedTeamApprovalRendererPorts';
import type { Cursor } from '@shared/contracts/hosted';

const DEFAULT_PAGE_LIMIT = 25;

type PageReason = 'decision' | 'manual' | 'poll' | 'reconnect' | 'refresh';

interface FocusContext {
  readonly approvalId: HostedTeamApprovalId;
  readonly index: number;
}

interface PendingPage {
  readonly cursor: Cursor | null;
  readonly promise: Promise<void>;
}

interface PendingPreview {
  readonly approvalId: HostedTeamApprovalId;
  readonly generation: HostedTeamApprovalItem['generation'];
  readonly promise: Promise<void>;
}

interface PendingDecision {
  readonly approvalId: HostedTeamApprovalId;
  readonly decision: HostedTeamApprovalDecision;
  readonly generation: HostedTeamApprovalItem['generation'];
  readonly promise: Promise<void>;
}

function initialState(mounted: boolean): HostedTeamApprovalRendererState {
  return Object.freeze({
    mounted,
    items: Object.freeze([]),
    nextCursor: null,
    pageStatus: 'idle',
    pageError: null,
    selectedApprovalId: null,
    preview: null,
    previewStatus: 'idle',
    previewError: null,
    pendingDecision: null,
    decisionReceipt: null,
    decisionError: null,
    focusRequest: null,
  });
}

function mergePageItems(
  previous: readonly HostedTeamApprovalItem[],
  incoming: readonly HostedTeamApprovalItem[]
): readonly HostedTeamApprovalItem[] {
  const merged = [...previous];
  const indexById = new Map(merged.map((item, index) => [item.approvalId, index]));
  for (const item of incoming) {
    const index = indexById.get(item.approvalId);
    if (index === undefined) {
      indexById.set(item.approvalId, merged.length);
      merged.push(item);
    } else {
      merged[index] = item;
    }
  }
  return Object.freeze(merged);
}

function focusTarget(
  items: readonly HostedTeamApprovalItem[],
  context: FocusContext
): HostedTeamApprovalId | null {
  const sameApproval = items.find((item) => item.approvalId === context.approvalId);
  return (
    sameApproval?.approvalId ??
    items[context.index]?.approvalId ??
    items[Math.max(0, context.index - 1)]?.approvalId ??
    null
  );
}

function pageFailure(kind: string): string {
  switch (kind) {
    case 'invalid_request':
      return 'The approval request was rejected.';
    case 'not_found':
      return 'This team is no longer available.';
    case 'cancelled':
      return 'The approval refresh was cancelled.';
    default:
      return 'Approvals are temporarily unavailable.';
  }
}

function previewFailure(kind: string): string {
  switch (kind) {
    case 'invalid_request':
      return 'The preview request was rejected.';
    case 'stale_generation':
      return 'This approval changed. The pending list was refreshed.';
    case 'not_found':
      return 'This approval is no longer pending.';
    case 'cancelled':
      return 'The preview request was cancelled.';
    default:
      return 'The preview is temporarily unavailable.';
  }
}

function decisionFailure(kind: string): string {
  switch (kind) {
    case 'already_resolved':
      return 'This approval was already answered.';
    case 'stale_generation':
      return 'This approval changed before the decision was accepted.';
    case 'expired':
      return 'This approval expired before the decision was accepted.';
    case 'not_found':
      return 'This approval is no longer pending.';
    case 'invalid_request':
      return 'The approval decision was rejected.';
    case 'conflict':
      return 'The approval decision conflicts with an earlier command.';
    default:
      return 'The approval decision could not be confirmed.';
  }
}

export function createHostedTeamApprovalRendererSlice(
  dependencies: HostedTeamApprovalRendererSliceDependencies
): HostedTeamApprovalRendererSlice {
  const pageLimit = dependencies.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) {
    throw new TypeError('hosted-team-approval-renderer-page-limit-invalid');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 30_000) {
    throw new TypeError('hosted-team-approval-renderer-poll-interval-invalid');
  }

  let state = initialState(false);
  let mountCount = 0;
  let pageGeneration = 0;
  let previewGeneration = 0;
  let decisionGeneration = 0;
  let focusSequence = 0;
  let pageController: AbortController | null = null;
  let previewController: AbortController | null = null;
  let decisionController: AbortController | null = null;
  let pendingPage: PendingPage | null = null;
  let pendingPreview: PendingPreview | null = null;
  let pendingDecision: PendingDecision | null = null;
  let unsubscribeRefresh: (() => void) | null = null;
  let unsubscribeReconnect: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  const publish = (patch: Partial<HostedTeamApprovalRendererState>): void => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };

  const advancePage = (): number => {
    pageGeneration += 1;
    pageController?.abort();
    pageController = null;
    pendingPage = null;
    return pageGeneration;
  };

  const advancePreview = (): number => {
    previewGeneration += 1;
    previewController?.abort();
    previewController = null;
    pendingPreview = null;
    return previewGeneration;
  };

  const advanceDecision = (): number => {
    decisionGeneration += 1;
    decisionController?.abort();
    decisionController = null;
    pendingDecision = null;
    return decisionGeneration;
  };

  const advanceAll = (): void => {
    advancePage();
    advancePreview();
    advanceDecision();
  };

  const isCurrentPage = (generation: number): boolean =>
    state.mounted && pageGeneration === generation;
  const isCurrentPreview = (generation: number, item: HostedTeamApprovalItem): boolean =>
    state.mounted &&
    previewGeneration === generation &&
    state.selectedApprovalId === item.approvalId &&
    state.items.some(
      (candidate) =>
        candidate.approvalId === item.approvalId && candidate.generation === item.generation
    );
  const isCurrentDecision = (generation: number, item: HostedTeamApprovalItem): boolean =>
    state.mounted &&
    decisionGeneration === generation &&
    state.selectedApprovalId === item.approvalId &&
    state.items.some(
      (candidate) =>
        candidate.approvalId === item.approvalId && candidate.generation === item.generation
    );

  const requestPage = (
    cursor: Cursor | null,
    reason: PageReason,
    focusAfter?: FocusContext,
    force = false
  ): Promise<void> => {
    if (!state.mounted) return Promise.resolve();
    if (!force && pendingPage?.cursor === cursor) return pendingPage.promise;

    const selectedBefore = state.selectedApprovalId;
    const selectedIndex = state.items.findIndex((item) => item.approvalId === selectedBefore);
    const selectedContext =
      selectedBefore === null || selectedIndex < 0
        ? undefined
        : { approvalId: selectedBefore, index: selectedIndex };

    if (cursor === null && reason !== 'poll') {
      advanceAll();
    } else {
      advancePage();
    }
    const generation = pageGeneration;
    const controller = new AbortController();
    pageController = controller;

    const clearSelection = reason === 'reconnect';
    publish({
      pageStatus: reason === 'poll' ? state.pageStatus : 'loading',
      pageError: null,
      pendingDecision: null,
      focusRequest: null,
      ...(reason === 'decision' ? {} : { decisionReceipt: null, decisionError: null }),
      ...(clearSelection
        ? {
            selectedApprovalId: null,
            preview: null,
            previewStatus: 'idle',
            previewError: null,
          }
        : {}),
    });

    const promise = (async (): Promise<void> => {
      let result: Awaited<ReturnType<typeof dependencies.transport.getPage>>;
      try {
        result = await dependencies.transport.getPage(
          {
            schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
            teamId: dependencies.teamId,
            cursor,
            limit: pageLimit,
          },
          { signal: controller.signal }
        );
      } catch {
        if (!isCurrentPage(generation)) return;
        publish({ pageStatus: 'error', pageError: pageFailure('unavailable') });
        return;
      }
      if (!isCurrentPage(generation)) return;

      if (result.kind !== 'success') {
        publish({ pageStatus: 'error', pageError: pageFailure(result.kind) });
        return;
      }

      const items =
        cursor === null
          ? Object.freeze([...result.page.items])
          : mergePageItems(state.items, result.page.items);
      const previouslySelected = state.selectedApprovalId;
      const previousItem = state.items.find((item) => item.approvalId === previouslySelected);
      const currentItem = items.find((item) => item.approvalId === previouslySelected);
      const selectionIsCurrent =
        previousItem !== undefined &&
        currentItem !== undefined &&
        previousItem.generation === currentItem.generation;
      const staleSelectionContext = selectionIsCurrent ? undefined : selectedContext;
      const requestedFocus = focusAfter ?? staleSelectionContext;

      publish({
        items,
        nextCursor: result.page.nextCursor,
        pageStatus: 'ready',
        pageError: null,
        ...(selectionIsCurrent
          ? {}
          : {
              selectedApprovalId: null,
              preview: null,
              previewStatus: 'idle',
              previewError: null,
              pendingDecision: null,
            }),
        ...(requestedFocus === undefined
          ? {}
          : {
              focusRequest: Object.freeze({
                sequence: ++focusSequence,
                approvalId: focusTarget(items, requestedFocus),
              }),
            }),
      });
    })().finally(() => {
      if (pendingPage?.promise === promise) pendingPage = null;
      if (pageController === controller) pageController = null;
    });

    pendingPage = { cursor, promise };
    return promise;
  };

  const requestPreview = (item: HostedTeamApprovalItem): Promise<void> => {
    if (item.previewRef === null || !state.mounted) return Promise.resolve();
    const previewRef = item.previewRef;
    if (
      pendingPreview?.approvalId === item.approvalId &&
      pendingPreview.generation === item.generation
    ) {
      return pendingPreview.promise;
    }

    const generation = advancePreview();
    const controller = new AbortController();
    previewController = controller;
    publish({ preview: null, previewStatus: 'loading', previewError: null });

    const promise = (async (): Promise<void> => {
      let result: Awaited<ReturnType<typeof dependencies.transport.getPreview>>;
      try {
        result = await dependencies.transport.getPreview(
          {
            schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
            teamId: dependencies.teamId,
            approvalId: item.approvalId,
            expectedGeneration: item.generation,
            previewRef,
          },
          { signal: controller.signal }
        );
      } catch {
        if (!isCurrentPreview(generation, item)) return;
        publish({ previewStatus: 'error', previewError: previewFailure('unavailable') });
        return;
      }
      if (!isCurrentPreview(generation, item)) return;

      if (result.kind === 'success') {
        publish({ preview: result.preview, previewStatus: 'ready', previewError: null });
        return;
      }

      if (result.kind === 'stale_generation' || result.kind === 'not_found') {
        const index = state.items.findIndex(
          (candidate) => candidate.approvalId === item.approvalId
        );
        publish({
          selectedApprovalId: null,
          preview: null,
          previewStatus: 'error',
          previewError: previewFailure(result.kind),
          pendingDecision: null,
        });
        await requestPage(
          null,
          'refresh',
          { approvalId: item.approvalId, index: Math.max(0, index) },
          true
        );
        return;
      }

      publish({ previewStatus: 'error', previewError: previewFailure(result.kind) });
    })().finally(() => {
      if (pendingPreview?.promise === promise) pendingPreview = null;
      if (previewController === controller) previewController = null;
    });

    pendingPreview = { approvalId: item.approvalId, generation: item.generation, promise };
    return promise;
  };

  const decide = (decision: HostedTeamApprovalDecision): Promise<void> => {
    const item = state.items.find((candidate) => candidate.approvalId === state.selectedApprovalId);
    if (!state.mounted || item === undefined) return Promise.resolve();
    if (
      pendingDecision?.approvalId === item.approvalId &&
      pendingDecision.generation === item.generation &&
      pendingDecision.decision === decision
    ) {
      return pendingDecision.promise;
    }

    advancePage();
    const generation = advanceDecision();
    const controller = new AbortController();
    decisionController = controller;
    const index = state.items.findIndex((candidate) => candidate.approvalId === item.approvalId);

    let idempotencyKey: ReturnType<typeof dependencies.idempotencyKeys.create>;
    try {
      idempotencyKey = dependencies.idempotencyKeys.create({
        approvalId: item.approvalId,
        generation: item.generation,
        decision,
      });
    } catch {
      publish({
        pageStatus: state.items.length > 0 ? 'ready' : state.pageStatus,
        pendingDecision: null,
        decisionReceipt: null,
        decisionError: 'A secure approval command could not be created.',
      });
      return Promise.resolve();
    }

    publish({
      pageStatus: state.items.length > 0 ? 'ready' : state.pageStatus,
      pendingDecision: Object.freeze({
        approvalId: item.approvalId,
        generation: item.generation,
        decision,
      }),
      decisionReceipt: null,
      decisionError: null,
      focusRequest: null,
    });

    const promise = (async (): Promise<void> => {
      let result: Awaited<ReturnType<typeof dependencies.transport.decide>>;
      try {
        result = await dependencies.transport.decide(
          {
            schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
            teamId: dependencies.teamId,
            approvalId: item.approvalId,
            expectedGeneration: item.generation,
            idempotencyKey,
            decision,
          },
          { signal: controller.signal }
        );
      } catch {
        if (!isCurrentDecision(generation, item)) return;
        publish({
          pendingDecision: null,
          decisionError: decisionFailure('unavailable'),
        });
        return;
      }
      if (!isCurrentDecision(generation, item)) return;

      if (result.kind === 'committed' || result.kind === 'idempotent_replay') {
        publish({
          pendingDecision: null,
          decisionReceipt: result.receipt,
          decisionError: null,
        });
        await requestPage(
          null,
          'decision',
          { approvalId: item.approvalId, index: Math.max(0, index) },
          true
        );
        return;
      }

      publish({
        pendingDecision: null,
        decisionReceipt: null,
        decisionError: decisionFailure(result.kind),
      });
      if (
        result.kind === 'already_resolved' ||
        result.kind === 'stale_generation' ||
        result.kind === 'expired' ||
        result.kind === 'not_found'
      ) {
        await requestPage(
          null,
          'decision',
          { approvalId: item.approvalId, index: Math.max(0, index) },
          true
        );
      }
    })().finally(() => {
      if (pendingDecision?.promise === promise) pendingDecision = null;
      if (decisionController === controller) decisionController = null;
    });

    pendingDecision = {
      approvalId: item.approvalId,
      generation: item.generation,
      decision,
      promise,
    };
    return promise;
  };

  const slice: HostedTeamApprovalRendererSlice = Object.freeze({
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mount: () => {
      mountCount += 1;
      if (mountCount === 1) {
        advanceAll();
        state = initialState(true);
        for (const listener of listeners) listener();
        const refresh = (): void => {
          void requestPage(null, 'refresh', undefined, true);
        };
        const reconnect = (): void => {
          void requestPage(null, 'reconnect', undefined, true);
        };
        unsubscribeRefresh = dependencies.refresh.subscribe(refresh);
        unsubscribeReconnect = dependencies.reconnect.subscribe(reconnect);
        pollTimer = globalThis.setInterval(() => {
          // Never abort an operator action or overlap an existing page request.
          if (pendingDecision === null && pendingPage === null) {
            void requestPage(null, 'poll');
          }
        }, pollIntervalMs);
        void requestPage(null, 'manual', undefined, true);
      }

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        mountCount = Math.max(0, mountCount - 1);
        if (mountCount > 0) return;
        unsubscribeRefresh?.();
        unsubscribeReconnect?.();
        unsubscribeRefresh = null;
        unsubscribeReconnect = null;
        if (pollTimer !== null) globalThis.clearInterval(pollTimer);
        pollTimer = null;
        advanceAll();
        state = initialState(false);
        for (const listener of listeners) listener();
      };
    },
    reload: () => requestPage(null, 'manual'),
    loadMore: () =>
      state.nextCursor === null ? Promise.resolve() : requestPage(state.nextCursor, 'refresh'),
    selectApproval: (approvalId: HostedTeamApprovalId | null) => {
      if (!state.mounted) return Promise.resolve();
      if (approvalId === state.selectedApprovalId) {
        const selected = state.items.find((item) => item.approvalId === approvalId);
        if (
          selected !== undefined &&
          pendingPreview?.approvalId === selected.approvalId &&
          pendingPreview.generation === selected.generation
        ) {
          return pendingPreview.promise;
        }
        return Promise.resolve();
      }

      const item = state.items.find((candidate) => candidate.approvalId === approvalId);
      advanceAll();
      publish({
        pageStatus: state.items.length > 0 ? 'ready' : state.pageStatus,
        selectedApprovalId: item?.approvalId ?? null,
        preview: null,
        previewStatus: item?.previewRef === null ? 'ready' : 'idle',
        previewError: null,
        pendingDecision: null,
        decisionReceipt: null,
        decisionError: null,
        focusRequest: null,
      });
      return item === undefined || item.previewRef === null
        ? Promise.resolve()
        : requestPreview(item);
    },
    allow: () => decide('allow'),
    deny: () => decide('deny'),
  });

  return slice;
}
