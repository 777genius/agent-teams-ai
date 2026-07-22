import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { TeamMemberRuntimeAdvisoryService } from '@main/services/team/TeamMemberRuntimeAdvisoryService';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { OPENCODE_RUNTIME_DELIVERY_GENERIC_PROOF_GRACE_MS } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

import type {
  MemberRuntimeAdvisory,
  ResolvedTeamMember,
  TeamChangeEvent,
} from '@shared/types';

const hoisted = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: hoisted.openExternal,
  },
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({
    children,
    className,
    title,
  }: {
    children: React.ReactNode;
    className?: string;
    title?: string;
  }) => React.createElement('span', { className, title }, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/components/team/members/CurrentTaskIndicator', () => ({
  CurrentTaskIndicator: () => null,
}));

import { MemberCard } from '@renderer/components/team/members/MemberCard';

const TEAM_NAME = 'opencode-advisory-e2e';
const MEMBER_NAME = 'jack';
const LANE_ID = 'secondary:opencode:jack';
const NOW_ISO = '2026-05-09T12:05:00.000Z';
const OLD_FAILURE_ISO = new Date(
  Date.parse(NOW_ISO) - OPENCODE_RUNTIME_DELIVERY_GENERIC_PROOF_GRACE_MS - 5_000
).toISOString();
const FRESH_FAILURE_ISO = new Date(Date.parse(NOW_ISO) - 10_000).toISOString();

let tempDir = '';
let tempClaudeRoot = '';

interface SideEffectHarness {
  addTeamNotification: ReturnType<typeof vi.fn>;
  sendMessageToRun: ReturnType<typeof vi.fn>;
  teamChangeEvents: TeamChangeEvent[];
  invalidations: { teamName: string; memberName: string }[];
}

interface TeamProvisioningSideEffectAccess {
  aliveRunByTeam: Map<string, string>;
  runs: Map<string, unknown>;
  sendMessageToRun: (run: unknown, text: string) => Promise<void>;
  handleOpenCodeRuntimeDeliveryUserFacingSideEffects: (
    record: OpenCodePromptDeliveryLedgerRecord
  ) => Promise<void>;
  openCodeRuntimeDeliveryAdvisory: {
    cancelTeam(teamName: string): void;
  };
}

const baseMember: ResolvedTeamMember = {
  name: MEMBER_NAME,
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'purple',
  agentType: 'developer',
  role: 'Developer',
  providerId: 'opencode',
  removedAt: undefined,
};

describe('MemberCard OpenCode delivery advisory fixture e2e', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-card-opencode-advisory-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    hoisted.openExternal.mockReset();
    NotificationManager.resetInstance();
    setClaudeBasePathOverride(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('keeps a fresh generic terminal failure out of the member card and user-facing side effects', async () => {
    const record = makeDeliveryRecord({
      failedAt: FRESH_FAILURE_ISO,
      updatedAt: FRESH_FAILURE_ISO,
      lastObservedAt: FRESH_FAILURE_ISO,
      respondedAt: FRESH_FAILURE_ISO,
    });
    await writeDeliveryFixture(record);

    const advisory = await readMemberAdvisory();
    expect(advisory).toBeNull();

    const cardText = await renderMemberCardText(advisory);
    expect(cardText).not.toContain('OpenCode delivery error');
    expect(cardText).not.toContain('OpenCode returned an empty assistant turn');

    const sideEffects = await runUserFacingSideEffects(record);
    expect(sideEffects.addTeamNotification).not.toHaveBeenCalled();
    expect(sideEffects.sendMessageToRun).not.toHaveBeenCalled();
    expect(sideEffects.invalidations).toEqual([{ teamName: TEAM_NAME, memberName: MEMBER_NAME }]);
    expect(sideEffects.teamChangeEvents).toContainEqual(
      expect.objectContaining({
        type: 'member-advisory',
        teamName: TEAM_NAME,
      })
    );
  });

  it('suppresses a stale terminal failure across card, notification, and lead notice after visible reply proof appears', async () => {
    const record = makeDeliveryRecord({
      failedAt: OLD_FAILURE_ISO,
      updatedAt: OLD_FAILURE_ISO,
      lastObservedAt: OLD_FAILURE_ISO,
      respondedAt: OLD_FAILURE_ISO,
    });
    await writeDeliveryFixture(record);
    await writeVisibleRuntimeReplyProof(record);

    const advisory = await readMemberAdvisory();
    expect(advisory).toBeNull();

    const cardText = await renderMemberCardText(advisory);
    expect(cardText).not.toContain('OpenCode delivery error');
    expect(cardText).not.toContain('OpenCode returned an empty assistant turn');

    const sideEffects = await runUserFacingSideEffects(record);
    expect(sideEffects.addTeamNotification).not.toHaveBeenCalled();
    expect(sideEffects.sendMessageToRun).not.toHaveBeenCalled();
    expect(sideEffects.invalidations).toEqual([{ teamName: TEAM_NAME, memberName: MEMBER_NAME }]);
  });

  it('still surfaces a stale terminal failure with no proof in the card, notification, and lead notice', async () => {
    const record = makeDeliveryRecord({
      failedAt: OLD_FAILURE_ISO,
      updatedAt: OLD_FAILURE_ISO,
      lastObservedAt: OLD_FAILURE_ISO,
      respondedAt: OLD_FAILURE_ISO,
    });
    await writeDeliveryFixture(record);

    const advisory = await readMemberAdvisory();
    expect(advisory).toMatchObject({
      kind: 'api_error',
      reasonCode: 'backend_error',
      message: 'OpenCode returned an empty assistant turn.',
    });

    const cardText = await renderMemberCardText(advisory);
    expect(cardText).toContain('OpenCode delivery error');
    expect(cardText).toContain('OpenCode returned an empty assistant turn.');

    const sideEffects = await runUserFacingSideEffects(record);
    expect(sideEffects.addTeamNotification).toHaveBeenCalledTimes(1);
    expect(sideEffects.addTeamNotification.mock.calls[0]?.[0]).toMatchObject({
      teamEventType: 'api_error',
      teamName: TEAM_NAME,
      from: MEMBER_NAME,
      summary: 'OpenCode runtime error #task-1',
    });
    expect(sideEffects.sendMessageToRun).toHaveBeenCalledTimes(1);
    expect(String(sideEffects.sendMessageToRun.mock.calls[0]?.[1])).toContain(
      'System notice: OpenCode teammate @jack hit a runtime delivery error while handling #task-1.'
    );
  });

  it('schedules targeted work-sync recovery for stale protocol proof-missing advisory', async () => {
    const record = makeDeliveryRecord({
      failedAt: OLD_FAILURE_ISO,
      updatedAt: OLD_FAILURE_ISO,
      lastObservedAt: OLD_FAILURE_ISO,
      respondedAt: OLD_FAILURE_ISO,
      responseState: 'responded_non_visible_tool',
      lastReason: 'non_visible_tool_without_task_progress',
      diagnostics: [
        'OpenCode used tools, but did not create a visible reply or task progress proof.',
      ],
    });
    await writeDeliveryFixture(record);
    const scheduleProofMissingRecovery = vi.fn(() => Promise.resolve({
      scheduled: true,
      reason: 'scheduled' as const,
      intentKey: 'proof-missing:msg-empty-turn',
    }));

    const sideEffects = await runUserFacingSideEffects(record, scheduleProofMissingRecovery);

    expect(scheduleProofMissingRecovery).toHaveBeenCalledTimes(1);
    expect(scheduleProofMissingRecovery).toHaveBeenCalledWith({
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      originalMessageId: record.inboxMessageId,
      taskRefs: record.taskRefs,
      reason:
        'OpenCode used tools, but did not create a visible reply or task progress proof.',
    });
    expect(sideEffects.addTeamNotification).not.toHaveBeenCalled();
    expect(sideEffects.sendMessageToRun).not.toHaveBeenCalled();
    expect(sideEffects.invalidations).toEqual([{ teamName: TEAM_NAME, memberName: MEMBER_NAME }]);
  });

  it('suppresses protocol proof-missing recovery after visible reply proof appears', async () => {
    const record = makeDeliveryRecord({
      failedAt: OLD_FAILURE_ISO,
      updatedAt: OLD_FAILURE_ISO,
      lastObservedAt: OLD_FAILURE_ISO,
      respondedAt: OLD_FAILURE_ISO,
      responseState: 'responded_non_visible_tool',
      lastReason: 'non_visible_tool_without_task_progress',
      diagnostics: [
        'OpenCode used tools, but did not create a visible reply or task progress proof.',
      ],
    });
    await writeDeliveryFixture(record);
    await writeVisibleRuntimeReplyProof(record);
    const scheduleProofMissingRecovery = vi.fn(() => Promise.resolve({
      scheduled: true,
      reason: 'scheduled' as const,
      intentKey: 'proof-missing:msg-empty-turn',
    }));

    const advisory = await readMemberAdvisory();
    expect(advisory).toBeNull();

    const sideEffects = await runUserFacingSideEffects(record, scheduleProofMissingRecovery);

    expect(scheduleProofMissingRecovery).not.toHaveBeenCalled();
    expect(sideEffects.addTeamNotification).not.toHaveBeenCalled();
    expect(sideEffects.sendMessageToRun).not.toHaveBeenCalled();
    expect(sideEffects.invalidations).toEqual([{ teamName: TEAM_NAME, memberName: MEMBER_NAME }]);
  });
});

async function readMemberAdvisory(): Promise<MemberRuntimeAdvisory | null> {
  const service = new TeamMemberRuntimeAdvisoryService({
    findMemberLogs: vi.fn(() => Promise.resolve([])),
  });
  return await service.getMemberAdvisory(TEAM_NAME, MEMBER_NAME);
}

async function renderMemberCardText(
  runtimeAdvisory: MemberRuntimeAdvisory | null
): Promise<string> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      React.createElement(MemberCard, {
        member: {
          ...baseMember,
          runtimeAdvisory: runtimeAdvisory ?? undefined,
        },
        memberColor: 'purple',
        runtimeSummary: 'OpenCode - kimi-k2.6',
        isTeamAlive: true,
        isTeamProvisioning: false,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        spawnRuntimeAlive: true,
      })
    );
    await Promise.resolve();
  });

  const text = host.textContent ?? '';
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  host.remove();
  return text;
}

async function runUserFacingSideEffects(
  record: OpenCodePromptDeliveryLedgerRecord,
  scheduleProofMissingRecovery?: Parameters<
    TeamProvisioningService['setMemberWorkSyncProofMissingRecoveryScheduler']
  >[0]
): Promise<SideEffectHarness> {
  const addTeamNotification = vi.fn(() => Promise.resolve(undefined));
  NotificationManager.setInstance({ addTeamNotification } as never);

  const service = new TeamProvisioningService();
  const access = service as unknown as TeamProvisioningSideEffectAccess;
  const sendMessageToRun = vi.fn(() => Promise.resolve(undefined));
  const teamChangeEvents: TeamChangeEvent[] = [];
  const invalidations: { teamName: string; memberName: string }[] = [];

  service.setTeamChangeEmitter((event) => {
    teamChangeEvents.push(event);
  });
  service.setMemberRuntimeAdvisoryInvalidator((teamName, memberName) => {
    invalidations.push({ teamName, memberName });
  });
  if (scheduleProofMissingRecovery) {
    service.setMemberWorkSyncProofMissingRecoveryScheduler(scheduleProofMissingRecovery);
  }
  access.sendMessageToRun = sendMessageToRun;
  access.aliveRunByTeam.set(TEAM_NAME, 'lead-run-1');
  access.runs.set('lead-run-1', {
    runId: 'lead-run-1',
    teamName: TEAM_NAME,
    processKilled: false,
    cancelRequested: false,
  });

  try {
    await access.handleOpenCodeRuntimeDeliveryUserFacingSideEffects(record);
  } finally {
    access.openCodeRuntimeDeliveryAdvisory.cancelTeam(TEAM_NAME);
  }

  return {
    addTeamNotification,
    sendMessageToRun,
    teamChangeEvents,
    invalidations,
  };
}

function makeDeliveryRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'opencode-prompt:msg-empty-turn',
    teamName: TEAM_NAME,
    memberName: MEMBER_NAME,
    laneId: LANE_ID,
    runId: 'opencode-run-1',
    runtimeSessionId: 'session-jack',
    inboxMessageId: 'msg-empty-turn',
    inboxTimestamp: overrides.inboxTimestamp ?? OLD_FAILURE_ISO,
    source: 'watcher',
    messageKind: null,
    replyRecipient: 'team-lead',
    actionMode: 'ask',
    taskRefs: [{ taskId: 'task-1', displayId: 'task-1', teamName: TEAM_NAME }],
    payloadHash: 'sha256:test',
    status: 'failed_terminal',
    responseState: 'empty_assistant_turn',
    attempts: 3,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: overrides.lastAttemptAt ?? OLD_FAILURE_ISO,
    lastObservedAt: overrides.lastObservedAt ?? OLD_FAILURE_ISO,
    acceptedAt: overrides.acceptedAt ?? OLD_FAILURE_ISO,
    respondedAt: overrides.respondedAt ?? OLD_FAILURE_ISO,
    failedAt: overrides.failedAt ?? OLD_FAILURE_ISO,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'opencode-user-msg-1',
    observedAssistantMessageId: 'opencode-assistant-empty',
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: 'empty_assistant_turn',
    diagnostics: ['empty_assistant_turn'],
    createdAt: overrides.createdAt ?? OLD_FAILURE_ISO,
    updatedAt: overrides.updatedAt ?? OLD_FAILURE_ISO,
    ...overrides,
  };
}

async function writeDeliveryFixture(record: OpenCodePromptDeliveryLedgerRecord): Promise<void> {
  const teamDir = path.join(tempClaudeRoot, 'teams', TEAM_NAME);
  const runtimeDir = path.join(teamDir, '.opencode-runtime');
  const laneDir = path.join(runtimeDir, 'lanes', encodeURIComponent(LANE_ID));
  await fs.mkdir(laneDir, { recursive: true });
  await fs.mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: TEAM_NAME,
        projectPath: path.join(tempDir, 'project'),
        leadSessionId: 'lead-session',
        members: [
          { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
          { name: MEMBER_NAME, role: 'Developer', providerId: 'opencode' },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(runtimeDir, 'lanes.json'),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: record.updatedAt,
        lanes: {
          [LANE_ID]: {
            laneId: LANE_ID,
            state: 'active',
            updatedAt: record.updatedAt,
          },
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(laneDir, 'opencode-prompt-delivery-ledger.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: record.updatedAt,
        data: [record],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeVisibleRuntimeReplyProof(
  record: OpenCodePromptDeliveryLedgerRecord
): Promise<void> {
  await fs.writeFile(
    path.join(tempClaudeRoot, 'teams', TEAM_NAME, 'inboxes', 'team-lead.json'),
    `${JSON.stringify(
      [
        {
          from: MEMBER_NAME,
          to: 'team-lead',
          text: 'Done, visible reply already delivered.',
          timestamp: NOW_ISO,
          read: false,
          source: 'runtime_delivery',
          messageId: 'visible-runtime-reply-1',
          relayOfMessageId: record.inboxMessageId,
          taskRefs: record.taskRefs,
        },
      ],
      null,
      2
    )}\n`,
    'utf8'
  );
}
