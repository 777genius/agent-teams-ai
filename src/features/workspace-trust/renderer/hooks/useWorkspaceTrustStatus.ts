import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';

import type { WorkspaceTrustProjectStatusResult } from '@features/workspace-trust/contracts';
import type { WorkspaceTrustDisplayStatus } from '../view-models/workspaceTrustLaunchNotice';

export type { WorkspaceTrustDisplayStatus } from '../view-models/workspaceTrustLaunchNotice';
export { shouldShowWorkspaceTrustLaunchNotice } from '../view-models/workspaceTrustLaunchNotice';

interface WorkspaceTrustStatusSnapshot extends WorkspaceTrustProjectStatusResult {
  requestKey: { projectPath: string } | null;
}

export function useWorkspaceTrustStatus(input: {
  enabled: boolean;
  projectPath: string | null;
}): WorkspaceTrustDisplayStatus {
  const projectPath = input.projectPath?.trim() ?? '';
  // Identity belongs to this open/path lifecycle, not to a cached pathname.
  const requestKey = useMemo(
    () => (input.enabled && projectPath ? { projectPath } : null),
    [input.enabled, projectPath]
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
    if (!workspaceTrustApi) {
      setSnapshot({ requestKey, status: 'unknown' });
      return undefined;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void workspaceTrustApi
        .getProjectStatus({ projectPath: requestKey.projectPath })
        .then((result) => {
          if (!cancelled) {
            setSnapshot({ requestKey, status: result.status });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSnapshot({ requestKey, status: 'unknown' });
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [requestKey]);

  if (!requestKey) {
    return 'disabled';
  }
  return snapshot.requestKey === requestKey ? snapshot.status : 'checking';
}
