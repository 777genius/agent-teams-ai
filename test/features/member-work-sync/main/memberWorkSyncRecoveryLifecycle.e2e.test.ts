import {
  createMemberWorkSyncFeature,
} from '@features/member-work-sync/main';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestWorkSyncIdentity } from '../helpers/createTestWorkSyncIdentity';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-work-sync-lifecycle-'));
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
}) {
  return createMemberWorkSyncFeature({
    lifecycleIdentity: createTestWorkSyncIdentity(input.incarnation),
    teamsBasePath: input.teamsBasePath,
    ...(input.recoveryAllocation ? { recoveryAllocation: input.recoveryAllocation } : {}),
    configReader: {
      getConfig: async () => ({
        name: input.teamName,
        members: [{ name: input.memberName, providerId: 'codex' }],
      }),
    } as never,
    taskReader: {
      getTasks: async () => [
        {
          id: 'task-1',
          displayId: '11111111',
          subject: 'Recover stuck work',
          status: 'pending',
          owner: input.memberName,
        },
      ],
    } as never,
    kanbanManager: {
      getState: async () => ({ teamName: input.teamName, reviewers: [], tasks: {} }),
    } as never,
    membersMetaStore: { getMembers: async () => [] } as never,
    isTeamActive: async () => true,
    queueQuietWindowMs: 1,
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

  it('does not inherit recovery budget after same-name team recreate', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-lifecycle-recreate';
    const memberName = 'bob';
    const first = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      incarnation: 'inc-a',
    });
    try {
      await seedShadowReadyMetrics({ teamsBasePath, teamName, memberName });
      first.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await first.refreshStatus({ teamName, memberName });
        expect(status).toMatchObject({
          state: 'needs_sync',
        });
      });
      await first.stopAutoResume({ teamName, memberName, reason: 'user_stop' });
      await first.prepareTeamDeletion(teamName);
      first.completeTeamDeletion(teamName);
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
    } finally {
      await first.dispose();
    }

    await fs.promises.mkdir(path.join(teamsBasePath, teamName), { recursive: true });
    await fs.promises.writeFile(path.join(teamsBasePath, teamName, 'config.json'), '{}');
    const recreated = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      incarnation: 'inc-b',
    });
    try {
      recreated.noteTeamChange({ type: 'config', teamName, detail: 'config.json' });
      recreated.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);
      await waitForAssertion(async () => {
        const status = await recreated.getStatus({ teamName, memberName });
        expect(status.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
        expect(status.recoveryHealth?.unresolvedIntentId).toBeUndefined();
      });
    } finally {
      await recreated.dispose();
    }
  });
});
