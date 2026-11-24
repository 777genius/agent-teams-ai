import type { AttentionTaskCandidate } from '../../contracts';
import type { AttentionChat, AttentionModel } from '../../core/domain/buildAttention';

export type AttentionItemType = 'all' | 'tasks' | 'chats';
export type AttentionConversationType = 'all' | AttentionChat['scope']['kind'];
export type AttentionWaitTime = 'all' | 'day' | 'week';

export interface AttentionFilters {
  type: AttentionItemType;
  teamName: string | null;
  conversation: AttentionConversationType;
  waiting: AttentionWaitTime;
}

export const DEFAULT_ATTENTION_FILTERS: Readonly<AttentionFilters> = {
  type: 'all',
  teamName: null,
  conversation: 'all',
  waiting: 'all',
};

export interface AttentionTeamOption {
  teamName: string;
  displayName: string;
}

export function attentionFilterCount(filters: AttentionFilters): number {
  return Number(filters.type !== 'all') +
    Number(filters.teamName !== null) +
    Number(filters.conversation !== 'all') +
    Number(filters.waiting !== 'all');
}

/** Every team seen in either section is filterable, including stopped teams. */
export function attentionTeamOptions(model: AttentionModel | null): AttentionTeamOption[] {
  const teams = new Map<string, AttentionTeamOption>();
  for (const item of [...(model?.tasks ?? []), ...(model?.chats ?? [])]) {
    if (!teams.has(item.teamName)) {
      teams.set(item.teamName, {
        teamName: item.teamName,
        displayName: item.teamDisplayName,
      });
    }
  }
  return [...teams.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName) ||
    a.teamName.localeCompare(b.teamName));
}

export function filterAttentionEntries(
  model: AttentionModel | null,
  filters: AttentionFilters,
  searchQuery: string,
  now: number
): { tasks: AttentionTaskCandidate[]; chats: AttentionChat[] } {
  const search = searchQuery.trim().toLocaleLowerCase();
  const matches = (...values: Array<string | undefined>): boolean =>
    !search || values.some((value) => value?.toLocaleLowerCase().includes(search));

  const teamMatches = (teamName: string): boolean =>
    filters.teamName === null || teamName === filters.teamName;

  const waitingMatches = (requestedAt: string | null | undefined): boolean => {
    if (filters.waiting === 'all') return true;
    // Unknown legacy timestamps cannot be classified as waiting 1/7 days.
    const timestamp = Date.parse(requestedAt ?? '');
    if (!Number.isFinite(timestamp)) return false;
    return now - timestamp >= (filters.waiting === 'day' ? 24 : 7 * 24) * 60 * 60 * 1000;
  };

  return {
    tasks: filters.type === 'chats' ? [] : (model?.tasks ?? []).filter((task) =>
      teamMatches(task.teamName) && waitingMatches(task.requestedAt) &&
      matches(task.subject, task.teamName, task.teamDisplayName)),
    chats: filters.type === 'tasks' ? [] : (model?.chats ?? []).filter((chat) =>
      teamMatches(chat.teamName) &&
      (filters.conversation === 'all' || chat.scope.kind === filters.conversation) &&
      matches(chat.name, chat.teamName, chat.teamDisplayName,
        chat.latestUnread.from, chat.latestUnread.text)),
  };
}
