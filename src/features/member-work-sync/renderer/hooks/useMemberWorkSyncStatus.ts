import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

import {
  type MemberWorkSyncStatusViewModel,
  toMemberWorkSyncStatusViewModel,
} from '../view-models/memberWorkSyncStatusViewModel';

import type { MemberWorkSyncStatus } from '../../contracts';

export interface UseMemberWorkSyncStatusOptions {
  teamName?: string | null;
  memberName?: string | null;
  enabled?: boolean;
}

export interface UseMemberWorkSyncStatusResult {
  status: MemberWorkSyncStatus | null;
  viewModel: MemberWorkSyncStatusViewModel;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load member work sync status.';
}

export function useMemberWorkSyncStatus({
  teamName,
  memberName,
  enabled = true,
}: UseMemberWorkSyncStatusOptions): UseMemberWorkSyncStatusResult {
  const [status, setStatus] = useState<MemberWorkSyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const normalizedTeamName = teamName?.trim();
    const normalizedMemberName = memberName?.trim();

    if (!enabled || !normalizedTeamName || !normalizedMemberName) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus((current) =>
      current?.teamName === normalizedTeamName && current.memberName === normalizedMemberName
        ? current
        : null
    );

    api.memberWorkSync
      .getStatus({ teamName: normalizedTeamName, memberName: normalizedMemberName })
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setStatus(null);
          setError(getErrorMessage(nextError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, memberName, refreshKey, teamName]);

  return {
    status,
    viewModel: toMemberWorkSyncStatusViewModel(status),
    loading,
    error,
    refresh: () => setRefreshKey((current) => current + 1),
  };
}
