import { withFileLock } from '../../adapters/cross-team/fileLock.js';

import { emptyMetricsIndex, isMetricsIndexFile, updateMetricsMember } from './jsonStorePolicy.js';
import { readJsonFile, writeJsonFile } from './jsonStoreFiles.js';
import {
  compareAndWriteMemberWorkSyncJsonStatus,
  readMemberWorkSyncJsonStatus,
} from './memberWorkSyncJsonStatusPersistence.js';

import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths.js';
import type { MemberWorkSyncWriteQueue } from './MemberWorkSyncWriteQueue.js';
import type {
  MemberWorkSyncAuthorityRawSnapshot,
  MemberWorkSyncPreparedStatusBackend,
} from './MemberWorkSyncStatusAuthority.js';

/** The consumer has already admitted this original member and holds its physical identity fence. */
export function createMemberWorkSyncJsonBackend(options: {
  teamName: string;
  memberName: string;
  paths: MemberWorkSyncStorePaths;
  queue: MemberWorkSyncWriteQueue;
  assertCurrent(): void;
}): MemberWorkSyncPreparedStatusBackend {
  const assertMember = (memberName: string) => {
    options.assertCurrent();
    if (memberName !== options.memberName) throw new Error('Work sync member scope changed');
  };
  return {
    kind: 'json',
    async read(memberName) {
      assertMember(memberName);
      const snapshot = await readMemberWorkSyncJsonStatus(
        options.paths.getMemberStatusPath(options.teamName, memberName)
      );
      assertMember(memberName);
      return authoritySnapshot(snapshot);
    },
    async compareAndWrite(input) {
      assertMember(input.nextStatus.memberName);
      if (input.nextStatus.teamName !== options.teamName)
        throw new Error('Work sync team scope changed');
      const result = await compareAndWriteMemberWorkSyncJsonStore(options, input);
      if (result.committed === true) {
        return {
          committed: true,
          snapshot: { state: 'present', raw: result.raw, payload: input.nextStatus },
          ...(result.projectionDegraded ? { projectionDegraded: ['metrics'] } : {}),
        };
      }
      if (result.committed === false && result.reason === 'conflict')
        return { ...result, current: authoritySnapshot(result.current) };
      return result;
    },
  };
}

/** Original JSON-store queue → metrics lock → canonical CAS → metrics projection order. */
export async function compareAndWriteMemberWorkSyncJsonStore(
  options: {
    teamName: string;
    memberName: string;
    paths: MemberWorkSyncStorePaths;
    queue: MemberWorkSyncWriteQueue;
    assertCurrent(): void;
    /** Legacy consumer retains its original index repair/durability policy. */
    project?: () => Promise<void>;
  },
  input: Omit<Parameters<typeof compareAndWriteMemberWorkSyncJsonStatus>[0], 'path' | 'project'>
) {
  await options.paths.ensureMemberWorkSyncDir(options.teamName, options.memberName);
  options.assertCurrent();
  let result: Awaited<ReturnType<typeof compareAndWriteMemberWorkSyncJsonStatus>> | undefined;
  await options.queue.enqueue(options.teamName, async () => {
    options.assertCurrent();
    result = await withFileLock(
      options.paths.getMetricsIndexPath(options.teamName),
      () =>
        compareAndWriteMemberWorkSyncJsonStatus({
          ...input,
          assertCurrent: options.assertCurrent,
          path: options.paths.getMemberStatusPath(options.teamName, options.memberName),
          project:
            options.project ??
            (async () => {
              const path = options.paths.getMetricsIndexPath(options.teamName);
              const metrics = await readJsonFile(path, isMetricsIndexFile, emptyMetricsIndex(), {
                strict: true,
                assertCurrent: options.assertCurrent,
              });
              updateMetricsMember(
                metrics,
                input.nextStatus,
                options.paths.getMemberKey(options.memberName)
              );
              await writeJsonFile(path, metrics, {
                assertCurrent: options.assertCurrent,
                durability: 'strict',
                syncDirectory: true,
              });
            }),
        }),
      { preventLiveOwnerTakeover: true }
    );
  });
  if (!result) throw new Error('Work sync canonical write did not settle');
  return result;
}

function authoritySnapshot(
  snapshot: Awaited<ReturnType<typeof readMemberWorkSyncJsonStatus>>
): MemberWorkSyncAuthorityRawSnapshot {
  if (snapshot.state === 'present' || snapshot.state === 'absent') return snapshot;
  return snapshot.state === 'corrupt' ? { state: 'corrupt' } : { state: 'unavailable' };
}
