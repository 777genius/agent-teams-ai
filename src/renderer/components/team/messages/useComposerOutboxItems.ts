import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { composerDraftRepository } from '@renderer/services/composerDraftRepository';
import {
  canonicalComposerOutboxReconciliations,
  composerOutboxItemFromRecovery,
  composerOutboxItemFromUnavailableWorking,
} from '@renderer/services/composerOutbox';
import {
  composerDraftAddressKey,
  sameComposerDraftAddress,
} from '@renderer/utils/composerDraftIdentity';

import type { ComposerDraftDestination } from './composerDraftDestination';
import type { ComposerOutboxItem } from '@renderer/services/composerOutbox';
import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerPersistenceStatus,
  RestoreRecoveryResult,
} from '@renderer/types/composerDraft';
import type { InboxMessage } from '@shared/types';

interface UseComposerOutboxItemsOptions {
  readonly contextId: string;
  readonly teamName: string;
  readonly viewAddress: ComposerDraftAddress | null;
  readonly destination: ComposerDraftDestination | null;
  readonly canonicalMessages: readonly InboxMessage[];
  readonly canOpenAddress: (address: ComposerDraftAddress) => boolean;
  readonly repository?: ComposerDraftRepository;
}

interface ComposerOutboxItemsState {
  readonly items: readonly ComposerOutboxItem[];
  readonly status: ComposerPersistenceStatus;
  readonly readError: string | null;
}

export interface ComposerOutboxController extends ComposerOutboxItemsState {
  readonly refresh: () => Promise<void>;
  readonly copy: (item: ComposerOutboxItem) => Promise<void>;
  readonly restore: (item: ComposerOutboxItem) => Promise<RestoreRecoveryResult>;
  readonly discard: (
    item: ComposerOutboxItem
  ) => Promise<'discarded' | 'missing' | 'conflict' | 'active' | 'blocked'>;
}

const EMPTY_STATE: ComposerOutboxItemsState = {
  items: [],
  status: 'durable',
  readError: null,
};

export function shouldProjectComposerOutboxItem(
  address: ComposerDraftAddress | null,
  destinationAddress: ComposerDraftAddress,
  canOpenAddress: (address: ComposerDraftAddress) => boolean
): boolean {
  if (address && sameComposerDraftAddress(address, destinationAddress)) return true;
  return (
    destinationAddress.target.kind === 'team-feed' &&
    (address == null || !canOpenAddress(address))
  );
}

export function useComposerOutboxItems({
  contextId,
  teamName,
  viewAddress,
  destination,
  canonicalMessages,
  canOpenAddress,
  repository = composerDraftRepository,
}: UseComposerOutboxItemsOptions): ComposerOutboxController {
  const [state, setState] = useState<ComposerOutboxItemsState>(EMPTY_STATE);
  const generationRef = useRef(0);
  const reconciliationInFlightRef = useRef(new Set<string>());
  const destinationRef = useRef(destination);
  destinationRef.current = destination;
  const viewAddressRef = useRef(viewAddress);
  viewAddressRef.current = viewAddress;
  const viewAddressKey = viewAddress ? composerDraftAddressKey(viewAddress) : '';

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    const currentViewAddress = viewAddressRef.current;
    if (
      !currentViewAddress ||
      composerDraftAddressKey(currentViewAddress) !== viewAddressKey
    ) {
      setState(EMPTY_STATE);
      return;
    }
    const [recoveriesResult, workingResult] = await Promise.all([
      repository.listRecoveries(contextId, teamName),
      repository.listWorkingSummaries(contextId, teamName),
    ]);
    if (generation !== generationRef.current) return;

    const recoverySummaries = recoveriesResult.recoveries.filter((summary) =>
      shouldProjectComposerOutboxItem(
        summary.address,
        currentViewAddress,
        canOpenAddress
      )
    );
    const fallbackWorkingSummaries =
      currentViewAddress.target.kind === 'team-feed'
        ? workingResult.summaries.filter((summary) => !canOpenAddress(summary.address))
        : [];
    const [recoveryRecords, unavailableWorking] = await Promise.all([
      Promise.all(
        recoverySummaries.map((summary) =>
          repository.loadRecovery(contextId, teamName, summary.id)
        )
      ),
      Promise.all(
        fallbackWorkingSummaries.map(async (summary) => ({
          summary,
          result: await repository.loadWorking(summary.address),
        }))
      ),
    ]);
    if (generation !== generationRef.current) return;

    const status: ComposerPersistenceStatus =
      recoveriesResult.status === 'memory-only' ||
      workingResult.status === 'memory-only' ||
      unavailableWorking.some(({ result }) => result.status === 'memory-only')
        ? 'memory-only'
        : 'durable';
    const recoveryItems = recoveryRecords.flatMap((record) =>
      record
        ? [
            composerOutboxItemFromRecovery(
              record,
              repository.isAttemptActive(record.id),
              status
            ),
          ]
        : []
    );
    const workingItems = unavailableWorking.flatMap(({ result, summary }) => {
      const item = composerOutboxItemFromUnavailableWorking(
        result.working,
        summary,
        result.status
      );
      return item ? [item] : [];
    });
    const items = [...recoveryItems, ...workingItems].sort(
      (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)
    );
    const readError = recoveriesResult.readError ?? workingResult.readError ?? null;
    setState((previous) => ({
      items: readError && items.length === 0 && previous.items.length > 0 ? previous.items : items,
      status,
      readError,
    }));
  }, [canOpenAddress, contextId, repository, teamName, viewAddressKey]);

  useEffect(() => {
    void refresh();
    return repository.subscribe((event) => {
      if (event.contextId !== contextId || event.teamName !== teamName) return;
      if (
        event.kind === 'recoveries' ||
        event.kind === 'working-index' ||
        event.kind === 'attempt-state'
      ) {
        void refresh();
      }
    });
  }, [contextId, refresh, repository, teamName]);

  const reconciliations = useMemo(
    () => canonicalComposerOutboxReconciliations(state.items, canonicalMessages),
    [canonicalMessages, state.items]
  );
  const visibleItems = useMemo(() => {
    if (reconciliations.length === 0) return state.items;
    const reconciledIds = new Set(reconciliations.map(({ recoveryId }) => recoveryId));
    return state.items.filter(
      (item) => item.source.kind !== 'recovery' || !reconciledIds.has(item.source.recoveryId)
    );
  }, [reconciliations, state.items]);
  useEffect(() => {
    for (const reconciliation of reconciliations) {
      const key = `${reconciliation.recoveryId}\0${reconciliation.messageId}`;
      if (reconciliationInFlightRef.current.has(key)) continue;
      reconciliationInFlightRef.current.add(key);
      void repository
        .reconcileRecovery(
          contextId,
          teamName,
          reconciliation.recoveryId,
          reconciliation.messageId
        )
        .finally(() => {
          reconciliationInFlightRef.current.delete(key);
        });
    }
  }, [contextId, reconciliations, repository, teamName]);

  const copy = useCallback(async (item: ComposerOutboxItem): Promise<void> => {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(item.displayText).catch(() => undefined);
  }, []);

  const restore = useCallback(
    async (item: ComposerOutboxItem): Promise<RestoreRecoveryResult> => {
      const currentDestination = destinationRef.current;
      if (!currentDestination?.isLoaded) {
        return { kind: 'active', status: state.status };
      }
      if (!currentDestination.isEmpty) {
        return { kind: 'conflict', status: state.status };
      }
      if (item.status === 'sending' || item.status === 'syncing') {
        return { kind: 'active', status: state.status };
      }
      if (item.source.kind === 'working') {
        return currentDestination.moveWorkingAsNew(item.source.summary);
      }
      const moving = !item.address || !sameComposerDraftAddress(item.address, currentDestination.address);
      return currentDestination.restoreRecovery(
        contextId,
        teamName,
        item.source.recoveryId,
        moving ? { asNewMessage: true } : undefined
      );
    },
    [contextId, state.status, teamName]
  );

  const discard = useCallback(
    async (
      item: ComposerOutboxItem
    ): Promise<'discarded' | 'missing' | 'conflict' | 'active' | 'blocked'> => {
      if (item.source.kind === 'working') {
        return repository.discardWorking(
          item.source.summary.address,
          item.source.summary.workingRevision
        );
      }
      return repository.discardRecovery(
        contextId,
        teamName,
        item.source.recoveryId
      );
    },
    [contextId, repository, teamName]
  );

  return { ...state, items: visibleItems, refresh, copy, restore, discard };
}
