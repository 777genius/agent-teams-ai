import type {
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxRecentDeliveredSummary,
} from '../../contracts';

export function summarizeRecentDeliveredOutboxItems(
  items: Iterable<
    Pick<MemberWorkSyncOutboxItem, 'status' | 'updatedAt'> & {
      memberName?: string;
      payload?: Pick<MemberWorkSyncOutboxItem['payload'], 'workSyncIntentKey'>;
    }
  >,
  input: {
    sinceIso: string;
    memberName?: string;
    workSyncIntentKeyPrefix?: string;
  }
): MemberWorkSyncOutboxRecentDeliveredSummary {
  const memberName = input.memberName;
  const prefix = input.workSyncIntentKeyPrefix;
  let count = 0;
  let oldestUpdatedAt: string | undefined;
  for (const item of items) {
    if (item.status !== 'delivered' || item.updatedAt < input.sinceIso) {
      continue;
    }
    if (memberName && item.memberName !== memberName) {
      continue;
    }
    if (prefix && item.payload?.workSyncIntentKey?.startsWith(prefix) !== true) {
      continue;
    }
    count += 1;
    if (!oldestUpdatedAt || item.updatedAt < oldestUpdatedAt) {
      oldestUpdatedAt = item.updatedAt;
    }
  }
  return oldestUpdatedAt ? { count, oldestUpdatedAt } : { count };
}
