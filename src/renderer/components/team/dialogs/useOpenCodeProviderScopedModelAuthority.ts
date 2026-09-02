import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CliProviderStatus } from '@shared/types';

export type OpenCodeProviderScopedStatusListener = (
  sourceProviderId: string,
  update:
    | { mode: 'publish'; providerStatus: CliProviderStatus }
    | { mode: 'detach' | 'withdraw'; providerStatus: null },
  publisherToken: symbol
) => void;

interface ScopedAuthorityState {
  scopeKey: string;
  contributionsBySourceId: ReadonlyMap<string, ReadonlyMap<symbol, CliProviderStatus>>;
  retainedStatusBySourceId: ReadonlyMap<string, CliProviderStatus>;
}

const EMPTY_SCOPED_STATUSES: ReadonlyMap<string, CliProviderStatus> = new Map();

function createEmptyScopedAuthorityState(scopeKey: string): ScopedAuthorityState {
  return {
    scopeKey,
    contributionsBySourceId: new Map(),
    retainedStatusBySourceId: new Map(),
  };
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

  const statusBySourceId = useMemo<ReadonlyMap<string, CliProviderStatus>>(() => {
    if (authorityState.scopeKey !== scopeKey) return EMPTY_SCOPED_STATUSES;
    return authorityState.retainedStatusBySourceId;
  }, [authorityState, scopeKey]);

  const publishStatus = useCallback<OpenCodeProviderScopedStatusListener>(
    (sourceProviderId, update, publisherToken) => {
      const sourceId = sourceProviderId.trim().toLowerCase();
      if (!sourceId) return;
      setAuthorityState((current) => {
        if (update.mode !== 'publish' && current.scopeKey !== scopeKey) return current;
        const currentContributions: ReadonlyMap<
          string,
          ReadonlyMap<symbol, CliProviderStatus>
        > = current.scopeKey === scopeKey
          ? current.contributionsBySourceId
          : new Map<string, ReadonlyMap<symbol, CliProviderStatus>>();
        const retainedStatusBySourceId = new Map<string, CliProviderStatus>(
          current.scopeKey === scopeKey ? current.retainedStatusBySourceId : []
        );
        const sourceContributions = new Map<symbol, CliProviderStatus>(
          currentContributions.get(sourceId) ?? []
        );
        if (update.mode === 'publish') {
          sourceContributions.delete(publisherToken);
          sourceContributions.set(publisherToken, update.providerStatus);
          retainedStatusBySourceId.set(sourceId, update.providerStatus);
        } else {
          sourceContributions.delete(publisherToken);
          const latestLiveStatus = [...sourceContributions.values()].at(-1);
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
        return { scopeKey, contributionsBySourceId, retainedStatusBySourceId };
      });
    },
    [scopeKey]
  );

  return [statusBySourceId, publishStatus] as const;
}

export function usePublishOpenCodeProviderScopedStatus(
  listener: OpenCodeProviderScopedStatusListener | undefined,
  sourceProviderId: string | null,
  providerStatus: CliProviderStatus | null,
  preservePreviousStatus = false
): void {
  const publisherTokenRef = useRef(Symbol('opencode-provider-scoped-status-publisher'));

  useEffect(() => {
    if (!listener || !sourceProviderId) return;
    const publisherToken = publisherTokenRef.current;
    return () =>
      listener(sourceProviderId, { mode: 'detach', providerStatus: null }, publisherToken);
  }, [listener, sourceProviderId]);

  useEffect(() => {
    if (!listener || !sourceProviderId || (!providerStatus && preservePreviousStatus)) return;
    listener(
      sourceProviderId,
      providerStatus
        ? { mode: 'publish', providerStatus }
        : { mode: 'withdraw', providerStatus: null },
      publisherTokenRef.current
    );
  }, [listener, preservePreviousStatus, providerStatus, sourceProviderId]);
}
