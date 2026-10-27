import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeTurnSettledIngestor } from '@features/member-work-sync/core/application';
import { TeamRuntimeTurnSettledTargetResolver } from '@features/member-work-sync/main/adapters/output/TeamRuntimeTurnSettledTargetResolver';
import { MemberWorkSyncEventQueue } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLegacySourceWriteAdmissionPolicy } from '../../../src/main/composition/legacySourceWriteAdmission';

import type { RuntimeTurnSettledEvent } from '@features/member-work-sync/core/domain';
import type { RuntimeTurnSettledSourceExecution } from '@features/member-work-sync/core/application';

const qualified = vi.hoisted(() => new Set<string>());
vi.mock('../../../src/main/services/team/provisioning/LegacyNativeStopRelease', () => ({
  readLegacyNativeStopRelease: (path: string) => (qualified.has(path) ? {} : null),
}));
let root: string;
const team = 'test-runtime-original';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(async () => {
  qualified.clear();
  root = await mkdtemp(join(tmpdir(), 'TEST-legacy-runtime-admission-'));
  await mkdir(join(root, team));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runtime target original-source restriction', () => {
  it.each(['claude', 'codex', 'opencode'] as const)(
    'captures before the first %s target read, then protects actual queued effects',
    async (provider) => {
      for (const scenario of ['unchanged', 'stopped', 'replaced'] as const) {
        qualified.clear();
        const policy = createLegacySourceWriteAdmissionPolicy({
          teamsRoot: root,
          selectedHost: true,
          isCurrentOwner: () => true,
          withIdentityFence: (_team, operation) => operation(),
        });
        let original: RuntimeTurnSettledSourceExecution | undefined;
        const readStarted = deferred(),
          finishRead = deferred();
        const readBarrier = async () => {
          expect(policy.current(team).sourceKey).toBe(join(root, team));
          readStarted.resolve();
          await finishRead.promise;
        };
        const resolver = new TeamRuntimeTurnSettledTargetResolver({
          captureSourceExecution: (name) => {
            const admission = policy.capture(name);
            if (admission.kind === 'read-only') return null;
            return (original = admission.run(() => policy.bindExecution(name)));
          },
          teamSource: {
            listTeams: async () => [{ teamName: team } as never],
            getConfig: async () => {
              if (provider !== 'claude') await readBarrier();
              return {
                name: team,
                members: [
                  { name: 'alice', providerId: provider === 'claude' ? 'anthropic' : provider },
                ],
              };
            },
          },
          membersMetaStore: { getMembers: async () => [] } as never,
          memberLogsFinder: {
            listAttributedMemberFiles: async () => {
              await readBarrier();
              return [
                {
                  memberName: 'alice',
                  sessionId: 'session-1',
                  filePath: '/TEST/session-1.jsonl',
                  mtimeMs: 1,
                },
              ];
            },
          },
        });
        const event: RuntimeTurnSettledEvent = {
          schemaVersion: 1,
          provider,
          hookEventName: 'Stop',
          sourceId: 'source-1',
          payloadHash: 'hash',
          recordedAt: '2026-04-29T12:00:00.000Z',
          teamName: team,
          memberName: 'alice',
          sessionId: 'session-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          outcome: 'success',
        };
        const processed = vi.fn(async () => undefined);
        const queue = new MemberWorkSyncEventQueue({
          quietWindowMs: 1,
          maxRetryAttempts: 0,
          captureExecutionScope: policy.bindExecution,
          isTeamActive: () => true,
          reconcile: async () => {
            original!.assertCurrent();
            await policy
              .current(team)
              .publish(() => writeFile(join(root, team, 'runtime-result.json'), scenario));
          },
        });
        const ingestor = new RuntimeTurnSettledIngestor({
          eventStore: {
            claimPending: async () => [
              {
                id: 'one',
                fileName: 'one',
                filePath: '/TEST/one',
                raw: '{}',
                provider,
                claimedAt: event.recordedAt,
              },
            ],
            markProcessed: processed,
            markInvalid: vi.fn(),
          },
          normalizer: { normalize: () => ({ ok: true, event }) },
          targetResolver: resolver,
          reconcileQueue: { enqueueRuntimeTurnSettled: (input) => queue.enqueueTurnSettled(input) },
          clock: { now: () => new Date(event.recordedAt) },
        });
        try {
          const work = ingestor.drainPending();
          await readStarted.promise;
          if (scenario === 'stopped') qualified.add(join(root, team));
          if (scenario === 'replaced') {
            await rename(join(root, team), join(root, 'old-' + provider));
            await mkdir(join(root, team));
          }
          finishRead.resolve();
          const result = await work;
          await vi.waitFor(() =>
            expect(queue.getDiagnostics()).toMatchObject({ queued: 0, running: 0 })
          );
          if (scenario === 'unchanged') {
            expect(result).toMatchObject({ enqueued: 1, failed: 0 });
            expect(await readFile(join(root, team, 'runtime-result.json'), 'utf8')).toBe(scenario);
            expect(processed).toHaveBeenCalledOnce();
            expect(JSON.stringify(processed.mock.calls)).not.toContain('sourceExecution');
            await rm(join(root, team, 'runtime-result.json'));
          } else {
            expect(result).toMatchObject({ enqueued: 0, failed: 1 });
            expect(processed).not.toHaveBeenCalled();
            await expect(readFile(join(root, team, 'runtime-result.json'))).rejects.toMatchObject({
              code: 'ENOENT',
            });
          }
        } finally {
          await queue.stop();
        }
      }
    }
  );

  it('rechecks the resolved restriction before enqueue without persisting its closure', async () => {
    const enqueue = vi.fn(() => true),
      markProcessed = vi.fn();
    const sourceExecution = {
      assertCurrent: () => {
        throw new Error('original source replaced');
      },
      run: <T>(work: () => T) => work(),
    };
    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: {
        claimPending: async () => [
          {
            id: 'one',
            fileName: 'one',
            filePath: '/TEST/one',
            raw: '{}',
            provider: 'claude',
            claimedAt: '2026-04-29',
          },
        ],
        markProcessed,
        markInvalid: vi.fn(),
      },
      normalizer: {
        normalize: () => ({
          ok: true,
          event: {
            schemaVersion: 1,
            provider: 'claude',
            hookEventName: 'Stop',
            sourceId: 'source',
            payloadHash: 'hash',
            recordedAt: '2026-04-29',
          },
        }),
      },
      targetResolver: {
        resolve: async () => ({ ok: true, teamName: team, memberName: 'alice', sourceExecution }),
      },
      reconcileQueue: { enqueueRuntimeTurnSettled: enqueue },
      clock: { now: () => new Date('2026-04-29') },
    });
    expect(await ingestor.drainPending()).toMatchObject({ enqueued: 0, failed: 1 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });
});
