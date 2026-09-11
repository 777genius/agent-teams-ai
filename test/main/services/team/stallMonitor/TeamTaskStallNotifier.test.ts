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
  it('records stall observations into member-work-sync instead of sending owner commands', async () => {
    const record = vi.fn(async () => undefined);
    const inboxWriter = { sendMessage: vi.fn() };
    const relay = vi.fn();
    const notifier = new TeamTaskStallNotifier(
      { sendSystemNotificationToLead: vi.fn(async () => undefined) } as never,
      { relayOpenCodeMemberInboxMessages: relay } as never,
      { getMessagesFor: vi.fn(async () => []) } as never,
      inboxWriter as never,
      { record }
    );

    await expect(notifier.notifyOpenCodeOwners('demo', [createAlert()])).resolves.toEqual([]);
    expect(record).toHaveBeenCalledWith({
      teamName: 'demo',
      memberName: 'alice',
      taskId: 'task-a',
      reason: 'Potential work stall after weak start-only task comment.',
      observedAt: expect.any(String),
    });
    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
  });

  it('still notifies the lead for user-visible stall attention', async () => {
    const sendSystemNotificationToLead = vi.fn(async () => undefined);
    const notifier = new TeamTaskStallNotifier({ sendSystemNotificationToLead } as never);
    const alert = createAlert();

    await notifier.notifyLead('demo', [alert]);

    expect(sendSystemNotificationToLead).toHaveBeenCalledWith({
      teamName: 'demo',
      summary: 'Potential stalled tasks detected',
      text: expect.stringContaining('Task A'),
      taskRefs: [alert.taskRef],
    });
  });
});
