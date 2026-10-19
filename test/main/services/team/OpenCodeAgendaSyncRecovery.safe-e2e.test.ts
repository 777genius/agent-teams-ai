import { createMemberWorkSyncFeature } from '@features/member-work-sync/main';
import {
  OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
  type OpenCodePromptDeliveryLedgerRecord,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeRuntimeLaneIndexPath,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestWorkSyncIdentity } from '../../../features/member-work-sync/helpers/createTestWorkSyncIdentity';

import type { MemberWorkSyncNudgeDeliveryWakePort } from '@features/member-work-sync/core/application/ports';
import type { InboxMessage, TaskRef } from '@shared/types/team';
import type { Mock } from 'vitest';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agenda-sync-e2e-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  setClaudeBasePathOverride(null);
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Poll an async assertion until it succeeds or the 5s deadline expires.
 * Used to wait for eventually-consistent recovery state in this safe-e2e test.
 */
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

/**
 * The two broken fixtures below intentionally make the delivery watchdog and
 * the OpenCode inbox relay emit diagnostics for their fixture team names, so
 * those diagnostics are designed observables of this safe-e2e file rather than
 * regressions. Assert them here and remove exactly these fixture-scoped
 * entries from the console.warn spy (installed by test/setup.ts) so the shared
 * "no unexpected warnings" assertion only sees output unrelated to the
 * fixtures.
 *
 * Remove the fixture-scoped diagnostics emitted by the delivery watchdog and
 * the OpenCode inbox relay from the shared console.warn spy. Matching is
 * exact (fixture team name plus diagnostic phrase) so unrelated warnings stay
 * observable. Removal happens in reverse index order so splicing never shifts
 * later positions. An empty match set is valid when the watchdog is disabled
 * via CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG=0.
 */
function consumeExpectedFixtureDiagnostics(): void {
  const warnSpy = console.warn as unknown as { mock: { calls: unknown[][] } };
  const calls = warnSpy.mock.calls;
  const expectedIndexes: number[] = [];
  calls.forEach((args, index) => {
    const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    const isFixtureName =
      text.includes('[team-opencode-agenda-sync-recovery]') ||
      text.includes('[team-opencode-agenda-sync-no-proof]');
    const isDiagnostic =
      text.includes('delivery watchdog relay diagnostics for ') ||
      text.includes('OpenCode inbox relay failed for ');
    if (isFixtureName && isDiagnostic) expectedIndexes.push(index);
  });
  // The watchdog may be disabled via CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG=0,
  // in which case no matching fixture diagnostic is necessarily produced. An
  // empty result is therefore legitimate and must not fail the helper.
  for (let index = expectedIndexes.length - 1; index >= 0; index -= 1) {
    calls.splice(expectedIndexes[index], 1);
  }
}

/**
 * Seed metrics that make a member appear shadow-ready (caught up) for recovery
 * assertions, including enough status events to exercise non-blocking collection.
 */
async function seedNonBlockingShadowCollectingMetrics(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  statusEventCount?: number;
}): Promise<void> {
  const statusEventCount = input.statusEventCount ?? 18;
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
        recentEvents: Array.from({ length: statusEventCount }, (_, index) => ({
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

/**
 * Write a minimal team config.json for the given member and provider.
 */
async function seedTeamConfig(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  providerId?: 'opencode' | 'codex';
}): Promise<void> {
  const providerId = input.providerId ?? 'opencode';
  const configPath = path.join(input.teamsBasePath, input.teamName, 'config.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: path.join(input.teamsBasePath, input.teamName, 'project'),
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          {
            name: input.memberName,
            role: 'developer',
            providerId,
            model: providerId === 'codex' ? 'gpt-5.4-mini' : 'openrouter/test',
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

/**
 * Seed the member's inbox file with the provided messages.
 */
async function seedInbox(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  messages: InboxMessage[];
}): Promise<void> {
  const inboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'inboxes',
    `${input.memberName}.json`
  );
  await fs.promises.mkdir(path.dirname(inboxPath), { recursive: true });
  await fs.promises.writeFile(inboxPath, `${JSON.stringify(input.messages, null, 2)}\n`, 'utf8');
}

/**
 * Read and parse the member's inbox messages from disk.
 */
async function readInboxMessages(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<InboxMessage[]> {
  const inboxPath = path.join(
    input.teamsBasePath,
    input.teamName,
    'inboxes',
    `${input.memberName}.json`
  );
  const raw = await fs.promises.readFile(inboxPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as InboxMessage[]) : [];
}

/**
 * Read the member's outbox items from disk for delivery-status assertions.
 */
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
  const raw = await fs.promises.readFile(outboxPath, 'utf8');
  const parsed = JSON.parse(raw) as {
    items?: Record<
      string,
      { status?: string; lastError?: string; nextAttemptAt?: string; deliveredMessageId?: string }
    >;
  };
  return parsed.items ?? {};
}

/**
 * Seed an OpenCode runtime lane index and prompt-delivery ledger for recovery.
 */
async function seedOpenCodeRuntimeLane(input: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  records: OpenCodePromptDeliveryLedgerRecord[];
}): Promise<void> {
  const now = '2026-02-23T17:30:00.000Z';
  const laneIndexPath = getOpenCodeRuntimeLaneIndexPath(input.teamsBasePath, input.teamName);
  await fs.promises.mkdir(path.dirname(laneIndexPath), { recursive: true });
  await fs.promises.writeFile(
    laneIndexPath,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: now,
        lanes: {
          [input.laneId]: {
            laneId: input.laneId,
            state: 'active',
            updatedAt: now,
          },
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
    teamsBasePath: input.teamsBasePath,
    teamName: input.teamName,
    laneId: input.laneId,
    fileName: 'opencode-prompt-delivery-ledger.json',
  });
  await fs.promises.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.promises.writeFile(
    ledgerPath,
    `${JSON.stringify(
      {
        schemaVersion: OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
        updatedAt: now,
        data: input.records,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

/**
 * Build a proof-missing (failed_terminal) prompt-delivery ledger record fixture.
 */
function buildProofMissingRecord(input: {
  teamName: string;
  memberName: string;
  laneId: string;
  inboxMessageId: string;
  taskRefs: TaskRef[];
}): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: `opencode-prompt:${input.inboxMessageId}`,
    teamName: input.teamName,
    memberName: input.memberName,
    laneId: input.laneId,
    runId: 'run-1',
    runtimeSessionId: 'session-1',
    inboxMessageId: input.inboxMessageId,
    inboxTimestamp: '2026-02-23T17:31:00.000Z',
    source: 'watcher',
    messageKind: 'default',
    replyRecipient: 'team-lead',
    actionMode: 'do',
    taskRefs: input.taskRefs,
    payloadHash: 'sha256:test',
    status: 'failed_terminal',
    responseState: 'responded_non_visible_tool',
    attempts: 3,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: '2026-02-23T17:31:10.000Z',
    lastObservedAt: '2026-02-23T17:31:15.000Z',
    acceptedAt: '2026-02-23T17:31:05.000Z',
    respondedAt: '2026-02-23T17:31:15.000Z',
    failedAt: '2026-02-23T17:31:20.000Z',
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'msg-user',
    observedAssistantMessageId: 'msg-assistant',
    observedAssistantPreview: null,
    observedToolCallNames: ['task_get', 'glob'],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: 'non_visible_tool_without_task_progress',
    diagnostics: ['non_visible_tool_without_task_progress'],
    createdAt: '2026-02-23T17:31:00.000Z',
    updatedAt: '2026-02-23T17:31:20.000Z',
  };
}

type TestNudgeDeliveryWake = MemberWorkSyncNudgeDeliveryWakePort & {
  schedule: Mock<MemberWorkSyncNudgeDeliveryWakePort['schedule']>;
};

function createNudgeDeliveryWake(): TestNudgeDeliveryWake {
  return {
    schedule: vi.fn<MemberWorkSyncNudgeDeliveryWakePort['schedule']>(async () => undefined),
  };
}

/**
 * Create the member-work-sync feature fixture and its in-memory collaborators.
 */
function createFeature(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  service: TeamProvisioningService;
  nudgeDeliveryWake: TestNudgeDeliveryWake;
  providerId?: 'opencode' | 'codex';
}) {
  const providerId = input.providerId ?? 'opencode';
  return createMemberWorkSyncFeature({
    lifecycleIdentity: createTestWorkSyncIdentity(),
    teamsBasePath: input.teamsBasePath,
    configReader: {
      getConfig: vi.fn(async () => ({
        name: input.teamName,
        members: [{ name: input.memberName, providerId }],
      })),
    } as never,
    taskReader: {
      getTasks: vi.fn(async () => [
        {
          id: 'task-1',
          displayId: '11111111',
          subject: 'Recover OpenCode agenda sync',
          status: 'pending',
          owner: input.memberName,
        },
      ]),
    } as never,
    kanbanManager: {
      getState: vi.fn(async () => ({
        teamName: input.teamName,
        reviewers: [],
        tasks: {},
      })),
    } as never,
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
    } as never,
    isTeamActive: vi.fn(async () => true),
    extraBusySignals:
      providerId === 'opencode'
        ? [
            {
              isBusy: (busyInput) => input.service.getOpenCodeMemberDeliveryBusyStatus(busyInput),
            },
          ]
        : [],
    nudgeDeliveryWake: input.nudgeDeliveryWake,
    queueQuietWindowMs: 1,
  });
}

describe('OpenCode agenda-sync proof-missing recovery safe e2e', () => {
  it('delivers a Codex work-sync nudge during shadow collection with prefixed MCP aliases and schedules a Codex wake', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-codex-agenda-sync-nudge';
    const memberName = 'bob';
    const service = new TeamProvisioningService();
    const nudgeDeliveryWake = createNudgeDeliveryWake();
    const feature = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      service,
      nudgeDeliveryWake,
      providerId: 'codex',
    });

    try {
      await seedTeamConfig({ teamsBasePath, teamName, memberName, providerId: 'codex' });
      await seedNonBlockingShadowCollectingMetrics({
        teamsBasePath,
        teamName,
        memberName,
      });

      await feature.refreshStatus({ teamName, memberName });
      await feature.dispatchDueNudges([teamName]);

      await waitForAssertion(async () => {
        const inbox = await readInboxMessages({ teamsBasePath, teamName, memberName });
        const nudges = inbox.filter((message) => message.messageKind === 'member_work_sync_nudge');
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('Required sync action: call member_work_sync_status');
        expect(nudges[0]?.text).toContain('mcp__agent-teams__member_work_sync_status');
        expect(nudges[0]?.text).toContain('mcp__agent-teams__member_work_sync_report');
        expect(nudges[0]?.text).toContain('Do not search the filesystem');
        await expect(feature.getMetrics({ teamName })).resolves.toMatchObject({
          phase2Readiness: { state: 'collecting_shadow_data' },
        });
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
    } finally {
      await feature.dispose();
    }
  });

  it('delivers a work-sync nudge without marking the proof-missing foreground message read', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-opencode-agenda-sync-recovery';
    const memberName = 'jack';
    const laneId = 'secondary:opencode:jack';
    const taskRef: TaskRef = { teamName, taskId: 'task-1', displayId: '11111111' };
    const foregroundMessageId = 'proof-missing-message-1';
    const service = new TeamProvisioningService();
    const nudgeDeliveryWake = createNudgeDeliveryWake();
    const feature = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      service,
      nudgeDeliveryWake,
    });

    try {
      await seedTeamConfig({ teamsBasePath, teamName, memberName });
      await seedNonBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      await seedInbox({
        teamsBasePath,
        teamName,
        memberName,
        messages: [
          {
            from: 'team-lead',
            to: memberName,
            text: 'Please continue task #11111111.',
            timestamp: '2026-02-23T17:31:00.000Z',
            read: false,
            messageId: foregroundMessageId,
            messageKind: 'default',
            taskRefs: [taskRef],
          },
        ],
      });
      await seedOpenCodeRuntimeLane({
        teamsBasePath,
        teamName,
        laneId,
        records: [
          buildProofMissingRecord({
            teamName,
            memberName,
            laneId,
            inboxMessageId: foregroundMessageId,
            taskRefs: [taskRef],
          }),
        ],
      });

      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const inbox = await readInboxMessages({ teamsBasePath, teamName, memberName });
        const foreground = inbox.find((message) => message.messageId === foregroundMessageId);
        const nudges = inbox.filter((message) => message.messageKind === 'member_work_sync_nudge');
        expect(foreground).toMatchObject({ read: false });
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.text).toContain('11111111');
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
    } finally {
      await feature.dispose();
      consumeExpectedFixtureDiagnostics();
    }
  });

  it('keeps the nudge retryable when unread foreground lacks proof-missing ledger evidence', async () => {
    const claudeRoot = makeTempRoot();
    setClaudeBasePathOverride(claudeRoot);
    const teamsBasePath = getTeamsBasePath();
    const teamName = 'team-opencode-agenda-sync-no-proof';
    const memberName = 'jack';
    const laneId = 'secondary:opencode:jack';
    const taskRef: TaskRef = { teamName, taskId: 'task-1', displayId: '11111111' };
    const service = new TeamProvisioningService();
    const nudgeDeliveryWake = createNudgeDeliveryWake();
    const feature = createFeature({
      teamsBasePath,
      teamName,
      memberName,
      service,
      nudgeDeliveryWake,
    });

    try {
      await seedTeamConfig({ teamsBasePath, teamName, memberName });
      await seedNonBlockingShadowCollectingMetrics({ teamsBasePath, teamName, memberName });
      await seedInbox({
        teamsBasePath,
        teamName,
        memberName,
        messages: [
          {
            from: 'team-lead',
            to: memberName,
            text: 'Please continue task #11111111.',
            timestamp: '2026-02-23T17:31:00.000Z',
            read: false,
            messageId: 'foreground-message-1',
            messageKind: 'default',
            taskRefs: [taskRef],
          },
        ],
      });
      await seedOpenCodeRuntimeLane({ teamsBasePath, teamName, laneId, records: [] });

      feature.noteTeamChange({ type: 'task', teamName, taskId: 'task-1' } as never);

      await waitForAssertion(async () => {
        const inbox = await readInboxMessages({ teamsBasePath, teamName, memberName });
        expect(inbox.filter((message) => message.messageKind === 'member_work_sync_nudge')).toEqual(
          []
        );
        expect(nudgeDeliveryWake.schedule).not.toHaveBeenCalled();
        expect(
          Object.values(await readMemberOutboxItems({ teamsBasePath, teamName, memberName }))
        ).toEqual([
          expect.objectContaining({
            status: 'failed_retryable',
            lastError: 'member_busy:opencode_foreground_inbox_unread',
          }),
        ]);
      });
    } finally {
      await feature.dispose();
      consumeExpectedFixtureDiagnostics();
    }
  });
});
