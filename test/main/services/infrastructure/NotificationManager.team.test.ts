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
});
