import { useCallback, useEffect, useState } from 'react';

import type { CliProviderStatus } from '@shared/types';

export type OpenCodeProviderScopedStatusListener = (
  sourceProviderId: string,
  providerStatus: CliProviderStatus | null
) => void;

export function useOpenCodeProviderScopedModelAuthority(projectPath: string | null | undefined) {
  const [statusBySourceId, setStatusBySourceId] = useState<ReadonlyMap<string, CliProviderStatus>>(
    () => new Map()
  );
  const publishStatus = useCallback<OpenCodeProviderScopedStatusListener>(
    (sourceProviderId, providerStatus) => {
      const sourceId = sourceProviderId.trim().toLowerCase();
      if (!sourceId) return;
      setStatusBySourceId((current) => {
        if (providerStatus && current.get(sourceId) === providerStatus) return current;
        if (!providerStatus && !current.has(sourceId)) return current;
        const next = new Map(current);
        if (providerStatus) next.set(sourceId, providerStatus);
        else next.delete(sourceId);
        return next;
      });
    },
    []
  );

  useEffect(() => setStatusBySourceId(new Map()), [projectPath]);

  return [statusBySourceId, publishStatus] as const;
}

export function usePublishOpenCodeProviderScopedStatus(
  listener: OpenCodeProviderScopedStatusListener | undefined,
  sourceProviderId: string | null,
  providerStatus: CliProviderStatus | null
): void {
  useEffect(() => {
    if (!listener || !sourceProviderId) return;
    listener(sourceProviderId, providerStatus);
    return () => listener(sourceProviderId, null);
  }, [listener, providerStatus, sourceProviderId]);
}
