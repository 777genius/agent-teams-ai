import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import {
  canonicalLaunchTrustProviders,
  getWorkspaceTrustDisplayStatus,
} from '../view-models/workspaceTrustLaunchNotice';

import type { WorkspaceTrustDisplayStatus } from '../view-models/workspaceTrustLaunchNotice';
import type { LaunchTrustRequest } from '@features/workspace-trust/contracts';

export type { WorkspaceTrustDisplayStatus } from '../view-models/workspaceTrustLaunchNotice';
export { shouldShowWorkspaceTrustLaunchNotice } from '../view-models/workspaceTrustLaunchNotice';

interface WorkspaceTrustStatusSnapshot {
  requestKey: LaunchTrustRequest | null;
  status: WorkspaceTrustDisplayStatus;
}

export function useWorkspaceTrustStatus(input: {
  enabled: boolean;
  projectPath: string | null;
  providerIds: readonly string[];
}): WorkspaceTrustDisplayStatus {
  const projectPath = input.projectPath?.trim() ?? '';
  const providerKey = canonicalLaunchTrustProviders(input.providerIds).join(',');
  const localReadAllowed = useStore(
    (state) =>
      (!state.activeContextId || state.activeContextId === 'local') &&
      !state.isContextSwitching &&
      state.connectionMode !== 'ssh'
  );
  const sourceKey = useStore((state) =>
    JSON.stringify([
      state.activeContextId,
      state.isContextSwitching,
      state.targetContextId,
      state.connectionMode,
      state.connectionState,
      state.connectedHost,
      state.appConfig?.general?.claudeRootPath,
    ])
  );
  // Identity belongs to this open/path/provider/source lifecycle, never a cached pathname.
  const requestKey = useMemo(
    () =>
      input.enabled && projectPath && providerKey
        ? {
            projectPath,
            providerIds: canonicalLaunchTrustProviders(providerKey.split(',')),
            sourceKey,
          }
        : null,
    [input.enabled, projectPath, providerKey, sourceKey]
  );
  const [snapshot, setSnapshot] = useState<WorkspaceTrustStatusSnapshot>({
    requestKey: null,
    status: 'disabled',
  });

  useEffect(() => {
    if (!requestKey) {
      return undefined;
    }

    const workspaceTrustApi = api.workspaceTrust;
    if (!workspaceTrustApi || !localReadAllowed) {
      setSnapshot({ requestKey, status: 'unknown' });
      return undefined;
    }

    let finished = false;
    const finish = (result: unknown): void => {
      if (finished) return;
      finished = true;
      window.clearTimeout(deadlineId);
      setSnapshot({
        requestKey,
        status: getWorkspaceTrustDisplayStatus(result, requestKey.providerIds),
      });
    };
    const deadlineId = window.setTimeout(() => finish(null), 2_000);
    const timeoutId = window.setTimeout(() => {
      void Promise.resolve()
        .then(async () => {
          if (workspaceTrustApi.getLaunchStatus)
            return workspaceTrustApi.getLaunchStatus({
              projectPath: requestKey.projectPath,
              providerIds: requestKey.providerIds,
            });
          if (requestKey.providerIds.length === 1 && requestKey.providerIds[0] === 'anthropic') {
            const result = await workspaceTrustApi.getProjectStatus({
              projectPath: requestKey.projectPath,
            });
            return { providers: [{ providerId: 'anthropic', status: result?.status }] };
          }
          return null;
        })
        .then(finish, () => finish(null));
    }, 120);

    return () => {
      finished = true;
      window.clearTimeout(timeoutId);
      window.clearTimeout(deadlineId);
    };
  }, [requestKey, localReadAllowed]);

  if (!requestKey) {
    return 'disabled';
  }
  return snapshot.requestKey === requestKey ? snapshot.status : 'checking';
}
