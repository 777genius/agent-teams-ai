import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clearMemberModelOverrides } from '@renderer/components/team/members/MembersEditorSection';
import { useOpenCodePassiveStatusPrefetch } from '@renderer/hooks/useOpenCodePassiveStatusPrefetch';
import { useStore } from '@renderer/store';
import { isProviderModelCatalogExactReady } from '@shared/utils/providerStatusAuthority';

import {
  clearInheritedMemberModelsUnavailableForProvider,
  getSelectedOpenCodeModels,
} from './memberModelScope';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { TeamModelRuntimeProviderStatus } from '@renderer/utils/teamModelAvailability';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

export type OpenCodeProviderScopedStatusListener = (
  sourceProviderId: string,
  update:
    | { mode: 'publish'; providerStatus: CliProviderStatus }
    | { mode: 'loading' | 'detach' | 'withdraw'; providerStatus: null },
  generation: number,
  publisherToken: symbol
) => void;

interface ScopedAuthorityState {
  scopeKey: string;
  contributionsBySourceId: ReadonlyMap<string, ReadonlyMap<symbol, CliProviderStatus>>;
  retainedStatusBySourceId: ReadonlyMap<string, CliProviderStatus>;
  generationBySourceId: ReadonlyMap<string, number>;
}

const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;
const EMPTY_SCOPED_STATUSES: ReadonlyMap<string, CliProviderStatus> = new Map();

function createEmptyScopedAuthorityState(scopeKey: string): ScopedAuthorityState {
  return {
    scopeKey,
    contributionsBySourceId: new Map(),
    retainedStatusBySourceId: new Map(),
    generationBySourceId: new Map(),
  };
}

function pruneExpiredContributions(state: ScopedAuthorityState, now: number): ScopedAuthorityState {
  const contributionsBySourceId = new Map<string, ReadonlyMap<symbol, CliProviderStatus>>();
  const retainedStatusBySourceId = new Map<string, CliProviderStatus>();
  const sourceIds = new Set([
    ...state.contributionsBySourceId.keys(),
    ...state.retainedStatusBySourceId.keys(),
  ]);
  for (const sourceId of sourceIds) {
    const live = new Map(
      [...(state.contributionsBySourceId.get(sourceId) ?? [])].filter(([, status]) =>
        status.modelCatalogRefreshState === 'error' ||
        isProviderModelCatalogExactReady(status, now)
      )
    );
    if (live.size > 0) contributionsBySourceId.set(sourceId, live);
    const retained = state.retainedStatusBySourceId.get(sourceId);
    const selected =
      retained && isProviderModelCatalogExactReady(retained, now)
        ? retained
        : ([...live.values()].findLast((status) =>
            isProviderModelCatalogExactReady(status, now)
          ) ?? [...live.values()].at(-1));
    if (selected) retainedStatusBySourceId.set(sourceId, selected);
  }
  return { ...state, contributionsBySourceId, retainedStatusBySourceId };
}

export function useOpenCodeProviderScopedModelAuthority(projectPath: string | null | undefined) {
  const scopeKey = projectPath?.trim() ?? '';
  const [authorityState, setAuthorityState] = useState<ScopedAuthorityState>(() =>
    createEmptyScopedAuthorityState(scopeKey)
  );
  useEffect(() => {
    setAuthorityState((current) =>
      current.scopeKey === scopeKey ? current : createEmptyScopedAuthorityState(scopeKey)
    );
  }, [scopeKey]);

  const nextStaleAt = useMemo(() => {
    if (authorityState.scopeKey !== scopeKey) return null;
    const statuses = [
      ...authorityState.retainedStatusBySourceId.values(),
      ...[...authorityState.contributionsBySourceId.values()].flatMap((entries) => [
        ...entries.values(),
      ]),
    ];
    return statuses.reduce<number | null>((nearest, status) => {
      if (!isProviderModelCatalogExactReady(status)) return nearest;
      const staleAt = Date.parse(status.modelCatalog?.staleAt ?? '');
      return Number.isFinite(staleAt) && (nearest === null || staleAt < nearest)
        ? staleAt
        : nearest;
    }, null);
  }, [authorityState, scopeKey]);

  useEffect(() => {
    if (nextStaleAt === null) return;
    const delay = Math.max(0, nextStaleAt - Date.now());
    const timeoutId = window.setTimeout(
      () => setAuthorityState((current) => pruneExpiredContributions(current, Date.now())),
      Math.min(delay, MAX_BROWSER_TIMEOUT_MS)
    );
    return () => window.clearTimeout(timeoutId);
  }, [nextStaleAt]);

  const statusBySourceId = useMemo<ReadonlyMap<string, CliProviderStatus>>(() => {
    if (authorityState.scopeKey !== scopeKey) return EMPTY_SCOPED_STATUSES;
    return authorityState.retainedStatusBySourceId;
  }, [authorityState, scopeKey]);

  const publishStatus = useCallback<OpenCodeProviderScopedStatusListener>(
    (sourceProviderId, update, generation, publisherToken) => {
      const sourceId = sourceProviderId.trim().toLowerCase();
      if (!sourceId) return;
      setAuthorityState((current) => {
        if (update.mode !== 'publish' && current.scopeKey !== scopeKey) return current;
        current = pruneExpiredContributions(
          current.scopeKey === scopeKey ? current : createEmptyScopedAuthorityState(scopeKey),
          Date.now()
        );
        const currentContributions: ReadonlyMap<
          string,
          ReadonlyMap<symbol, CliProviderStatus>
        > = current.contributionsBySourceId;
        const generationBySourceId = new Map(current.generationBySourceId);
        const currentGeneration = generationBySourceId.get(sourceId) ?? -1;
        if (generation < currentGeneration) return current;
        const retainedStatusBySourceId = new Map<string, CliProviderStatus>(
          current.retainedStatusBySourceId
        );
        const sourceContributions = new Map<symbol, CliProviderStatus>(
          generation > currentGeneration ? [] : (currentContributions.get(sourceId) ?? [])
        );
        if (generation > currentGeneration) {
          generationBySourceId.set(sourceId, generation);
          retainedStatusBySourceId.delete(sourceId);
        }
        if (update.mode === 'publish') {
          sourceContributions.delete(publisherToken);
          sourceContributions.set(publisherToken, update.providerStatus);
          if (isProviderModelCatalogExactReady(update.providerStatus)) {
            retainedStatusBySourceId.set(sourceId, update.providerStatus);
          } else {
            const latestLiveStatus = [...sourceContributions.values()].findLast((status) =>
              isProviderModelCatalogExactReady(status)
            );
            if (latestLiveStatus) {
              retainedStatusBySourceId.set(sourceId, latestLiveStatus);
            } else {
              retainedStatusBySourceId.set(sourceId, update.providerStatus);
            }
          }
        } else if (update.mode !== 'loading') {
          sourceContributions.delete(publisherToken);
          const statuses = [...sourceContributions.values()];
          const latestLiveStatus =
            statuses.findLast((status) => isProviderModelCatalogExactReady(status)) ??
            statuses.at(-1);
          if (latestLiveStatus) {
            retainedStatusBySourceId.set(sourceId, latestLiveStatus);
          } else if (update.mode === 'withdraw') {
            retainedStatusBySourceId.delete(sourceId);
          }
        }
        const contributionsBySourceId = new Map<string, ReadonlyMap<symbol, CliProviderStatus>>(
          currentContributions
        );
        if (sourceContributions.size > 0) {
          contributionsBySourceId.set(sourceId, sourceContributions);
        } else {
          contributionsBySourceId.delete(sourceId);
        }
        return {
          scopeKey,
          contributionsBySourceId,
          retainedStatusBySourceId,
          generationBySourceId,
        };
      });
    },
    [scopeKey]
  );

  return [statusBySourceId, publishStatus] as const;
}

interface OpenCodeProviderScopedDialogModelStateOptions {
  projectPath: string | null | undefined;
  catalogEnabled?: boolean;
  passiveStatusPrefetchEnabled?: boolean;
  passiveProviderStatus?: CliProviderStatus | null;
  members: readonly MemberDraft[];
  syncModelsWithLead: boolean;
  selectedProviderId: TeamProviderId;
  selectedModel: string | null | undefined;
  runtimeProviderStatusById: ReadonlyMap<
    TeamProviderId,
    TeamModelRuntimeProviderStatus | null | undefined
  >;
  deferredProviderIds?: ReadonlySet<TeamProviderId>;
  openCodeLocalProviderIds?: ReadonlySet<string>;
  openCodeLocalProviderLookupAuthoritative?: boolean;
}

export function useOpenCodeProviderScopedDialogModelState({
  projectPath,
  catalogEnabled,
  passiveStatusPrefetchEnabled,
  passiveProviderStatus,
  members,
  syncModelsWithLead,
  selectedProviderId,
  selectedModel,
  runtimeProviderStatusById,
  deferredProviderIds,
  openCodeLocalProviderIds,
  openCodeLocalProviderLookupAuthoritative,
}: OpenCodeProviderScopedDialogModelStateOptions) {
  useOpenCodePassiveStatusPrefetch({
    enabled: passiveStatusPrefetchEnabled === true,
    projectPath,
  });
  const [openCodeProviderScopedStatusBySourceId, handleOpenCodeProviderScopedStatusChange] =
    useOpenCodeProviderScopedModelAuthority(projectPath);
  const catalogRefreshRevision = useStore((state) => state.cliProviderStatusScopeRevision) ?? 0;
  const effectiveMemberDrafts = useMemo(() => {
    const scopedMembers = syncModelsWithLead ? members.map(clearMemberModelOverrides) : members;
    return clearInheritedMemberModelsUnavailableForProvider({
      members: [...scopedMembers],
      selectedProviderId,
      runtimeProviderStatusById,
      deferredProviderIds,
      openCodeLocalProviderIds,
      openCodeLocalProviderLookupAuthoritative,
      openCodeProviderScopedStatusBySourceId,
    }).members;
  }, [
    deferredProviderIds,
    members,
    openCodeLocalProviderIds,
    openCodeLocalProviderLookupAuthoritative,
    openCodeProviderScopedStatusBySourceId,
    runtimeProviderStatusById,
    selectedProviderId,
    syncModelsWithLead,
  ]);
  const openCodePreparationEvidence = useMemo(
    () => ({
      selectedModels: getSelectedOpenCodeModels(
        selectedProviderId,
        selectedModel,
        effectiveMemberDrafts
      ),
      scopedStatusBySourceId: openCodeProviderScopedStatusBySourceId,
      localSourceIds: openCodeLocalProviderIds ?? new Set<string>(),
      localProviderLookupAuthoritative: openCodeLocalProviderLookupAuthoritative === true,
    }),
    [
      effectiveMemberDrafts,
      openCodeLocalProviderIds,
      openCodeLocalProviderLookupAuthoritative,
      openCodeProviderScopedStatusBySourceId,
      selectedModel,
      selectedProviderId,
    ]
  );
  return {
    effectiveMemberDrafts,
    handleOpenCodeProviderScopedStatusChange,
    openCodePreparationEvidence,
    openCodeProviderScopedStatusBySourceId,
    openCodeCatalogLoaderConfiguration: {
      enabled: catalogEnabled === true,
      projectPath,
      selectedModels: openCodePreparationEvidence.selectedModels,
      localProviderIds: openCodePreparationEvidence.localSourceIds,
      passiveProviderStatus,
      refreshRevision: catalogRefreshRevision,
      listener: handleOpenCodeProviderScopedStatusChange,
    },
  };
}

export function usePublishOpenCodeProviderScopedStatus(
  listener: OpenCodeProviderScopedStatusListener | undefined,
  sourceProviderId: string | null,
  providerStatus: CliProviderStatus | null,
  preservePreviousStatus = false,
  generation = 0
): void {
  const publisherTokenRef = useRef(Symbol('opencode-provider-scoped-status-publisher'));

  useEffect(() => {
    if (!listener || !sourceProviderId) return;
    const publisherToken = publisherTokenRef.current;
    return () =>
      listener(
        sourceProviderId,
        { mode: 'detach', providerStatus: null },
        generation,
        publisherToken
      );
  }, [generation, listener, sourceProviderId]);

  useEffect(() => {
    if (!listener || !sourceProviderId) return;
    listener(
      sourceProviderId,
      providerStatus
        ? { mode: 'publish', providerStatus }
        : preservePreviousStatus
          ? { mode: 'loading', providerStatus: null }
          : { mode: 'withdraw', providerStatus: null },
      generation,
      publisherTokenRef.current
    );
  }, [generation, listener, preservePreviousStatus, providerStatus, sourceProviderId]);
}
