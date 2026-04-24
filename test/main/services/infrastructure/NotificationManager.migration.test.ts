import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn().mockImplementation(() => ({
      show: vi.fn(),
      on: vi.fn(),
    })),
    { isSupported: vi.fn().mockReturnValue(false) }
  ),
  BrowserWindow: vi.fn(),
}));

function createConfigManagerStub() {
  return {
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
  };
}

describe('NotificationManager storage migration', () => {
  let tempHome: string | null = null;

  afterEach(() => {
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = null;
    }
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function useTempHome(): string {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-migration-home-'));
    vi.stubEnv('HOME', tempHome);
    return tempHome;
  }

  function makeStoredNotification(id: string) {
    return {
      id,
      title: id,
      message: 'Copied',
      timestamp: new Date().toISOString(),
      type: 'error',
      isRead: false,
      createdAt: Date.now(),
    };
  }

  it('copies legacy notification history to the new Agent Teams filename', async () => {
    const home = useTempHome();
    const legacyPath = path.join(home, '.claude', 'claude-devtools-notifications.json');
    const currentPath = path.join(home, '.claude', 'agent-teams-notifications.json');
    const legacyNotifications = [makeStoredNotification('legacy-notification')];
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(legacyNotifications), 'utf8');

    const { NotificationManager } =
      await import('../../../../src/main/services/infrastructure/NotificationManager');
    const manager = new NotificationManager(createConfigManagerStub() as never);
    await manager.initialize();

    const result = await manager.getNotifications({ limit: 10 });
    expect(result.notifications.map((notification) => notification.id)).toEqual([
      'legacy-notification',
    ]);
    expect(JSON.parse(fs.readFileSync(currentPath, 'utf8'))).toEqual(legacyNotifications);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('keeps existing Agent Teams notification history when legacy history also exists', async () => {
    const home = useTempHome();
    const legacyPath = path.join(home, '.claude', 'claude-devtools-notifications.json');
    const currentPath = path.join(home, '.claude', 'agent-teams-notifications.json');
    const currentNotifications = [makeStoredNotification('current-notification')];
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify([{ ...currentNotifications[0], id: 'legacy-notification' }]),
      'utf8'
    );
    fs.writeFileSync(currentPath, JSON.stringify(currentNotifications), 'utf8');

    const { NotificationManager } =
      await import('../../../../src/main/services/infrastructure/NotificationManager');
    const manager = new NotificationManager(createConfigManagerStub() as never);
    await manager.initialize();

    const result = await manager.getNotifications({ limit: 10 });
    expect(result.notifications.map((notification) => notification.id)).toEqual([
      'current-notification',
    ]);
    expect(JSON.parse(fs.readFileSync(currentPath, 'utf8'))).toEqual(currentNotifications);
  });

  it('copies pre-devtools notification history when newer legacy history is absent', async () => {
    const home = useTempHome();
    const legacyPath = path.join(home, '.claude', 'claude-code-context-notifications.json');
    const currentPath = path.join(home, '.claude', 'agent-teams-notifications.json');
    const legacyNotifications = [makeStoredNotification('pre-devtools-notification')];
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(legacyNotifications), 'utf8');

    const { NotificationManager } =
      await import('../../../../src/main/services/infrastructure/NotificationManager');
    const manager = new NotificationManager(createConfigManagerStub() as never);
    await manager.initialize();

    const result = await manager.getNotifications({ limit: 10 });
    expect(result.notifications.map((notification) => notification.id)).toEqual([
      'pre-devtools-notification',
    ]);
    expect(JSON.parse(fs.readFileSync(currentPath, 'utf8'))).toEqual(legacyNotifications);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('prefers valid older notification history over an invalid newer legacy file', async () => {
    const home = useTempHome();
    const invalidNewerLegacyPath = path.join(home, '.claude', 'claude-devtools-notifications.json');
    const validOlderLegacyPath = path.join(
      home,
      '.claude',
      'claude-code-context-notifications.json'
    );
    const currentPath = path.join(home, '.claude', 'agent-teams-notifications.json');
    const legacyNotifications = [makeStoredNotification('older-valid-notification')];
    fs.mkdirSync(path.dirname(invalidNewerLegacyPath), { recursive: true });
    fs.writeFileSync(invalidNewerLegacyPath, '', 'utf8');
    fs.writeFileSync(validOlderLegacyPath, JSON.stringify(legacyNotifications), 'utf8');

    const { NotificationManager } =
      await import('../../../../src/main/services/infrastructure/NotificationManager');
    const manager = new NotificationManager(createConfigManagerStub() as never);
    await manager.initialize();

    const result = await manager.getNotifications({ limit: 10 });
    expect(result.notifications.map((notification) => notification.id)).toEqual([
      'older-valid-notification',
    ]);
    expect(JSON.parse(fs.readFileSync(currentPath, 'utf8'))).toEqual(legacyNotifications);
  });

  it('recovers and compacts a notification history file with concatenated JSON', async () => {
    const home = useTempHome();
    const currentPath = path.join(home, '.claude', 'agent-teams-notifications.json');
    const currentNotifications = [makeStoredNotification('current-valid-notification')];
    const trailingNotifications = [makeStoredNotification('trailing-garbage-notification')];
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(
      currentPath,
      `${JSON.stringify(currentNotifications, null, 2)}\n${JSON.stringify(trailingNotifications)}`,
      'utf8'
    );

    const { NotificationManager } =
      await import('../../../../src/main/services/infrastructure/NotificationManager');
    const manager = new NotificationManager(createConfigManagerStub() as never);
    await manager.initialize();

    const result = await manager.getNotifications({ limit: 10 });
    expect(result.notifications.map((notification) => notification.id)).toEqual([
      'current-valid-notification',
    ]);

    await vi.waitFor(() => {
      expect(JSON.parse(fs.readFileSync(currentPath, 'utf8'))).toEqual(currentNotifications);
    });
  });

  it('keeps notification history valid after rapid consecutive saves', async () => {
    const home = useTempHome();
    const currentPath = path.join(home, '.claude', 'agent-teams-notifications.json');

    const { NotificationManager } =
      await import('../../../../src/main/services/infrastructure/NotificationManager');
    const manager = new NotificationManager(createConfigManagerStub() as never);
    await manager.initialize();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        manager.addTeamNotification({
          teamEventType: 'user_inbox',
          teamName: 'team-a',
          teamDisplayName: 'Team A',
          from: 'alice',
          summary: `Message ${index}`,
          body: `Message ${index}`,
          dedupeKey: `rapid-save-${index}`,
          suppressToast: true,
        })
      )
    );

    await vi.waitFor(() => {
      const parsed = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Array<{ id: string }>;
      expect(parsed).toHaveLength(20);
    });
  });
});
