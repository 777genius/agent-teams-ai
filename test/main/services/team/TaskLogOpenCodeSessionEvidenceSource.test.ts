import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskLogOpenCodeSessionEvidenceSource } from '../../../../src/main/services/team/taskLogs/stream/TaskLogOpenCodeSessionEvidenceSource';
import {
  OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
  type OpenCodePromptDeliveryLedgerRecord,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

import type { TeamTask } from '../../../../src/shared/types';

const tempDirs: string[] = [];

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-a',
    displayId: 'task-a',
    subject: 'Implement task',
    owner: 'bob',
    status: 'in_progress',
    createdAt: '2026-04-21T09:00:00.000Z',
    updatedAt: '2026-04-21T10:00:00.000Z',
    ...overrides,
  };
}

function createLedgerRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-a',
    teamName: 'team-a',
    memberName: 'bob',
    laneId: 'lane-a',
    runId: 'run-a',
    runtimeSessionId: 'session-a',
    runtimePromptMessageIds: [],
    lastRuntimePromptMessageId: null,
    lastDeliveryAttemptIdWithAcceptedPrompt: null,
    inboxMessageId: 'inbox-a',
    inboxTimestamp: '2026-04-21T10:00:00.000Z',
    source: 'watcher',
    messageKind: 'default',
    replyRecipient: 'user',
    actionMode: 'do',
    taskRefs: [
      {
        taskId: 'task-a',
        displayId: 'task-a',
        teamName: 'team-a',
      },
    ],
    payloadHash: 'hash-a',
    status: 'accepted',
    responseState: 'pending',
    attempts: 1,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: '2026-04-21T10:00:01.000Z',
    lastObservedAt: null,
    acceptedAt: '2026-04-21T10:00:02.000Z',
    respondedAt: null,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'runtime-user-a',
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: null,
    diagnostics: [],
    createdAt: '2026-04-21T10:00:00.000Z',
    updatedAt: '2026-04-21T10:00:02.000Z',
    ...overrides,
  };
}

async function writeLedger(input: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  records: OpenCodePromptDeliveryLedgerRecord[];
}): Promise<void> {
  const ledgerPath = path.join(
    input.teamsBasePath,
    input.teamName,
    '.opencode-runtime',
    'lanes',
    encodeURIComponent(input.laneId),
    'opencode-prompt-delivery-ledger.json'
  );
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify(
      {
        schemaVersion: OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
        updatedAt: '2026-04-21T10:00:00.000Z',
        data: input.records,
      },
      null,
      2
    )}\n`
  );
}

async function createTempTeamsBasePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'task-log-session-evidence-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TaskLogOpenCodeSessionEvidenceSource', () => {
  it('returns bounded exact OpenCode session evidence from prompt delivery ledgers', async () => {
    const teamsBasePath = await createTempTeamsBasePath();
    await writeLedger({
      teamsBasePath,
      teamName: 'team-a',
      laneId: 'lane-a',
      records: [
        createLedgerRecord({
          id: 'record-old',
          runtimeSessionId: 'session-old',
          inboxTimestamp: '2026-04-21T09:00:00.000Z',
          lastAttemptAt: '2026-04-21T09:00:01.000Z',
          acceptedAt: '2026-04-21T09:00:01.000Z',
          createdAt: '2026-04-21T09:00:00.000Z',
          updatedAt: '2026-04-21T09:00:01.000Z',
        }),
        createLedgerRecord({
          id: 'record-new',
          runtimeSessionId: 'session-new',
          deliveredUserMessageId: 'runtime-user-new',
          inboxTimestamp: '2026-04-21T10:00:00.000Z',
          lastAttemptAt: '2026-04-21T10:00:01.000Z',
          acceptedAt: '2026-04-21T10:00:01.000Z',
          createdAt: '2026-04-21T10:00:00.000Z',
          updatedAt: '2026-04-21T10:00:01.000Z',
        }),
      ],
    });
    await writeLedger({
      teamsBasePath,
      teamName: 'team-a',
      laneId: 'lane-foreign',
      records: [
        createLedgerRecord({
          id: 'record-foreign-task',
          laneId: 'lane-foreign',
          runtimeSessionId: 'session-foreign',
          taskRefs: [
            {
              taskId: 'task-foreign',
              displayId: 'task-foreign',
              teamName: 'team-a',
            },
          ],
        }),
        createLedgerRecord({
          id: 'record-rejected-before-acceptance',
          laneId: 'lane-foreign',
          runtimeSessionId: 'session-rejected',
          status: 'failed_terminal',
          acceptedAt: null,
        }),
      ],
    });

    const source = new TaskLogOpenCodeSessionEvidenceSource({
      teamsBasePath,
      maxEvidenceRecords: 1,
    });

    const records = await source.readTaskRecords('team-a', createTask());

    expect(records).toEqual([
      expect.objectContaining({
        taskId: 'task-a',
        memberName: 'bob',
        scope: 'member_session_window',
        laneId: 'lane-a',
        sessionId: 'session-new',
        source: 'delivery_ledger',
        startMessageUuid: 'runtime-user-new',
      }),
    ]);
  });

  it('returns an empty candidate list when no matching ledger exists', async () => {
    const teamsBasePath = await createTempTeamsBasePath();
    const source = new TaskLogOpenCodeSessionEvidenceSource({ teamsBasePath });

    await expect(source.readTaskRecords('team-a', createTask())).resolves.toEqual([]);
  });

  it('uses accepted runtime prompt id as task-log start anchor before observation catches up', async () => {
    const teamsBasePath = await createTempTeamsBasePath();
    await writeLedger({
      teamsBasePath,
      teamName: 'team-a',
      laneId: 'lane-a',
      records: [
        createLedgerRecord({
          id: 'record-accepted-only',
          runtimeSessionId: 'session-accepted-only',
          runtimePromptMessageId: 'msg_prompt_current',
          runtimePromptMessageIds: ['msg_prompt_previous', 'msg_prompt_current'],
          lastRuntimePromptMessageId: 'msg_prompt_current',
          deliveredUserMessageId: null,
        }),
      ],
    });

    const source = new TaskLogOpenCodeSessionEvidenceSource({ teamsBasePath });
    const records = await source.readTaskRecords('team-a', createTask());

    expect(records).toEqual([
      expect.objectContaining({
        sessionId: 'session-accepted-only',
        startMessageUuid: 'msg_prompt_current',
      }),
    ]);
  });
});
