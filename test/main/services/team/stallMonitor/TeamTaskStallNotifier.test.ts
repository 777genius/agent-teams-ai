import { describe, expect, it, vi } from 'vitest';

import { TeamTaskStallNotifier } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallNotifier';

import type { TaskStallAlert } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';

function createAlert(overrides: Partial<TaskStallAlert> = {}): TaskStallAlert {
  return {
    teamName: 'demo',
    taskId: 'task-a',
    displayId: 'abcd1234',
    subject: 'Task A',
    branch: 'work',
    signal: 'turn_ended_after_touch',
    progressSignal: 'weak_start_only',
    reason: 'Potential work stall after weak start-only task comment.',
    epochKey: 'task-a:work:turn_ended_after_touch:stamp:file:msg:tool',
    owner: 'alice',
    ownerProviderId: 'opencode',
    taskRef: {
      taskId: 'task-a',
      displayId: 'abcd1234',
      teamName: 'demo',
    },
    ...overrides,
  };
}

describe('TeamTaskStallNotifier', () => {
  it('sends OpenCode owner nudges with deterministic message ids', async () => {
    const teamDataService = {
      sendSystemNotificationToLead: vi.fn(async () => undefined),
    };
    const teamProvisioningService = {
      relayOpenCodeMemberInboxMessages: vi.fn(async () => ({
        relayed: 1,
        attempted: 1,
        delivered: 1,
        failed: 0,
        lastDelivery: { delivered: true, accepted: true },
      })),
    };
    const inboxReader = {
      getMessagesFor: vi.fn(async () => []),
    };
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg' })),
    };
    const notifier = new TeamTaskStallNotifier(
      teamDataService as never,
      teamProvisioningService as never,
      inboxReader as never,
      inboxWriter as never
    );
    const alert = createAlert();
    const messageId = `task-stall:demo:task-a:${alert.epochKey}`;

    await expect(notifier.notifyOpenCodeOwners('demo', [alert])).resolves.toEqual([alert]);

    expect(inboxWriter.sendMessage).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        member: 'alice',
        from: 'system',
        to: 'alice',
        messageId,
        summary: 'Potential stalled task',
        taskRefs: [alert.taskRef],
        actionMode: 'do',
        source: 'system_notification',
      })
    );
    expect(teamProvisioningService.relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith(
      'demo',
      'alice',
      {
        onlyMessageId: messageId,
        source: 'watchdog',
        deliveryMetadata: {
          replyRecipient: 'user',
          actionMode: 'do',
          taskRefs: [alert.taskRef],
        },
      }
    );
    expect(teamDataService.sendSystemNotificationToLead).not.toHaveBeenCalled();
  });

  it('skips non-OpenCode owners', async () => {
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      {
        relayOpenCodeMemberInboxMessages: vi.fn(async () => ({
          lastDelivery: { delivered: true },
        })),
      } as never,
      { getMessagesFor: vi.fn(async () => []) } as never,
      { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg' })) } as never
    );

    await expect(
      notifier.notifyOpenCodeOwners('demo', [
        createAlert({ ownerProviderId: 'codex', owner: 'alice' }),
      ])
    ).resolves.toEqual([]);
  });

  it('skips review alerts because task owner is not necessarily the reviewer', async () => {
    const relay = vi.fn(async () => ({ lastDelivery: { delivered: true } }));
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      { relayOpenCodeMemberInboxMessages: relay } as never,
      { getMessagesFor: vi.fn(async () => []) } as never,
      { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg' })) } as never
    );

    await expect(
      notifier.notifyOpenCodeOwners('demo', [
        createAlert({ branch: 'review', ownerProviderId: 'opencode', owner: 'alice' }),
      ])
    ).resolves.toEqual([]);
    expect(relay).not.toHaveBeenCalled();
  });

  it('returns no remediated alert when OpenCode delivery is rejected', async () => {
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      {
        relayOpenCodeMemberInboxMessages: vi.fn(async () => ({
          relayed: 0,
          attempted: 1,
          delivered: 0,
          failed: 1,
          lastDelivery: {
            delivered: false,
            reason: 'opencode_runtime_not_active',
          },
        })),
      } as never,
      { getMessagesFor: vi.fn(async () => []) } as never,
      { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg' })) } as never
    );

    await expect(notifier.notifyOpenCodeOwners('demo', [createAlert()])).resolves.toEqual([]);
  });

  it('does not mark queued-behind delivery as remediated even when active ledger exists', async () => {
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      {
        relayOpenCodeMemberInboxMessages: vi.fn(async () => ({
          relayed: 0,
          attempted: 1,
          delivered: 0,
          failed: 0,
          lastDelivery: {
            delivered: true,
            accepted: false,
            responsePending: true,
            ledgerRecordId: 'active-ledger-record',
            queuedBehindMessageId: 'msg-active',
            reason: 'opencode_delivery_response_pending',
          },
        })),
      } as never,
      { getMessagesFor: vi.fn(async () => []) } as never,
      { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg' })) } as never
    );

    await expect(notifier.notifyOpenCodeOwners('demo', [createAlert()])).resolves.toEqual([]);
  });

  it('does not mark response-pending delivery as remediated even after runtime acceptance', async () => {
    const relay = vi.fn(async () => ({
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: true,
        ledgerRecordId: 'active-ledger-record',
        reason: 'opencode_delivery_response_pending',
      },
    }));
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      { relayOpenCodeMemberInboxMessages: relay } as never,
      { getMessagesFor: vi.fn(async () => []) } as never,
      { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg' })) } as never
    );

    await expect(notifier.notifyOpenCodeOwners('demo', [createAlert()])).resolves.toEqual([]);
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('does not deliver runtime nudge when inbox write fails', async () => {
    const relay = vi.fn(async () => ({ lastDelivery: { delivered: true } }));
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      { relayOpenCodeMemberInboxMessages: relay } as never,
      { getMessagesFor: vi.fn(async () => []) } as never,
      { sendMessage: vi.fn(async () => { throw new Error('disk full'); }) } as never
    );

    await expect(notifier.notifyOpenCodeOwners('demo', [createAlert()])).resolves.toEqual([]);
    expect(relay).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'OpenCode task stall remediation inbox write failed'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('does not write or relay when existing inbox read fails', async () => {
    const relay = vi.fn(async () => ({ lastDelivery: { delivered: true } }));
    const inboxWrite = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg' }));
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      { relayOpenCodeMemberInboxMessages: relay } as never,
      { getMessagesFor: vi.fn(async () => { throw new Error('read failed'); }) } as never,
      { sendMessage: inboxWrite } as never
    );

    await expect(notifier.notifyOpenCodeOwners('demo', [createAlert()])).resolves.toEqual([]);
    expect(inboxWrite).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'OpenCode task stall remediation inbox write failed'
    );
    vi.mocked(console.warn).mockClear();
  });
});
