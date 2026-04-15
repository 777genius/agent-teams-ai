import type { TeamMessageFeedService } from './TeamMessageFeedService';
import type { InboxMessage, MemberActivityMetaEntry, TeamMemberActivityMeta } from '@shared/types';

interface MemberActivityMetaCacheEntry {
  feedRevision: string;
  meta: TeamMemberActivityMeta;
}

function messageSignalsTermination(message: InboxMessage | null | undefined): boolean {
  if (!message) return false;
  try {
    const parsed = JSON.parse(message.text) as {
      type?: string;
      approve?: boolean;
      approved?: boolean;
    };
    return (
      (parsed.type === 'shutdown_response' &&
        (parsed.approve === true || parsed.approved === true)) ||
      parsed.type === 'shutdown_approved'
    );
  } catch {
    return false;
  }
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
    const feed = await this.feedService.getFeed(teamName);
    const cached = this.cacheByTeam.get(teamName);
    if (cached?.feedRevision === feed.feedRevision) {
      return cached.meta;
    }

    const latestByMember = new Map<string, InboxMessage>();
    const countsByMember = new Map<string, number>();

    for (const message of feed.messages) {
      const memberName = typeof message.from === 'string' ? message.from.trim() : '';
      if (!memberName || memberName === 'user' || memberName === 'system') {
        continue;
      }

      countsByMember.set(memberName, (countsByMember.get(memberName) ?? 0) + 1);
      if (!latestByMember.has(memberName)) {
        latestByMember.set(memberName, message);
      }
    }

    const nextMembers = Object.fromEntries(
      Array.from(new Set([...countsByMember.keys(), ...latestByMember.keys()]))
        .sort((left, right) => left.localeCompare(right))
        .map((memberName) => {
          const latestMessage = latestByMember.get(memberName) ?? null;
          return [
            memberName,
            {
              memberName,
              lastAuthoredMessageAt: latestMessage?.timestamp ?? null,
              messageCountExact: countsByMember.get(memberName) ?? 0,
              latestAuthoredMessageSignalsTermination: messageSignalsTermination(latestMessage),
            },
          ] as const;
        })
    );
    const members = structurallyShareMemberFacts(cached?.meta.members, nextMembers);

    const meta: TeamMemberActivityMeta = {
      teamName,
      computedAt: new Date().toISOString(),
      members,
      feedRevision: feed.feedRevision,
    };

    this.cacheByTeam.set(teamName, { feedRevision: feed.feedRevision, meta });
    return meta;
  }
}
