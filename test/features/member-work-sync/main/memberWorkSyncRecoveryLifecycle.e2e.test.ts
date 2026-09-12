import { createMemberWorkSyncFeature } from '@features/member-work-sync/main';
import { RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from '@features/member-work-sync/main/infrastructure/runtimeTurnSettledEnvironment';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOwnedWorkSyncIdentity } from '../helpers/createOwnedWorkSyncIdentity';
import { createTestWorkSyncIdentity } from '../helpers/createTestWorkSyncIdentity';

import type { TeamWorkSyncIdentityAccess } from '@main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-work-sync-lifecycle-'));
  tempRoots.push(root);
  return root;
}

async function writeTeamConfig(
  teamsBasePath: string,
  teamName: string,
  identityId?: string
): Promise<void> {
  const teamRoot = path.join(teamsBasePath, teamName);
  await fs.promises.mkdir(teamRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(teamRoot, 'config.json'),
    JSON.stringify({
      name: teamName,
      ...(identityId ? { _backupIdentityId: identityId } : {}),
    })
  );
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
    `${JSON.stringify({
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
    })}\n`,
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lastError) {
    throw lastError;
  }
  await assertion();
}

async function readInboxMessages(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<Array<{ messageId?: string; messageKind?: string }>> {
  const inboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'inboxes',
    `${input.memberName}.json`
  );
  try {
    const parsed = JSON.parse(await fs.promises.readFile(inboxPath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readMemberOutboxItems(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<Record<string, { status?: string; payload?: { workSyncIntentKey?: string } }>> {
  const outboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'members',
    input.memberName,
    '.member-work-sync',
    'outbox.json'
  );
  try {
    const parsed = JSON.parse(await fs.promises.readFile(outboxPath, 'utf8')) as {
      items?: Record<string, { status?: string; payload?: { workSyncIntentKey?: string } }>;
    };
    return parsed.items ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function createFeature(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  recoveryAllocation?: { enabled: boolean };
  incarnation?: string;
  resolveControlUrl?: () => Promise<string | null>;
  agentType?: string;
  tasks?: Array<{
    id: string;
    displayId: string;
    subject: string;
    status: string;
    owner: string;
  }>;
  priorityBusySignals?: Array<{
    isBusy: (request: {
      teamName: string;
      memberName: string;
      nowIso: string;
    }) => Promise<{ busy: boolean; reason?: string }>;
  }>;
  isMemberActive?: (request: {
    teamName: string;
    memberName: string;
  }) => boolean | Promise<boolean>;
  lifecycleIdentity?: Pick<
    TeamWorkSyncIdentityAccess,
    'readCurrent' | 'adoptLegacy' | 'withCurrent'
  >;
}) {
  const tasks = input.tasks ?? [
    {
      id: 'task-1',
      displayId: '11111111',
      subject: 'Recover stuck work',
      status: 'pending',
      owner: input.memberName,
    },
  ];
  return createMemberWorkSyncFeature({
    lifecycleIdentity: input.lifecycleIdentity ?? createTestWorkSyncIdentity(input.incarnation),
    teamsBasePath: input.teamsBasePath,
    ...(input.recoveryAllocation ? { recoveryAllocation: input.recoveryAllocation } : {}),
    configReader: {
      getConfig: async () => ({
        name: input.teamName,
        members: [
          {
            name: input.memberName,
            providerId: 'codex',
            ...(input.agentType ? { agentType: input.agentType } : {}),
          },
        ],
      }),
    } as never,
    taskReader: {
      getTasks: async () => tasks,
    } as never,
    kanbanManager: {
      getState: async () => ({ teamName: input.teamName, reviewers: [], tasks: {} }),
    } as never,
    membersMetaStore: { getMembers: async () => [] } as never,
    isTeamActive: async () => true,
    ...(input.isMemberActive ? { isMemberActive: input.isMemberActive } : {}),
    ...(input.priorityBusySignals ? { priorityBusySignals: input.priorityBusySignals } : {}),
    queueQuietWindowMs: 1,
    ...(input.resolveControlUrl ? { resolveControlUrl: input.resolveControlUrl } : {}),
  });
}

describe('member work sync recovery lifecycle e2e', () => {
  it('keeps a user stop latch across process restart and does not start automatic recovery', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-stop';
    const memberName = 'bob';
    const first = createFeature({ teamsBasePath, teamName, memberName });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          )
        ).toHaveLength(1);
      });
      await first.stopAutoResume({ teamName, memberName, reason: 'user_stop' });
    } finally {
      await first.dispose();
    }

    const restarted = createFeature({ teamsBasePath, teamName, memberName });
    try {
      restarted.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await restarted.getStatus({ teamName, memberName });
        expect(status.recoveryHealth?.autoResumeStopLatch?.reason).toBe('user_stop');
        expect(status.recoveryHealth?.autoResumeStopLatch?.controlRevision).toBeGreaterThan(0);
      });
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName })).filter(
          (item) => item.payload?.workSyncIntentKey
        )
      ).toEqual([]);
    } finally {
      await restarted.dispose();
    }
  });

  it('does not mint a new recovery ID after unknown delivery when D0 is off', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-unknown';
    const memberName = 'bob';
    const first = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      recoveryAllocation: { enabled: false },
    });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const items = Object.values(
          await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
        );
        expect(items).toEqual([expect.objectContaining({ status: 'delivered' })]);
        expect(items[0]?.payload?.workSyncIntentKey).toBeUndefined();
      });
    } finally {
      await first.dispose();
    }

    const restarted = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      recoveryAllocation: { enabled: false },
    });
    try {
      restarted.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await restarted.getStatus({ teamName, memberName });
        expect(status.state).toBe('needs_sync');
      });
      const items = Object.values(
        await readMemberOutboxItems({ teamsBasePath, teamName, memberName })
      );
      expect(items.filter((item) => item.payload?.workSyncIntentKey)).toEqual([]);
      expect(items).toHaveLength(1);
    } finally {
      await restarted.dispose();
    }
  });

  it('rejects a report token after same-name recreate in the same process (C21/S12)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-recreate';
    const memberName = 'bob';
    const owned = await createOwnedWorkSyncIdentity();
    const identity = owned.identity;
    await writeTeamConfig(teamsBasePath, teamName);
    const feature = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      lifecycleIdentity: identity,
    });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      let firstStatus = await feature.refreshStatus({ teamName, memberName });
      await waitForAssertion(async () => {
        firstStatus = await feature.refreshStatus({ teamName, memberName });
        expect(firstStatus.reportToken).toBeTruthy();
      });
      const firstIdentity = await identity.readCurrent(teamName);
      expect(firstIdentity).toMatchObject({ status: 'identified' });
      if (firstIdentity.status !== 'identified') {
        throw new Error('expected identified lifecycle marker before recreate');
      }
      const firstToken = firstStatus.reportToken;
      const firstFingerprint = firstStatus.agenda.fingerprint;
      expect(firstToken).toBeTruthy();
      await feature.stopAutoResume({ teamName, memberName, reason: 'user_stop' });
      await feature.prepareTeamDeletion(teamName, firstIdentity.identityId);
      feature.completeTeamDeletion(teamName);
      expect(
        fs.existsSync(
          path.join(
            teamsBasePath,
            teamName,
            'members',
            memberName,
            '.member-work-sync',
            'status.json'
          )
        )
      ).toBe(false);

      await writeTeamConfig(teamsBasePath, teamName);
      feature.resumeTeam(teamName);
      feature.noteTeamChange({ type: 'config', teamName, detail: 'config.json' });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      const recreated = await feature.refreshStatus({ teamName, memberName });
      const secondIdentity = await identity.readCurrent(teamName);
      expect(secondIdentity.status).toBe('identified');
      if (secondIdentity.status !== 'identified') {
        throw new Error('expected identified lifecycle marker after recreate');
      }
      expect(secondIdentity.identityId).not.toBe(firstIdentity.identityId);
      expect(recreated.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
      expect(recreated.recoveryHealth?.unresolvedIntentId).toBeUndefined();
      expect(recreated.agenda.fingerprint).toBe(firstFingerprint);
      await expect(
        feature.report({
          teamName,
          memberName,
          state: 'still_working',
          agendaFingerprint: firstFingerprint,
          reportToken: firstToken,
          taskIds: ['task-1'],
          source: 'test',
        })
      ).resolves.toMatchObject({
        accepted: false,
        code: 'invalid_report_token',
      });
    } finally {
      await feature.dispose();
      await owned.dispose();
    }
  });

  it('does not mint a new marker when the backup owner still knows the prior identity', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const owned = await createOwnedWorkSyncIdentity();
    try {
      const teamName = 'team-lifecycle-identity-lost';
      await writeTeamConfig(getTeamsBasePath(), teamName);
      const first = await owned.identity.adoptLegacy(teamName);
      expect(first.status).toBe('identified');
      if (first.status !== 'identified') {
        throw new Error('expected identified lifecycle marker before backup');
      }
      await owned.backup.backupTeam(teamName);
      await writeTeamConfig(getTeamsBasePath(), teamName);
      expect(await owned.identity.adoptLegacy(teamName)).toEqual({
        status: 'unidentified',
        reason: 'identity_lost',
      });
    } finally {
      await owned.dispose();
    }
  });

  it('keeps the same inbox message after crash between write and restart (D01)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-d01';
    const memberName = 'bob';
    const first = createFeature({ teamsBasePath, teamName, memberName });
    let messageIds: Array<string | undefined> = [];
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const messages = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(messages).toHaveLength(1);
        messageIds = messages.map((message) => message.messageId);
      });
    } finally {
      await first.dispose();
    }

    const restarted = createFeature({ teamsBasePath, teamName, memberName });
    try {
      restarted.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const messages = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(messages.map((message) => message.messageId)).toEqual(messageIds);
      });
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName })).filter(
          (item) => item.payload?.workSyncIntentKey
        )
      ).toEqual([]);
    } finally {
      await restarted.dispose();
    }
  });

  it('rejects Continue after user stop across process restart (C14/U04)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-continue-stop';
    const memberName = 'bob';
    const first = createFeature({ teamsBasePath, teamName, memberName });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          )
        ).toHaveLength(1);
      });
      await first.stopAutoResume({ teamName, memberName, reason: 'user_stop' });
      await expect(first.continueManually({ teamName, memberName })).rejects.toThrow(
        'member_stopped'
      );
    } finally {
      await first.dispose();
    }

    const restarted = createFeature({ teamsBasePath, teamName, memberName });
    try {
      await expect(restarted.continueManually({ teamName, memberName })).rejects.toThrow(
        'member_stopped'
      );
      const status = await restarted.getStatus({ teamName, memberName });
      expect(status.recoveryHealth?.autoResumeStopLatch?.reason).toBe('user_stop');
      expect(
        (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        )
      ).toHaveLength(1);
    } finally {
      await restarted.dispose();
    }
  });

  it('repairs the same Continue outbox ID after crash before durable outbox (C20)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-c20';
    const memberName = 'bob';
    const first = createFeature({ teamsBasePath, teamName, memberName });
    let intentId: string | undefined;
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          )
        ).toHaveLength(1);
      });
      const continued = await first.continueManually({
        teamName,
        memberName,
        idempotencyKey: 'c20',
      });
      intentId = continued.recoveryHealth?.unresolvedIntentId;
      expect(intentId).toBeTruthy();
    } finally {
      await first.dispose();
    }

    const outboxPath = path.join(
      teamsBasePath,
      teamName,
      'members',
      memberName,
      '.member-work-sync',
      'outbox.json'
    );
    const persisted = JSON.parse(await fs.promises.readFile(outboxPath, 'utf8')) as {
      items?: Record<string, unknown>;
    };
    expect(persisted.items?.[intentId!]).toBeTruthy();
    delete persisted.items?.[intentId!];
    await fs.promises.writeFile(outboxPath, `${JSON.stringify(persisted)}\n`, 'utf8');

    const restarted = createFeature({ teamsBasePath, teamName, memberName });
    try {
      const repaired = await restarted.continueManually({
        teamName,
        memberName,
        idempotencyKey: 'c20',
      });
      expect(repaired.recoveryHealth?.unresolvedIntentId).toBe(intentId);
      expect(
        Object.keys(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
      ).toContain(intentId);
    } finally {
      await restarted.dispose();
    }
  });

  it('does not start a second turn after crash between spool processed and restart (C48)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-c48';
    const memberName = 'bob';
    const first = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      recoveryAllocation: { enabled: true },
      resolveControlUrl: async () => 'http://127.0.0.1:43123',
    });
    let messageIds: Array<string | undefined> = [];
    let spoolRoot: string | undefined;
    let eventFileName = '';
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          )
        ).toHaveLength(1);
      });
      const env = await first.buildRuntimeTurnSettledEnvironment({ provider: 'codex' });
      spoolRoot = env?.[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV];
      expect(spoolRoot).toBeTruthy();
      eventFileName = '20260505T120001000Z-c48.codex.json';
      await fs.promises.writeFile(
        path.join(spoolRoot!, 'incoming', eventFileName),
        `${JSON.stringify({
          schemaVersion: 1,
          provider: 'codex',
          source: 'agent-teams-orchestrator-codex-native',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          sessionId: 'ses-codex-c48',
          memberName,
          teamName,
          cwd: claudeRoot,
          outcome: 'success',
          recordedAt: '2026-05-05T12:00:01.000Z',
        })}\n`,
        'utf8'
      );
      await expect(first.drainRuntimeTurnSettledEvents()).resolves.toMatchObject({
        invalid: 0,
        unresolved: 0,
      });
      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges.length).toBeGreaterThanOrEqual(2);
        messageIds = nudges.map((message) => message.messageId);
      });
      expect(fs.existsSync(path.join(spoolRoot!, 'processed', `${eventFileName}.meta.json`))).toBe(
        true
      );
    } finally {
      await first.dispose();
    }

    const restarted = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      recoveryAllocation: { enabled: true },
      resolveControlUrl: async () => 'http://127.0.0.1:43123',
    });
    try {
      await expect(restarted.drainRuntimeTurnSettledEvents()).resolves.toMatchObject({
        invalid: 0,
        unresolved: 0,
      });
      restarted.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const nudges = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(nudges.map((message) => message.messageId)).toEqual(messageIds);
      });
    } finally {
      await restarted.dispose();
    }
  });

  it('observes lead-owned work and delivers a nudge for a lead-only team', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-lead';
    const memberName = 'team-lead';
    const feature = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      agentType: 'team-lead',
    });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await feature.getStatus({ teamName, memberName });
        expect(status.agenda.items.some((item) => item.taskId === 'task-1')).toBe(true);
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          )
        ).toHaveLength(1);
      });
    } finally {
      await feature.dispose();
    }
  });

  it('refuses Continue while approval or an active tool is occupying the runtime (C)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-busy';
    const memberName = 'bob';
    const approval = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      priorityBusySignals: [
        {
          isBusy: async () => ({ busy: true, reason: 'approval_pending' }),
        },
      ],
    });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      approval.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await approval.refreshStatus({ teamName, memberName });
        expect(status.state).toBe('needs_sync');
      });
      await expect(approval.continueManually({ teamName, memberName })).rejects.toThrow(
        'member_busy'
      );
    } finally {
      await approval.dispose();
    }

    const toolBusy = createFeature({
      teamsBasePath,
      teamName: 'team-lifecycle-tool',
      memberName,
    });
    try {
      await seedShadowReadyMetrics({
        teamsBasePath,
        teamName: 'team-lifecycle-tool',
        memberName,
      });
      toolBusy.noteTeamChange({
        type: 'task',
        teamName: 'team-lifecycle-tool',
        taskId: 'task-1',
      } as never);
      await waitForAssertion(async () => {
        const status = await toolBusy.refreshStatus({
          teamName: 'team-lifecycle-tool',
          memberName,
        });
        expect(status.state).toBe('needs_sync');
      });
      toolBusy.noteTeamChange({
        type: 'tool-activity',
        teamName: 'team-lifecycle-tool',
        detail: JSON.stringify({
          action: 'start',
          activity: {
            memberName,
            toolUseId: 'approval-1',
            toolName: 'AskUserQuestion',
            startedAt: new Date().toISOString(),
            source: 'runtime',
          },
        }),
      } as never);
      await expect(
        toolBusy.continueManually({ teamName: 'team-lifecycle-tool', memberName })
      ).rejects.toThrow('member_busy');
    } finally {
      await toolBusy.dispose();
    }
  });

  it('promotes durable attention after the no-progress deadline without a burst of recovery IDs (B)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-attention';
    const memberName = 'bob';
    const first = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      recoveryAllocation: { enabled: false },
    });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await first.getStatus({ teamName, memberName });
        expect(status.recoveryHealth?.episodes[0]?.firstObservedAt).toBeTruthy();
      });
    } finally {
      await first.dispose();
    }

    const statusPath = path.join(
      teamsBasePath,
      teamName,
      'members',
      memberName,
      '.member-work-sync',
      'status.json'
    );
    const stored = JSON.parse(await fs.promises.readFile(statusPath, 'utf8')) as {
      schemaVersion?: number;
      status?: {
        recoveryHealth?: {
          episodes?: Array<{ firstObservedAt?: string; dueAt?: string; phase?: string }>;
          attentionAt?: string;
        };
      };
      recoveryHealth?: {
        episodes?: Array<{ firstObservedAt?: string; dueAt?: string; phase?: string }>;
        attentionAt?: string;
      };
    };
    const health = stored.status?.recoveryHealth ?? stored.recoveryHealth;
    const observed = health?.episodes?.[0]?.firstObservedAt;
    expect(observed).toBeTruthy();
    const overdueAt = new Date(Date.parse(observed!) - 21 * 60_000).toISOString();
    health!.episodes![0]!.firstObservedAt = overdueAt;
    health!.episodes![0]!.dueAt = observed;
    await fs.promises.writeFile(statusPath, `${JSON.stringify(stored)}\n`, 'utf8');

    const restarted = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      recoveryAllocation: { enabled: false },
    });
    try {
      const status = await restarted.refreshStatus({ teamName, memberName });
      expect(status.recoveryHealth?.episodes[0]?.phase).toBe('attention');
      expect(status.recoveryHealth?.attentionAt).toBeTruthy();
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName })).filter(
          (item) => item.payload?.workSyncIntentKey
        )
      ).toEqual([]);
    } finally {
      await restarted.dispose();
    }
  });

  it('treats confirmed task progress after continuation as a new baseline (A)', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-progress';
    const memberName = 'bob';
    const tasks = [
      {
        id: 'task-1',
        displayId: '11111111',
        subject: 'Recover stuck work',
        status: 'pending',
        owner: memberName,
      },
    ];
    const feature = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      recoveryAllocation: { enabled: true },
      resolveControlUrl: async () => 'http://127.0.0.1:43123',
      tasks,
    });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          )
        ).toHaveLength(1);
      });
      const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'codex' });
      const spoolRoot = env?.[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV];
      expect(spoolRoot).toBeTruthy();
      await fs.promises.writeFile(
        path.join(spoolRoot!, 'incoming', '20260505T120002000Z-progress.codex.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          provider: 'codex',
          source: 'agent-teams-orchestrator-codex-native',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          sessionId: 'ses-codex-progress',
          memberName,
          teamName,
          cwd: claudeRoot,
          outcome: 'success',
          recordedAt: '2026-05-05T12:00:02.000Z',
        })}\n`,
        'utf8'
      );
      await expect(feature.drainRuntimeTurnSettledEvents()).resolves.toMatchObject({
        invalid: 0,
        unresolved: 0,
      });
      await waitForAssertion(async () => {
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          ).length
        ).toBeGreaterThanOrEqual(2);
      });
      const beforeProgress = await feature.getStatus({ teamName, memberName });
      const beforeObserved = beforeProgress.recoveryHealth?.episodes[0]?.firstObservedAt;
      tasks[0]!.status = 'in_progress';
      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await feature.refreshStatus({ teamName, memberName });
        expect(status.recoveryHealth?.episodes[0]?.lastEvidenceId).toBe('in_progress');
        expect(status.recoveryHealth?.episodes[0]?.firstObservedAt).not.toBe(beforeObserved);
        expect(status.recoveryHealth?.episodes[0]?.phase).not.toBe('attention');
      });
    } finally {
      await feature.dispose();
    }
  });

  it('keeps the same inbox message after a teammate process disappears and returns', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-pid';
    const memberName = 'bob';
    let memberActive = true;
    const first = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      isMemberActive: () => memberActive,
    });
    let messageIds: Array<string | undefined> = [];
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const messages = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(messages).toHaveLength(1);
        messageIds = messages.map((message) => message.messageId);
      });
      memberActive = false;
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        expect(
          (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
            (message) => message.messageKind === 'member_work_sync_nudge'
          )
        ).toHaveLength(1);
      });
    } finally {
      await first.dispose();
    }

    memberActive = true;
    const restarted = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      isMemberActive: () => memberActive,
    });
    try {
      restarted.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const messages = (await readInboxMessages({ teamsBasePath, teamName, memberName })).filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        expect(messages.map((message) => message.messageId)).toEqual(messageIds);
      });
      expect(
        Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName })).filter(
          (item) => item.payload?.workSyncIntentKey
        )
      ).toEqual([]);
    } finally {
      await restarted.dispose();
    }
  });
});
