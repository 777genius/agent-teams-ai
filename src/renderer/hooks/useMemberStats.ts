import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

import type { MemberFullStats } from '@shared/types';

export function useMemberStats(
  teamName: string,
  memberName: string | null
): { stats: MemberFullStats | null; loading: boolean; error: string | null } {
  const [stats, setStats] = useState<MemberFullStats | null>(null);
  const [loading, setLoading] = useState(memberName !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!memberName) {
      setStats(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setStats(null);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await api.teams.getMemberStats(teamName, memberName);
        if (!cancelled) setStats(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teamName, memberName]);

  return { stats, loading, error };
}
