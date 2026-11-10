import { withFileLock } from '@main/services/team/fileLock';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import { pickDomainOutboxItem, pickDomainReportIntent } from './memberWorkSyncDomainSnapshotMerge';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type { MemberWorkSyncOutboxItem, MemberWorkSyncReportIntent } from '../../contracts';
import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';

interface DeliveryRestoreReads {
  reports(memberName: string): Promise<{ intents: Record<string, MemberWorkSyncReportIntent> }>;
  outbox(memberName: string): Promise<{ items: Record<string, MemberWorkSyncOutboxItem> }>;
  reportIndex(): Promise<{ items: Record<string, unknown> }>;
  outboxIndex(): Promise<{ items: Record<string, unknown> }>;
}
async function publish(path: string, payload: unknown): Promise<void> {
  await atomicWriteAsync(path, `${JSON.stringify(payload, null, 2)}\n`, {
    durability: 'strict',
    syncDirectory: true,
  });
}
function groups<T extends { memberName: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = normalizeMemberKey(row.memberName);
    const group = map.get(key) ?? [];
    group.push(row);
    map.set(key, group);
  }
  return map;
}

/** Team queue is already held. Each phase follows index -> member lock, like normal writers. */
export async function restoreMemberWorkSyncJsonDelivery(
  paths: MemberWorkSyncStorePaths,
  teamName: string,
  snapshot: MemberWorkSyncStoreSnapshot,
  read: DeliveryRestoreReads
): Promise<void> {
  const owned = (row: { teamName: string; memberName: string }, memberName: string): void => {
    if (
      row.teamName?.trim().toLowerCase() !== teamName.trim().toLowerCase() ||
      !normalizeMemberKey(row.memberName) ||
      normalizeMemberKey(row.memberName) !== normalizeMemberKey(memberName)
    ) {
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    }
  };
  await withFileLock(
    paths.getPendingReportsIndexPath(teamName),
    async () => {
      const index = await read.reportIndex();
      for (const intents of groups(snapshot.reportIntents).values()) {
        const memberName = intents[0].memberName;
        await paths.ensureMemberWorkSyncDir(teamName, memberName);
        const path = paths.getMemberReportsPath(teamName, memberName);
        await withFileLock(
          path,
          async () => {
            const current = await read.reports(memberName);
            for (const row of Object.values(current.intents)) {
              owned(row, memberName);
              owned(row.request, memberName);
            }
            for (const intent of intents) {
              owned(intent, memberName);
              owned(intent.request, memberName);
              const existing = current.intents[intent.id];
              current.intents[intent.id] = existing
                ? pickDomainReportIntent(existing, intent)
                : intent;
            }
            for (const intent of Object.values(current.intents)) {
              index.items[intent.id] = {
                memberKey: paths.getMemberKey(memberName),
                memberName: intent.memberName,
                status: intent.status,
                recordedAt: intent.recordedAt,
                ...(intent.processedAt ? { processedAt: intent.processedAt } : {}),
              };
            }
            await publish(path, { schemaVersion: 2, intents: current.intents });
          },
          { preventLiveOwnerTakeover: true }
        );
      }
      await publish(paths.getPendingReportsIndexPath(teamName), {
        schemaVersion: 2,
        items: index.items,
      });
    },
    { preventLiveOwnerTakeover: true }
  );

  await withFileLock(
    paths.getOutboxIndexPath(teamName),
    async () => {
      const index = await read.outboxIndex();
      for (const items of groups(snapshot.outboxItems).values()) {
        const memberName = items[0].memberName;
        await paths.ensureMemberWorkSyncDir(teamName, memberName);
        const path = paths.getMemberOutboxPath(teamName, memberName);
        await withFileLock(
          path,
          async () => {
            const current = await read.outbox(memberName);
            for (const row of Object.values(current.items)) owned(row, memberName);
            for (const item of items) {
              owned(item, memberName);
              const existing = current.items[item.id];
              current.items[item.id] = existing ? pickDomainOutboxItem(existing, item) : item;
            }
            for (const item of Object.values(current.items)) {
              index.items[item.id] = {
                memberKey: paths.getMemberKey(memberName),
                memberName: item.memberName,
                status: item.status,
                updatedAt: item.updatedAt,
                createdAt: item.createdAt,
                ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}),
              };
            }
            await publish(path, { schemaVersion: 2, items: current.items });
          },
          { preventLiveOwnerTakeover: true }
        );
      }
      await publish(paths.getOutboxIndexPath(teamName), { schemaVersion: 2, items: index.items });
    },
    { preventLiveOwnerTakeover: true }
  );
}
