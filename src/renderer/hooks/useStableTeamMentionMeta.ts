import { useMemo } from 'react';

import type { TeamSummary } from '@shared/types';

const EMPTY_TEAM_NAMES: string[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();

interface TeamMentionEntry {
  teamName: string;
  displayName: string;
  color: string;
  deletedAt: string;
}

function compareTeamMentionEntries(a: TeamMentionEntry, b: TeamMentionEntry): number {
  return (
    a.teamName.localeCompare(b.teamName, undefined, { sensitivity: 'base' }) ||
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  );
}

export interface TeamMentionMeta {
  teamNames: string[];
  teamColorByName: ReadonlyMap<string, string>;
}

function buildTeamMentionEntries(teams: readonly TeamSummary[]): TeamMentionEntry[] {
  return teams
    .map((team) => ({
      teamName: team.teamName ?? '',
      displayName: team.displayName ?? '',
      color: team.color ?? '',
      deletedAt: team.deletedAt ?? '',
    }))
    .sort(compareTeamMentionEntries);
}

function buildTeamMentionMeta(entries: readonly TeamMentionEntry[]): TeamMentionMeta {
  if (entries.length === 0) {
    return { teamNames: EMPTY_TEAM_NAMES, teamColorByName: EMPTY_TEAM_COLOR_MAP };
  }

  const teamNames: string[] = [];
  const teamColorByName = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.deletedAt && entry.teamName) {
      teamNames.push(entry.teamName);
    }

    if (entry.teamName) {
      teamColorByName.set(entry.teamName, entry.color);
    }
    if (entry.displayName) {
      teamColorByName.set(entry.displayName, entry.color);
    }
  }

  return { teamNames, teamColorByName };
}

export function useStableTeamMentionMeta(teams: readonly TeamSummary[]): TeamMentionMeta {
  const entries = useMemo(() => buildTeamMentionEntries(teams), [teams]);

  const meta = useMemo(() => buildTeamMentionMeta(entries), [entries]);

  return meta;
}
