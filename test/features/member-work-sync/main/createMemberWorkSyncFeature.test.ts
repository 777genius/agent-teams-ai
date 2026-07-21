import { buildMemberWorkSyncOutboxEnsureInput } from '@features/member-work-sync/core/domain';
import {
  buildMemberWorkSyncRuntimeTurnSettledEnvironment,
  createMemberWorkSyncFeature,
} from '@features/member-work-sync/main';
import { TeamInboxMemberWorkSyncNudgeSink } from '@features/member-work-sync/main/adapters/output/TeamInboxMemberWorkSyncNudgeSink';
import { HmacMemberWorkSyncReportTokenAdapter } from '@features/member-work-sync/main/infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncEventQueue } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue';
import { MemberWorkSyncNudgeDispatchScheduler } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { NodeHashAdapter } from '@features/member-work-sync/main/infrastructure/NodeHashAdapter';
import { RuntimeTurnSettledDrainScheduler } from '@features/member-work-sync/main/infrastructure/RuntimeTurnSettledDrainScheduler';
import { RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from '@features/member-work-sync/main/infrastructure/runtimeTurnSettledEnvironment';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-work-sync-feature-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  setClaudeBasePathOverride(null);
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function seedShadowReadyMetrics(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<void> {
  const metricsPath = path.join(
    input.teamsBasePath,
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  await fs.promises.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.promises.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members: {
          [input.memberName]: {
            memberName: input.memberName,
            state: 'caught_up',
            agendaFingerprint: 'agenda:v1:seed',
            actionableCount: 0,
            evaluatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        recentEvents: Array.from({ length: 20 }, (_, index) => ({
          id: `seed-status-${index}`,
          teamName: input.teamName,
          memberName: input.memberName,
          kind: 'status_evaluated',
          state: 'caught_up',
          agendaFingerprint: `agenda:v1:seed-${index}`,
          recordedAt: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
          actionableCount: 0,
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function seedNonBlockingShadowCollectingMetrics(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<void> {
  const metricsPath = path.join(
    input.teamsBasePath,
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  await fs.promises.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.promises.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members: {
          [input.memberName]: {
            memberName: input.memberName,
            state: 'caught_up',
            agendaFingerprint: 'agenda:v1:seed',
            actionableCount: 0,
            evaluatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        recentEvents: Array.from({ length: 18 }, (_, index) => ({
          id: `seed-status-${index}`,
          teamName: input.teamName,
          memberName: input.memberName,
          kind: 'status_evaluated',
          state: 'caught_up',
          agendaFingerprint: `agenda:v1:seed-${index}`,
          recordedAt: new Date(Date.UTC(2026, 0, 1, index * 6)).toISOString(),
          actionableCount: 0,
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function seedBlockingShadowCollectingMetrics(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  metricKind?: 'would_nudge' | 'fingerprint_changed' | 'report_rejected';
  metricKinds?: Array<'would_nudge' | 'fingerprint_changed' | 'report_rejected'>;
}): Promise<void> {
  const metricKinds = input.metricKinds ?? [input.metricKind ?? 'would_nudge'];
  const nowMs = Date.now();
  const firstObservedAt = new Date(nowMs - 1_000).toISOString();
  const secondObservedAt = new Date(nowMs).toISOString();
  const metricsPath = path.join(
    input.teamsBasePath,
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  await fs.promises.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.promises.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members: {
          [input.memberName]: {
            memberName: input.memberName,
            state: 'needs_sync',
            agendaFingerprint: 'agenda:v1:seed',
            actionableCount: 1,
            evaluatedAt: firstObservedAt,
          },
        },
        recentEvents: [
          {
            id: 'seed-status-0',
            teamName: input.teamName,
            memberName: input.memberName,
            kind: 'status_evaluated',
            state: 'needs_sync',
            agendaFingerprint: 'agenda:v1:seed',
            recordedAt: firstObservedAt,
            actionableCount: 1,
          },
          ...metricKinds.map((metricKind, index) => ({
            id: `seed-${metricKind}-${index}`,
            teamName: input.teamName,
            memberName: input.memberName,
            kind: metricKind,
            state: 'needs_sync',
            agendaFingerprint: 'agenda:v1:seed',
            recordedAt: secondObservedAt,
            actionableCount: 1,
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function seedMatureBlockingMetrics(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  memberNames?: string[];
  metricKinds: Array<'would_nudge' | 'fingerprint_changed' | 'report_rejected'>;
}): Promise<void> {
  const memberNames = [...new Set(input.memberNames ?? [input.memberName])];
  const nowMs = Date.now();
  const observationWindowMs = 2 * 60 * 60_000;
  const startMs = nowMs - observationWindowMs;
  const metricEventCounts = {
    would_nudge: 12,
    fingerprint_changed: 6,
    report_rejected: 6,
  } as const;
  const metricsPath = path.join(
    input.teamsBasePath,
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  const members = Object.fromEntries(
    memberNames.map((memberName) => [
      memberName,
      {
        memberName,
        state: 'caught_up',
        agendaFingerprint: `agenda:v1:seed:${memberName}`,
        actionableCount: 0,
        evaluatedAt: new Date(startMs).toISOString(),
        providerId: 'codex',
      },
    ])
  );
  const statusEvents = Array.from({ length: 24 }, (_, index) => {
    const memberName = memberNames[index % memberNames.length]!;
    return {
      id: `mature-status-${index}`,
      teamName: input.teamName,
      memberName,
      kind: 'status_evaluated',
      state: 'caught_up',
      agendaFingerprint: `agenda:v1:seed:${memberName}:${index}`,
      recordedAt: new Date(startMs + Math.round((observationWindowMs * index) / 23)).toISOString(),
      actionableCount: 0,
      providerId: 'codex',
    };
  });
  const metricEvents = input.metricKinds.flatMap((metricKind) =>
    Array.from({ length: metricEventCounts[metricKind] }, (_, index) => ({
      id: `mature-${metricKind}-${index}`,
      teamName: input.teamName,
      memberName: input.memberName,
      kind: metricKind,
      state: 'needs_sync',
      agendaFingerprint: 'agenda:v1:noisy-member',
      recordedAt: new Date(nowMs - index * 1_000).toISOString(),
      actionableCount: 1,
      providerId: 'codex',
    }))
  );

  await fs.promises.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.promises.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members,
        recentEvents: [...statusEvents, ...metricEvents],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function seedNativeStaleInProgressBlockingMetrics(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
}): Promise<void> {
  const nowMs = Date.now();
  const staleObservedAt = new Date(nowMs - 6 * 60_000 - 1_000).toISOString();
  const metricsPath = path.join(
    input.teamsBasePath,
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  await fs.promises.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.promises.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members: {
          [input.memberName]: {
            memberName: input.memberName,
            state: 'needs_sync',
            agendaFingerprint: input.agendaFingerprint,
            actionableCount: 1,
            evaluatedAt: staleObservedAt,
            providerId: 'codex',
          },
        },
        recentEvents: [
          {
            id: 'native-stale-status',
            teamName: input.teamName,
            memberName: input.memberName,
            kind: 'status_evaluated',
            state: 'needs_sync',
            agendaFingerprint: input.agendaFingerprint,
            recordedAt: staleObservedAt,
            actionableCount: 1,
            providerId: 'codex',
          },
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `native-stale-would-nudge-${index}`,
            teamName: input.teamName,
            memberName: input.memberName,
            kind: 'would_nudge',
            state: 'needs_sync',
            agendaFingerprint: input.agendaFingerprint,
            recordedAt: new Date(nowMs - 5 * 60_000 + index * 5_000).toISOString(),
            actionableCount: 1,
            providerId: 'codex',
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function waitForAssertion(assertion: () => Promise<void> | void): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) {
    throw lastError;
  }
  await assertion();
}

async function waitForQueueIdle(
  feature: ReturnType<typeof createMemberWorkSyncFeature>
): Promise<void> {
  await waitForAssertion(() => {
    expect(feature.getQueueDiagnostics()).toMatchObject({
      queued: 0,
      running: 0,
    });
  });
}

async function readInboxMessages(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<Array<{ messageId?: string; messageKind?: string; text?: string }>> {
  const inboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'inboxes',
    `${input.memberName}.json`
  );
  let raw: string;
  try {
    raw = await fs.promises.readFile(inboxPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      return [];
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter(
        (item): item is { messageId?: string; messageKind?: string; text?: string } =>
          Boolean(item) && typeof item === 'object'
      )
    : [];
}

async function readMemberOutboxItems(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<
  Record<
    string,
    {
      status?: string;
      lastError?: string;
      nextAttemptAt?: string;
      deliveredMessageId?: string;
      attemptGeneration?: number;
      claimedBy?: string;
      claimedAt?: string;
      payload?: { workSyncIntentKey?: string; text?: string };
    }
  >
> {
  const outboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'members',
    input.memberName,
    '.member-work-sync',
    'outbox.json'
  );
  let raw: string;
  try {
    raw = await fs.promises.readFile(outboxPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as {
    items?: Record<string, { status?: string; lastError?: string }>;
  };
  return parsed.items ?? {};
}

async function forceRetryableOutboxDue(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  nextAttemptAt: string;
}): Promise<void> {
  const outboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'members',
    input.memberName,
    '.member-work-sync',
    'outbox.json'
  );
  const parsed = JSON.parse(await fs.promises.readFile(outboxPath, 'utf8')) as {
    items?: Record<string, { status?: string; nextAttemptAt?: string; updatedAt?: string }>;
  };
  let touched = 0;
  for (const item of Object.values(parsed.items ?? {})) {
    if (item.status === 'failed_retryable') {
      item.nextAttemptAt = input.nextAttemptAt;
      item.updatedAt = input.nextAttemptAt;
      touched += 1;
    }
  }
  expect(touched).toBeGreaterThan(0);
  await fs.promises.writeFile(outboxPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await fs.promises.rm(
    path.join(
      input.teamsBasePath,
      input.teamName,
      '.member-work-sync',
      'indexes',
      'outbox-index.json'
    ),
    { force: true }
  );
}

async function backdateDeliveredOutboxItems(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  updatedAt: string;
}): Promise<void> {
  const outboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'members',
    input.memberName,
    '.member-work-sync',
    'outbox.json'
  );
  const parsed = JSON.parse(await fs.promises.readFile(outboxPath, 'utf8')) as {
    items?: Record<string, { status?: string; updatedAt?: string }>;
  };
  const touchedIds: string[] = [];
  for (const [id, item] of Object.entries(parsed.items ?? {})) {
    if (item.status === 'delivered') {
      item.updatedAt = input.updatedAt;
      touchedIds.push(id);
    }
  }
  expect(touchedIds.length).toBeGreaterThan(0);
  await fs.promises.writeFile(outboxPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  const indexPath = path.join(
    input.teamsBasePath,
    input.teamName,
    '.member-work-sync',
    'indexes',
    'outbox-index.json'
  );
  const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8')) as {
    items?: Record<string, { updatedAt?: string }>;
  };
  for (const id of touchedIds) {
    if (index.items?.[id]) {
      index.items[id].updatedAt = input.updatedAt;
    }
  }
  await fs.promises.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

describe('createMemberWorkSyncFeature composition', () => {
  it('idempotently waits for every scheduler and queue disposal', async () => {
    const runtimeDrain = createDeferred();
    const nudgeDrain = createDeferred();
    const queueDrain = createDeferred();
    const runtimeDisposeOriginal = RuntimeTurnSettledDrainScheduler.prototype.dispose;
    const nudgeDisposeOriginal = MemberWorkSyncNudgeDispatchScheduler.prototype.dispose;
    const queueStopOriginal = MemberWorkSyncEventQueue.prototype.stop;
    const runtimeDispose = vi
      .spyOn(RuntimeTurnSettledDrainScheduler.prototype, 'dispose')
      .mockImplementation(function (this: RuntimeTurnSettledDrainScheduler) {
        return Promise.all([runtimeDisposeOriginal.call(this), runtimeDrain.promise]).then(
          () => undefined
        );
      });
    const nudgeDispose = vi
      .spyOn(MemberWorkSyncNudgeDispatchScheduler.prototype, 'dispose')
      .mockImplementation(function (this: MemberWorkSyncNudgeDispatchScheduler) {
        return Promise.all([nudgeDisposeOriginal.call(this), nudgeDrain.promise]).then(
          () => undefined
        );
      });
    const queueStop = vi
      .spyOn(MemberWorkSyncEventQueue.prototype, 'stop')
      .mockImplementation(function (this: MemberWorkSyncEventQueue) {
        return Promise.all([queueStopOriginal.call(this), queueDrain.promise]).then(
          () => undefined
        );
      });
    const feature = createMemberWorkSyncFeature({
      teamsBasePath: path.join(makeTempRoot(), 'teams'),
      configReader: { getConfig: vi.fn(async () => null) } as never,
      taskReader: { getTasks: vi.fn(async () => []) } as never,
      kanbanManager: { getState: vi.fn(async () => null) } as never,
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      listLifecycleActiveTeamNames: async () => [],
    });

    try {
      const firstDispose = feature.dispose();
      const secondDispose = feature.dispose();
      expect(secondDispose).toBe(firstDispose);
      expect(runtimeDispose).toHaveBeenCalledOnce();
      expect(nudgeDispose).toHaveBeenCalledOnce();
      expect(queueStop).toHaveBeenCalledOnce();

      let disposed = false;
      void firstDispose.then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);

      runtimeDrain.resolve();
      queueDrain.resolve();
      await Promise.resolve();
      expect(disposed).toBe(false);

      nudgeDrain.resolve();
      await firstDispose;
      expect(disposed).toBe(true);
      expect(feature.dispose()).toBe(firstDispose);
    } finally {
      runtimeDrain.resolve();
      nudgeDrain.resolve();
      queueDrain.resolve();
      await feature.dispose();
      runtimeDispose.mockRestore();
      nudgeDispose.mockRestore();
      queueStop.mockRestore();
    }
  });

  it('schedules proof-missing recovery through the work-sync queue', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName }],
        })),
      } as never,
      taskReader: { getTasks: vi.fn(async () => []) } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({ teamName, reviewers: [], tasks: {} })),
      } as never,
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
    });

    try {
      await expect(
        feature.scheduleProofMissingRecovery({
          teamName,
          memberName,
          originalMessageId: 'message-1',
          taskRefs: [{ taskId: 'task-1', displayId: '11111111', teamName }],
          reason: 'OpenCode proof missing',
        })
      ).resolves.toMatchObject({
        scheduled: true,
        reason: 'scheduled',
        intentKey: 'proof-missing:message-1',
      });

      expect(feature.getQueueDiagnostics()).toMatchObject({
        queued: 1,
        queuedItems: [
          {
            teamName,
            memberName,
            triggerReasons: ['proof_missing_recovery'],
          },
        ],
      });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
    } finally {
      await feature.dispose();
    }
  });

  it('coalesces proof-missing recovery when a recent matching outbox item exists', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName }],
        })),
      } as never,
      taskReader: { getTasks: vi.fn(async () => []) } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({ teamName, reviewers: [], tasks: {} })),
      } as never,
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
    });

    try {
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await store.ensurePending({
        id: 'member-work-sync:team-a:bob:proof-missing:message-1',
        teamName,
        memberName,
        agendaFingerprint: 'agenda:v1:test',
        payloadHash: 'payload-hash',
        payload: {
          from: 'system',
          to: memberName,
          messageKind: 'member_work_sync_nudge',
          source: 'member-work-sync',
          actionMode: 'do',
          workSyncIntent: 'agenda_sync',
          workSyncIntentKey: 'proof-missing:message-1',
          text: 'Recover proof',
          taskRefs: [{ taskId: 'task-1', displayId: '11111111', teamName }],
        },
        nowIso: new Date().toISOString(),
      });

      await expect(
        feature.scheduleProofMissingRecovery({
          teamName,
          memberName,
          originalMessageId: 'message-1',
          taskRefs: [{ taskId: 'task-1', displayId: '11111111', teamName }],
        })
      ).resolves.toMatchObject({
        scheduled: false,
        reason: 'coalesced_recent',
        existingOutboxId: 'member-work-sync:team-a:bob:proof-missing:message-1',
      });
      expect(feature.getQueueDiagnostics()).toMatchObject({ queued: 0 });
    } finally {
      await feature.dispose();
    }
  });

  it('does not schedule broad proof-missing recovery without task refs', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName }],
        })),
      } as never,
      taskReader: { getTasks: vi.fn(async () => []) } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({ teamName, reviewers: [], tasks: {} })),
      } as never,
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
    });

    try {
      await expect(
        feature.scheduleProofMissingRecovery({
          teamName,
          memberName,
          originalMessageId: 'message-1',
        })
      ).resolves.toMatchObject({
        scheduled: false,
        reason: 'invalid',
      });
      expect(feature.getQueueDiagnostics()).toMatchObject({ queued: 0 });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
    } finally {
      await feature.dispose();
    }
  });

  it('dispatches a due nudge through the real outbox and inbox by default', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const status = await feature.refreshStatus({ teamName, memberName });
      expect(status).toMatchObject({
        state: 'needs_sync',
        shadow: { wouldNudge: true },
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: { state: 'shadow_ready' },
      });

      const outboxInput = buildMemberWorkSyncOutboxEnsureInput({
        status,
        hash: new NodeHashAdapter(),
        nowIso: status.evaluatedAt,
      });
      expect(outboxInput).not.toBeNull();
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await expect(store.ensurePending(outboxInput!)).resolves.toMatchObject({
        ok: true,
        outcome: 'existing',
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      await expect(
        fs.promises.readFile(path.join(teamsBasePath, teamName, 'inboxes', `${memberName}.json`), {
          encoding: 'utf8',
        })
      ).resolves.toContain(outboxInput!.id);
    } finally {
      await feature.dispose();
    }
  });

  it('dispatches existing due nudges before background stale refresh work', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let postSeedGetConfigCalls = 0;
    let refreshBlocked = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshBlocker = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const getConfig = vi.fn(async () => {
      postSeedGetConfigCalls += 1;
      if (postSeedGetConfigCalls === 2) {
        refreshBlocked = true;
        await refreshBlocker;
      }
      return {
        name: teamName,
        members: [{ name: memberName }],
      };
    });
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig,
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
    });
    let dispatchPromise: Promise<unknown> | null = null;

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const status = await feature.refreshStatus({ teamName, memberName });
      const outboxInput = buildMemberWorkSyncOutboxEnsureInput({
        status,
        hash: new NodeHashAdapter(),
        nowIso: status.evaluatedAt,
      });
      expect(outboxInput).not.toBeNull();
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await expect(store.ensurePending(outboxInput!)).resolves.toMatchObject({
        ok: true,
        outcome: 'existing',
      });
      await store.write({
        ...status,
        evaluatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });

      postSeedGetConfigCalls = 0;
      dispatchPromise = feature.dispatchDueNudges([teamName]);
      await waitForAssertion(() => {
        expect(refreshBlocked).toBe(true);
      });

      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ messageId: outboxInput!.id })])
      );

      releaseRefresh();
      await expect(dispatchPromise).resolves.toMatchObject({
        claimed: 1,
        delivered: 1,
      });
    } finally {
      releaseRefresh();
      await dispatchPromise?.catch(() => undefined);
      await feature.dispose();
    }
  });

  it('suppresses queued proof-missing recovery when the original delivery is no longer proof-missing', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const proofMissingRecoveryGuard = {
      shouldDispatch: vi.fn(async () => ({
        ok: false as const,
        reason: 'proof_missing_recovery_suppressed',
        retryable: false,
      })),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      proofMissingRecoveryGuard,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const status = await feature.refreshStatus({ teamName, memberName });
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await expect(
        store.ensurePending({
          id: 'member-work-sync:team-a:bob:proof-missing:message-1',
          teamName,
          memberName,
          agendaFingerprint: status.agenda.fingerprint,
          payloadHash: 'payload-hash',
          payload: {
            from: 'system',
            to: memberName,
            messageKind: 'member_work_sync_nudge',
            source: 'member-work-sync',
            actionMode: 'do',
            workSyncIntent: 'agenda_sync',
            workSyncIntentKey: 'proof-missing:message-1',
            text: 'Recover proof',
            taskRefs: [{ taskId: 'task-1', displayId: '11111111', teamName }],
          },
          nowIso: status.evaluatedAt,
        })
      ).resolves.toMatchObject({
        ok: true,
        outcome: 'created',
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 2,
        delivered: 1,
        superseded: 1,
        retryable: 0,
        terminal: 0,
      });
      expect(proofMissingRecoveryGuard.shouldDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName,
          memberName,
          intentKey: 'proof-missing:message-1',
          originalMessageId: 'message-1',
          taskIds: ['task-1'],
        })
      );
      const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
        (message) => message.messageKind === 'member_work_sync_nudge'
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.text).toContain('Required sync action');
      expect(nudges[0]?.text).not.toContain('Recover proof');
    } finally {
      await feature.dispose();
    }
  });

  it('does not deliver pending nudges until the team is ready for nudge dispatch', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let canDispatchNudges = false;
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      canDispatchNudges: vi.fn(async () => canDispatchNudges),
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const status = await feature.refreshStatus({ teamName, memberName });
      const outboxInput = buildMemberWorkSyncOutboxEnsureInput({
        status,
        hash: new NodeHashAdapter(),
        nowIso: status.evaluatedAt,
      });
      expect(outboxInput).not.toBeNull();
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await expect(store.ensurePending(outboxInput!)).resolves.toMatchObject({
        ok: true,
        outcome: 'existing',
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
      await expect(
        readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      ).resolves.toMatchObject({
        [outboxInput!.id]: { status: 'pending' },
      });

      canDispatchNudges = true;
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      await expect(
        readInboxMessages({ teamsBasePath, teamName, memberName })
      ).resolves.toMatchObject([{ messageId: outboxInput!.id }]);
    } finally {
      await feature.dispose();
    }
  });

  it('checks nudge dispatch readiness sequentially', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    let releaseFirst!: () => void;
    const startedTeams: string[] = [];
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async (teamName: string) => ({
          name: teamName,
          members: [],
        })),
      } as never,
      taskReader: { getTasks: vi.fn(async () => []) } as never,
      kanbanManager: {
        getState: vi.fn(async (teamName: string) => ({ teamName, reviewers: [], tasks: {} })),
      } as never,
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      canDispatchNudges: vi.fn(async (teamName: string) => {
        startedTeams.push(teamName);
        if (teamName === 'team-a') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return false;
      }),
    });

    try {
      const dispatch = feature.dispatchDueNudges(['team-a', 'team-b']);
      await Promise.resolve();

      expect(startedTeams).toEqual(['team-a']);

      releaseFirst();
      await expect(dispatch).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      expect(startedTeams).toEqual(['team-a', 'team-b']);
    } finally {
      await feature.dispose();
    }
  });

  it('plans and dispatches due nudges after queued reconcile by default', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      queueQuietWindowMs: 1,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({
        type: 'task',
        teamName,
        taskId: 'task-1',
      } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const inbox = await fs.promises.readFile(
          path.join(teamsBasePath, teamName, 'inboxes', `${memberName}.json`),
          'utf8'
        );
        expect(inbox).toContain('member_work_sync_nudge');
        expect(inbox).toContain(`member-work-sync:${teamName}:${memberName}:agenda:v1:`);
      });
    } finally {
      await feature.dispose();
    }
  });

  it('drains runtime turn-settled files into queued reconcile and nudge delivery', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'opencode' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync after settled turn',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
      resolveControlUrl: vi.fn(async () => 'http://127.0.0.1:43123'),
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' });
      const spoolRoot = env?.[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV];
      expect(spoolRoot).toBeTruthy();
      const eventFileName = '20260505T120000000Z-test.opencode.json';
      await fs.promises.writeFile(
        path.join(spoolRoot!, 'incoming', eventFileName),
        `${JSON.stringify({
          schemaVersion: 1,
          provider: 'opencode',
          source: 'agent-teams-orchestrator-opencode',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          sessionId: 'ses-opencode-1',
          runtimePromptMessageId: 'msg_123',
          laneId: 'secondary:opencode:bob',
          memberName,
          teamName,
          cwd: claudeRoot,
          outcome: 'success',
          recordedAt: '2026-05-05T12:00:00.000Z',
        })}\n`,
        'utf8'
      );

      const drain = await feature.drainRuntimeTurnSettledEvents();
      expect(drain).toMatchObject({
        invalid: 0,
        unresolved: 0,
      });

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        const status = await feature.getStatus({ teamName, memberName });
        expect(status).toMatchObject({
          state: 'needs_sync',
          providerId: 'opencode',
          shadow: {
            wouldNudge: true,
            triggerReasons: ['turn_settled'],
          },
        });
      });

      const processedMeta = JSON.parse(
        await fs.promises.readFile(
          path.join(spoolRoot!, 'processed', `${eventFileName}.meta.json`),
          'utf8'
        )
      ) as { outcome?: string; teamName?: string; memberName?: string };
      expect(processedMeta).toMatchObject({
        outcome: 'enqueued',
        teamName,
        memberName,
      });
    } finally {
      await feature.dispose();
    }
  });

  it('delivers a status-only recovery nudge when a delivered Codex nudge settles without report proof', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-codex-status-only-recovery';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync after status-only turn',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
      resolveControlUrl: vi.fn(async () => 'http://127.0.0.1:43123'),
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudges[0]?.text).toContain('controlUrl "http://127.0.0.1:43123"');
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual([
          expect.objectContaining({
            status: 'delivered',
          }),
        ]);
        const deliveredOutboxItem = outboxItems[0] as {
          payload?: { workSyncIntentKey?: string };
        };
        expect(deliveredOutboxItem.payload?.workSyncIntentKey).toBeUndefined();
      });

      feature.noteTeamChange({
        type: 'tool-activity',
        teamName,
        detail: JSON.stringify({
          action: 'start',
          activity: {
            memberName,
            toolUseId: 'status-tool-1',
            toolName: 'member_work_sync_status',
            startedAt: '2026-05-05T12:00:00.000Z',
            source: 'runtime',
          },
        }),
      } as never);
      feature.noteTeamChange({
        type: 'tool-activity',
        teamName,
        detail: JSON.stringify({
          action: 'finish',
          memberName,
          toolUseId: 'status-tool-1',
          finishedAt: new Date().toISOString(),
        }),
      } as never);

      const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'codex' });
      const spoolRoot = env?.[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV];
      expect(spoolRoot).toBeTruthy();
      const eventFileName = '20260505T120001000Z-status-only.codex.json';
      await fs.promises.writeFile(
        path.join(spoolRoot!, 'incoming', eventFileName),
        `${JSON.stringify({
          schemaVersion: 1,
          provider: 'codex',
          source: 'agent-teams-orchestrator-codex-native',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          sessionId: 'ses-codex-1',
          memberName,
          teamName,
          cwd: claudeRoot,
          outcome: 'success',
          recordedAt: '2026-05-05T12:00:01.000Z',
        })}\n`,
        'utf8'
      );

      await expect(feature.drainRuntimeTurnSettledEvents()).resolves.toMatchObject({
        invalid: 0,
        unresolved: 0,
      });

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(2);
        expect(nudges[1]?.messageId).toContain('status-only');
        expect(nudges[1]?.text).toContain('previous work-sync turn appears to have stopped');
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'delivered',
              payload: expect.objectContaining({
                workSyncIntentKey: expect.stringContaining('status-only:'),
              }),
            }),
          ])
        );
      });
    } finally {
      await feature.dispose();
    }
  });

  it.each(['idle_without_assistant_activity', 'timeout'])(
    'delivers recovery when a delivered OpenCode nudge settles with prompt-owned %s',
    async (outcome) => {
      const claudeRoot = makeTempRoot();
      setClaudeBasePathOverride(claudeRoot);
      const teamsBasePath = getTeamsBasePath();
      const teamName = `team-opencode-${outcome.replace(/_/g, '-')}-recovery`;
      const memberName = 'bob';
      const feature = createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'opencode' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: `Ship sync after OpenCode ${outcome}`,
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        queueQuietWindowMs: 1,
        resolveControlUrl: vi.fn(async () => 'http://127.0.0.1:43123'),
      });

      try {
        await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
        feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

        await waitForAssertion(async () => {
          const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          );
          expect(nudges).toHaveLength(1);
          expect(nudges[0]?.text).toContain('11111111');
          expect(
            Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                status: 'delivered',
                payload: expect.objectContaining({
                  workSyncIntent: 'agenda_sync',
                }),
              }),
            ])
          );
        });

        const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' });
        const spoolRoot = env?.[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV];
        expect(spoolRoot).toBeTruthy();
        const eventFileName = `20260505T120001000Z-${outcome}.opencode.json`;
        await fs.promises.writeFile(
          path.join(spoolRoot!, 'incoming', eventFileName),
          `${JSON.stringify({
            schemaVersion: 1,
            provider: 'opencode',
            source: 'agent-teams-orchestrator-opencode',
            eventName: 'runtime_turn_settled',
            hookEventName: 'Stop',
            sessionId: 'ses-opencode-1',
            runtimePromptMessageId: 'msg_123',
            laneId: 'secondary:opencode:bob',
            memberName,
            teamName,
            cwd: claudeRoot,
            outcome,
            recordedAt: '2026-05-05T12:00:01.000Z',
          })}\n`,
          'utf8'
        );

        await expect(feature.drainRuntimeTurnSettledEvents()).resolves.toMatchObject({
          invalid: 0,
          unresolved: 0,
          ignored: 0,
        });

        await waitForAssertion(async () => {
          const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          );
          expect(nudges).toHaveLength(2);
          expect(nudges[1]?.messageId).toContain('status-only');
          expect(nudges[1]?.text).toContain('previous work-sync turn appears to have stopped');
          const status = await feature.getStatus({ teamName, memberName });
          expect(status.diagnostics).toEqual(
            expect.arrayContaining(['runtime_stall:same_agenda_still_needs_sync'])
          );
        });

        const processedMeta = JSON.parse(
          await fs.promises.readFile(
            path.join(spoolRoot!, 'processed', `${eventFileName}.meta.json`),
            'utf8'
          )
        ) as { outcome?: string; event?: { outcome?: string } };
        expect(processedMeta).toMatchObject({
          outcome: 'enqueued',
          event: { outcome },
        });
      } finally {
        await feature.dispose();
      }
    }
  );

  it.each([
    {
      outcome: 'idle_without_assistant_activity',
      expectedReason: 'opencode_non_terminal_outcome:idle_without_assistant_activity',
    },
    {
      outcome: 'success',
      expectedReason: 'opencode_missing_prompt_identity',
    },
  ])(
    'does not deliver recovery for OpenCode $outcome events with turnId only',
    async (scenario) => {
      const claudeRoot = makeTempRoot();
      setClaudeBasePathOverride(claudeRoot);
      const teamsBasePath = getTeamsBasePath();
      const teamName = 'team-opencode-turnid-only-ignored';
      const memberName = 'bob';
      const feature = createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'opencode' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Ignore launch-like OpenCode idle events',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        queueQuietWindowMs: 1,
        resolveControlUrl: vi.fn(async () => 'http://127.0.0.1:43123'),
      });

      try {
        await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
        feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

        await waitForAssertion(async () => {
          const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          );
          expect(nudges).toHaveLength(1);
          expect(nudges[0]?.text).toContain('11111111');
        });

        const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' });
        const spoolRoot = env?.[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV];
        expect(spoolRoot).toBeTruthy();
        const eventFileName = '20260505T120002000Z-turnid-only.opencode.json';
        await fs.promises.writeFile(
          path.join(spoolRoot!, 'incoming', eventFileName),
          `${JSON.stringify({
            schemaVersion: 1,
            provider: 'opencode',
            source: 'agent-teams-orchestrator-opencode',
            eventName: 'runtime_turn_settled',
            hookEventName: 'Stop',
            sessionId: 'ses-opencode-1',
            turnId: 'msg_launch_or_bootstrap',
            laneId: 'secondary:opencode:bob',
            memberName,
            teamName,
            cwd: claudeRoot,
            outcome: scenario.outcome,
            recordedAt: '2026-05-05T12:00:02.000Z',
          })}\n`,
          'utf8'
        );

        await expect(feature.drainRuntimeTurnSettledEvents()).resolves.toMatchObject({
          invalid: 0,
          unresolved: 0,
        });

        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        const outboxItems = Object.values(
          (await readMemberOutboxItems({ teamsBasePath, teamName, memberName })) as Record<
            string,
            { payload?: { workSyncIntentKey?: string } }
          >
        );
        expect(
          outboxItems.some((item) => item.payload?.workSyncIntentKey?.startsWith('status-only:'))
        ).toBe(false);

        await waitForAssertion(async () => {
          const processedMeta = JSON.parse(
            await fs.promises.readFile(
              path.join(spoolRoot!, 'processed', `${eventFileName}.meta.json`),
              'utf8'
            )
          ) as {
            outcome?: string;
            reason?: string;
            event?: { turnId?: string; threadId?: string };
          };
          expect(processedMeta).toMatchObject({
            outcome: 'ignored',
            reason: scenario.expectedReason,
            event: { turnId: 'msg_launch_or_bootstrap' },
          });
          expect(processedMeta.event).not.toHaveProperty('threadId');
        });
      } finally {
        await feature.dispose();
      }
    }
  );

  it('delivers targeted OpenCode nudges during shadow collection and schedules a delivery wake', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-opencode-targeted';
    const memberName = 'alice';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'opencode' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship OpenCode targeted nudge',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedNonBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'opencode',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: { state: 'collecting_shadow_data' },
        });
        await expect(feature.getStatus({ teamName, memberName })).resolves.toMatchObject({
          state: 'needs_sync',
          providerId: 'opencode',
          shadow: { wouldNudge: true },
        });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
          }),
        ]);
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"delivery_not_ready"');
    } finally {
      await feature.dispose();
    }
  });

  it('delivers Codex inbox-watch nudges while shadow data is still collecting', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-codex-shadow-gated';
    const memberName = 'bob';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Keep Codex gated during shadow collection',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedNonBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudges[0]?.text).toContain('mcp__agent-teams__member_work_sync_report');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'codex',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
          }),
        ]);
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: { state: 'collecting_shadow_data' },
        });
        await expect(feature.getStatus({ teamName, memberName })).resolves.toMatchObject({
          state: 'needs_sync',
          providerId: 'codex',
          shadow: { wouldNudge: true },
        });
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"delivery_not_ready"');
    } finally {
      await feature.dispose();
    }
  });

  it('delivers Codex task protocol repair after a settled worker turn despite noisy metrics', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-codex-task-protocol-repair';
    const memberName = 'bob';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Close Codex task protocol',
            status: 'in_progress',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedBlockingShadowCollectingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKind: 'report_rejected',
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        await expect(feature.getStatus({ teamName, memberName })).resolves.toMatchObject({
          state: 'needs_sync',
          providerId: 'codex',
          diagnostics: expect.arrayContaining(['no_current_report']),
          shadow: { wouldNudge: true },
        });
        await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual(
          []
        );
      });

      feature.noteTeamChange({
        type: 'member-turn-settled',
        teamName,
        detail: JSON.stringify({ memberName, provider: 'codex', sourceId: 'test-turn' }),
      } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('Task protocol repair');
        expect(nudges[0]?.text).toContain('task_add_comment');
        expect(nudges[0]?.text).toContain('task_complete');
        expect(nudges[0]?.text).toContain('mcp__agent-teams__member_work_sync_report');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'codex',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
            payload: expect.objectContaining({
              workSyncIntentKey: expect.stringContaining('task-protocol-repair:'),
            }),
          }),
        ]);
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"runtime_stall_observed"');
      expect(journal).toContain('"event":"nudge_planned"');
      expect(journal).toContain('"reason":"created"');
      expect(journal).toContain('"event":"nudge_delivered"');
    } finally {
      await feature.dispose();
    }
  });

  it('delivers native stale in-progress recovery nudges despite noisy global metrics', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-native-stale-in-progress';
    const memberName = 'alice';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Review landing',
            status: 'in_progress',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      let agendaFingerprint = '';
      await waitForAssertion(async () => {
        const status = await feature.getStatus({ teamName, memberName });
        expect(status).toMatchObject({
          state: 'needs_sync',
          providerId: 'codex',
          diagnostics: expect.arrayContaining(['no_current_report']),
          agenda: {
            items: [
              expect.objectContaining({
                reason: 'owned_in_progress_task',
                evidence: expect.objectContaining({ status: 'in_progress' }),
              }),
            ],
          },
        });
        agendaFingerprint = status.agenda.fingerprint;
      });
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);
      expect(nudgeDeliveryWake.schedule).not.toHaveBeenCalled();

      await seedNativeStaleInProgressBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        agendaFingerprint,
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('Work sync check');
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'codex',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: {
            reasons: expect.arrayContaining(['would_nudge_rate_high']),
          },
        });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
          }),
        ]);
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).toContain('"reason":"created"');
    } finally {
      await feature.dispose();
    }
  });

  it('keeps config provider when runtime member meta omits it before native stale recovery', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-native-stale-meta-provider';
    const memberName = 'nickname';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: 'NickName', providerId: 'codex', model: 'gpt-5.5' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Review landing',
            status: 'in_progress',
            owner: 'NickName',
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => [
          {
            name: 'NickName',
            role: 'developer',
            agentType: 'general-purpose',
            color: 'blue',
          },
        ]),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      let agendaFingerprint = '';
      await waitForAssertion(async () => {
        const status = await feature.getStatus({ teamName, memberName });
        expect(status).toMatchObject({
          state: 'needs_sync',
          providerId: 'codex',
          diagnostics: expect.arrayContaining(['no_current_report']),
          agenda: {
            items: [
              expect.objectContaining({
                reason: 'owned_in_progress_task',
                evidence: expect.objectContaining({ status: 'in_progress' }),
              }),
            ],
          },
        });
        agendaFingerprint = status.agenda.fingerprint;
      });
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);

      await seedNativeStaleInProgressBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        agendaFingerprint,
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('Work sync check');
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'codex',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
          }),
        ]);
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"blocking_metrics"');
    } finally {
      await feature.dispose();
    }
  });

  it('delivers native stale pending-work recovery nudges despite noisy global metrics', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-native-stale-pending';
    const memberName = 'alice';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Start assigned pending work',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      let agendaFingerprint = '';
      await waitForAssertion(async () => {
        const status = await feature.getStatus({ teamName, memberName });
        expect(status).toMatchObject({
          state: 'needs_sync',
          providerId: 'codex',
          diagnostics: expect.arrayContaining(['no_current_report']),
          agenda: {
            items: [
              expect.objectContaining({
                reason: 'owned_pending_task',
                evidence: expect.objectContaining({ status: 'pending' }),
              }),
            ],
          },
        });
        agendaFingerprint = status.agenda.fingerprint;
      });
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);
      expect(nudgeDeliveryWake.schedule).not.toHaveBeenCalled();

      await seedNativeStaleInProgressBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        agendaFingerprint,
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('Work sync check');
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: {
            reasons: expect.arrayContaining(['would_nudge_rate_high']),
          },
        });
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"blocking_metrics"');
    } finally {
      await feature.dispose();
    }
  });

  it('delivers still-stuck recovery from json outbox when a delivered agenda nudge gets no report', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-json-still-stuck-recovery';
    const memberName = 'alice';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Recover ignored delivered sync',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      let agendaFingerprint = '';
      await waitForAssertion(async () => {
        const status = await feature.getStatus({ teamName, memberName });
        agendaFingerprint = status.agenda.fingerprint;
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
          }),
        ]);
      });

      await backdateDeliveredOutboxItems({
        teamsBasePath,
        teamName,
        memberName,
        updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      await seedNativeStaleInProgressBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        agendaFingerprint,
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(2);
        expect(nudges[1]?.messageId).toContain('agenda-sync-still-stuck');
        expect(nudges[1]?.text).toContain('still no accepted member_work_sync_report');
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'delivered',
              deliveredMessageId: nudges[1]?.messageId,
            }),
          ])
        );
      });
    } finally {
      await feature.dispose();
    }
  });

  it('delivers targeted OpenCode nudges even when global delivery readiness metrics are noisy', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-opencode-blocking-metrics';
    const memberName = 'alice';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'opencode' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Nudge OpenCode despite noisy global metrics',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'opencode',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: {
            state: 'blocked',
            reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
          },
        });
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"blocking_metrics"');
    } finally {
      await feature.dispose();
    }
  });

  it('delivers targeted lead nudges even when global delivery readiness metrics are noisy', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lead-blocking-metrics';
    const memberName = 'team-lead';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex', agentType: 'team-lead' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Resolve lead clarification',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'codex',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: {
            state: 'blocked',
            reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
          },
        });
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"blocking_metrics"');
    } finally {
      await feature.dispose();
    }
  });

  it('keeps targeted OpenCode nudge idempotent after noisy metrics become ready', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-opencode-metrics-recovery';
    const memberName = 'alice';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'opencode' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Keep OpenCode nudge idempotent after metrics ready',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: {
            state: 'blocked',
            reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
          },
        });
      });

      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenLastCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'opencode',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
          }),
        ]);
      });
    } finally {
      await feature.dispose();
    }
  });

  it('keeps targeted OpenCode nudges retryable when prompt delivery is busy', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-opencode-busy';
    const memberName = 'alice';
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    let promptDeliveryBusy = true;
    const promptDeliveryBusySignal = {
      isBusy: vi.fn(async () =>
        promptDeliveryBusy
          ? {
              busy: true,
              reason: 'opencode_prompt_delivery_active',
              retryAfterIso: '2026-05-05T12:05:00.000Z',
            }
          : { busy: false }
      ),
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'opencode' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship OpenCode busy nudge',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      extraBusySignals: [promptDeliveryBusySignal],
      nudgeDeliveryWake,
      queueQuietWindowMs: 1,
    });

    try {
      await seedNonBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);
        expect(nudgeDeliveryWake.schedule).not.toHaveBeenCalled();
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'failed_retryable',
            lastError: 'member_busy:opencode_prompt_delivery_active',
            nextAttemptAt: '2026-05-05T12:05:00.000Z',
          }),
        ]);
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"member_busy"');
      expect(journal).toContain('"reason":"member_busy:opencode_prompt_delivery_active"');
      expect(journal).not.toContain('"event":"nudge_delivered"');

      promptDeliveryBusy = false;
      await forceRetryableOutboxDue({
        teamsBasePath,
        teamName,
        memberName,
        nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
          teamName,
          memberName,
          messageId: nudges[0]?.messageId,
          providerId: 'opencode',
          reason: 'member_work_sync_nudge_inserted',
          delayMs: 500,
        });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: nudges[0]?.messageId,
          }),
        ]);
      });

      const recoveredJournal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(recoveredJournal).toContain('"event":"nudge_delivered"');
    } finally {
      await feature.dispose();
    }
  });

  it('delivers native targeted recovery when agenda telemetry makes readiness noisy', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync despite self-noisy readiness',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const metrics = await feature.getMetrics({ teamName });
        expect(metrics.deliveryReadiness).toMatchObject({
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual([
          expect.objectContaining({
            status: 'delivered',
          }),
        ]);
      });

      const wouldNudgeCountBeforeStorm = (await feature.getMetrics({ teamName })).wouldNudgeCount;
      for (let index = 0; index < 12; index += 1) {
        const reconciledBefore = feature.getQueueDiagnostics().reconciled;
        feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
        await waitForAssertion(() => {
          expect(feature.getQueueDiagnostics()).toMatchObject({
            queued: 0,
            running: 0,
          });
          expect(feature.getQueueDiagnostics().reconciled).toBeGreaterThanOrEqual(
            reconciledBefore + 1
          );
        });
      }
      const stormMetrics = await feature.getMetrics({ teamName });
      expect(stormMetrics.wouldNudgeCount).toBeGreaterThan(wouldNudgeCountBeforeStorm);
      expect(stormMetrics.deliveryReadiness).toMatchObject({
        state: 'blocked',
        reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"blocking_metrics"');
    } finally {
      await feature.dispose();
    }
  });

  it('keeps the planner silent for a peer safety blocker and recovers after metrics clear', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-report-rejection-planner';
    const safetyMemberName = 'alice';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [
            { name: safetyMemberName, providerId: 'codex' },
            { name: memberName, providerId: 'codex' },
          ],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Wait until safety metrics recover',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName: safetyMemberName,
        memberNames: [safetyMemberName, memberName],
        metricKinds: ['would_nudge', 'fingerprint_changed', 'report_rejected'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: {
            state: 'blocked',
            reasons: expect.arrayContaining([
              'would_nudge_rate_high',
              'fingerprint_churn_high',
              'report_rejection_rate_high',
            ]),
          },
          recentEvents: expect.arrayContaining([
            expect.objectContaining({
              memberName: safetyMemberName,
              kind: 'report_rejected',
            }),
          ]),
        });
        await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual(
          []
        );
        await expect(
          readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        ).resolves.toEqual({});
      });

      const blockedJournal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      const plannerBlock = blockedJournal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.source === 'nudge_planner' && event.reason === 'blocking_metrics');
      expect(plannerBlock).toMatchObject({
        event: 'nudge_skipped',
        diagnostics: expect.arrayContaining([
          'delivery_readiness:would_nudge_rate_high',
          'delivery_readiness:fingerprint_churn_high',
          'delivery_readiness:report_rejection_rate_high',
        ]),
        metadata: expect.objectContaining({
          deliveryReadinessState: 'blocked',
          deliveryReadinessReasons: expect.stringContaining('report_rejection_rate_high'),
          reportRejectionRate: 1,
          maxReportRejectionRate: 0.2,
        }),
      });

      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics().reconciled).toBeGreaterThanOrEqual(2);
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      });
    } finally {
      await feature.dispose();
    }
  });

  it('recovers a safety-blocked queued nudge after metrics clear and the feature restarts', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-report-rejection-dispatch';
    const memberName = 'bob';
    let canDispatchNudges = false;
    const createFeature = () =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Keep unsafe report recovery queued',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges: vi.fn(async () => canDispatchNudges),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();

    try {
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending' })]);
      });

      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed', 'report_rejected'],
      });
      canDispatchNudges = true;

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        superseded: 0,
        retryable: 1,
        terminal: 0,
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining([
            'would_nudge_rate_high',
            'fingerprint_churn_high',
            'report_rejection_rate_high',
          ]),
        },
      });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'failed_retryable',
          lastError: 'blocking_metrics',
        }),
      ]);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      const dispatcherBlock = journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(
          (event) => event.source === 'nudge_dispatcher' && event.reason === 'blocking_metrics'
        );
      expect(dispatcherBlock).toMatchObject({
        event: 'nudge_skipped',
        diagnostics: expect.arrayContaining([
          'delivery_readiness:would_nudge_rate_high',
          'delivery_readiness:fingerprint_churn_high',
          'delivery_readiness:report_rejection_rate_high',
        ]),
        metadata: expect.objectContaining({
          deliveryReadinessReasons: expect.stringContaining('report_rejection_rate_high'),
          reportRejectionRate: 1,
          maxReportRejectionRate: 0.2,
        }),
      });
      expect(journal).not.toContain('"event":"nudge_delivered"');

      await feature.dispose();
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      await forceRetryableOutboxDue({
        teamsBasePath,
        teamName,
        memberName,
        nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      });
      feature = createFeature();
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'shadow_ready',
          reasons: [],
        },
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      const recoveredJournal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(recoveredJournal).toContain('"event":"nudge_delivered"');
    } finally {
      await feature.dispose();
    }
  });

  it('repairs a missing outbox index and recovers persisted noisy delivery after restart', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-scheduled-noisy-recovery';
    const memberName = 'bob';
    let canDispatchNudges = false;
    const listLifecycleActiveTeamNames = vi.fn(async () => [' ', teamName, teamName]);
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Recover through the persisted scheduled path',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges: vi.fn(async () => canDispatchNudges),
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending' })]);
      });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);

      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed', 'report_rejected'],
      });
      await feature.dispose();

      const outboxIndexPath = path.join(
        teamsBasePath,
        teamName,
        '.member-work-sync',
        'indexes',
        'outbox-index.json'
      );
      await fs.promises.rm(outboxIndexPath, { force: true });
      await expect(fs.promises.readFile(outboxIndexPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      canDispatchNudges = true;
      vi.useFakeTimers();
      usesFakeTimers = true;
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining([
            'would_nudge_rate_high',
            'fingerprint_churn_high',
            'report_rejection_rate_high',
          ]),
        },
      });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
      const [blockedOutboxItem] = Object.values(
        await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      );
      expect(blockedOutboxItem).toMatchObject({
        status: 'failed_retryable',
        lastError: 'blocking_metrics',
        nextAttemptAt: expect.any(String),
      });
      const repairedBlockedIndex = JSON.parse(
        await fs.promises.readFile(outboxIndexPath, 'utf8')
      ) as {
        items?: Record<string, { memberName?: string; status?: string; nextAttemptAt?: string }>;
      };
      expect(Object.values(repairedBlockedIndex.items ?? {})).toEqual([
        expect.objectContaining({
          memberName,
          status: 'failed_retryable',
          nextAttemptAt: blockedOutboxItem!.nextAttemptAt,
        }),
      ]);

      vi.setSystemTime(new Date(Date.parse(blockedOutboxItem!.nextAttemptAt!) + 1_000));
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          deliveredMessageId: expect.any(String),
        }),
      ]);
      const repairedDeliveredIndex = JSON.parse(
        await fs.promises.readFile(outboxIndexPath, 'utf8')
      ) as {
        items?: Record<string, { memberName?: string; status?: string }>;
      };
      expect(Object.values(repairedDeliveredIndex.items ?? {})).toEqual([
        expect.objectContaining({
          memberName,
          status: 'delivered',
        }),
      ]);
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(2);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"reason":"blocking_metrics"');
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event?: string })
          .filter((event) => event.event === 'nudge_delivered')
      ).toHaveLength(1);
    } finally {
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('quarantines corrupt metrics and still delivers a persisted OpenCode nudge after restart', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-corrupt-metrics-recovery';
    const memberName = 'bob';
    let canDispatchNudges = false;
    const listLifecycleActiveTeamNames = vi.fn(async () => [teamName]);
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'opencode' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Recover after telemetry corruption',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges: vi.fn(async () => canDispatchNudges),
        nudgeDeliveryWake,
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending' })]);
      });
      await feature.dispose();

      const metricsPath = path.join(
        teamsBasePath,
        teamName,
        '.member-work-sync',
        'indexes',
        'metrics.json'
      );
      await fs.promises.writeFile(metricsPath, '{corrupt telemetry', 'utf8');

      canDispatchNudges = true;
      vi.useFakeTimers();
      usesFakeTimers = true;
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      const metricsDirectoryEntries = await fs.promises.readdir(path.dirname(metricsPath));
      expect(
        metricsDirectoryEntries.some((entry) => entry.startsWith('metrics.json.invalid.'))
      ).toBe(true);
      const repairedMetricsFile = JSON.parse(await fs.promises.readFile(metricsPath, 'utf8')) as {
        schemaVersion?: number;
        members?: Record<string, { memberName?: string; providerId?: string }>;
        recentEvents?: unknown[];
      };
      expect(repairedMetricsFile).toMatchObject({
        schemaVersion: 2,
        members: {
          [memberName]: {
            memberName,
            providerId: 'opencode',
          },
        },
      });
      expect(repairedMetricsFile.recentEvents?.length).toBeGreaterThan(0);
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'collecting_shadow_data',
          reasons: expect.arrayContaining([
            'insufficient_status_events',
            'insufficient_observation_window',
          ]),
        },
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          deliveredMessageId: expect.any(String),
        }),
      ]);
      expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
      expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName,
          memberName,
          providerId: 'opencode',
          reason: 'member_work_sync_nudge_inserted',
        })
      );
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(1);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"blocking_metrics"');
    } finally {
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('isolates a scheduled readiness failure to one team and recovers it on restart', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const failingTeamName = 'team-readiness-failure';
    const healthyTeamName = 'team-readiness-healthy';
    const memberName = 'bob';
    const tasksByTeam = {
      [failingTeamName]: {
        id: 'task-failing',
        displayId: '11111111',
        subject: 'Recover after readiness failure',
        status: 'pending',
        owner: memberName,
      },
      [healthyTeamName]: {
        id: 'task-healthy',
        displayId: '22222222',
        subject: 'Deliver despite peer readiness failure',
        status: 'pending',
        owner: memberName,
      },
    };
    let readinessMode: 'hold' | 'fail-first' | 'ready' = 'hold';
    const canDispatchNudges = vi.fn(async (teamName: string) => {
      if (readinessMode === 'hold') {
        return false;
      }
      if (readinessMode === 'fail-first' && teamName === failingTeamName) {
        throw new Error('readiness unavailable');
      }
      return true;
    });
    const listLifecycleActiveTeamNames = vi.fn(async () => [failingTeamName, healthyTeamName]);
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async (teamName: string) => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async (teamName: string) => {
            const task = tasksByTeam[teamName as keyof typeof tasksByTeam];
            return task ? [task] : [];
          }),
        } as never,
        kanbanManager: {
          getState: vi.fn(async (teamName: string) => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges,
        logger,
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName: failingTeamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName: healthyTeamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({
        type: 'task',
        teamName: failingTeamName,
        taskId: tasksByTeam[failingTeamName].id,
      } as never);
      feature.noteTeamChange({
        type: 'task',
        teamName: healthyTeamName,
        taskId: tasksByTeam[healthyTeamName].id,
      } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics().reconciled).toBeGreaterThanOrEqual(2);
        for (const teamName of [failingTeamName, healthyTeamName]) {
          expect(
            Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
          ).toEqual([expect.objectContaining({ status: 'pending' })]);
        }
      });
      await feature.dispose();

      canDispatchNudges.mockClear();
      readinessMode = 'fail-first';
      vi.useFakeTimers();
      usesFakeTimers = true;
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      await expect(
        readInboxMessages({ teamsBasePath, teamName: failingTeamName, memberName })
      ).resolves.toEqual([]);
      expect(
        Object.values(
          await readMemberOutboxItems({
            teamsBasePath,
            teamName: failingTeamName,
            memberName,
          })
        )
      ).toEqual([expect.objectContaining({ status: 'pending' })]);
      expect(
        (
          await readInboxMessages({
            teamsBasePath,
            teamName: healthyTeamName,
            memberName,
          })
        ).filter((message) => message.messageKind === 'member_work_sync_nudge')
      ).toHaveLength(1);
      expect(
        Object.values(
          await readMemberOutboxItems({
            teamsBasePath,
            teamName: healthyTeamName,
            memberName,
          })
        )
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      expect(logger.warn).toHaveBeenCalledWith(
        'member work sync nudge dispatch readiness check failed',
        {
          teamName: failingTeamName,
          error: 'Error: readiness unavailable',
        }
      );

      readinessMode = 'ready';
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      for (const teamName of [failingTeamName, healthyTeamName]) {
        expect(
          (
            await readInboxMessages({
              teamsBasePath,
              teamName,
              memberName,
            })
          ).filter((message) => message.messageKind === 'member_work_sync_nudge')
        ).toHaveLength(1);
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'delivered' })]);
        const journal = await fs.promises.readFile(
          path.join(
            teamsBasePath,
            teamName,
            'members',
            memberName,
            '.member-work-sync',
            'journal.jsonl'
          ),
          'utf8'
        );
        expect(journal).not.toContain('"reason":"blocking_metrics"');
        expect(
          journal
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event?: string })
            .filter((event) => event.event === 'nudge_delivered')
        ).toHaveLength(1);
      }
      expect(canDispatchNudges.mock.calls).toEqual([
        [failingTeamName],
        [healthyTeamName],
        [failingTeamName],
        [healthyTeamName],
      ]);
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(2);
    } finally {
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('drains an in-flight scheduled dispatch during dispose without orphaning the claim', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-dispose-in-flight';
    const memberName = 'bob';
    let canDispatchNudges = false;
    let activeBusyGate: Promise<void> | null = null;
    const busyGateControl: { release: (() => void) | null } = { release: null };
    let notifyBusySignalStarted: (() => void) | null = null;
    const slowBusySignal = {
      isBusy: vi.fn(async () => {
        const gate = activeBusyGate;
        if (gate) {
          notifyBusySignalStarted?.();
          await gate;
          if (activeBusyGate === gate) {
            activeBusyGate = null;
          }
        }
        return { busy: false };
      }),
    };
    const listLifecycleActiveTeamNames = vi.fn(async () => [teamName]);
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Finish delivery during graceful shutdown',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges: vi.fn(async () => canDispatchNudges),
        extraBusySignals: [slowBusySignal],
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending', attemptGeneration: 0 })]);
      });
      await feature.dispose();

      activeBusyGate = new Promise<void>((resolve) => {
        busyGateControl.release = resolve;
      });
      let signalBusyCheckStarted!: () => void;
      const busyCheckStarted = new Promise<void>((resolve) => {
        signalBusyCheckStarted = resolve;
      });
      notifyBusySignalStarted = signalBusyCheckStarted;
      canDispatchNudges = true;
      vi.useFakeTimers();
      usesFakeTimers = true;
      feature = createFeature(true);

      const scheduledTick = vi.advanceTimersByTimeAsync(60_000);
      await busyCheckStarted;

      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'claimed',
          attemptGeneration: 1,
          claimedBy: expect.stringContaining(':scheduled'),
        }),
      ]);
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);

      let disposeSettled = false;
      const dispose = feature.dispose().then(() => {
        disposeSettled = true;
      });
      await Promise.resolve();
      expect(disposeSettled).toBe(false);

      busyGateControl.release?.();
      busyGateControl.release = null;
      await Promise.all([scheduledTick, dispose]);
      expect(disposeSettled).toBe(true);

      expect(
        (
          await readInboxMessages({
            teamsBasePath,
            teamName,
            memberName,
          })
        ).filter((message) => message.messageKind === 'member_work_sync_nudge')
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          attemptGeneration: 1,
          deliveredMessageId: expect.any(String),
        }),
      ]);

      notifyBusySignalStarted = null;
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      expect(
        (
          await readInboxMessages({
            teamsBasePath,
            teamName,
            memberName,
          })
        ).filter((message) => message.messageKind === 'member_work_sync_nudge')
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          attemptGeneration: 1,
        }),
      ]);
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event?: string })
          .filter((event) => event.event === 'nudge_delivered')
      ).toHaveLength(1);
      expect(journal).not.toContain('"reason":"blocking_metrics"');
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(2);
    } finally {
      busyGateControl.release?.();
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('cancels timed-out scheduled readiness before it can late-dispatch after dispose', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-readiness-timeout-cancel';
    const memberName = 'bob';
    let readinessMode: 'blocked' | 'hold' | 'ready' = 'blocked';
    const readinessGateControl: { release: (() => void) | null } = { release: null };
    let notifyReadinessStarted: (() => void) | null = null;
    let notifyReadinessFinished: (() => void) | null = null;
    const canDispatchNudges = vi.fn(async () => {
      if (readinessMode === 'blocked') {
        return false;
      }
      if (readinessMode === 'ready') {
        return true;
      }

      notifyReadinessStarted?.();
      try {
        return await new Promise<boolean>((resolve) => {
          readinessGateControl.release = () => resolve(true);
        });
      } finally {
        notifyReadinessFinished?.();
      }
    });
    const listLifecycleActiveTeamNames = vi.fn(async () => [teamName]);
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Do not dispatch after a timed-out readiness check',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges,
        logger,
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending', attemptGeneration: 0 })]);
      });
      await feature.dispose();

      let signalReadinessStarted!: () => void;
      const readinessStarted = new Promise<void>((resolve) => {
        signalReadinessStarted = resolve;
      });
      let signalReadinessFinished!: () => void;
      const readinessFinished = new Promise<void>((resolve) => {
        signalReadinessFinished = resolve;
      });
      notifyReadinessStarted = signalReadinessStarted;
      notifyReadinessFinished = signalReadinessFinished;
      readinessMode = 'hold';
      canDispatchNudges.mockClear();
      vi.useFakeTimers();
      usesFakeTimers = true;
      feature = createFeature(true);

      await vi.advanceTimersByTimeAsync(60_000);
      await readinessStarted;
      await vi.advanceTimersByTimeAsync(120_000);

      let disposeSettled = false;
      const dispose = feature.dispose().then(() => {
        disposeSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(disposeSettled).toBe(false);

      expect(logger.warn).toHaveBeenCalledWith('member work sync scheduled nudge dispatch failed', {
        error: 'Error: member work sync scheduled nudge dispatch timed out after 120000ms',
      });
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([expect.objectContaining({ status: 'pending', attemptGeneration: 0 })]);
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);

      readinessGateControl.release?.();
      readinessGateControl.release = null;
      await readinessFinished;
      await dispose;
      expect(disposeSettled).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([expect.objectContaining({ status: 'pending', attemptGeneration: 0 })]);
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);

      readinessMode = 'ready';
      notifyReadinessStarted = null;
      notifyReadinessFinished = null;
      feature = createFeature();
      await expect(feature.dispatchDueNudges([teamName])).resolves.toMatchObject({
        claimed: 1,
        delivered: 1,
        retryable: 0,
      });

      expect(
        (
          await readInboxMessages({
            teamsBasePath,
            teamName,
            memberName,
          })
        ).filter((message) => message.messageKind === 'member_work_sync_nudge')
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          attemptGeneration: 1,
          deliveredMessageId: expect.any(String),
        }),
      ]);
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event?: string })
          .filter((event) => event.event === 'nudge_delivered')
      ).toHaveLength(1);
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(1);
    } finally {
      readinessGateControl.release?.();
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('cancels a timed-out claimed dispatch and recovers it once after lease expiry', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-claimed-timeout-cancel';
    const memberName = 'bob';
    let canDispatchNudges = false;
    let activeBusyGate: Promise<void> | null = null;
    const busyGateControl: { release: (() => void) | null } = { release: null };
    let notifyBusySignalStarted: (() => void) | null = null;
    let notifyBusySignalFinished: (() => void) | null = null;
    const slowBusySignal = {
      isBusy: vi.fn(async () => {
        const gate = activeBusyGate;
        if (gate) {
          notifyBusySignalStarted?.();
          try {
            await gate;
          } finally {
            notifyBusySignalFinished?.();
          }
          if (activeBusyGate === gate) {
            activeBusyGate = null;
          }
        }
        return { busy: false };
      }),
    };
    const listLifecycleActiveTeamNames = vi.fn(async () => [teamName]);
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Recover a claimed item after scheduled timeout',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges: vi.fn(async () => canDispatchNudges),
        extraBusySignals: [slowBusySignal],
        logger,
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending', attemptGeneration: 0 })]);
      });
      await feature.dispose();

      activeBusyGate = new Promise<void>((resolve) => {
        busyGateControl.release = resolve;
      });
      let signalBusyCheckStarted!: () => void;
      const busyCheckStarted = new Promise<void>((resolve) => {
        signalBusyCheckStarted = resolve;
      });
      let signalBusyCheckFinished!: () => void;
      const busyCheckFinished = new Promise<void>((resolve) => {
        signalBusyCheckFinished = resolve;
      });
      notifyBusySignalStarted = signalBusyCheckStarted;
      notifyBusySignalFinished = signalBusyCheckFinished;
      canDispatchNudges = true;
      vi.useFakeTimers();
      usesFakeTimers = true;
      feature = createFeature(true);

      await vi.advanceTimersByTimeAsync(60_000);
      await busyCheckStarted;
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'claimed',
          attemptGeneration: 1,
          claimedBy: expect.stringContaining(':scheduled'),
          claimedAt: expect.any(String),
        }),
      ]);

      await vi.advanceTimersByTimeAsync(120_000);

      const dispose = feature.dispose();
      expect(logger.warn).toHaveBeenCalledWith('member work sync scheduled nudge dispatch failed', {
        error: 'Error: member work sync scheduled nudge dispatch timed out after 120000ms',
      });

      busyGateControl.release?.();
      busyGateControl.release = null;
      await busyCheckFinished;
      await dispose;
      await vi.advanceTimersByTimeAsync(0);

      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'claimed',
          attemptGeneration: 1,
          claimedBy: expect.stringContaining(':scheduled'),
        }),
      ]);
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);

      notifyBusySignalStarted = null;
      notifyBusySignalFinished = null;
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
      feature = createFeature();
      await expect(feature.dispatchDueNudges([teamName])).resolves.toMatchObject({
        claimed: 1,
        delivered: 1,
        retryable: 0,
      });

      expect(
        (
          await readInboxMessages({
            teamsBasePath,
            teamName,
            memberName,
          })
        ).filter((message) => message.messageKind === 'member_work_sync_nudge')
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          attemptGeneration: 2,
          deliveredMessageId: expect.any(String),
        }),
      ]);
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event?: string })
          .filter((event) => event.event === 'nudge_delivered')
      ).toHaveLength(1);
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(1);
    } finally {
      busyGateControl.release?.();
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('recovers a stale crash claim without stealing its active lease or duplicating delivery', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-stale-crash-claim';
    const memberName = 'bob';
    let canDispatchNudges = false;
    const listLifecycleActiveTeamNames = vi.fn(async () => [teamName]);
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Recover a nudge claimed by a crashed process',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges: vi.fn(async () => canDispatchNudges),
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending', attemptGeneration: 0 })]);
      });

      const crashedClaimedAt = new Date().toISOString();
      const crashStore = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      const [crashClaim] = await crashStore.claimDue({
        teamName,
        claimedBy: 'crashed-process',
        nowIso: crashedClaimedAt,
        limit: 1,
      });
      expect(crashClaim).toMatchObject({
        status: 'claimed',
        attemptGeneration: 1,
        claimedBy: 'crashed-process',
        claimedAt: crashedClaimedAt,
      });
      await feature.dispose();

      canDispatchNudges = true;
      vi.useFakeTimers();
      usesFakeTimers = true;
      vi.setSystemTime(new Date(crashedClaimedAt));
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'claimed',
          attemptGeneration: 1,
          claimedBy: 'crashed-process',
          claimedAt: crashedClaimedAt,
        }),
      ]);

      vi.setSystemTime(new Date(Date.parse(crashedClaimedAt) + 5 * 60_000));
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
      const [recoveredOutboxItem] = Object.values(
        await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      );
      expect(recoveredOutboxItem).toEqual(
        expect.objectContaining({
          status: 'delivered',
          attemptGeneration: 2,
          claimedBy: expect.stringContaining(':scheduled'),
          deliveredMessageId: expect.any(String),
        })
      );
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(2);

      const lateWriteAt = new Date(Date.now() + 1_000).toISOString();
      await crashStore.markFailed({
        teamName,
        id: crashClaim!.id,
        attemptGeneration: crashClaim!.attemptGeneration,
        retryable: true,
        error: 'late_crashed_attempt_failure',
        nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        nowIso: lateWriteAt,
      });
      await crashStore.markDelivered({
        teamName,
        id: crashClaim!.id,
        attemptGeneration: crashClaim!.attemptGeneration,
        deliveredMessageId: 'late-stale-delivery',
        nowIso: lateWriteAt,
      });
      await crashStore.markSuperseded({
        teamName,
        id: crashClaim!.id,
        reason: 'late_crashed_attempt_superseded',
        nowIso: lateWriteAt,
      });

      const [outboxAfterLateWrites] = Object.values(
        await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      );
      expect(outboxAfterLateWrites).toMatchObject({
        status: 'delivered',
        attemptGeneration: 2,
        claimedBy: recoveredOutboxItem!.claimedBy,
        deliveredMessageId: recoveredOutboxItem!.deliveredMessageId,
      });
      expect(outboxAfterLateWrites).not.toHaveProperty('lastError');
      expect(outboxAfterLateWrites).not.toHaveProperty('nextAttemptAt');
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).not.toContain('"reason":"blocking_metrics"');
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event?: string })
          .filter((event) => event.event === 'nudge_delivered')
      ).toHaveLength(1);
    } finally {
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('finalizes a preinserted OpenCode inbox nudge exactly once after a crash', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-preinserted-crash-recovery';
    const memberName = 'bob';
    let canDispatchNudges = false;
    const listLifecycleActiveTeamNames = vi.fn(async () => [teamName]);
    const nudgeDeliveryWake = {
      schedule: vi.fn(async () => undefined),
    };
    const createFeature = (withScheduler = false) =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'opencode' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Finalize delivery after inbox persistence',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        canDispatchNudges: vi.fn(async () => canDispatchNudges),
        nudgeDeliveryWake,
        ...(withScheduler ? { listLifecycleActiveTeamNames } : {}),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();
    let usesFakeTimers = false;

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'pending', attemptGeneration: 0 })]);
      });

      const crashedClaimedAt = new Date().toISOString();
      const crashStore = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      const [crashClaim] = await crashStore.claimDue({
        teamName,
        claimedBy: 'crashed-after-inbox-insert',
        nowIso: crashedClaimedAt,
        limit: 1,
      });
      expect(crashClaim).toMatchObject({
        status: 'claimed',
        attemptGeneration: 1,
        claimedBy: 'crashed-after-inbox-insert',
      });
      await expect(
        new TeamInboxMemberWorkSyncNudgeSink().insertIfAbsent({
          teamName,
          memberName,
          messageId: crashClaim!.id,
          payloadHash: crashClaim!.payloadHash,
          payload: crashClaim!.payload,
          timestamp: crashedClaimedAt,
        })
      ).resolves.toEqual({
        inserted: true,
        messageId: crashClaim!.id,
      });
      await expect(
        readInboxMessages({ teamsBasePath, teamName, memberName })
      ).resolves.toHaveLength(1);
      expect(nudgeDeliveryWake.schedule).not.toHaveBeenCalled();
      await feature.dispose();

      canDispatchNudges = true;
      vi.useFakeTimers();
      usesFakeTimers = true;
      vi.setSystemTime(new Date(Date.parse(crashedClaimedAt) + 5 * 60_000));
      feature = createFeature(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await feature.dispose();

      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          attemptGeneration: 2,
          deliveredMessageId: crashClaim!.id,
        }),
      ]);
      expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
      expect(nudgeDeliveryWake.schedule).toHaveBeenCalledWith({
        teamName,
        memberName,
        messageId: crashClaim!.id,
        providerId: 'opencode',
        reason: 'member_work_sync_nudge_existing',
        delayMs: 500,
      });
      expect(listLifecycleActiveTeamNames).toHaveBeenCalledTimes(1);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).not.toContain('"reason":"blocking_metrics"');
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event?: string })
          .filter((event) => event.event === 'nudge_delivered')
      ).toHaveLength(1);
    } finally {
      await feature.dispose();
      if (usesFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it('delivers a queued native nudge when another member makes team metrics self-noisy before dispatch', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-cross-member-noise';
    const noisyMemberName = 'alice';
    const targetMemberName = 'bob';
    let canDispatchNudges = false;
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [
            { name: noisyMemberName, providerId: 'codex' },
            { name: targetMemberName, providerId: 'codex' },
          ],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Recover despite noisy peer telemetry',
            status: 'pending',
            owner: targetMemberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      canDispatchNudges: vi.fn(async () => canDispatchNudges),
      queueQuietWindowMs: 1,
    });

    try {
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(
          Object.values(
            await readMemberOutboxItems({
              teamsBasePath,
              teamName,
              memberName: targetMemberName,
            })
          )
        ).toEqual([expect.objectContaining({ status: 'pending' })]);
      });

      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName: noisyMemberName,
        memberNames: [noisyMemberName, targetMemberName],
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
        recentEvents: expect.arrayContaining([
          expect.objectContaining({
            memberName: noisyMemberName,
            kind: 'would_nudge',
          }),
          expect.objectContaining({
            memberName: noisyMemberName,
            kind: 'fingerprint_changed',
          }),
        ]),
      });

      const reconciledBeforeTeamWideRefresh = feature.getQueueDiagnostics().reconciled;
      feature.noteTeamChange({ type: 'config', teamName } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({
          queued: 0,
          running: 0,
        });
        expect(feature.getQueueDiagnostics().reconciled).toBeGreaterThanOrEqual(
          reconciledBeforeTeamWideRefresh + 2
        );
        await expect(
          readMemberOutboxItems({
            teamsBasePath,
            teamName,
            memberName: noisyMemberName,
          })
        ).resolves.toEqual({});
        await expect(
          readInboxMessages({
            teamsBasePath,
            teamName,
            memberName: noisyMemberName,
          })
        ).resolves.toEqual([]);
      });

      canDispatchNudges = true;
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      const targetNudges = (
        await readInboxMessages({
          teamsBasePath,
          teamName,
          memberName: targetMemberName,
        })
      ).filter((message) => message.messageKind === 'member_work_sync_nudge');
      expect(targetNudges).toHaveLength(1);
      expect(targetNudges[0]?.text).toContain('11111111');
      await expect(
        readInboxMessages({
          teamsBasePath,
          teamName,
          memberName: noisyMemberName,
        })
      ).resolves.toEqual([]);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          targetMemberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_delivered"');
      expect(journal).not.toContain('"reason":"blocking_metrics"');
    } finally {
      await feature.dispose();
    }
  });

  it('keeps readiness blockers isolated between teams with the same member name', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const safetyTeamName = 'team-safety-blocked';
    const diagnosticTeamName = 'team-diagnostic-noisy';
    const memberName = 'bob';
    const tasksByTeam = {
      [safetyTeamName]: {
        id: 'task-safety',
        displayId: '11111111',
        subject: 'Wait for safety metrics',
        status: 'pending',
        owner: memberName,
      },
      [diagnosticTeamName]: {
        id: 'task-diagnostic',
        displayId: '22222222',
        subject: 'Recover through diagnostic noise',
        status: 'pending',
        owner: memberName,
      },
    };
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async (requestedTeamName: string) => ({
          name: requestedTeamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async (requestedTeamName: string) => {
          const task = tasksByTeam[requestedTeamName as keyof typeof tasksByTeam];
          return task ? [task] : [];
        }),
      } as never,
      kanbanManager: {
        getState: vi.fn(async (requestedTeamName: string) => ({
          teamName: requestedTeamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName: safetyTeamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed', 'report_rejected'],
      });
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName: diagnosticTeamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });

      feature.noteTeamChange({
        type: 'task',
        teamName: safetyTeamName,
        taskId: tasksByTeam[safetyTeamName].id,
      } as never);
      feature.noteTeamChange({
        type: 'task',
        teamName: diagnosticTeamName,
        taskId: tasksByTeam[diagnosticTeamName].id,
      } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics().reconciled).toBeGreaterThanOrEqual(2);
        await expect(feature.getMetrics({ teamName: safetyTeamName })).resolves.toMatchObject({
          deliveryReadiness: {
            state: 'blocked',
            reasons: expect.arrayContaining([
              'would_nudge_rate_high',
              'fingerprint_churn_high',
              'report_rejection_rate_high',
            ]),
          },
        });
        await expect(feature.getMetrics({ teamName: diagnosticTeamName })).resolves.toMatchObject({
          deliveryReadiness: {
            state: 'blocked',
            reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
          },
        });
        await expect(
          readInboxMessages({
            teamsBasePath,
            teamName: safetyTeamName,
            memberName,
          })
        ).resolves.toEqual([]);
        await expect(
          readMemberOutboxItems({
            teamsBasePath,
            teamName: safetyTeamName,
            memberName,
          })
        ).resolves.toEqual({});

        const diagnosticNudges = (
          await readInboxMessages({
            teamsBasePath,
            teamName: diagnosticTeamName,
            memberName,
          })
        ).filter((message) => message.messageKind === 'member_work_sync_nudge');
        expect(diagnosticNudges).toHaveLength(1);
        expect(diagnosticNudges[0]?.text).toContain('22222222');
        expect(
          Object.values(
            await readMemberOutboxItems({
              teamsBasePath,
              teamName: diagnosticTeamName,
              memberName,
            })
          )
        ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      });
    } finally {
      await feature.dispose();
    }
  });

  it('keeps noisy native recovery idempotent after the feature restarts', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-noisy-restart-idempotency';
    const memberName = 'bob';
    const createFeature = () =>
      createMemberWorkSyncFeature({
        teamsBasePath,
        configReader: {
          getConfig: vi.fn(async () => ({
            name: teamName,
            members: [{ name: memberName, providerId: 'codex' }],
          })),
        } as never,
        taskReader: {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: '11111111',
              subject: 'Do not redeliver after restart',
              status: 'pending',
              owner: memberName,
            },
          ]),
        } as never,
        kanbanManager: {
          getState: vi.fn(async () => ({
            teamName,
            reviewers: [],
            tasks: {},
          })),
        } as never,
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        } as never,
        isTeamActive: vi.fn(async () => true),
        queueQuietWindowMs: 1,
      });
    let feature = createFeature();

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      });

      await feature.dispose();
      feature = createFeature();
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics().reconciled).toBeGreaterThanOrEqual(1);
      });
      await expect(feature.dispatchDueNudges([teamName])).resolves.toMatchObject({
        delivered: 0,
      });

      const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
        (message) => message.messageKind === 'member_work_sync_nudge'
      );
      expect(nudges).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event?: string })
          .filter((event) => event.event === 'nudge_delivered')
      ).toHaveLength(1);
    } finally {
      await feature.dispose();
    }
  });

  it('runs the active bounded loop without duplicate nudges across report and fingerprint changes', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let tasks = [
      {
        id: 'task-1',
        displayId: '11111111',
        subject: 'Ship sync',
        status: 'pending',
        owner: memberName,
      },
    ];
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => tasks),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      let firstStatus = await feature.getStatus({ teamName, memberName });
      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        firstStatus = await feature.getStatus({ teamName, memberName });
        expect(firstStatus).toMatchObject({
          state: 'needs_sync',
          providerId: 'codex',
          shadow: { wouldNudge: true },
        });
        expect(firstStatus.reportToken).toBeTruthy();
      });

      const firstFingerprint = firstStatus.agenda.fingerprint;
      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: firstFingerprint,
          reportToken: firstStatus.reportToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: {
          state: 'still_working',
          report: { accepted: true, state: 'still_working' },
        },
      });

      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      const reconciledBeforeLeaseRefresh = feature.getQueueDiagnostics().reconciled;
      feature.noteTeamChange({ type: 'config', teamName } as never);
      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({
          queued: 0,
          running: 0,
        });
        expect(feature.getQueueDiagnostics().reconciled).toBeGreaterThanOrEqual(
          reconciledBeforeLeaseRefresh + 1
        );
        await expect(feature.getStatus({ teamName, memberName })).resolves.toMatchObject({
          state: 'still_working',
          report: { accepted: true, state: 'still_working' },
        });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      });
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);

      tasks = [
        ...tasks,
        {
          id: 'task-2',
          displayId: '22222222',
          subject: 'Ship follow-up sync',
          status: 'pending',
          owner: memberName,
        },
      ];
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-2' } as never);

      let secondStatus = firstStatus;
      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(2);
        expect(new Set(nudges.map((message) => message.messageId)).size).toBe(2);
        expect(nudges.at(-1)?.text).toContain('22222222');
        secondStatus = await feature.getStatus({ teamName, memberName });
        expect(secondStatus.state).toBe('needs_sync');
        expect(secondStatus.agenda.fingerprint).not.toBe(firstFingerprint);
        expect(secondStatus.shadow).toMatchObject({
          wouldNudge: true,
          fingerprintChanged: true,
          previousFingerprint: firstFingerprint,
        });
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          deliveryReadiness: {
            state: 'blocked',
            reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
          },
        });
      });

      const secondTaskIds = secondStatus.agenda.items.map((item) => item.taskId);
      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: secondStatus.agenda.fingerprint,
          reportToken: secondStatus.reportToken,
          taskIds: secondTaskIds,
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: {
          state: 'still_working',
          report: { accepted: true, taskIds: secondTaskIds },
        },
      });
      await expect(feature.dispatchDueNudges([teamName])).resolves.toMatchObject({
        claimed: 0,
        delivered: 0,
      });

      tasks = tasks.map((task) => ({ ...task, status: 'completed' }));
      const clearedStatus = await feature.refreshStatus({ teamName, memberName });
      expect(clearedStatus).toMatchObject({
        state: 'caught_up',
        agenda: { items: [] },
        shadow: { wouldNudge: false },
      });
      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'caught_up',
          agendaFingerprint: clearedStatus.agenda.fingerprint,
          reportToken: clearedStatus.reportToken,
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: {
          state: 'caught_up',
          report: { accepted: true, state: 'caught_up' },
        },
      });
      await expect(feature.dispatchDueNudges([teamName])).resolves.toMatchObject({
        claimed: 0,
        delivered: 0,
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(2);

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      const events = journal
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event: string }).event);
      expect(events.filter((event) => event === 'nudge_delivered')).toHaveLength(2);
      expect(events.filter((event) => event === 'report_accepted')).toHaveLength(3);
    } finally {
      await feature.dispose();
    }
  });

  it('supersedes stale file-backed nudges and rejects stale reports before accepting the current fingerprint', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let tasks = [
      {
        id: 'task-1',
        displayId: '11111111',
        subject: 'Ship sync',
        status: 'pending',
        owner: memberName,
      },
    ];
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => tasks),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const staleStatus = await feature.refreshStatus({ teamName, memberName });
      expect(staleStatus).toMatchObject({
        state: 'needs_sync',
        shadow: { wouldNudge: true },
      });
      const outboxInput = buildMemberWorkSyncOutboxEnsureInput({
        status: staleStatus,
        hash: new NodeHashAdapter(),
        nowIso: staleStatus.evaluatedAt,
      });
      expect(outboxInput).not.toBeNull();
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await expect(store.ensurePending(outboxInput!)).resolves.toMatchObject({
        ok: true,
        outcome: 'existing',
      });
      const staleOutboxId = `member-work-sync:${teamName}:${memberName}:${staleStatus.agenda.fingerprint}`;
      await expect(
        readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      ).resolves.toMatchObject({
        [staleOutboxId]: { status: 'pending' },
      });

      tasks = tasks.map((task) => ({ ...task, status: 'completed' }));
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        superseded: 1,
        retryable: 0,
        terminal: 0,
      });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
      await expect(
        readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      ).resolves.toMatchObject({
        [staleOutboxId]: {
          status: 'superseded',
          lastError: 'status_no_longer_matches_outbox',
        },
      });

      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: staleStatus.agenda.fingerprint,
          reportToken: staleStatus.reportToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: false,
        code: 'stale_fingerprint',
        status: {
          state: 'caught_up',
          report: {
            accepted: false,
            rejectionCode: 'stale_fingerprint',
          },
        },
      });

      const currentStatus = await feature.getStatus({ teamName, memberName });
      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'caught_up',
          agendaFingerprint: currentStatus.agenda.fingerprint,
          reportToken: currentStatus.reportToken,
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: {
          state: 'caught_up',
          report: { accepted: true, state: 'caught_up' },
        },
      });
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      const events = journal
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event: string }).event);
      expect(events).toContain('nudge_superseded');
      expect(events).toContain('report_rejected');
      expect(events).toContain('report_accepted');
    } finally {
      await feature.dispose();
    }
  });

  it('supersedes pending nudges without delivery when the team becomes inactive', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let teamActive = true;
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync before shutdown',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => teamActive),
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const status = await feature.refreshStatus({ teamName, memberName });
      expect(status).toMatchObject({
        state: 'needs_sync',
        shadow: { wouldNudge: true },
      });
      const outboxInput = buildMemberWorkSyncOutboxEnsureInput({
        status,
        hash: new NodeHashAdapter(),
        nowIso: status.evaluatedAt,
      });
      expect(outboxInput).not.toBeNull();
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await expect(store.ensurePending(outboxInput!)).resolves.toMatchObject({
        ok: true,
        outcome: 'existing',
      });

      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      teamActive = false;
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        superseded: 1,
        retryable: 0,
        terminal: 0,
      });
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual([]);
      await expect(
        readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      ).resolves.toMatchObject({
        [outboxInput!.id]: {
          status: 'superseded',
          lastError: 'team_inactive',
        },
      });

      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_superseded"');
      expect(journal).toContain('"reason":"team_inactive"');
      expect(journal).not.toContain('"event":"nudge_delivered"');
    } finally {
      await feature.dispose();
    }
  });

  it('replays legacy controller pending report intents through the real app validator', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync after offline report',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
    });

    try {
      const status = await feature.refreshStatus({ teamName, memberName });
      expect(status).toMatchObject({
        state: 'needs_sync',
        agenda: { items: [expect.objectContaining({ taskId: 'task-1' })] },
      });
      expect(status.reportToken).toBeTruthy();

      const legacyIntentPath = path.join(
        teamsBasePath,
        teamName,
        '.member-work-sync',
        'pending-reports.json'
      );
      const intentId = 'legacy-intent-1';
      await fs.promises.mkdir(path.dirname(legacyIntentPath), { recursive: true });
      await fs.promises.writeFile(
        legacyIntentPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            intents: {
              [intentId]: {
                id: intentId,
                teamName,
                memberName,
                status: 'pending',
                reason: 'control_api_unavailable',
                recordedAt: '2026-05-05T12:00:00.000Z',
                request: {
                  teamName,
                  memberName,
                  state: 'still_working',
                  agendaFingerprint: status.agenda.fingerprint,
                  reportToken: status.reportToken,
                  taskIds: ['task-1'],
                  source: 'mcp',
                },
              },
            },
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(feature.replayPendingReports([teamName])).resolves.toEqual({
        processed: 1,
        accepted: 1,
        rejected: 0,
        superseded: 0,
      });

      const finalStatus = await feature.getStatus({ teamName, memberName });
      expect(finalStatus).toMatchObject({
        state: 'still_working',
        report: {
          accepted: true,
          state: 'still_working',
          taskIds: ['task-1'],
          source: 'mcp',
        },
      });
      const memberReports = JSON.parse(
        await fs.promises.readFile(
          path.join(
            teamsBasePath,
            teamName,
            'members',
            memberName,
            '.member-work-sync',
            'reports.json'
          ),
          'utf8'
        )
      ) as { intents?: Record<string, { status?: string; resultCode?: string }> };
      expect(memberReports.intents?.[intentId]).toMatchObject({
        status: 'accepted',
        resultCode: 'accepted',
      });
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"legacy_fallback_used"');
      expect(journal).toContain('"event":"report_accepted"');
    } finally {
      await feature.dispose();
    }
  });

  it('defers noisy fail-open nudges while a member is busy and recovers on the next agenda change', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let tasks = [
      {
        id: 'task-1',
        displayId: '11111111',
        subject: 'Ship sync while busy',
        status: 'pending',
        owner: memberName,
      },
    ];
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => tasks),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      feature.noteTeamChange({
        type: 'tool-activity',
        teamName,
        detail: JSON.stringify({
          action: 'start',
          activity: {
            memberName,
            toolUseId: 'tool-1',
            toolName: 'bash',
            startedAt: new Date(Date.now()).toISOString(),
            source: 'runtime',
          },
        }),
      } as never);
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual([
          expect.objectContaining({
            status: 'failed_retryable',
            lastError: 'member_busy:active_tool_activity',
          }),
        ]);
      });

      feature.noteTeamChange({
        type: 'tool-activity',
        teamName,
        detail: JSON.stringify({
          action: 'reset',
          memberName,
          toolUseIds: ['tool-1'],
        }),
      } as never);
      tasks = [
        ...tasks,
        {
          id: 'task-2',
          displayId: '22222222',
          subject: 'Ship sync after busy clears',
          status: 'pending',
          owner: memberName,
        },
      ];
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-2' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('22222222');
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'failed_retryable',
              lastError: 'member_busy:active_tool_activity',
            }),
            expect.objectContaining({
              status: 'delivered',
            }),
          ])
        );
      });

      await waitForAssertion(async () => {
        const journal = await fs.promises.readFile(
          path.join(
            teamsBasePath,
            teamName,
            'members',
            memberName,
            '.member-work-sync',
            'journal.jsonl'
          ),
          'utf8'
        );
        expect(journal).toContain('"event":"member_busy"');
        expect(journal).toContain('"event":"nudge_delivered"');
      });
    } finally {
      await feature.dispose();
    }
  });

  it('clears stale retry delay and recovers when tool activity finishes without agenda changes', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const tasks = [
      {
        id: 'task-1',
        displayId: '11111111',
        subject: 'Ship sync after tool finish',
        status: 'pending',
        owner: memberName,
      },
    ];
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => tasks),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({
        type: 'tool-activity',
        teamName,
        detail: JSON.stringify({
          action: 'start',
          activity: {
            memberName,
            toolUseId: 'tool-1',
            toolName: 'bash',
            startedAt: new Date(Date.now()).toISOString(),
            source: 'runtime',
          },
        }),
      } as never);
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual([
          expect.objectContaining({
            status: 'failed_retryable',
            lastError: 'member_busy:active_tool_activity',
            nextAttemptAt: expect.any(String),
          }),
        ]);
      });

      feature.noteTeamChange({
        type: 'tool-activity',
        teamName,
        detail: JSON.stringify({
          action: 'finish',
          memberName,
          toolUseId: 'tool-1',
          finishedAt: new Date(Date.now() - 120_000).toISOString(),
        }),
      } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual([
          expect.objectContaining({
            status: 'delivered',
          }),
        ]);
      });
    } finally {
      await feature.dispose();
    }
  });

  it('rate-limits the noisy fail-open loop after two delivered nudges per member per hour', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let tasks = [
      {
        id: 'task-1',
        displayId: '11111111',
        subject: 'Ship sync first',
        status: 'pending',
        owner: memberName,
      },
    ];
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => tasks),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedMatureBlockingMetrics({
        teamsBasePath,
        teamName,
        memberName,
        metricKinds: ['would_nudge', 'fingerprint_changed'],
      });
      await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
        deliveryReadiness: {
          state: 'blocked',
          reasons: expect.arrayContaining(['would_nudge_rate_high', 'fingerprint_churn_high']),
        },
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
      });

      tasks = [
        ...tasks,
        {
          id: 'task-2',
          displayId: '22222222',
          subject: 'Ship sync second',
          status: 'pending',
          owner: memberName,
        },
      ];
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-2' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(2);
        expect(nudges.at(-1)?.text).toContain('22222222');
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems.filter((item) => item.status === 'delivered')).toHaveLength(2);
      });

      tasks = [
        ...tasks,
        {
          id: 'task-3',
          displayId: '33333333',
          subject: 'Ship sync third',
          status: 'pending',
          owner: memberName,
        },
      ];
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-3' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(2);
        expect(nudges.some((message) => message.text?.includes('33333333'))).toBe(false);
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems.filter((item) => item.status === 'delivered')).toHaveLength(2);
        expect(outboxItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'failed_retryable',
              lastError: 'member_nudge_rate_limited',
            }),
          ])
        );
      });

      await waitForAssertion(async () => {
        const journal = await fs.promises.readFile(
          path.join(
            teamsBasePath,
            teamName,
            'members',
            memberName,
            '.member-work-sync',
            'journal.jsonl'
          ),
          'utf8'
        );
        const events = journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event: string; reason?: string });
        expect(events.filter((event) => event.event === 'nudge_delivered')).toHaveLength(2);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: 'nudge_skipped',
              reason: 'member_nudge_rate_limited',
            }),
          ])
        );
      });
    } finally {
      await feature.dispose();
    }
  });

  it('recovers retryable inbox delivery failures without duplicate nudges', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync after inbox retry',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const inboxPath = path.join(teamsBasePath, teamName, 'inboxes', `${memberName}.json`);
      await fs.promises.mkdir(inboxPath, { recursive: true });

      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(0);
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'failed_retryable',
              lastError: expect.stringMatching(/EISDIR|ENOTDIR|EEXIST/),
            }),
          ])
        );
      });
      await waitForQueueIdle(feature);

      await fs.promises.rm(inboxPath, { recursive: true, force: true });
      await forceRetryableOutboxDue({
        teamsBasePath,
        teamName,
        memberName,
        nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
        (message) => message.messageKind === 'member_work_sync_nudge'
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.text).toContain('11111111');
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: expect.any(String),
          }),
        ])
      );
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"nudge_retryable"');
      expect(journal).toContain('"event":"nudge_delivered"');
    } finally {
      await feature.dispose();
    }
  });

  it('keeps nudges retryable while configured controlUrl is unavailable and delivers after recovery', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-control-url-retry';
    const memberName = 'bob';
    let controlUrl: string | null = null;
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync after control URL recovery',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
      resolveControlUrl: vi.fn(async () => controlUrl),
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(0);
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'failed_retryable',
              lastError: expect.stringContaining('member work sync control URL unavailable'),
            }),
          ])
        );
      });
      await waitForQueueIdle(feature);

      controlUrl = 'http://127.0.0.1:43123';
      await forceRetryableOutboxDue({
        teamsBasePath,
        teamName,
        memberName,
        nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });

      const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
        (message) => message.messageKind === 'member_work_sync_nudge'
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.text).toContain('11111111');
      expect(nudges[0]?.text).toContain('controlUrl "http://127.0.0.1:43123"');
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'delivered',
            deliveredMessageId: expect.any(String),
          }),
        ])
      );
    } finally {
      await feature.dispose();
    }
  });

  it('respects watchdog cooldown and delivers after the retry window is due', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync after watchdog cooldown',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const stallJournalPath = path.join(teamsBasePath, teamName, 'stall-monitor-journal.json');
      await fs.promises.mkdir(path.dirname(stallJournalPath), { recursive: true });
      await fs.promises.writeFile(
        stallJournalPath,
        `${JSON.stringify([
          {
            taskId: 'task-1',
            state: 'alerted',
            alertedAt: new Date().toISOString(),
          },
        ])}\n`,
        'utf8'
      );

      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(0);
        const outboxItems = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(outboxItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'failed_retryable',
              lastError: 'watchdog_cooldown_active',
            }),
          ])
        );
      });
      await waitForQueueIdle(feature);

      await fs.promises.writeFile(
        stallJournalPath,
        `${JSON.stringify([
          {
            taskId: 'task-1',
            state: 'alerted',
            alertedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
          },
        ])}\n`,
        'utf8'
      );
      await forceRetryableOutboxDue({
        teamsBasePath,
        teamName,
        memberName,
        nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
        (message) => message.messageKind === 'member_work_sync_nudge'
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.text).toContain('11111111');
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"watchdog_cooldown_active"');
      expect(journal).toContain('"reason":"watchdog_cooldown_active"');
      expect(journal).toContain('"event":"nudge_delivered"');
    } finally {
      await feature.dispose();
    }
  });

  it('supersedes retryable nudges when the member reports before retry delivery', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync without stale retry',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      queueQuietWindowMs: 1,
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const stallJournalPath = path.join(teamsBasePath, teamName, 'stall-monitor-journal.json');
      await fs.promises.mkdir(path.dirname(stallJournalPath), { recursive: true });
      await fs.promises.writeFile(
        stallJournalPath,
        `${JSON.stringify([
          {
            taskId: 'task-1',
            state: 'alerted',
            alertedAt: new Date().toISOString(),
          },
        ])}\n`,
        'utf8'
      );

      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      let status = await feature.getStatus({ teamName, memberName });
      await waitForAssertion(async () => {
        status = await feature.getStatus({ teamName, memberName });
        expect(status).toMatchObject({
          state: 'needs_sync',
          shadow: { wouldNudge: true },
        });
        expect(status.reportToken).toBeTruthy();
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(0);
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'failed_retryable',
              lastError: 'watchdog_cooldown_active',
            }),
          ])
        );
      });
      await waitForQueueIdle(feature);

      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: status.agenda.fingerprint,
          reportToken: status.reportToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: { state: 'still_working', report: { accepted: true } },
      });
      await forceRetryableOutboxDue({
        teamsBasePath,
        teamName,
        memberName,
        nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        superseded: 1,
        retryable: 0,
        terminal: 0,
      });
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(0);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'superseded',
            lastError: 'status_no_longer_matches_outbox',
          }),
        ])
      );
      const journal = await fs.promises.readFile(
        path.join(
          teamsBasePath,
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'journal.jsonl'
        ),
        'utf8'
      );
      expect(journal).toContain('"event":"watchdog_cooldown_active"');
      expect(journal).toContain('"event":"report_accepted"');
      expect(journal).toContain('"event":"nudge_superseded"');
      expect(journal).not.toContain('"event":"nudge_delivered"');
    } finally {
      await feature.dispose();
    }
  });

  it('refreshes an expired still_working lease during nudge dispatch without a status read', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Wake after lease expiry',
            status: 'in_progress',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      canDispatchNudges: vi.fn(async () => true),
    });

    try {
      await seedBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      const current = await feature.refreshStatus({ teamName, memberName });
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toEqual([expect.objectContaining({ status: 'pending' })]);

      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: current.agenda.fingerprint,
          reportToken: current.reportToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: { state: 'still_working', report: { accepted: true } },
      });

      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      const acceptedStatus = await store.read({ teamName, memberName });
      expect(acceptedStatus?.report?.accepted).toBe(true);
      const expiredReportedAt = new Date(Date.now() - 7 * 60_000).toISOString();
      const expiredAt = new Date(Date.now() - 6 * 60_000).toISOString();
      await store.write({
        ...acceptedStatus!,
        evaluatedAt: expiredReportedAt,
        report: {
          ...acceptedStatus!.report!,
          reportedAt: expiredReportedAt,
          expiresAt: expiredAt,
        },
      });
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(1);
    } finally {
      await feature.dispose();
    }
  });

  it('refreshes a legacy still_working report without a lease during nudge dispatch', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Wake after missing lease',
            status: 'in_progress',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      canDispatchNudges: vi.fn(async () => true),
    });

    try {
      await seedBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      const current = await feature.refreshStatus({ teamName, memberName });
      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: current.agenda.fingerprint,
          reportToken: current.reportToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: { state: 'still_working', report: { accepted: true } },
      });

      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      const acceptedStatus = await store.read({ teamName, memberName });
      const legacyReport = { ...acceptedStatus!.report! };
      delete legacyReport.expiresAt;
      await store.write({
        ...acceptedStatus!,
        evaluatedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
        report: legacyReport,
      });
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(1);
    } finally {
      await feature.dispose();
    }
  });

  it('repairs a legacy working status when the stored agenda is empty', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => []),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      canDispatchNudges: vi.fn(async () => true),
    });

    try {
      const current = await feature.refreshStatus({ teamName, memberName });
      expect(current.state).toBe('caught_up');
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await store.write({
        ...current,
        state: 'still_working',
        report: {
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: current.agenda.fingerprint,
          reportedAt: current.evaluatedAt,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          accepted: true,
        },
      });

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      const repaired = await store.read({ teamName, memberName });
      expect(repaired).toMatchObject({
        state: 'caught_up',
        diagnostics: expect.arrayContaining(['agenda_empty']),
      });
      expect(repaired?.report).toBeUndefined();
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(0);
    } finally {
      await feature.dispose();
    }
  });

  it('refreshes stale caught_up status during nudge dispatch when new work appears', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    let tasks: Array<{
      id: string;
      displayId: string;
      subject: string;
      status: 'pending';
      owner: string;
    }> = [];
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => tasks),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      canDispatchNudges: vi.fn(async () => true),
    });

    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      const current = await feature.refreshStatus({ teamName, memberName });
      expect(current.state).toBe('caught_up');
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await store.write({
        ...current,
        evaluatedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
      });
      tasks = [
        {
          id: 'task-1',
          displayId: '11111111',
          subject: 'Wake after missed task event',
          status: 'pending',
          owner: memberName,
        },
      ];

      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
        (message) => message.messageKind === 'member_work_sync_nudge'
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.text).toContain('11111111');
      await expect(store.read({ teamName, memberName })).resolves.toMatchObject({
        state: 'needs_sync',
        agenda: {
          items: [expect.objectContaining({ taskId: 'task-1' })],
        },
      });
    } finally {
      await feature.dispose();
    }
  });

  it('materializes a missing active-member status during nudge dispatch', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Wake after app restart',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
      canDispatchNudges: vi.fn(async () => true),
    });

    try {
      await seedNonBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      await expect(feature.dispatchDueNudges([teamName])).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toHaveLength(1);
      await expect(
        new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath)).read({
          teamName,
          memberName,
        })
      ).resolves.toMatchObject({
        state: 'needs_sync',
        shadow: { triggerReasons: ['startup_scan'] },
      });
    } finally {
      await feature.dispose();
    }
  });

  it('refreshes expired fallback pending report tokens through the real HMAC validator', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-expired-pending-report';
    const memberName = 'bob';
    const storePaths = new MemberWorkSyncStorePaths(teamsBasePath);
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Ship sync after expired fallback report',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
    });

    try {
      const status = await feature.refreshStatus({ teamName, memberName });
      expect(status.reportToken).toBeTruthy();
      const expiredToken = await new HmacMemberWorkSyncReportTokenAdapter(storePaths).create({
        teamName,
        memberName,
        agendaFingerprint: status.agenda.fingerprint,
        issuedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      const store = new JsonMemberWorkSyncStore(storePaths);
      await store.appendPendingReport(
        {
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: status.agenda.fingerprint,
          reportToken: expiredToken.token,
          taskIds: ['task-1'],
          source: 'mcp',
        },
        'control_api_unavailable'
      );

      await expect(feature.replayPendingReports([teamName])).resolves.toEqual({
        processed: 1,
        accepted: 1,
        rejected: 0,
        superseded: 0,
      });

      const finalStatus = await feature.getStatus({ teamName, memberName });
      expect(finalStatus).toMatchObject({
        state: 'still_working',
        report: {
          accepted: true,
          state: 'still_working',
          taskIds: ['task-1'],
          source: 'mcp',
        },
      });
      const memberReports = JSON.parse(
        await fs.promises.readFile(
          path.join(
            teamsBasePath,
            teamName,
            'members',
            memberName,
            '.member-work-sync',
            'reports.json'
          ),
          'utf8'
        )
      ) as {
        intents?: Record<
          string,
          { status?: string; resultCode?: string; request?: { reportToken?: string } }
        >;
      };
      expect(Object.values(memberReports.intents ?? {})).toContainEqual(
        expect.objectContaining({
          status: 'accepted',
          resultCode: 'accepted',
          request: expect.objectContaining({ reportToken: expiredToken.token }),
        })
      );
    } finally {
      await feature.dispose();
    }
  });

  it('returns a reportable status with a token when no stored status exists', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Wake from first status call',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
    });

    try {
      const status = await feature.getStatus({ teamName, memberName });
      expect(status).toMatchObject({
        state: 'needs_sync',
        shadow: { reconciledBy: 'request' },
      });
      expect(status.reportToken).toBeTruthy();

      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: status.agenda.fingerprint,
          reportToken: status.reportToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: { state: 'still_working', report: { accepted: true } },
      });
    } finally {
      await feature.dispose();
    }
  });

  it('refreshes an expired stored report token before returning status to a teammate', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-a';
    const memberName = 'bob';
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Wake with expired token',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => true),
    });

    try {
      const current = await feature.refreshStatus({ teamName, memberName });
      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      const expiredToken = 'wrs:v1.expired-token-for-regression';
      await store.write({
        ...current,
        reportToken: expiredToken,
        reportTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const refreshed = await feature.getStatus({ teamName, memberName });
      expect(refreshed.reportToken).toBeTruthy();
      expect(refreshed.reportToken).not.toBe(expiredToken);
      expect(Date.parse(refreshed.reportTokenExpiresAt ?? '')).toBeGreaterThan(Date.now());

      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: refreshed.agenda.fingerprint,
          reportToken: refreshed.reportToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: true,
        status: { state: 'still_working', report: { accepted: true } },
      });
    } finally {
      await feature.dispose();
    }
  });

  it('refreshes stale needs_sync into inactive after the whole team stops', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-stopped';
    const memberName = 'bob';
    let teamActive = true;
    const feature = createMemberWorkSyncFeature({
      teamsBasePath,
      configReader: {
        getConfig: vi.fn(async () => ({
          name: teamName,
          members: [{ name: memberName, providerId: 'codex' }],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => [
          {
            id: 'task-1',
            displayId: '11111111',
            subject: 'Finish work after sleep',
            status: 'pending',
            owner: memberName,
          },
        ]),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({
          teamName,
          reviewers: [],
          tasks: {},
        })),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      isTeamActive: vi.fn(async () => teamActive),
      canDispatchNudges: vi.fn(async () => teamActive),
    });

    try {
      const current = await feature.refreshStatus({ teamName, memberName });
      expect(current.state).toBe('needs_sync');

      const store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(teamsBasePath));
      await store.write({
        ...current,
        evaluatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });
      teamActive = false;

      await expect(feature.getStatus({ teamName, memberName })).resolves.toMatchObject({
        state: 'inactive',
        diagnostics: expect.arrayContaining(['team_runtime_inactive']),
        shadow: { reconciledBy: 'request', triggerReasons: ['manual_refresh'] },
      });
    } finally {
      await feature.dispose();
    }
  });

  it('uses snapshot config reads for startup roster materialization', async () => {
    const getConfig = vi.fn(async () => ({ members: [] }));
    const getConfigSnapshot = vi.fn(async () => ({
      members: [{ name: 'alice' }],
    }));
    const feature = createMemberWorkSyncFeature({
      teamsBasePath: makeTempRoot(),
      configReader: {
        getConfig,
        getConfigSnapshot,
      } as never,
      taskReader: {} as never,
      kanbanManager: {} as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
    });

    try {
      await feature.enqueueStartupScan(['my-team']);
      expect(getConfigSnapshot).toHaveBeenCalledWith('my-team');
      expect(getConfig).not.toHaveBeenCalled();
    } finally {
      await feature.dispose();
    }
  });

  it('builds Claude Stop hook settings with nudges active by default', async () => {
    const root = makeTempRoot();
    const feature = createMemberWorkSyncFeature({
      teamsBasePath: root,
      configReader: {} as never,
      taskReader: {} as never,
      kanbanManager: {} as never,
      membersMetaStore: {} as never,
    });

    try {
      const settings = await feature.buildRuntimeTurnSettledHookSettings({ provider: 'claude' });
      expect(settings).toMatchObject({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: expect.stringContaining('agent-teams:member-work-sync-turn-settled:v1'),
                },
              ],
            },
          ],
        },
      });
      await expect(
        fs.promises.stat(
          path.join(root, '.member-work-sync/runtime-hooks/bin/turn-settled-hook-v1.sh')
        )
      ).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await feature.dispose();
    }
  });

  it('builds Codex turn-settled environment with nudges active by default', async () => {
    const root = makeTempRoot();
    const feature = createMemberWorkSyncFeature({
      teamsBasePath: root,
      configReader: {} as never,
      taskReader: {} as never,
      kanbanManager: {} as never,
      membersMetaStore: {} as never,
    });

    try {
      const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'codex' });
      expect(env).toEqual({
        [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: path.join(root, '.member-work-sync/runtime-hooks'),
      });
      await expect(
        fs.promises.stat(path.join(root, '.member-work-sync/runtime-hooks/incoming'))
      ).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await feature.dispose();
    }
  });

  it('builds OpenCode turn-settled environment with nudges active by default', async () => {
    const root = makeTempRoot();
    const feature = createMemberWorkSyncFeature({
      teamsBasePath: root,
      configReader: {} as never,
      taskReader: {} as never,
      kanbanManager: {} as never,
      membersMetaStore: {} as never,
    });

    try {
      const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' });
      expect(env).toEqual({
        [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: path.join(root, '.member-work-sync/runtime-hooks'),
      });
      await expect(
        fs.promises.stat(path.join(root, '.member-work-sync/runtime-hooks/incoming'))
      ).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await feature.dispose();
    }
  });

  it('builds OpenCode bridge environment before feature facade initialization', async () => {
    const root = makeTempRoot();

    const env = await buildMemberWorkSyncRuntimeTurnSettledEnvironment({
      teamsBasePath: root,
      provider: 'opencode',
    });

    expect(env).toEqual({
      [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: path.join(root, '.member-work-sync/runtime-hooks'),
    });
    await expect(
      fs.promises.stat(path.join(root, '.member-work-sync/runtime-hooks/incoming'))
    ).resolves.toMatchObject({ mode: expect.any(Number) });
  });
});
