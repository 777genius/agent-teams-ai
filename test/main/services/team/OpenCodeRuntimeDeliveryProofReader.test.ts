import { describe, expect, it, vi } from 'vitest';

import { OpenCodeRuntimeDeliveryProofReader } from '../../../../src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofReader';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { InboxMessage, TaskRef, TeamTask } from '../../../../src/shared/types/team';

const TEAM_NAME = 'relay-works-69';
const TARGET_TASK_ID = 'a7fd5f34-ff82-4ead-8089-34064454a623';
const OTHER_TASK_ID = '8dc34135-1111-4111-8111-8dc341350000';
const TARGET_TASK_REF: TaskRef = {
  teamName: TEAM_NAME,
  taskId: TARGET_TASK_ID,
  displayId: 'a7fd5f34',
};
const OTHER_TASK_REF: TaskRef = {
  teamName: TEAM_NAME,
  taskId: OTHER_TASK_ID,
  displayId: '8dc34135',
};

function createLedgerRecord(): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'opencode-prompt:dependency-comment',
    teamName: TEAM_NAME,
    memberName: 'tom',
    laneId: 'secondary:opencode:tom',
    runId: 'run-1',
    runtimeSessionId: 'ses-1',
    inboxMessageId: 'dependency-comment-1',
    inboxTimestamp: '2026-05-18T21:25:05.428Z',
    source: 'watcher',
    messageKind: null,
    replyRecipient: 'team-lead',
    actionMode: null,
    taskRefs: [],
    payloadHash: 'sha256:test',
    status: 'failed_terminal',
    responseState: 'session_stale',
    attempts: 1,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: '2026-05-18T21:25:27.592Z',
    lastObservedAt: '2026-05-18T21:27:58.582Z',
    acceptedAt: '2026-05-18T21:25:27.592Z',
    respondedAt: null,
    failedAt: '2026-05-18T21:27:58.582Z',
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'delivered-1',
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: 'opencode_session_stale_observe_loop_after_accepted_prompt',
    diagnostics: [
      'OpenCode API error',
      'OpenCode session stayed stale while observing an accepted prompt after 5 attempt(s).',
    ],
    createdAt: '2026-05-18T21:25:05.428Z',
    updatedAt: '2026-05-18T21:27:58.582Z',
  };
}

function createDependencyInboxMessage(): InboxMessage {
  return {
    from: 'team-lead',
    to: 'tom',
    text: [
      '**Comment on task #a7fd5f34** _Calculator styles_',
      '',
      '> **Dependency resolved** - task #8dc34135 completed.',
      '> All blockers for #a7fd5f34 are resolved - this task is ready to start.',
    ].join('\n'),
    timestamp: '2026-05-18T21:25:05.428Z',
    read: false,
    summary: 'Comment on #a7fd5f34',
    messageId: 'dependency-comment-1',
    source: 'system_notification',
  };
}

function createRuntimeReply(taskRefs: TaskRef[]): InboxMessage {
  return {
    from: 'tom',
    to: 'team-lead',
    text: 'Done and verified.',
    timestamp: '2026-05-18T21:25:45.000Z',
    read: false,
    summary: 'Done',
    messageId: `reply-${taskRefs[0]?.displayId ?? 'none'}`,
    source: 'runtime_delivery',
    taskRefs,
  };
}

function createProofReader(leadInboxMessages: InboxMessage[]): OpenCodeRuntimeDeliveryProofReader {
  const inboxReader = {
    getMessagesFor: vi.fn((_teamName: string, inboxName: string) => {
      if (inboxName === 'tom') {
        return Promise.resolve([createDependencyInboxMessage()]);
      }
      if (inboxName === 'team-lead') {
        return Promise.resolve(leadInboxMessages);
      }
      return Promise.resolve([]);
    }),
  };
  const taskReader = {
    getTasks: vi.fn(() =>
      Promise.resolve([
        { id: TARGET_TASK_ID, displayId: 'a7fd5f34' },
        { id: OTHER_TASK_ID, displayId: '8dc34135' },
      ] as TeamTask[])
    ),
  };
  const configReader = {
    getConfigSnapshot: vi.fn(() =>
      Promise.resolve({
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      })
    ),
  };

  return new OpenCodeRuntimeDeliveryProofReader(
    inboxReader as never,
    taskReader as never,
    configReader as never
  );
}

describe('OpenCodeRuntimeDeliveryProofReader', () => {
  it('matches visible replies using task refs inferred from the original inbox message', async () => {
    const record = createLedgerRecord();
    const proofIndex = await createProofReader([
      createRuntimeReply([TARGET_TASK_REF]),
    ]).readProofIndex({
      teamName: TEAM_NAME,
      activeMemberKeys: new Set(['tom']),
      recordsByMember: new Map([['tom', [record]]]),
    });

    expect(proofIndex.getSnapshot('tom', record).visibleReplyMessageId).toBe('reply-a7fd5f34');
  });

  it('does not treat a reply for another task as proof for an inferred task ref', async () => {
    const record = createLedgerRecord();
    const proofIndex = await createProofReader([
      createRuntimeReply([OTHER_TASK_REF]),
    ]).readProofIndex({
      teamName: TEAM_NAME,
      activeMemberKeys: new Set(['tom']),
      recordsByMember: new Map([['tom', [record]]]),
    });

    expect(proofIndex.getSnapshot('tom', record).visibleReplyMessageId).toBeUndefined();
  });

  it('does not infer task refs for non-error records', async () => {
    const record: OpenCodePromptDeliveryLedgerRecord = {
      ...createLedgerRecord(),
      status: 'pending',
      responseState: 'pending',
      failedAt: null,
      lastReason: null,
      diagnostics: [],
    };
    const inboxReader = {
      getMessagesFor: vi.fn(() => Promise.resolve([] as InboxMessage[])),
    };
    const taskReader = {
      getTasks: vi.fn(() => Promise.resolve([] as TeamTask[])),
    };
    const configReader = {
      getConfigSnapshot: vi.fn(() =>
        Promise.resolve({
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })
      ),
    };

    const proofIndex = await new OpenCodeRuntimeDeliveryProofReader(
      inboxReader as never,
      taskReader as never,
      configReader as never
    ).readProofIndex({
      teamName: TEAM_NAME,
      activeMemberKeys: new Set(['tom']),
      recordsByMember: new Map([['tom', [record]]]),
    });

    expect(proofIndex.getSnapshot('tom', record).taskProgressAt).toBeUndefined();
    expect(taskReader.getTasks).not.toHaveBeenCalled();
    expect(inboxReader.getMessagesFor).not.toHaveBeenCalledWith(TEAM_NAME, 'tom');
  });
});
