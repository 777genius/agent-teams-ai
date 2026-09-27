import { toMessageKey } from '@renderer/utils/teamMessageKey';

import type { LeadThoughtGroup } from './LeadThoughtsGroup';

/** The oldest thought keeps the group key stable when newer thoughts are prepended. */
export function getThoughtGroupKey(group: LeadThoughtGroup): string {
  const oldestThought = group.thoughts[group.thoughts.length - 1];
  return `thoughts-${toMessageKey(oldestThought)}`;
}
