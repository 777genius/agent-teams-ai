import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { MemberWorkSyncOutboxOperations } from './MemberWorkSyncOutboxOperations.js';
import { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths.js';
import { isMemberOutboxFile, isOutboxIndexFile } from './jsonStorePolicy.js';
import { readJsonFile, writeJsonFile } from './jsonStoreFiles.js';
import { scanMemberWorkSyncNames } from './scanMemberWorkSyncNames.js';

import type { MemberWorkSyncOutboxItem } from '../policy/contracts/index.js';
import type { MemberWorkSyncOutboxStorePort } from '../policy/core/application/ports.js';
import type { WorkSyncCommandReceipt } from '../commandContracts.js';
import type { MemberWorkSyncWriteQueue } from './MemberWorkSyncWriteQueue.js';
import type { MemberOutboxFile, OutboxIndexFile } from './jsonStorePolicy.js';

export interface NativeWorkSyncOutboxOrigin {
  commandId: string;
  commandFingerprint: string;
  inputAuthority: string;
  payloadHash: string;
}
type NativeItem = MemberWorkSyncOutboxItem & { nativeWorkSync?: NativeWorkSyncOutboxOrigin };

/** Metadata stays in the same original outbox row; the full causal proof stays in its Team command receipt. */
export function nativeWorkSyncOutboxOrigin(
  item: MemberWorkSyncOutboxItem
): NativeWorkSyncOutboxOrigin {
  const value = (item as NativeItem).nativeWorkSync;
  if (
    !value ||
    typeof value.commandId !== 'string' ||
    !value.commandId ||
    value.commandId.length > 256 ||
    !/^[a-f0-9]{64}$/.test(value.commandFingerprint) ||
    !/^[a-f0-9]{64}$/.test(value.inputAuthority) ||
    value.payloadHash !== item.payloadHash
  )
    throw new Error('Work sync original outbox intent unavailable');
  return value;
}

/** One member's original accepted intent; whole-Team index repair never grants cross-member delivery. */
export function createNativeWorkSyncOutbox(options: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  queue: MemberWorkSyncWriteQueue;
  original: Readonly<WorkSyncCommandReceipt>;
  /** Caller holds the original physical identity and rechecks its original active/accepted input at every commit. */
  withPublication<T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T>;
}): MemberWorkSyncOutboxStorePort {
  if (
    !options.original.nativeInput.runtime ||
    options.original.binding.teamName !== options.teamName ||
    options.original.nativeInput.team.memberName !== options.memberName ||
    !['running', 'completed'].includes(options.original.phase)
  )
    throw new Error('Work sync original outbox command unavailable');
  const assertTeam = (teamName: string) => {
    if (teamName !== options.teamName) throw new Error('Work sync outbox team scope changed');
  };
  const originFor = (item: MemberWorkSyncOutboxItem): NativeWorkSyncOutboxOrigin => ({
    commandId: options.original.commandId,
    commandFingerprint: options.original.fingerprint,
    inputAuthority: options.original.inputAuthority,
    payloadHash: item.payloadHash,
  });
  async function within<T>(
    operation: (outbox: MemberWorkSyncOutboxOperations) => Promise<T>,
    claim = false
  ) {
    return options.withPublication(async (assertCurrent) => {
      const paths = new MemberWorkSyncStorePaths(options.teamsBasePath, assertCurrent);
      const readOptions = { strict: true, assertCurrent };
      const writeOptions = { assertCurrent, durability: 'strict' as const, syncDirectory: true };
      const readMember = (teamName: string, memberName: string): Promise<MemberOutboxFile> => {
        assertTeam(teamName);
        return readJsonFile(
          paths.getMemberOutboxPath(teamName, memberName),
          isMemberOutboxFile,
          { schemaVersion: 2, items: {} },
          readOptions
        );
      };
      let itemScope: Set<string> | undefined;
      if (claim) {
        const current = await readMember(options.teamName, options.memberName);
        itemScope = new Set(
          Object.entries(current.items)
            .filter(([, item]) => {
              const origin = nativeWorkSyncOutboxOrigin(item);
              return (
                origin.commandId === options.original.commandId &&
                origin.commandFingerprint === options.original.fingerprint &&
                origin.inputAuthority === options.original.inputAuthority
              );
            })
            .map(([id]) => id)
        );
      }
      const operations = new MemberWorkSyncOutboxOperations(
        {
          paths,
          enqueue: (teamName, work) => {
            assertTeam(teamName);
            return options.queue.enqueue(teamName, async () => {
              assertCurrent();
              await work();
              assertCurrent();
            });
          },
          readMemberOutboxFile: readMember,
          async writeMemberOutboxFile(teamName, memberName, file) {
            assertTeam(teamName);
            if (memberName !== options.memberName)
              throw new Error('Work sync outbox member scope changed');
            const before = await readMember(teamName, memberName);
            const items: Record<string, NativeItem> = {};
            for (const [id, item] of Object.entries(file.items)) {
              const prior = before.items[id];
              const priorOrigin = prior ? nativeWorkSyncOutboxOrigin(prior) : undefined;
              if (
                prior &&
                !isDeepStrictEqual(prior, item) &&
                priorOrigin?.commandId !== options.original.commandId
              )
                throw new Error('Work sync outbox original intent changed');
              const nativeWorkSync =
                priorOrigin && prior?.payloadHash === item.payloadHash
                  ? priorOrigin
                  : originFor(item);
              items[id] = { ...item, nativeWorkSync };
            }
            await paths.ensureMemberWorkSyncDir(teamName, memberName);
            await writeJsonFile(
              paths.getMemberOutboxPath(teamName, memberName),
              { schemaVersion: 2, items },
              writeOptions
            );
          },
          async readOutboxIndexFile(teamName): Promise<OutboxIndexFile> {
            assertTeam(teamName);
            return readJsonFile(
              paths.getOutboxIndexPath(teamName),
              isOutboxIndexFile,
              { schemaVersion: 2, items: {} },
              readOptions
            );
          },
          async writeOutboxIndexFile(teamName, file) {
            assertTeam(teamName);
            await writeJsonFile(paths.getOutboxIndexPath(teamName), file, writeOptions);
          },
          async scanMemberNames(teamName) {
            assertTeam(teamName);
            return scanMemberWorkSyncNames(paths, teamName, assertCurrent);
          },
          async readLegacyOutboxFile(teamName) {
            assertTeam(teamName);
            assertCurrent();
            try {
              await readFile(paths.getLegacyOutboxPath(teamName));
            } catch (error) {
              assertCurrent();
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return { schemaVersion: 1, items: {} };
              throw error;
            }
            throw new Error('Work sync native outbox cannot adopt legacy intents');
          },
          // No audit journal is configured in this owner slice; receipts and the original outbox remain authoritative.
          appendAudit: async () => {},
        },
        options.memberName,
        itemScope
      );
      return operation(operations);
    });
  }
  return {
    ensurePending: (input) => within((store) => store.ensurePending(input)),
    claimDue: (input) => within((store) => store.claimDue(input), true),
    markDelivered: (input) => within((store) => store.markDelivered(input)),
    markSuperseded: (input) => within((store) => store.markSuperseded(input)),
    markFailed: (input) => within((store) => store.markFailed(input)),
    countRecentDelivered: (input) => within((store) => store.countRecentDelivered(input)),
    countDeliveredForAgenda: (input) => within((store) => store.countDeliveredForAgenda(input)),
    findDeliveredReviewPickupRequestEventIds: (input) =>
      within((store) => store.findDeliveredReviewPickupRequestEventIds(input)),
    findRecentRecoveryByIntent: (input) =>
      within((store) => store.findRecentRecoveryByIntent(input)),
    readItem: (input) => within((store) => store.readItem(input)),
  };
}

/** Private current-member read of the same canonical file, selecting existing unresolved origins only. */
export async function readNativeWorkSyncOutboxOrigins(options: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  assertCurrent(): void;
}): Promise<ReadonlySet<string>> {
  options.assertCurrent();
  const paths = new MemberWorkSyncStorePaths(options.teamsBasePath, options.assertCurrent);
  const file = await readJsonFile(
    paths.getMemberOutboxPath(options.teamName, options.memberName),
    isMemberOutboxFile,
    { schemaVersion: 2, items: {} },
    { strict: true, assertCurrent: options.assertCurrent }
  );
  options.assertCurrent();
  return new Set(
    Object.values(file.items)
      .filter((item) => ['pending', 'claimed', 'failed_retryable'].includes(item.status))
      .map((item) => nativeWorkSyncOutboxOrigin(item).commandId)
  );
}
