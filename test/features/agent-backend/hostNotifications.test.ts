import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareHostNotification } from '../../../src/features/agent-backend/main/application/prepareHostNotification';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { createNotificationSlice } from '../../../src/renderer/store/slices/notificationSlice';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { HostNotificationSource } from '../../../src/features/agent-backend/main/application/prepareHostNotification';
import type { NotificationManager as Manager } from '../../../src/main/services/infrastructure/NotificationManager';
import type { AppState } from '../../../src/renderer/store/types';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { TeamMessageNotificationData } from '../../../src/shared/types/team';

const fixturePaths = vi.hoisted(() => ({
  root: '/TEST-notification-unconfigured',
  show: vi.fn(),
  manager: null as unknown as Manager,
}));
vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn(() => ({ show: fixturePaths.show, on: vi.fn() })),
    { isSupported: () => true }
  ),
  nativeImage: undefined,
}));
vi.mock('@renderer/api', () => ({ api: { notifications: {} } }));
vi.mock('../../../src/main/services', () => ({
  NotificationManager: { getInstance: () => fixturePaths.manager },
}));
vi.mock('@main/utils/pathDecoder', () => ({
  getHomeDir: () => fixturePaths.root,
  getAppDataPath: () => fixturePaths.root,
  getTeamsBasePath: () => {
    throw new Error('TEST legacy Team reader forbidden');
  },
}));
vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: () => ({
      getConfig: () => ({
        notifications: { enabled: false, soundEnabled: false, snoozedUntil: null },
      }),
    }),
  },
}));
vi.mock('@main/services/discovery/ProjectPathResolver', () => ({ projectPathResolver: {} }));
vi.mock('@main/services/parsing/GitIdentityResolver', () => ({ gitIdentityResolver: {} }));
vi.mock('@main/utils/appIcon', () => ({ getAppIconPath: () => undefined }));

let NotificationManager: typeof Manager;
beforeAll(async () => {
  fixturePaths.root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-notifications-')));
  ({ NotificationManager } =
    await import('../../../src/main/services/infrastructure/NotificationManager'));
});
beforeEach(() => {
  fixturePaths.show.mockClear();
  NotificationManager.resetInstance();
});
afterAll(() => {
  NotificationManager.resetInstance();
  rmSync(fixturePaths.root, { recursive: true, force: true });
});

function fixture() {
  const key = hostTeamSelectionKey('TEST-original-handle');
  const connection = {
    handle: { handleId: 'TEST-original-handle' },
    label: 'Original Host Team',
    ownerResourceRef: 'TEST-owner-A',
    teamResourceRef: 'TEST-Team-A',
    members: [],
  };
  const snapshot: BackendTeamSnapshot = {
    teamName: 'same-name',
    revision: 'a'.repeat(64),
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333',
      sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    members: [{ name: 'alice', role: 'lead' }],
    tasks: [{ id: 'TEST-original-task', subject: 'Original task', status: 'completed' }],
    messages: [],
    kanbanState: { teamName: 'same-name', reviewers: [], tasks: {} },
  };
  let current = true;
  const read = vi.fn(async () => structuredClone(snapshot));
  const source: HostNotificationSource = {
    initialize: async () => {},
    isCurrent: () => current,
    connection: (handle) =>
      handle.handleId === connection.handle.handleId ? connection : undefined,
    readSnapshot: read,
  };
  const data: TeamMessageNotificationData = {
    teamName: key,
    teamDisplayName: 'Untrusted display',
    from: 'alice',
    body: 'Original task needs attention',
    dedupeKey: crypto.randomUUID(),
    teamEventType: 'task_review_requested',
    suppressToast: true,
    target: { kind: 'task', teamName: key, taskId: 'TEST-original-task', focus: 'review' },
  };
  return {
    key,
    connection,
    source,
    snapshot,
    data,
    read,
    revoke: () => {
      current = false;
    },
  };
}

describe('original Host notification destination', () => {
  it('uses the existing viewed-Team IPC and Manager read state for a focused Host destination', async () => {
    const f = fixture(),
      manager = NotificationManager.getInstance();
    await manager.initialize();
    fixturePaths.manager = manager;
    manager.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      on: vi.fn(),
      removeListener: vi.fn(),
      webContents: { isDestroyed: () => false, send: vi.fn() },
    } as unknown as Parameters<Manager['setMainWindow']>[0]);
    const captured = await prepareHostNotification(f.source, f.data);
    const initial = await manager.addTeamNotification(captured.payload, captured.assertCurrent);
    expect(initial?.isRead).toBe(false);
    const { registerNotificationHandlers } = await import('../../../src/main/ipc/notifications');
    const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
    registerNotificationHandlers({
      handle(channel: string, callback: (event: unknown, value: unknown) => unknown) {
        handlers.set(channel, callback);
      },
      removeHandler: vi.fn(),
    } as unknown as Parameters<typeof registerNotificationHandlers>[0]);
    const viewed = handlers.get('notifications:setViewedTeam')!;
    expect(await viewed({}, f.key)).toBe(true);
    expect(
      (await manager.getNotifications()).notifications.find((row) => row.id === initial!.id)?.isRead
    ).toBe(true);
    const next = await manager.addTeamNotification(
      { ...captured.payload, dedupeKey: captured.payload.dedupeKey + ':focused' },
      captured.assertCurrent
    );
    expect(next?.isRead).toBe(true);
    expect(await viewed({}, 'host-team:%not-canonical')).toBe(false);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '[IPC:notifications]',
      'notifications:setViewedTeam rejected: Invalid Host notification destination'
    );
    vi.mocked(console.error).mockClear();
    expect(fixturePaths.show).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        JSON.parse(
          readFileSync(join(fixturePaths.root, '.claude/agent-teams-notifications.json'), 'utf8')
        )
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: next!.id, isRead: true })]))
    );
    manager.setMainWindow(null);
  });
  it('stores through the existing Manager and reloads the original Task navigation and quick action after default owner changes', async () => {
    const f = fixture(),
      manager = NotificationManager.getInstance();
    await manager.initialize();
    const admit = vi.fn(async (raw: TeamMessageNotificationData) => {
      const captured = await prepareHostNotification(f.source, raw);
      await manager.addTeamNotification(captured.payload, captured.assertCurrent);
    });
    const legacy = {
      showMessageNotification: admit,
      getTask: vi.fn(() => {
        throw new Error('TEST no legacy task');
      }),
    } as unknown as TeamsAPI;
    let replacementDefault = false;
    const backend = {
      getConnections: vi.fn(async () => ({
        state: 'ready',
        bindings: replacementDefault
          ? [
              {
                ...f.connection,
                handle: { handleId: 'TEST-new-default' },
                ownerResourceRef: 'TEST-owner-B',
              },
              f.connection,
            ]
          : [f.connection],
      })),
      invoke: vi.fn(async () => ({ ok: true, value: structuredClone(f.snapshot) })),
    } as unknown as AgentBackendApi;
    const api = createHostTeamsApi(legacy, backend);
    await api.showMessageNotification(f.data);
    expect(admit).toHaveBeenCalledOnce();
    const path = join(fixturePaths.root, '.claude/agent-teams-notifications.json');
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dedupeKey: expect.stringContaining(f.data.dedupeKey!),
            target: {
              kind: 'task',
              teamName: f.key,
              taskId: 'TEST-original-task',
              focus: 'review',
            },
          }),
        ])
      )
    );
    const cold = new NotificationManager();
    await cold.initialize();
    const stored = (await cold.getNotifications()).notifications.find((row) =>
      row.dedupeKey?.includes(f.data.dedupeKey!)
    )!;
    expect(stored.context.projectName).toBe('Original Host Team');
    replacementDefault = true;
    const reloadedApi = createHostTeamsApi(legacy, backend);
    const openTeamTab = vi.fn(),
      taskAction = vi.fn((team: string, task: string) => reloadedApi.getTask(team, task));
    const state = {
      openTeamTab,
      openGlobalTaskDetail: taskAction,
      markNotificationRead: vi.fn(),
      openTab: vi.fn(),
      panes: [],
      activePaneId: 'TEST-pane',
    } as unknown as AppState;
    const slice = createNotificationSlice(vi.fn(), () => state, {} as never);
    slice.navigateToError(stored);
    expect(openTeamTab).toHaveBeenCalledWith(f.key, undefined);
    expect(taskAction).toHaveBeenCalledWith(f.key, 'TEST-original-task', undefined);
    await vi.waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: f.connection.handle,
          operation: 'team.snapshot',
          payload: {},
        })
      )
    );
    await expect(taskAction.mock.results[0]!.value).resolves.toMatchObject({
      id: 'TEST-original-task',
    });
    expect(legacy.getTask).not.toHaveBeenCalled();
    expect(fixturePaths.show).not.toHaveBeenCalled();
  });

  it('refuses conflicting top-level/structured Host destinations before forwarding to Main', async () => {
    const f = fixture(),
      show = vi.fn(),
      legacy = { showMessageNotification: show } as unknown as TeamsAPI;
    const api = createHostTeamsApi(legacy, {} as AgentBackendApi);
    await expect(
      api.showMessageNotification({
        ...f.data,
        target: {
          kind: 'task',
          teamName: hostTeamSelectionKey('TEST-foreign-owner'),
          taskId: 'TEST-original-task',
        },
      })
    ).rejects.toThrow('Invalid captured');
    expect(show).not.toHaveBeenCalled();
  });

  it('refuses foreign handles, missing original tasks, and a changed owner during the source read without notification admission', async () => {
    const f = fixture(),
      admit = vi.fn();
    await expect(
      prepareHostNotification(f.source, {
        ...f.data,
        teamName: hostTeamSelectionKey('TEST-foreign'),
        target: { kind: 'team', teamName: hostTeamSelectionKey('TEST-foreign') },
      })
    ).rejects.toThrow('destination unavailable');
    expect(f.read).not.toHaveBeenCalled();
    await expect(
      prepareHostNotification(f.source, {
        ...f.data,
        target: { kind: 'task', teamName: f.key, taskId: 'TEST-other-owner-task' },
      })
    ).rejects.toThrow('Original Host task');
    f.read.mockImplementationOnce(async () => {
      f.connection.ownerResourceRef = 'TEST-replacement-owner';
      return structuredClone(f.snapshot);
    });
    await expect(
      prepareHostNotification(f.source, f.data).then((captured) => admit(captured.payload))
    ).rejects.toThrow('owner changed');
    expect(admit).not.toHaveBeenCalled();
  });

  it('rechecks the captured owner at the Manager initialization await before any stored record or toast', async () => {
    const f = fixture(),
      manager = NotificationManager.getInstance();
    await manager.initialize();
    const captured = await prepareHostNotification(f.source, f.data);
    const before = (await manager.getNotifications()).total;
    const pending = manager.addTeamNotification(captured.payload, captured.assertCurrent);
    f.connection.ownerResourceRef = 'TEST-replacement-owner';
    await expect(pending).rejects.toThrow('owner changed');
    expect((await manager.getNotifications()).total).toBe(before);
    expect(fixturePaths.show).not.toHaveBeenCalled();
  });
});
