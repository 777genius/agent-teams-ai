import { mkdirSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FileMemberWorkSyncAuditJournal } from '@features/member-work-sync/main/infrastructure/FileMemberWorkSyncAuditJournal';
import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncEventQueue } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLegacySourceWriteAdmissionPolicy } from '../../../src/main/composition/legacySourceWriteAdmission';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

// Only canonical proof recognition is controlled here; the production policy,
// shared queue/timers, store, audit append chains, locks and filesystem are real.
const qualified = vi.hoisted(() => new Set<string>());
vi.mock('../../../src/main/services/team/provisioning/LegacyNativeStopRelease', () => ({
  readLegacyNativeStopRelease: (path: string) => (qualified.has(path) ? {} : null),
}));

let root: string;
const teamA = 'test-original-source';
const teamB = 'test-other-source';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const makePolicy = () =>
  createLegacySourceWriteAdmissionPolicy({
    teamsRoot: root,
    selectedHost: true,
    isCurrentOwner: () => true,
    withIdentityFence: (_team, operation) => operation(),
  });
const admitted = (policy: ReturnType<typeof makePolicy>, teamName = teamA) => {
  const result = policy.capture(teamName);
  if (result.kind !== 'admitted') throw new Error('Expected mutable original Team');
  return result;
};
const enqueue = (queue: MemberWorkSyncEventQueue, teamName = teamA) =>
  queue.enqueue({
    teamName,
    memberName: 'alice',
    triggerReason: 'task_changed',
    runAfterMs: 20,
  });
const expectIdle = (queue: MemberWorkSyncEventQueue) =>
  vi.waitFor(() => expect(queue.getDiagnostics()).toMatchObject({ queued: 0, running: 0 }));
const replaceA = () => {
  // Complete replacement before yielding to the existing shared queue timer.
  renameSync(join(root, teamA), join(root, 'retired-original-a'));
  mkdirSync(join(root, teamA));
};

beforeEach(async () => {
  qualified.clear();
  root = await mkdtemp(join(tmpdir(), 'TEST-legacy-source-queue-'));
  await Promise.all([mkdir(join(root, teamA)), mkdir(join(root, teamB))]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('original legacy source admission in actual WorkSync consumers', () => {
  it.each(['unchanged', 'stopped-a', 'replaced-a'] as const)(
    'pins each queued Team independently before a shared timer runs: %s',
    async (scenario) => {
      const policy = makePolicy();
      const originalA = admitted(policy);
      const originalB = admitted(policy, teamB);
      const seen: string[] = [];
      const queue = new MemberWorkSyncEventQueue({
        quietWindowMs: 20,
        maxRetryAttempts: 0,
        captureExecutionScope: policy.bindExecution,
        isTeamActive: () => true,
        reconcile: async ({ teamName }) => {
          const source = policy.current(teamName);
          expect(source).toBe(teamName === teamA ? originalA : originalB);
          await source.publish(() =>
            writeFile(join(root, teamName, 'queue-result.json'), teamName)
          );
          seen.push(teamName);
        },
      });
      try {
        originalA.run(() => enqueue(queue));
        originalB.run(() => enqueue(queue, teamB));
        if (scenario === 'stopped-a') qualified.add(join(root, teamA));
        if (scenario === 'replaced-a') replaceA();
        await expectIdle(queue);
        expect(await readFile(join(root, teamB, 'queue-result.json'), 'utf8')).toBe(teamB);
        if (scenario === 'unchanged') {
          expect(await readFile(join(root, teamA, 'queue-result.json'), 'utf8')).toBe(teamA);
          expect(seen.sort()).toEqual([teamA, teamB].sort());
          expect(queue.getDiagnostics()).toMatchObject({ reconciled: 2, failed: 0 });
        } else {
          await expect(readFile(join(root, teamA, 'queue-result.json'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(seen).toEqual([teamB]);
          expect(queue.getDiagnostics()).toMatchObject({ reconciled: 1, failed: 1, dropped: 1 });
        }
      } finally {
        await queue.stop();
      }
    }
  );

  it.each(['unchanged', 'replaced-b'] as const)(
    'retains the original admission through a coalesced follow-up: %s',
    async (scenario) => {
      const policy = makePolicy();
      const timerOwner = admitted(policy);
      const original = admitted(policy, teamB);
      const started = deferred();
      const finishFirst = deferred();
      let attempts = 0;
      const queue = new MemberWorkSyncEventQueue({
        quietWindowMs: 20,
        concurrency: 1,
        maxRetryAttempts: 0,
        captureExecutionScope: policy.bindExecution,
        isTeamActive: () => true,
        reconcile: async ({ teamName }) => {
          if (teamName === teamA) {
            expect(policy.current(teamA)).toBe(timerOwner);
            return;
          }
          expect(policy.current(teamB)).toBe(original);
          attempts += 1;
          if (attempts === 1) {
            started.resolve();
            await finishFirst.promise;
            return;
          }
          await policy
            .current(teamB)
            .publish(() => writeFile(join(root, teamB, 'follow-up.json'), 'original'));
        },
      });
      try {
        // A creates the global timer; B's finish/follow-up must still retain B.
        timerOwner.run(() => enqueue(queue));
        original.run(() => enqueue(queue, teamB));
        await started.promise;
        original.run(() => enqueue(queue, teamB));
        expect(queue.getDiagnostics()).toMatchObject({ running: 1, coalesced: 1 });
        if (scenario === 'replaced-b') {
          renameSync(join(root, teamB), join(root, 'retired-original-b'));
          mkdirSync(join(root, teamB));
        }
        finishFirst.resolve();
        await expectIdle(queue);
        if (scenario === 'unchanged') {
          expect(attempts).toBe(2);
          expect(await readFile(join(root, teamB, 'follow-up.json'), 'utf8')).toBe('original');
        } else {
          expect(attempts).toBe(1);
          await expect(readFile(join(root, teamB, 'follow-up.json'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(queue.getDiagnostics()).toMatchObject({ failed: 1, dropped: 1 });
        }
      } finally {
        finishFirst.resolve();
        await queue.stop();
      }
    }
  );

  it.each(['unchanged', 'replaced-a'] as const)(
    'retains retry scope without inheriting the producer publication token: %s',
    async (scenario) => {
      const policy = makePolicy();
      const original = admitted(policy);
      const firstAttempt = deferred();
      const retryNow = deferred();
      let attempts = 0;
      const queue = new MemberWorkSyncEventQueue({
        quietWindowMs: 20,
        maxRetryAttempts: 1,
        retryDelayMs: 20,
        captureExecutionScope: policy.bindExecution,
        isTeamActive: () => true,
        reconcile: async () => {
          expect(policy.current(teamA)).toBe(original);
          attempts += 1;
          if (attempts === 1) {
            // Publication must remain possible after the producer's lock token expired.
            await policy
              .current(teamA)
              .publish(() => writeFile(join(root, teamA, 'first-attempt.json'), 'original'));
            firstAttempt.resolve();
            await retryNow.promise;
            throw new Error('TEST transient reconcile failure');
          }
          await policy
            .current(teamA)
            .publish(() => writeFile(join(root, teamA, 'retry.json'), 'original'));
        },
      });
      try {
        await original.run(() =>
          original.publish(async () => {
            enqueue(queue);
          })
        );
        await firstAttempt.promise;
        if (scenario === 'replaced-a') replaceA();
        retryNow.resolve();
        await expectIdle(queue);
        if (scenario === 'unchanged') {
          expect(attempts).toBe(2);
          expect(await readFile(join(root, teamA, 'retry.json'), 'utf8')).toBe('original');
          expect(queue.getDiagnostics()).toMatchObject({ reconciled: 1, failed: 1 });
        } else {
          expect(attempts).toBe(1);
          await expect(readFile(join(root, teamA, 'retry.json'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(queue.getDiagnostics()).toMatchObject({ reconciled: 0, failed: 2, dropped: 1 });
        }
      } finally {
        retryNow.resolve();
        await queue.stop();
      }
    }
  );

  it('orders actual store audit publication before a competing per-file append chain', async () => {
    const policy = makePolicy();
    const original = admitted(policy);
    const paths = new MemberWorkSyncStorePaths(root);
    const journal = new FileMemberWorkSyncAuditJournal(paths, undefined, {
      sourceWriteAdmission: policy,
    });
    const store = new JsonMemberWorkSyncStore(paths, {
      auditJournal: journal,
      sourceWriteAdmission: policy,
    });
    const status: MemberWorkSyncStatus = {
      teamName: teamA,
      memberName: 'alice',
      state: 'needs_sync',
      agenda: {
        teamName: teamA,
        memberName: 'alice',
        generatedAt: '2026-10-27T00:00:00.000Z',
        fingerprint: 'TEST:original',
        items: [],
        diagnostics: [],
      },
      shadow: { reconciledBy: 'queue', wouldNudge: false, fingerprintChanged: false },
      evaluatedAt: '2026-10-27T00:00:00.000Z',
      diagnostics: [],
    };
    await mkdir(dirname(paths.getLegacyStatusPath(teamA)), { recursive: true });
    await writeFile(
      paths.getLegacyStatusPath(teamA),
      JSON.stringify({ schemaVersion: 1, members: { alice: status } })
    );
    const entered = deferred();
    const continueA = deferred();
    const a = original.run(() =>
      original.publish(async () => {
        entered.resolve();
        await continueA.promise;
        expect(await store.read({ teamName: teamA, memberName: 'alice' })).toEqual(status);
      })
    );
    await entered.promise;
    // B owns a distinct admission; before the fix it inserted its append chain
    // while awaiting A's publication. A then awaited B through its store audit.
    const b = journal.append({
      teamName: teamA,
      memberName: 'alice',
      timestamp: '2026-10-27T00:00:01.000Z',
      source: 'TEST',
      event: 'queue_enqueued',
      reason: 'B',
    });
    continueA.resolve();
    await Promise.all([a, b]);
    const rows = (await readFile(paths.getMemberJournalPath(teamA, 'alice'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { reason: string });
    expect(rows.map((row) => row.reason)).toEqual(['status_v1', 'B']);
  });
});
