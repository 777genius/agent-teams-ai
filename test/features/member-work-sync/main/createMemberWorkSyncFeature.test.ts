import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMemberWorkSyncRuntimeTurnSettledEnvironment,
  createMemberWorkSyncFeature,
} from '@features/member-work-sync/main';
import { buildMemberWorkSyncOutboxEnsureInput } from '@features/member-work-sync/core/domain';
import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { NodeHashAdapter } from '@features/member-work-sync/main/infrastructure/NodeHashAdapter';
import { RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from '@features/member-work-sync/main/infrastructure/runtimeTurnSettledEnvironment';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';

const tempRoots: string[] = [];

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
}): Promise<void> {
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
          {
            id: 'seed-would-nudge-0',
            teamName: input.teamName,
            memberName: input.memberName,
            kind: 'would_nudge',
            state: 'needs_sync',
            agendaFingerprint: 'agenda:v1:seed',
            recordedAt: secondObservedAt,
            actionableCount: 1,
          },
        ],
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
    { status?: string; lastError?: string; nextAttemptAt?: string; deliveredMessageId?: string }
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

describe('createMemberWorkSyncFeature composition', () => {
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
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual(
        []
      );
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
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual(
        []
      );
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
        phase2Readiness: { state: 'shadow_ready' },
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
        outcome: 'created',
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
        claimed: 1,
        delivered: 0,
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
      await expect(readInboxMessages({ teamsBasePath, teamName, memberName })).resolves.toEqual(
        []
      );
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
        outcome: 'created',
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

      await expect(feature.drainRuntimeTurnSettledEvents()).resolves.toMatchObject({
        claimed: 1,
        enqueued: 1,
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
          phase2Readiness: { state: 'collecting_shadow_data' },
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
      expect(journal).not.toContain('"reason":"phase2_not_ready"');
    } finally {
      await feature.dispose();
    }
  });

  it('does not apply the OpenCode shadow-collection exception to Codex members', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-codex-shadow-gated';
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
      queueQuietWindowMs: 1,
    });

    try {
      await seedNonBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);
        expect(await readMemberOutboxItems({ teamsBasePath, teamName, memberName })).toEqual({});
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          phase2Readiness: { state: 'collecting_shadow_data' },
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
      expect(journal).toContain('"event":"nudge_skipped"');
      expect(journal).toContain('"reason":"phase2_not_ready"');
      expect(journal).not.toContain('"event":"nudge_delivered"');
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
          phase2Readiness: {
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

  it('delivers targeted OpenCode nudges even when global phase2 metrics are noisy', async () => {
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
      await seedBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
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
          phase2Readiness: {
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

  it('delivers targeted lead nudges even when global phase2 metrics are noisy', async () => {
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
      await seedBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
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
          phase2Readiness: {
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
      await seedBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges).toHaveLength(1);
        expect(nudgeDeliveryWake.schedule).toHaveBeenCalledTimes(1);
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

  it('keeps nudges gated until shadow readiness is reached, then delivers on the next reconcile', async () => {
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
            subject: 'Ship sync after readiness',
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
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        expect(feature.getQueueDiagnostics()).toMatchObject({ reconciled: 1 });
        expect(await readInboxMessages({ teamsBasePath, teamName, memberName })).toEqual([]);
        expect(await readMemberOutboxItems({ teamsBasePath, teamName, memberName })).toEqual({});
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          phase2Readiness: { state: 'collecting_shadow_data' },
        });
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
        expect(journal).toContain('"event":"nudge_skipped"');
        expect(journal).toContain('"reason":"blocking_metrics"');
      });

      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

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
        outcome: 'created',
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
        outcome: 'created',
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

  it('defers nudges while a member is busy and recovers on the next agenda change', async () => {
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
            startedAt: '2026-05-05T12:00:00.000Z',
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

  it('rate-limits the active loop after two delivered nudges per member per hour', async () => {
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
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
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
