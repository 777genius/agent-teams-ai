import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { withFileLock } from '@main/services/team/fileLock';
import { atomicWriteAsync, syncDirectoryDurably } from '@main/utils/atomicWrite';

import { decodeMemberWorkSyncReportJournalMetadata } from '../../core/domain/MemberWorkSyncReportJournalMetadata';

import {
  findCanonicalReportJournalOwner,
  readMemberWorkSyncReportJournalFile,
  reportJournalBindingMatches,
} from './memberWorkSyncReportJournalOwnership';

import type {
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportJournalMetadata,
  MemberWorkSyncReportReceipt,
} from '../../contracts';
import type {
  MemberWorkSyncReportJournalIdentity,
  MemberWorkSyncReportJournalInput,
  MemberWorkSyncReportJournalPort,
  MemberWorkSyncReportJournalResult,
} from '../../core/application/MemberWorkSyncReportJournalPort';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;

interface Reports {
  schemaVersion: 2;
  intents: Record<string, MemberWorkSyncReportIntent>;
}

/** Uses the store's existing queue, then index lock, then member-file lock. */
export class JsonMemberWorkSyncReportJournal implements MemberWorkSyncReportJournalPort {
  constructor(
    private readonly paths: MemberWorkSyncStorePaths,
    private readonly enqueue: (teamName: string, operation: () => Promise<void>) => Promise<void>,
    private readonly project: (intent: MemberWorkSyncReportIntent) => Promise<void>
  ) {}

  async read(
    input: MemberWorkSyncReportJournalIdentity
  ): Promise<MemberWorkSyncReportJournalResult> {
    const owner = await findCanonicalReportJournalOwner(this.paths, input);
    if (owner.state !== 'present') return owner;
    return reportJournalBindingMatches(owner.intent, input)
      ? { state: 'present', intent: owner.intent, projectionDegraded: false }
      : { state: 'conflict' };
  }
  ensure(input: MemberWorkSyncReportJournalInput): Promise<MemberWorkSyncReportJournalResult> {
    return this.mutate(input);
  }
  transfer(
    input: MemberWorkSyncReportJournalInput & { receipt: MemberWorkSyncReportReceipt }
  ): Promise<MemberWorkSyncReportJournalResult> {
    return this.mutate(input, input.receipt);
  }

  private async mutate(
    input: MemberWorkSyncReportJournalInput,
    receipt?: MemberWorkSyncReportReceipt
  ): Promise<MemberWorkSyncReportJournalResult> {
    let result: MemberWorkSyncReportJournalResult = { state: 'unavailable' };
    let metadata: MemberWorkSyncReportJournalMetadata;
    try {
      if (
        !identifier(input.intentId) ||
        input.request.teamName !== input.teamName ||
        input.request.memberName !== input.memberName
      )
        return { state: 'conflict' };
      metadata = decodeMemberWorkSyncReportJournalMetadata(
        {
          incarnation: input.incarnation,
          requestDigest: input.requestDigest,
          firstRecordedAt: input.receivedAt,
          origin: input.origin,
          ...(receipt ? { receipt } : {}),
        },
        input.intentId
      );
    } catch {
      return { state: 'conflict' };
    }
    try {
      await this.paths.ensureMemberWorkSyncDir(input.teamName, input.memberName);
      await this.enqueue(input.teamName, async () => {
        await withFileLock(
          this.paths.getPendingReportsIndexPath(input.teamName),
          async () => {
            const path = this.paths.getMemberReportsPath(input.teamName, input.memberName);
            await withFileLock(
              path,
              async () => {
                const owner = await findCanonicalReportJournalOwner(this.paths, input);
                if (owner.state === 'corrupt' || owner.state === 'unavailable') {
                  result = owner;
                  return;
                }
                if (owner.state === 'conflict') {
                  result = owner;
                  return;
                }
                const snapshot = await readMemberWorkSyncReportJournalFile(path, input);
                if (snapshot.state === 'corrupt' || snapshot.state === 'unavailable') {
                  result = snapshot;
                  return;
                }
                const file: Reports =
                  snapshot.state === 'present' ? snapshot.file : { schemaVersion: 2, intents: {} };
                const current = file.intents[input.intentId];
                if (owner.state === 'present' && !isDeepStrictEqual(owner.intent, current)) {
                  result = { state: 'corrupt' };
                  return;
                }
                if (owner.state === 'absent' && current) {
                  result = { state: 'corrupt' };
                  return;
                }
                if (
                  current &&
                  (!reportJournalBindingMatches(current, input) ||
                    !isDeepStrictEqual(current.request, input.request))
                ) {
                  result = { state: 'conflict' };
                  return;
                }
                if (receipt && !current) {
                  result = { state: 'absent' };
                  return;
                }
                if (
                  receipt &&
                  current?.journal?.receipt &&
                  !isDeepStrictEqual(current.journal.receipt, receipt)
                ) {
                  result = { state: 'conflict' };
                  return;
                }
                const intent: MemberWorkSyncReportIntent = current
                  ? receipt
                    ? {
                        ...current,
                        status: 'accepted',
                        resultCode: 'accepted',
                        processedAt: receipt.acceptedAt,
                        journal: { ...current.journal!, receipt },
                      }
                    : current
                  : {
                      id: input.intentId,
                      teamName: input.teamName,
                      memberName: input.memberName,
                      request: input.request,
                      reason: input.origin,
                      status: 'pending',
                      recordedAt: input.receivedAt,
                      journal: metadata,
                    };
                file.intents[input.intentId] = intent;
                const provingExisting = Boolean(current && (!receipt || current.journal?.receipt));
                let publishStarted = provingExisting;
                try {
                  for (let dir = dirname(path); ; dir = dirname(dir)) {
                    await syncDirectoryDurably(dir);
                    if (dir === dirname(this.paths.getTeamRootDir(input.teamName))) break;
                    if (dirname(dir) === dir) break;
                  }
                  if (provingExisting) {
                    const handle = await open(path, 'r');
                    try {
                      await handle.sync();
                    } finally {
                      await handle.close();
                    }
                  } else
                    await atomicWriteAsync(path, `${JSON.stringify(file, null, 2)}\n`, {
                      durability: 'strict',
                      syncDirectory: true,
                      beforeCommit: async () => {
                        publishStarted = true;
                      },
                    });
                } catch {
                  result = {
                    state: publishStarted || provingExisting ? 'commit_unknown' : 'write_failed',
                  };
                  return;
                }
                try {
                  await this.project(intent);
                  result = { state: 'present', intent, projectionDegraded: false };
                } catch {
                  result = { state: 'present', intent, projectionDegraded: true };
                }
              },
              { preventLiveOwnerTakeover: true }
            );
          },
          { preventLiveOwnerTakeover: true }
        );
      });
    } catch {
      return result;
    }
    return result;
  }
}
