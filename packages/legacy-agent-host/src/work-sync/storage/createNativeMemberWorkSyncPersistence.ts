import { toMetrics } from './memberWorkSyncMetricsProjection.js';
import { isMetricsIndexFile } from './jsonStorePolicy.js';
import type { MetricsIndexFile } from './jsonStorePolicy.js';
import { MemberWorkSyncStatusAuthority } from './MemberWorkSyncStatusAuthority.js';
import { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths.js';
import { HmacMemberWorkSyncReportTokenAdapter } from './HmacMemberWorkSyncReportTokenAdapter.js';
import { JsonMemberWorkSyncReportJournal } from './JsonMemberWorkSyncReportJournal.js';
import { createMemberWorkSyncJsonBackend } from './createMemberWorkSyncJsonBackend.js';
import { isPendingReportsIndexFile } from './jsonStorePolicy.js';
import { readJsonFile, writeJsonFile } from './jsonStoreFiles.js';

import type { MemberWorkSyncWriteQueue } from './MemberWorkSyncWriteQueue.js';
import type { MemberWorkSyncTokenIdentity } from './reportTokenPorts.js';
import type { MemberWorkSyncConditionalStatusPort } from '../policy/core/application/MemberWorkSyncConditionalStatusPort.js';
import type { MemberWorkSyncReportJournalPort } from '../policy/core/application/MemberWorkSyncReportJournalPort.js';
import type {
  MemberWorkSyncReportTokenPort,
  MemberWorkSyncStatusStorePort,
} from '../policy/core/application/ports.js';

type NativeIdentity = Pick<MemberWorkSyncTokenIdentity, 'readCurrent'> &
  Required<Pick<MemberWorkSyncTokenIdentity, 'withCurrentPublication'>>;

type NativeLifecycle = NativeIdentity & { assertWorkAllowed(): void };

/** One original native command. Paths and identity come from the owner, never tool arguments. */
export function createNativeMemberWorkSyncPersistence(options: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  incarnation: string;
  identity: NativeLifecycle;
  queue: MemberWorkSyncWriteQueue;
  /** Retains the authenticated original DO input across every await. */
  assertCurrent(): void;
  createMutationId(): string;
}) {
  const assertScope = (input: { teamName: string; memberName?: string }) => {
    options.assertCurrent();
    options.identity.assertWorkAllowed();
    if (
      input.teamName !== options.teamName ||
      (input.memberName !== undefined && input.memberName !== options.memberName)
    )
      throw new Error('Work sync original member scope changed');
  };
  const identity: NativeIdentity = {
    async readCurrent(teamName) {
      assertScope({ teamName });
      const observed = await options.identity.readCurrent(teamName);
      assertScope({ teamName });
      return observed.status === 'identified' && observed.identityId !== options.incarnation
        ? { status: 'unavailable' }
        : observed;
    },
    withCurrentPublication(teamName, identityId, operation) {
      assertScope({ teamName });
      if (identityId !== options.incarnation)
        return Promise.resolve({ current: false, identity: { status: 'unavailable' } });
      return options.identity.withCurrentPublication(
        teamName,
        identityId,
        async (assertIdentity) => {
          const assertCurrent = () => {
            options.assertCurrent();
            assertIdentity();
            options.identity.assertWorkAllowed();
            options.assertCurrent();
          };
          assertCurrent();
          const result = await operation(assertCurrent);
          assertCurrent();
          return result;
        }
      );
    },
  };
  const authority = new MemberWorkSyncStatusAuthority({
    identity,
    async withPreparedBackend(input, operation) {
      assertScope(input);
      if (input.incarnation !== options.incarnation || !input.assertCurrent)
        throw new Error('Work sync physical publication scope unavailable');
      const paths = new MemberWorkSyncStorePaths(options.teamsBasePath, input.assertCurrent);
      return operation(
        createMemberWorkSyncJsonBackend({
          teamName: options.teamName,
          memberName: options.memberName,
          paths,
          queue: options.queue,
          assertCurrent: input.assertCurrent,
        })
      );
    },
  });
  const statusMutations: MemberWorkSyncConditionalStatusPort = {
    createMutationId: options.createMutationId,
    async readSnapshot(input) {
      assertScope(input);
      const call = authority.startRead(input);
      await call.settled;
      return call.result;
    },
    async compareAndWrite(input) {
      assertScope(input);
      const call = authority.startCompareAndWrite({
        teamName: input.teamName,
        memberName: input.memberName,
        incarnation: input.incarnation,
        expectedToken: input.expectedToken,
        mutationId: input.mutationId,
        nextStatus: input.nextStatus,
        ...(input.reportReceipt ? { reportReceipt: input.reportReceipt } : {}),
        ...(input.replacedReceipt ? { replacedReceipt: input.replacedReceipt } : {}),
      });
      await call.settled;
      return call.result;
    },
  };
  async function withOriginalPublication<T>(
    operation: (assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    const fenced = await identity.withCurrentPublication(
      options.teamName,
      options.incarnation,
      operation
    );
    if (!fenced.current) throw new Error('Work sync original incarnation unavailable');
    return fenced.value;
  }
  const statusStore: MemberWorkSyncStatusStorePort = {
    async read(input) {
      const read = await statusMutations.readSnapshot(input);
      if (!read.ok) throw new Error('Work sync canonical status unavailable');
      return read.snapshot.status;
    },
    async write() {
      throw new Error('Native work sync requires canonical conditional status publication');
    },
    async readTeamMetrics(teamName) {
      assertScope({ teamName });
      return withOriginalPublication(async (assertCurrent) => {
        const paths = new MemberWorkSyncStorePaths(options.teamsBasePath, assertCurrent);
        const file = await readJsonFile<MetricsIndexFile | null>(
          paths.getMetricsIndexPath(teamName),
          (value): value is MetricsIndexFile | null => isMetricsIndexFile(value),
          null,
          { strict: true, assertCurrent }
        );
        if (!file) throw new Error('Work sync metrics projection unavailable');
        const metrics = toMetrics(teamName, file);
        if (
          !Object.values(metrics.stateCounts).every(Number.isFinite) ||
          !Number.isFinite(metrics.actionableItemCount)
        )
          throw new Error('Work sync metrics projection corrupt');
        assertCurrent();
        return metrics;
      });
    },
  };
  async function withJournal<T>(
    input: { teamName: string; memberName: string; incarnation: string },
    operation: (journal: JsonMemberWorkSyncReportJournal) => Promise<T>
  ): Promise<T> {
    assertScope(input);
    const fenced = await identity.withCurrentPublication(
      input.teamName,
      input.incarnation,
      async (assertCurrent) => {
        const paths = new MemberWorkSyncStorePaths(options.teamsBasePath, assertCurrent);
        const journal = new JsonMemberWorkSyncReportJournal(
          paths,
          (teamName, work) => options.queue.enqueue(teamName, work),
          async (intent) => {
            assertScope(intent);
            const path = paths.getPendingReportsIndexPath(options.teamName);
            const index = await readJsonFile(
              path,
              isPendingReportsIndexFile,
              { schemaVersion: 2, items: {} },
              { strict: true, assertCurrent }
            );
            index.items[intent.id] = {
              memberKey: paths.getMemberKey(options.memberName),
              memberName: options.memberName,
              status: intent.status,
              recordedAt: intent.recordedAt,
              ...(intent.processedAt ? { processedAt: intent.processedAt } : {}),
            };
            await writeJsonFile(path, index, {
              assertCurrent,
              durability: 'strict',
              syncDirectory: true,
            });
          },
          assertCurrent
        );
        return operation(journal);
      }
    );
    if (!fenced.current) throw new Error('Work sync original incarnation unavailable');
    return fenced.value;
  }
  const reportJournal: MemberWorkSyncReportJournalPort = {
    read: (input) => withJournal(input, (journal) => journal.read(input)),
    ensure: (input) => withJournal(input, (journal) => journal.ensure(input)),
    transfer: (input) => withJournal(input, (journal) => journal.transfer(input)),
    retire: (input) => withJournal(input, (journal) => journal.retire(input)),
  };
  const token = new HmacMemberWorkSyncReportTokenAdapter(
    new MemberWorkSyncStorePaths(options.teamsBasePath),
    identity
  );
  const reportToken: MemberWorkSyncReportTokenPort = {
    async create(input) {
      assertScope(input);
      const result = await token.create(input);
      assertScope(input);
      return result;
    },
    async verify(input) {
      assertScope(input);
      const result = await token.verify(input);
      assertScope(input);
      return result;
    },
  };
  return { statusStore, statusMutations, reportJournal, reportToken, withOriginalPublication };
}
