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

    // Measured at the four-vCPU CI quota: each durable save costs ~37-46ms
    // (temp fsync + rename), so 20 rapid chained saves complete the full
    // snapshot just past the 1s default wait. The 5s window keeps the exact
    // 20-item assertion while sizing to the measured work (~5x margin).
    await vi.waitFor(
      () => {
        const parsed = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as { id: string }[];
        expect(parsed).toHaveLength(20);
      },
      { timeout: 5_000 }
    );
  });
});

describe('NotificationManager storage under the app Claude root', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function storedNotification(id: string) {
    return {
      id,
      title: id,
      message: 'Stored',
      timestamp: new Date().toISOString(),
      type: 'error',
      isRead: false,
      createdAt: Date.now(),
    };
  }

  async function loadModules() {
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    const { getNotificationsPath } =
      await import('../../../../src/main/services/infrastructure/notificationHistoryFile');
    const { NotificationManager } =
      await import('../../../../src/main/services/infrastructure/NotificationManager');
    return { pathDecoder, getNotificationsPath, NotificationManager };
  }

  async function addOneNotification(
    manager: Pick<
      import('../../../../src/main/services/infrastructure/NotificationManager').NotificationManager,
      'addTeamNotification'
    >
  ): Promise<void> {
    await manager.addTeamNotification({
      teamEventType: 'user_inbox',
      teamName: 'team-a',
      teamDisplayName: 'Team A',
      from: 'alice',
      summary: 'Fresh message',
      body: 'Fresh message',
      dedupeKey: 'claude-root-fresh-message',
      suppressToast: true,
    });
  }

  it('keeps ~/.claude/agent-teams-notifications.json when the default root is used', async () => {
    const home = makeTempDir('notification-root-home-');
    vi.stubEnv('HOME', home);
    const homePath = path.join(home, '.claude', 'agent-teams-notifications.json');
    fs.mkdirSync(path.dirname(homePath), { recursive: true });
    fs.writeFileSync(homePath, JSON.stringify([storedNotification('home-notification')]), 'utf8');

    const { getNotificationsPath, NotificationManager } = await loadModules();
    expect(getNotificationsPath()).toBe(homePath);
    const manager = new NotificationManager(createConfigManagerStub() as never);
    await manager.initialize();
    await addOneNotification(manager);

    expect((await manager.getNotifications({ limit: 10 })).notifications).toHaveLength(2);
    await vi.waitFor(() => {
      expect(JSON.parse(fs.readFileSync(homePath, 'utf8'))).toHaveLength(2);
    });
  });

  it('reads and writes under a Claude root configured after startup and leaves ~/.claude alone', async () => {
    const home = makeTempDir('notification-root-home-');
    const claudeRoot = makeTempDir('notification-root-claude-');
    vi.stubEnv('HOME', home);
    const homeDir = path.join(home, '.claude');
    fs.mkdirSync(homeDir, { recursive: true });
    const homeFiles = {
      'agent-teams-notifications.json': JSON.stringify([storedNotification('home-notification')]),
      'claude-devtools-notifications.json': JSON.stringify([storedNotification('home-legacy')]),
    };
    for (const [name, data] of Object.entries(homeFiles)) {
      fs.writeFileSync(path.join(homeDir, name), data, 'utf8');
    }

    const { pathDecoder, getNotificationsPath, NotificationManager } = await loadModules();
    // Applied after the history module loaded, like a configured root at runtime.
    pathDecoder.setClaudeBasePathOverride(claudeRoot);
    try {
      const rootPath = path.join(claudeRoot, 'agent-teams-notifications.json');
      expect(getNotificationsPath()).toBe(rootPath);
      const manager = new NotificationManager(createConfigManagerStub() as never);
      await manager.initialize();

      // Nothing is migrated from ~/.claude into the configured root.
      expect((await manager.getNotifications({ limit: 10 })).notifications).toEqual([]);
      await addOneNotification(manager);
      await vi.waitFor(() => {
        const stored = JSON.parse(fs.readFileSync(rootPath, 'utf8')) as { summary?: string }[];
        expect(stored).toHaveLength(1);
      });
      expect(
        Object.fromEntries(
          fs
            .readdirSync(homeDir)
            .map((name) => [name, fs.readFileSync(path.join(homeDir, name), 'utf8')])
        )
      ).toEqual(homeFiles);
    } finally {
      pathDecoder.setClaudeBasePathOverride(null);
    }
  });
  it('migrates a legacy history file that lives in the configured Claude root', async () => {
    const home = makeTempDir('notification-root-home-');
    const claudeRoot = makeTempDir('notification-root-claude-');
    vi.stubEnv('HOME', home);
    const legacyNotifications = [storedNotification('root-legacy-notification')];
    fs.writeFileSync(
      path.join(claudeRoot, 'claude-devtools-notifications.json'),
      JSON.stringify(legacyNotifications),
      'utf8'
    );

    const { pathDecoder, NotificationManager } = await loadModules();
    pathDecoder.setClaudeBasePathOverride(claudeRoot);
    try {
      const manager = new NotificationManager(createConfigManagerStub() as never);
      await manager.initialize();

      expect(
        (await manager.getNotifications({ limit: 10 })).notifications.map(({ id }) => id)
      ).toEqual(['root-legacy-notification']);
      expect(
        JSON.parse(fs.readFileSync(path.join(claudeRoot, 'agent-teams-notifications.json'), 'utf8'))
      ).toEqual(legacyNotifications);
      expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    } finally {
      pathDecoder.setClaudeBasePathOverride(null);
    }
  });
});
