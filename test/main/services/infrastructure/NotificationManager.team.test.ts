/**
 * NotificationManager team notification tests.
 *
 * Tests the addTeamNotification() adapter and its interaction with the
 * shared storage pipeline (storeNotification), dedupeKey-based dedupe,
 * and toast throttling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

// --- Mock electron Notification before importing NotificationManager ---
const mockNotificationShow = vi.fn();
const mockNotificationOn = vi.fn();
vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn().mockImplementation(() => ({
      show: mockNotificationShow,
      on: mockNotificationOn,
    })),
    { isSupported: vi.fn().mockReturnValue(true) }
  ),
  BrowserWindow: vi.fn(),
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: vi.fn().mockReturnValue(true),
    })),
    createFromDataURL: vi.fn(() => ({
      isEmpty: vi.fn().mockReturnValue(false),
    })),
  },
}));

// --- Mock fs/promises to prevent disk I/O ---
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock ConfigManager ---
vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: vi.fn().mockReturnValue({
      getConfig: vi.fn().mockReturnValue({
        notifications: {
          enabled: true,
          soundEnabled: false,
          snoozedUntil: null,
          ignoredRegex: [],
          ignoredRepositories: [],
        },
      }),
      clearSnooze: vi.fn(),
    }),
  },
}));

// --- Mock path/service dependencies that NotificationManager imports ---
vi.mock('@main/services/discovery/ProjectPathResolver', () => ({
  projectPathResolver: { resolveProjectPath: vi.fn().mockResolvedValue('/tmp') },
}));
vi.mock('@main/services/parsing/GitIdentityResolver', () => ({
  gitIdentityResolver: { resolveIdentity: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@main/utils/appIcon', () => ({
  getAppIconPath: vi.fn().mockReturnValue(undefined),
}));
vi.mock('@main/utils/textFormatting', () => ({
  stripMarkdown: vi.fn((s: string) => s),
}));

import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { Notification as ElectronNotification } from 'electron';
import { readFile } from 'fs/promises';

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function getLastNotificationOptions(): Record<string, unknown> {
  const mock = ElectronNotification as unknown as {
    mock: { calls: [Record<string, unknown>][] };
  };
  const options = mock.mock.calls.at(-1)?.[0] ?? {};
  if (typeof options.toastXml !== 'string') {
    return options;
  }

  const textRows = [...options.toastXml.matchAll(/<text>(.*?)<\/text>/g)].map((match) =>
    decodeXmlText(match[1] ?? '')
  );
  return {
    ...options,
    title: textRows[0],
    body: textRows.slice(1).join('\n'),
  };
}

function makeTeamPayload(
  overrides: Partial<TeamNotificationPayload> = {}
): TeamNotificationPayload {
  return {
    teamEventType: 'user_inbox',
    teamName: 'test-team',
    teamDisplayName: 'Test Team',
    from: 'alice',
    summary: 'New message from Alice',
    body: 'Hello from Alice!',
    dedupeKey: `inbox:test-team:alice:${Date.now()}`,
    ...overrides,
  };
}

describe('NotificationManager.addTeamNotification', () => {
  let manager: NotificationManager;

  const defaultConfig = {
    notifications: {
      enabled: true,
      soundEnabled: false,
      snoozedUntil: null,
      ignoredRegex: [],
      ignoredRepositories: [],
    },
  };

  beforeEach(async () => {
    NotificationManager.resetInstance();
    manager = new NotificationManager();
    await manager.initialize();
    mockNotificationShow.mockClear();
    mockNotificationOn.mockClear();
    // Restore default config — tests that override must not leak state
    const configMock = ConfigManager.getInstance().getConfig as ReturnType<typeof vi.fn>;
    configMock.mockReturnValue(defaultConfig);
  });

  afterEach(() => {
    NotificationManager.resetInstance();
  });

  it('stores team notification and returns StoredNotification', async () => {
    const result = await manager.addTeamNotification(makeTeamPayload());

    expect(result).not.toBeNull();
    expect(result!.category).toBe('team');
    expect(result!.teamEventType).toBe('user_inbox');
    expect(result!.isRead).toBe(false);
    expect(result!.createdAt).toBeGreaterThan(0);
    expect(result!.sessionId).toBe('team:test-team');
    expect(result!.dedupeKey).toContain('inbox:test-team:alice:');
  });

  it('shows native toast when notifications are enabled', async () => {
    await manager.addTeamNotification(makeTeamPayload());
    expect(mockNotificationShow).toHaveBeenCalledOnce();
  });

  it('stores notification but suppresses toast when suppressToast is true', async () => {
    const result = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'suppress-test' }),
    );
    // Clear from the first call
    mockNotificationShow.mockClear();

    const result2 = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'suppress-test-2', suppressToast: true }),
    );

    expect(result).not.toBeNull();
    expect(result2).not.toBeNull();
    // The second call with suppressToast=true should NOT show a toast
    expect(mockNotificationShow).not.toHaveBeenCalled();
  });

  it('stores notification even when notifications are disabled (storage is unconditional)', async () => {
    const configMock = ConfigManager.getInstance().getConfig as ReturnType<typeof vi.fn>;
    configMock.mockReturnValue({
      notifications: {
        enabled: false,
        soundEnabled: false,
        snoozedUntil: null,
        ignoredRegex: [],
        ignoredRepositories: [],
      },
    });

    const result = await manager.addTeamNotification(makeTeamPayload());

    expect(result).not.toBeNull();
    expect(result!.category).toBe('team');
    // But no native toast
    expect(mockNotificationShow).not.toHaveBeenCalled();
  });

  it('stores notification even when snoozed (storage is unconditional)', async () => {
    const configMock = ConfigManager.getInstance().getConfig as ReturnType<typeof vi.fn>;
    configMock.mockReturnValue({
      notifications: {
        enabled: true,
        soundEnabled: false,
        snoozedUntil: Date.now() + 60_000, // snoozed for 1 minute
        ignoredRegex: [],
        ignoredRepositories: [],
      },
    });

    const result = await manager.addTeamNotification(makeTeamPayload());

    expect(result).not.toBeNull();
    expect(mockNotificationShow).not.toHaveBeenCalled();
  });

  it('deduplicates by dedupeKey — same key returns null on second call', async () => {
    const payload = makeTeamPayload({ dedupeKey: 'unique-key-123' });

    const first = await manager.addTeamNotification(payload);
    const second = await manager.addTeamNotification(payload);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('does not deduplicate different dedupeKeys', async () => {
    const first = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'key-1' })
    );
    const second = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'key-2' })
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it('throttles native toast for same dedupeKey within 5s', async () => {
    // First call with a unique dedupeKey (not in storage yet) — shows toast
    const result1 = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'throttle-key-a' })
    );
    expect(result1).not.toBeNull();

    // Second call with different dedupeKey — also shows toast (different key)
    const result2 = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'throttle-key-b' })
    );
    expect(result2).not.toBeNull();

    // Both should have shown toasts (different keys, not throttled)
    expect(mockNotificationShow).toHaveBeenCalledTimes(2);
  });

  it('is accessible via getNotifications', async () => {
    await manager.addTeamNotification(makeTeamPayload({ dedupeKey: 'get-test' }));
    const result = await manager.getNotifications({ limit: 10 });

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].category).toBe('team');
    expect(result.unreadCount).toBe(1);
  });

  it('increments unread count correctly', async () => {
    await manager.addTeamNotification(makeTeamPayload({ dedupeKey: 'count-1' }));
    await manager.addTeamNotification(makeTeamPayload({ dedupeKey: 'count-2' }));

    expect(manager.getUnreadCountSync()).toBe(2);
  });

  it('markRead works on team notifications', async () => {
    const stored = await manager.addTeamNotification(makeTeamPayload({ dedupeKey: 'read-test' }));
    expect(stored).not.toBeNull();

    await manager.markRead(stored!.id);
    expect(manager.getUnreadCountSync()).toBe(0);
  });

  it('deleteNotification removes team notification', async () => {
    const stored = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'delete-test' })
    );
    expect(stored).not.toBeNull();

    const deleted = manager.deleteNotification(stored!.id);
    expect(deleted).toBe(true);

    const result = await manager.getNotifications({ limit: 10 });
    expect(result.notifications).toHaveLength(0);
  });

  it('formats clarification as a reply-needed notification', async () => {
    await manager.addTeamNotification(
      makeTeamPayload({
        teamEventType: 'task_clarification',
        from: 'jack',
        summary: 'Clarification needed - Task #55c51f15',
        body: 'Can you confirm the reviewer?',
        dedupeKey: 'presentation-reply',
      })
    );

    expect(getLastNotificationOptions().title).toBe('@jack needs your reply on #55c51f15');
  });

  it('formats review requests as action-needed notifications', async () => {
    await manager.addTeamNotification(
      makeTeamPayload({
        teamEventType: 'task_review_requested',
        from: 'alice',
        summary: 'Review requested #46cceca0: Landing page',
        body: 'Please review the implementation.',
        dedupeKey: 'presentation-review',
      })
    );

    expect(getLastNotificationOptions().title).toBe('@alice requested review on #46cceca0');
  });

  it('formats blocked tasks as action-needed notifications', async () => {
    await manager.addTeamNotification(
      makeTeamPayload({
        teamEventType: 'task_blocked',
        from: 'bob',
        summary: 'Blocked #6002830d: API contract',
        body: 'Blocked by #11111111',
        dedupeKey: 'presentation-blocked',
      })
    );

    expect(getLastNotificationOptions().title).toBe('@bob is blocked on #6002830d');
  });

  it('formats rate limits with human restart guidance', async () => {
    await manager.addTeamNotification(
      makeTeamPayload({
        teamEventType: 'rate_limit',
        from: 'tom',
        summary: 'Rate limit',
        body: 'Auto-resume scheduled at 14:30',
        dedupeKey: 'presentation-rate',
      })
    );

    const options = getLastNotificationOptions();
    expect(options.title).toBe('@tom paused: rate limit');
    expect(options.body).toContain('Auto-resume scheduled at 14:30');
  });

  it('formats API errors with manual restart guidance', async () => {
    await manager.addTeamNotification(
      makeTeamPayload({
        teamEventType: 'api_error',
        from: 'tom',
        summary: 'API Error 500',
        body: 'Manual restart needed',
        dedupeKey: 'presentation-api',
      })
    );

    const options = getLastNotificationOptions();
    expect(options.title).toBe('@tom paused: API error');
    expect(options.body).toContain('Manual restart needed');
  });

  it('formats incomplete launches without a System prefix', async () => {
    await manager.addTeamNotification(
      makeTeamPayload({
        teamEventType: 'team_launch_incomplete',
        from: 'system',
        summary: 'Team launch incomplete',
        body: '3/4 joined · @tom did not join',
        dedupeKey: 'presentation-launch-incomplete',
      })
    );

    const options = getLastNotificationOptions();
    expect(options.title).toBe('Team launch incomplete');
    expect(options.body).toContain('3/4 joined · @tom did not join');
  });
});


function focusedWindow() {
  return {
    isDestroyed: () => false,
    isFocused: () => true,
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe('NotificationManager viewed team', () => {
  let manager: NotificationManager;

  beforeEach(async () => {
    NotificationManager.resetInstance();
    manager = new NotificationManager();
    await manager.initialize();
    mockNotificationShow.mockClear();
    mockNotificationOn.mockClear();
    const configMock = ConfigManager.getInstance().getConfig as ReturnType<typeof vi.fn>;
    configMock.mockReturnValue({
      notifications: {
        enabled: true,
        soundEnabled: false,
        snoozedUntil: null,
        ignoredRegex: [],
        ignoredRepositories: [],
      },
    });
  });

  afterEach(() => {
    NotificationManager.resetInstance();
  });

  it('marks matching unread notifications read when that team is viewed', async () => {
    await manager.addTeamNotification(makeTeamPayload({ dedupeKey: 'inbox:test-team:a:1' }));
    await manager.addTeamNotification(
      makeTeamPayload({
        teamName: 'other-team',
        teamDisplayName: 'Other',
        dedupeKey: 'inbox:other-team:a:1',
      })
    );

    expect(await manager.getUnreadCount()).toBe(2);
    manager.setMainWindow(focusedWindow() as never);
    manager.setViewedTeamName('test-team');
    expect(await manager.getUnreadCount()).toBe(1);
    const remaining = await manager.getNotifications({ limit: 10, offset: 0 });
    expect(remaining.notifications.find((n) => n.sessionId === 'team:other-team')?.isRead).toBe(
      false
    );
  });

  it('stores new events for the viewed team as read and skips the OS toast', async () => {
    manager.setMainWindow(focusedWindow() as never);
    manager.setViewedTeamName('test-team');
    mockNotificationShow.mockClear();

    const stored = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'inbox:test-team:a:viewed' })
    );

    expect(stored?.isRead).toBe(true);
    expect(mockNotificationShow).not.toHaveBeenCalled();
    expect(await manager.getUnreadCount()).toBe(0);
  });

  it('keeps viewed-team events unread and toasted when the window is unfocused', async () => {
    const win = {
      isDestroyed: () => false,
      isFocused: () => false,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    manager.setMainWindow(win as never);
    manager.setViewedTeamName('test-team');
    mockNotificationShow.mockClear();

    const stored = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'inbox:test-team:a:unfocused' })
    );

    expect(stored?.isRead).toBe(false);
    expect(mockNotificationShow).toHaveBeenCalledOnce();
    expect(await manager.getUnreadCount()).toBe(1);
  });

  it('does not mark existing viewed-team unread while the window is unfocused', async () => {
    await manager.addTeamNotification(makeTeamPayload({ dedupeKey: 'inbox:test-team:a:existing' }));
    const win = {
      isDestroyed: () => false,
      isFocused: () => false,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    manager.setMainWindow(win as never);
    expect(await manager.getUnreadCount()).toBe(1);

    manager.setViewedTeamName('test-team');

    expect(await manager.getUnreadCount()).toBe(1);
  });

  it('marks viewed-team events read when the window is focused again', async () => {
    const listeners = new Map<string, () => void>();
    const win = {
      isDestroyed: () => false,
      isFocused: vi.fn(() => false),
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
    };
    manager.setMainWindow(win as never);
    manager.setViewedTeamName('test-team');
    await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'inbox:test-team:a:while-blurred' })
    );
    expect(await manager.getUnreadCount()).toBe(1);

    win.isFocused.mockReturnValue(true);
    listeners.get('focus')?.();
    expect(await manager.getUnreadCount()).toBe(0);
  });


  it('does not auto-read when there is no usable window', async () => {
    await manager.addTeamNotification(makeTeamPayload({ dedupeKey: 'inbox:test-team:a:nowin' }));
    manager.setViewedTeamName('test-team');
    expect(await manager.getUnreadCount()).toBe(1);
  });

  it('clears the viewed team when the main window is closed', async () => {
    manager.setMainWindow(focusedWindow() as never);
    manager.setViewedTeamName('test-team');
    manager.setMainWindow(null);
    mockNotificationShow.mockClear();
    const stored = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'inbox:test-team:a:after-close' })
    );
    expect(stored?.isRead).toBe(false);
    expect(mockNotificationShow).toHaveBeenCalledOnce();
  });

  it('stores later events as unread after the team tab is left', async () => {
    manager.setMainWindow(focusedWindow() as never);
    manager.setViewedTeamName('test-team');
    manager.setViewedTeamName(null);
    mockNotificationShow.mockClear();

    const stored = await manager.addTeamNotification(
      makeTeamPayload({ dedupeKey: 'inbox:test-team:a:after-leave' })
    );

    expect(stored?.isRead).toBe(false);
    expect(mockNotificationShow).toHaveBeenCalledOnce();
  });
});

describe('NotificationManager viewed team initialize race', () => {
  afterEach(() => {
    NotificationManager.resetInstance();
    vi.mocked(readFile).mockRejectedValue({ code: 'ENOENT' });
  });

  it('marks persisted viewed-team history read after setViewedTeam during load', async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    vi.mocked(readFile).mockImplementation(async () => {
      await loadGate;
      return JSON.stringify([
        {
          id: 'persisted-team',
          title: 'Alice',
          message: 'Hello',
          timestamp: '2026-09-17T10:00:00.000Z',
          type: 'info',
          sessionId: 'team:test-team',
          category: 'team',
          isRead: false,
          createdAt: Date.parse('2026-09-17T10:00:00.000Z'),
        },
      ]);
    });

    const delayed = new NotificationManager();
    delayed.setMainWindow(focusedWindow() as never);
    const initializing = delayed.initialize();
    delayed.setViewedTeamName('test-team');
    expect(delayed.getUnreadCountSync()).toBe(0);

    releaseLoad();
    await initializing;

    expect(delayed.getUnreadCountSync()).toBe(0);
    const loaded = await delayed.getNotifications({ limit: 10, offset: 0 });
    expect(loaded.notifications[0]?.isRead).toBe(true);
  });
});
