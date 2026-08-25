import { useEffect, useMemo, useState } from 'react';

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
  getProjectStatus?: (request: {
    projectPath: string;
  }) => Promise<WorkspaceTrustProjectStatusResult>;
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

    const getProjectStatus = input.getProjectStatus;
    if (!getProjectStatus) {
      setSnapshot({ requestKey, status: 'unknown' });
      return undefined;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void getProjectStatus({ projectPath: requestKey })
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
  }, [input.getProjectStatus, requestKey]);

  if (!requestKey) {
    return 'disabled';
  }
  return snapshot.requestKey === requestKey ? snapshot.status : 'checking';
}
