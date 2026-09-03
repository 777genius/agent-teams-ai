/**
 * Team mention metadata for the messages panel composer: sorted team names and
 * a color lookup keyed by both team name and display name. The selector is
 * memoized on the teams array identity and on a structural signature so that
 * store reads keep returning the same object reference.
 */

import type { TeamSummary } from '@shared/types';

const EMPTY_TEAM_NAMES: string[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();

interface TeamMentionMeta {
  teamNames: string[];
  teamColorByName: ReadonlyMap<string, string>;
}

interface TeamMentionEntry {
  teamName: string;
  displayName: string;
  color: string;
  deletedAt: string;
}

let cachedTeamMentionSignature = '';
let cachedTeamMentionSource: readonly TeamSummary[] | null = null;
let cachedTeamMentionMeta: TeamMentionMeta = {
  teamNames: EMPTY_TEAM_NAMES,
  teamColorByName: EMPTY_TEAM_COLOR_MAP,
};

function encodeTeamMentionParts(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function compareTeamMentionEntries(a: TeamMentionEntry, b: TeamMentionEntry): number {
  return (
    a.teamName.localeCompare(b.teamName, undefined, { sensitivity: 'base' }) ||
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  );
}

function getTeamMentionSignature(teams: readonly TeamSummary[]): string {
  return encodeTeamMentionParts(
    teams.flatMap((team) => [
      team.teamName ?? '',
      team.displayName ?? '',
      team.color ?? '',
      team.deletedAt ?? '',
    ])
  );
}

export function selectMessagesPanelTeamMentionMeta(teams: readonly TeamSummary[]): TeamMentionMeta {
  if (teams === cachedTeamMentionSource) {
    return cachedTeamMentionMeta;
  }

  const signature = getTeamMentionSignature(teams);
  if (signature === cachedTeamMentionSignature) {
    cachedTeamMentionSource = teams;
    return cachedTeamMentionMeta;
  }

  const entries = teams
    .map((team) => ({
      teamName: team.teamName ?? '',
      displayName: team.displayName ?? '',
      color: team.color ?? '',
      deletedAt: team.deletedAt ?? '',
    }))
    .sort(compareTeamMentionEntries);

  if (entries.length === 0) {
    cachedTeamMentionSource = teams;
    cachedTeamMentionSignature = signature;
    cachedTeamMentionMeta = {
      teamNames: EMPTY_TEAM_NAMES,
      teamColorByName: EMPTY_TEAM_COLOR_MAP,
    };
    return cachedTeamMentionMeta;
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

  cachedTeamMentionSource = teams;
  cachedTeamMentionSignature = signature;
  cachedTeamMentionMeta = { teamNames, teamColorByName };
  return cachedTeamMentionMeta;
}
