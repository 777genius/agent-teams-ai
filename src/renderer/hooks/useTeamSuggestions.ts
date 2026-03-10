/**
 * Hook for providing team @-mention suggestions.
 *
 * Returns non-deleted teams (excluding the current one) as MentionSuggestion[]
 * with online/offline status. Uses the alive list API to determine status.
 *
 * The returned list is unfiltered — query filtering is handled downstream
 * by useMentionDetection inside MentionableTextarea.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import type { MentionSuggestion } from '@renderer/types/mention';

export interface UseTeamSuggestionsResult {
  suggestions: MentionSuggestion[];
  loading: boolean;
}

/**
 * Returns team MentionSuggestion[] sorted by online status (online first).
 *
 * @param currentTeamName - The current team name to exclude from suggestions
 */
export function useTeamSuggestions(currentTeamName: string | null): UseTeamSuggestionsResult {
  const teams = useStore((s) => s.teams);
  const [aliveTeams, setAliveTeams] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const fetchAlive = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.teams.aliveList();
      setAliveTeams(new Set(list));
    } catch {
      // best-effort — treat all as offline on error
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount and when teams list changes
  useEffect(() => {
    void fetchAlive();
  }, [fetchAlive, teams]);

  // Build suggestion list sorted: online first, then offline
  const suggestions = useMemo<MentionSuggestion[]>(() => {
    const nonDeleted = teams.filter((t) => !t.deletedAt && t.teamName !== currentTeamName);

    const result: MentionSuggestion[] = nonDeleted.map((t) => {
      const isOnline = aliveTeams.has(t.teamName);
      return {
        id: `team:${t.teamName}`,
        name: t.displayName || t.teamName,
        subtitle: isOnline ? 'online' : 'offline',
        color: t.color,
        type: 'team' as const,
        isOnline,
      };
    });

    // Sort: online teams first
    result.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return 0;
    });

    return result;
  }, [teams, currentTeamName, aliveTeams]);

  return { suggestions, loading };
}
