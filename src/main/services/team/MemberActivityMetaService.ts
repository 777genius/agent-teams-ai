import {
  MEMBER_ACTIVITY_META_WINDOW_LIMIT,
  projectMemberActivityFacts,
} from '@shared/utils/memberActivityMeta';

import type { TeamMessageFeedService } from './TeamMessageFeedService';
import type { MemberActivityMetaEntry, TeamMemberActivityMeta } from '@shared/types';

interface MemberActivityMetaCacheEntry {
  feedRevision: string;
  meta: TeamMemberActivityMeta;
}

function areMemberActivityEntriesEqual(
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

function structurallyShareMemberFacts(
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
    if (!areMemberActivityEntriesEqual(previousEntry, nextEntry)) {
      changed = true;
      shared[key] = nextEntry;
      continue;
    }
    shared[key] = previousEntry;
  }

  return changed ? shared : previous;
}

export class MemberActivityMetaService {
  private readonly cacheByTeam = new Map<string, MemberActivityMetaCacheEntry>();

  constructor(private readonly feedService: TeamMessageFeedService) {}

  invalidate(teamName: string): void {
    this.cacheByTeam.delete(teamName);
  }

  async getMeta(teamName: string): Promise<TeamMemberActivityMeta> {
    const page = await this.feedService.getPage(teamName, {
      limit: MEMBER_ACTIVITY_META_WINDOW_LIMIT,
    });
    const cached = this.cacheByTeam.get(teamName);
    if (cached?.feedRevision === page.feedRevision) {
      return cached.meta;
    }

    const nextMembers = projectMemberActivityFacts(page.messages);
    const members = structurallyShareMemberFacts(cached?.meta.members, nextMembers);

    const meta: TeamMemberActivityMeta = {
      teamName,
      computedAt: new Date().toISOString(),
      members,
      feedRevision: page.feedRevision,
    };

    this.cacheByTeam.set(teamName, { feedRevision: page.feedRevision, meta });
    return meta;
  }
}
