import { useEffect, useRef, useState } from 'react';

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
  continueManually: () => void;
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
  const selectionRef = useRef({ teamName, memberName });
  selectionRef.current = { teamName, memberName };

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
    continueManually: () => {
      const normalizedTeamName = teamName?.trim();
      const normalizedMemberName = memberName?.trim();
      if (!normalizedTeamName || !normalizedMemberName) {
        return;
      }
      void api.memberWorkSync
        .continueManually({
          teamName: normalizedTeamName,
          memberName: normalizedMemberName,
        })
        .then((nextStatus) => {
          const current = selectionRef.current;
          if (
            current.teamName?.trim() !== normalizedTeamName ||
            current.memberName?.trim() !== normalizedMemberName
          ) {
            return;
          }
          setStatus(nextStatus);
          setError(null);
        })
        .catch((nextError: unknown) => {
          const current = selectionRef.current;
          if (
            current.teamName?.trim() !== normalizedTeamName ||
            current.memberName?.trim() !== normalizedMemberName
          ) {
            return;
          }
          setError(getErrorMessage(nextError));
        });
    },
  };
}
