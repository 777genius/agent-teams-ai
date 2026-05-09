import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getVersion: () => '1.3.0-e2e',
    isPackaged: false,
  },
  BrowserWindow: vi.fn(),
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  net: {},
  Notification: vi.fn(),
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    isEncryptionAvailable: vi.fn(() => false),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}));

import { createMemberWorkSyncFeature } from '@features/member-work-sync/main';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import { TeamTaskWriter } from '@main/services/team/TeamTaskWriter';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '@main/utils/pathDecoder';

import {
  createOpenCodeLiveHarness,
  waitForOpenCodeLanesStopped,
} from './openCodeLiveTestHarness';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_REVIEW_PICKUP === '1'
    ? describe
    : describe.skip;

const PROJECT_PATH = process.env.OPENCODE_E2E_PROJECT_PATH?.trim() ?? process.cwd();
const MODEL = process.env.OPENCODE_E2E_MODEL?.trim() ?? 'opencode/big-pickle';

liveDescribe('OpenCode review pickup live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-review-pickup-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (process.env.OPENCODE_E2E_KEEP_TEMP === '1') {
      console.info(`[OpenCodeReviewPickup.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it(
    'delivers review pickup when the current unread review request is still in the foreground inbox',
    async () => {
      const harness = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel: MODEL,
        projectPath: PROJECT_PATH,
      });
      const feature = createMemberWorkSyncFeature({
        teamsBasePath: getTeamsBasePath(),
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: () => true,
        queueQuietWindowMs: 0,
        extraBusySignals: [
          {
            isBusy: (input) => harness.svc.getOpenCodeMemberDeliveryBusyStatus(input),
          },
        ],
        reviewPickupDelivery: {
          canDeliver: (input) =>
            input.providerId === 'opencode'
              ? { ok: true }
              : {
                  ok: false,
                  reason: `provider_not_supported:${input.providerId ?? 'unknown'}`,
                },
          deliver: async (input) => {
            const relay = await harness.svc.relayOpenCodeMemberInboxMessages(
              input.teamName,
              input.memberName,
              {
                onlyMessageId: input.messageId,
                source: 'member-work-sync-review-pickup',
                deliveryMetadata: {
                  actionMode: input.payload.actionMode,
                  taskRefs: input.payload.taskRefs,
                },
              }
            );
            const lastDelivery = relay.lastDelivery;
            const diagnostics = [
              ...(relay.diagnostics ?? []),
              ...(lastDelivery?.diagnostics ?? []),
            ];
            if (lastDelivery?.accepted === true && lastDelivery.responsePending === true) {
              return {
                ok: true,
                state: 'prompt_accepted' as const,
                messageId: input.messageId,
                diagnostics,
              };
            }
            if (lastDelivery?.delivered && lastDelivery.accepted !== false) {
              return {
                ok: true,
                state: lastDelivery.responsePending
                  ? ('prompt_accepted' as const)
                  : ('response_proven' as const),
                messageId: input.messageId,
                diagnostics,
              };
            }
            return {
              ok: false,
              reason:
                lastDelivery?.ledgerStatus === 'failed_terminal'
                  ? ('terminal_failure' as const)
                  : ('retryable_failure' as const),
              message: lastDelivery?.reason ?? 'opencode_review_pickup_delivery_not_confirmed',
              diagnostics,
            };
          },
        },
      });

      const teamName = `opencode-review-pickup-${Date.now()}`;
      const memberName = 'bob';
      const taskId = '7142f765-76e5-4532-8a37-e228b841a6ed';
      const displayId = '7142f765';

      try {
        const progressEvents: { message?: string }[] = [];
        await harness.svc.createTeam(
          {
            teamName,
            cwd: PROJECT_PATH,
            providerId: 'opencode',
            model: MODEL,
            skipPermissions: true,
            members: [{ name: memberName, role: 'Reviewer', providerId: 'opencode', model: MODEL }],
          },
          (progress) => {
            progressEvents.push(progress);
          }
        );
        expect(
          progressEvents.some((progress) =>
            String(progress.message ?? '').includes('OpenCode team launch is ready')
          ),
          JSON.stringify(progressEvents, null, 2)
        ).toBe(true);

        const createdAt = new Date().toISOString();
        await new TeamTaskWriter().createTask(teamName, {
          id: taskId,
          displayId,
          subject: 'Live review pickup e2e task',
          description: 'Verify review-pickup delivery over its own unread review request.',
          owner: 'alice',
          createdBy: 'lead',
          status: 'completed',
          reviewState: 'review',
          projectPath: PROJECT_PATH,
          createdAt,
          updatedAt: createdAt,
        });

        const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);
        const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
        task.historyEvents = [
          ...(Array.isArray(task.historyEvents) ? task.historyEvents : []),
          {
            id: 'evt-live-review-request',
            type: 'review_requested',
            timestamp: new Date(Date.now() + 1000).toISOString(),
            from: 'approved',
            to: 'review',
            reviewer: memberName,
          },
        ];
        task.updatedAt = new Date().toISOString();
        await fs.writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');

        await new TeamInboxWriter().sendMessage(teamName, {
          member: memberName,
          from: 'team-lead',
          to: memberName,
          messageId: 'live-review-request-without-taskrefs',
          source: 'system_notification',
          summary: `Review request for #${displayId}`,
          text: [
            `**Please review** task #${displayId}`,
            '',
            'FIRST call review_start to signal you are beginning the review:',
            `{ teamName: "${teamName}", taskId: "${taskId}", from: "<your-name>" }`,
          ].join('\n'),
        });

        const status = await feature.refreshStatus({ teamName, memberName });
        expect(status.state).toBe('needs_sync');
        expect(status.agenda.items[0]).toMatchObject({
          taskId,
          kind: 'review',
          evidence: {
            reviewObligation: 'review_pickup_required',
            reviewRequestEventId: 'evt-live-review-request',
          },
        });

        const taskRef = { teamName, taskId, displayId };
        await expect(
          harness.svc.getOpenCodeMemberDeliveryBusyStatus({
            teamName,
            memberName,
            nowIso: new Date().toISOString(),
            workSyncIntent: 'review_pickup',
            taskRefs: [taskRef],
          })
        ).resolves.toEqual({ busy: false });

        const outboxPath = path.join(
          getTeamsBasePath(),
          teamName,
          'members',
          memberName,
          '.member-work-sync',
          'outbox.json'
        );

        const reconciledBefore = feature.getQueueDiagnostics().reconciled;
        feature.noteTeamChange({
          type: 'member-turn-settled',
          teamName,
          detail: JSON.stringify({
            memberName,
            sourceId: 'review-pickup-live-e2e',
            provider: 'opencode',
          }),
        });

        await waitForQueueReconciled(feature, reconciledBefore + 1, 45_000);
        const reviewItem = await waitForReviewPickupOutboxDelivery(outboxPath, 180_000);

        expect(reviewItem).toMatchObject({
          status: 'delivered',
        });
        expect(reviewItem?.lastError).not.toBe('member_busy:opencode_foreground_inbox_unread');
      } finally {
        await feature.dispose().catch(() => undefined);
        await harness.svc.stopTeam(teamName).catch(() => undefined);
        await harness.dispose().catch(() => undefined);
        await waitForOpenCodeLanesStopped(teamName).catch(() => undefined);
      }
    },
    300_000
  );
});

async function waitForQueueReconciled(
  feature: ReturnType<typeof createMemberWorkSyncFeature>,
  expectedReconciled: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let diagnostics = feature.getQueueDiagnostics();

  while (Date.now() < deadline) {
    diagnostics = feature.getQueueDiagnostics();
    if (diagnostics.reconciled >= expectedReconciled) {
      return;
    }
    if (diagnostics.failed > 0 && diagnostics.queued === 0 && diagnostics.running === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for member-work-sync queue reconcile. Diagnostics: ${JSON.stringify(
      diagnostics,
      null,
      2
    )}`
  );
}

async function waitForReviewPickupOutboxDelivery(
  outboxPath: string,
  timeoutMs: number
): Promise<{ status?: string; deliveryState?: string; lastError?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastOutbox: unknown = null;

  while (Date.now() < deadline) {
    try {
      const outbox = JSON.parse(await fs.readFile(outboxPath, 'utf8'));
      lastOutbox = outbox;
      const reviewItem = Object.values(outbox.items ?? outbox).find(
        (entry) =>
          (entry as { payload?: { workSyncIntent?: string } }).payload?.workSyncIntent ===
          'review_pickup'
      ) as { status?: string; deliveryState?: string; lastError?: string } | undefined;
      if (reviewItem?.status === 'delivered') {
        return reviewItem;
      }
      if (
        reviewItem?.status === 'failed_terminal' ||
        reviewItem?.lastError === 'member_busy:opencode_foreground_inbox_unread'
      ) {
        throw new Error(`Review pickup failed: ${JSON.stringify(reviewItem, null, 2)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Timed out waiting for review pickup outbox delivery. Last outbox: ${JSON.stringify(
      lastOutbox,
      null,
      2
    )}`
  );
}
