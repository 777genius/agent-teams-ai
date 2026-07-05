import { describe, expect, it, vi } from 'vitest';

import {
  getOpenCodeAgendaSyncRecoveryBypassMessageIds,
  type OpenCodeAgendaSyncRecoveryBypassPorts,
} from '../TeamProvisioningOpenCodeAgendaSyncRecovery';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { InboxMessage, TaskRef } from '@shared/types';

const taskRef: TaskRef = { teamName: 'alpha', taskId: 'task-1', displayId: 'T-1' };
const testAttachmentFilePath = '/safe-test/a.txt';

function createMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'user',
    to: 'dev',
    text: 'sync agenda',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'msg-1',
    taskRefs: [taskRef],
    workSyncIntent: 'agenda_sync',
    ...overrides,
  };
}

function createRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    teamName: 'alpha',
    memberName: 'dev',
    laneId: 'lane-1',
    status: 'failed_terminal',
    inboxMessageId: 'msg-1',
    inboxReadCommittedAt: null,
    taskRefs: [taskRef],
    lastReason: 'did not create a visible reply or task progress proof',
    diagnostics: [],
    ...overrides,
  } as OpenCodePromptDeliveryLedgerRecord;
}

function createPorts(
  overrides: Partial<OpenCodeAgendaSyncRecoveryBypassPorts> = {}
): OpenCodeAgendaSyncRecoveryBypassPorts {
  return {
    resolveOpenCodeMemberDeliveryIdentity: vi.fn().mockResolvedValue({
      ok: true,
      laneId: 'lane-1',
      canonicalMemberName: 'dev',
    }),
    readLaneState: vi.fn().mockResolvedValue('active'),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: vi
      .fn()
      .mockResolvedValue(false),
    listOpenCodePromptDeliveryLedgerRecords: vi.fn().mockResolvedValue([createRecord()]),
    ...overrides,
  };
}

describe('OpenCode agenda sync recovery bypass helpers', () => {
  it('returns matching foreground message ids for active proof-missing ledger records', async () => {
    const ids = await getOpenCodeAgendaSyncRecoveryBypassMessageIds(
      {
        teamName: 'alpha',
        memberName: 'dev',
        workSyncIntent: 'agenda_sync',
        taskRefs: [taskRef],
        foregroundMessages: [createMessage()],
      },
      createPorts()
    );

    expect([...ids]).toEqual(['msg-1']);
  });

  it('ignores non-agenda work sync requests', async () => {
    const ports = createPorts();
    const ids = await getOpenCodeAgendaSyncRecoveryBypassMessageIds(
      {
        teamName: 'alpha',
        memberName: 'dev',
        workSyncIntent: 'review_pickup',
        taskRefs: [taskRef],
        foregroundMessages: [createMessage()],
      },
      ports
    );

    expect(ids.size).toBe(0);
    expect(ports.resolveOpenCodeMemberDeliveryIdentity).not.toHaveBeenCalled();
  });

  it('filters out foreground messages with attachments or missing ids', async () => {
    const ports = createPorts();
    const ids = await getOpenCodeAgendaSyncRecoveryBypassMessageIds(
      {
        teamName: 'alpha',
        memberName: 'dev',
        workSyncIntent: 'agenda_sync',
        taskRefs: [taskRef],
        foregroundMessages: [
          createMessage({ messageId: undefined }),
          createMessage({
            messageId: 'msg-1',
            attachments: [
              {
                id: 'att-1',
                filename: 'a.txt',
                mimeType: 'text/plain',
                size: 1,
                filePath: testAttachmentFilePath,
              },
            ],
          }),
        ],
      },
      ports
    );

    expect(ids.size).toBe(0);
    expect(ports.resolveOpenCodeMemberDeliveryIdentity).not.toHaveBeenCalled();
  });

  it('attempts lane recovery when the lane index is not active', async () => {
    const ports = createPorts({
      readLaneState: vi.fn().mockResolvedValue('stopped'),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: vi
        .fn()
        .mockResolvedValue(true),
    });

    const ids = await getOpenCodeAgendaSyncRecoveryBypassMessageIds(
      {
        teamName: 'alpha',
        memberName: 'dev',
        workSyncIntent: 'agenda_sync',
        taskRefs: [taskRef],
        foregroundMessages: [createMessage()],
      },
      ports
    );

    expect(
      ports.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive
    ).toHaveBeenCalledWith({ teamName: 'alpha', memberName: 'dev', laneId: 'lane-1' });
    expect([...ids]).toEqual(['msg-1']);
  });

  it('requires failed terminal proof-missing records with overlapping task refs', async () => {
    const ids = await getOpenCodeAgendaSyncRecoveryBypassMessageIds(
      {
        teamName: 'alpha',
        memberName: 'dev',
        workSyncIntent: 'agenda_sync',
        taskRefs: [taskRef],
        foregroundMessages: [createMessage()],
      },
      createPorts({
        listOpenCodePromptDeliveryLedgerRecords: vi
          .fn()
          .mockResolvedValue([
            createRecord({ taskRefs: [{ teamName: 'alpha', taskId: 'task-2', displayId: 'T-2' }] }),
            createRecord({ status: 'accepted' }),
            createRecord({ lastReason: 'other failure' }),
          ]),
      })
    );

    expect(ids.size).toBe(0);
  });
});
