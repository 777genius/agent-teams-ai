import { getTeamMessagesCacheEntry, type TeamMessagesCacheState } from './teamMessagesCache';

import type { MemberActivityMetaEntry, TeamMemberActivityMeta } from '@shared/types';

export interface TeamMemberActivityMetaState extends TeamMessagesCacheState {
  memberActivityMetaByTeam: Record<string, TeamMemberActivityMeta>;
}

export function areMemberActivityMetaEntriesEqual(
  left: MemberActivityMetaEntry | undefined,
  right: MemberActivityMetaEntry
): boolean {
  if (!left) {
    return false;
  }
  return (
    left.memberName === right.memberName &&
    left.lastAuthoredMessageAt === right.lastAuthoredMessageAt &&
    left.messageCountExact === right.messageCountExact &&
    left.latestAuthoredMessageSignalsTermination === right.latestAuthoredMessageSignalsTermination
  );
}

export function structurallyShareMemberActivityFacts(
  previous: Record<string, MemberActivityMetaEntry> | undefined,
  next: Record<string, MemberActivityMetaEntry>
): Record<string, MemberActivityMetaEntry> {
  if (!previous) {
    return next;
  }

  const nextKeys = Object.keys(next);
  const previousKeys = Object.keys(previous);
  let changed = nextKeys.length !== previousKeys.length;
  const shared: Record<string, MemberActivityMetaEntry> = {};

  for (const key of nextKeys) {
    const nextEntry = next[key];
    const previousEntry = previous[key];
    if (!areMemberActivityMetaEntriesEqual(previousEntry, nextEntry)) {
      changed = true;
      shared[key] = nextEntry;
      continue;
    }
    shared[key] = previousEntry;
  }

  return changed ? shared : previous;
}

export function isMemberActivityMetaStale(
  state: TeamMemberActivityMetaState,
  teamName: string
): boolean {
  const meta = state.memberActivityMetaByTeam[teamName];
  const feedRevision = getTeamMessagesCacheEntry(state, teamName).feedRevision;
  if (!meta) {
    return true;
  }
  if (!feedRevision) {
    return false;
  }
  return meta.feedRevision !== feedRevision;
}
