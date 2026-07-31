import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';

import type {
  WorkspaceTrustProjectStatus,
  WorkspaceTrustProjectStatusResult,
} from '../../contracts';

interface WorkspaceTrustStatusSnapshot extends WorkspaceTrustProjectStatusResult {
  requestKey: string;
}

export type WorkspaceTrustDisplayStatus = WorkspaceTrustProjectStatus | 'checking';

export function shouldShowWorkspaceTrustLaunchNotice(status: WorkspaceTrustDisplayStatus): boolean {
  return status === 'untrusted' || status === 'unknown';
}

export function useWorkspaceTrustStatus(input: {
  enabled: boolean;
  projectPath: string | null;
}): WorkspaceTrustDisplayStatus {
  const requestKey = useMemo(
    () => (input.enabled ? (input.projectPath?.trim() ?? '') : ''),
    [input.enabled, input.projectPath]
  );
  const [snapshot, setSnapshot] = useState<WorkspaceTrustStatusSnapshot>({
    requestKey: '',
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
        .getProjectStatus({ projectPath: requestKey })
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
