import { readFileSync } from 'node:fs';
import { transformWithEsbuild } from 'vite';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual main entrypoint callback, with its I/O boundaries injected.
// Importing index itself would boot Electron and unrelated provider services.
async function inboxHarness() {
  const source = readFileSync('src/main/index.ts', 'utf8');
  const start = source.indexOf('async function notifyNewInboxMessages(');
  const end = source.indexOf('\n/**', start);
  const { code } = await transformWithEsbuild(source.slice(start, end), 'inbox.ts');
  let messages: Record<string, unknown>[] = [];
  const addTeamNotification = vi.fn(async () => undefined);
  const dependencies = {
    logger: { debug() {}, warn() {} },
    configManager: { getConfig: () => ({ notifications: { enabled: true, notifyOnLeadInbox: true } }) },
    existsSync: () => true,
    join: (...parts: string[]) => parts.join('/'),
    getTeamsBasePath: () => 'fixture',
    teamDataService: { getLeadMemberName: async () => 'team-lead' },
    teamInboxReader: { getMessagesFor: async () => messages },
    inboxMessageCounts: new Map(),
    resolveTeamDisplayName: async () => 'Fixture',
    suppressedSources: new Set(['user_sent']),
    isTeamInternalControlMessageEnvelope: () => false,
    isReviewPickupEscalationMessage: () => false,
    shouldSuppressDesktopNotificationForInboxText: () => false,
    extractNotificationContent: (text: string) => ({ summary: text, body: text }),
    notificationManager: { addTeamNotification },
  };
  const notify = new Function(...Object.keys(dependencies), `${code}; return notifyNewInboxMessages;`)(
    ...Object.values(dependencies)
  ) as (team: string, detail: string) => Promise<void>;
  await notify('fixture', 'inboxes/team-lead.json');
  return {
    addTeamNotification,
    async append(message: Record<string, unknown>) {
      messages = [message, ...messages];
      await notify('fixture', 'inboxes/team-lead.json');
    },
  };
}

describe('main inbox task comment forwarding', () => {
  it('does not turn historical or fresh lead forwarding envelopes into user notifications', async () => {
    const harness = await inboxHarness();
    for (const author of ['removed-teammate', 'active-teammate']) {
      await harness.append({
        from: author, source: 'system_notification', messageKind: 'task_comment_notification',
        summary: 'Comment on #abcd1234', text: 'Forwarded task comment', timestamp: new Date().toISOString(),
      });
    }
    expect(harness.addTeamNotification).not.toHaveBeenCalled();
  });

  it('preserves ordinary inbox messages even from an author no longer on the team', async () => {
    const harness = await inboxHarness();
    await harness.append({ from: 'removed-teammate', text: 'A genuine new message', timestamp: 'now' });
    expect(harness.addTeamNotification).toHaveBeenCalledWith(expect.objectContaining({
      teamEventType: 'lead_inbox', from: 'removed-teammate', body: 'A genuine new message',
    }));
  });
});
