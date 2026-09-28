import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventEmitter } from 'events';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const native = vi.hoisted(() => ({
  instances: [] as (EventEmitter & { close: ReturnType<typeof vi.fn> })[],
  show: vi.fn(),
  supported: vi.fn(() => true),
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events');
  return {
    Notification: class extends EventEmitter {
      static readonly isSupported = native.supported;
      close = vi.fn(() => this.emit('close'));
      constructor() {
        super();
        native.instances.push(this);
      }
      show(): void {
        native.show(this);
      }
    },
    nativeImage: {},
  };
});
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('@main/utils/pathDecoder', () => ({
  getHomeDir: () => '/test-fixtures/agent-teams-notifications',
  getAppDataPath: () => '/test-fixtures/agent-teams-notifications',
  getTeamsBasePath: () => '/test-fixtures/agent-teams-notifications/teams',
  getClaudeBasePath: () => '/test-fixtures/agent-teams-notifications/claude',
}));
vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: { getInstance: () => ({ getConfig: () => ({ notifications: {} }) }) },
}));
vi.mock('@main/services/discovery/ProjectPathResolver', () => ({ projectPathResolver: {} }));
vi.mock('@main/services/parsing/GitIdentityResolver', () => ({ gitIdentityResolver: {} }));
vi.mock('@main/utils/appIcon', () => ({ getAppIconPath: () => undefined }));

vi.mock('@main/services', async () => ({
  NotificationManager: (await import('@main/services/infrastructure/NotificationManager'))
    .NotificationManager,
}));

import { registerNotificationHandlers } from '@main/ipc/notifications';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';

function notification() {
  return native.instances.at(-1)!;
}

describe('NotificationManager.sendTestNotification delivery result', () => {
  let manager: NotificationManager;
  beforeEach(() => {
    vi.useFakeTimers();
    native.instances.length = 0;
    native.show.mockReset();
    native.supported.mockReturnValue(true);
    manager = new NotificationManager();
  });
  afterEach(() => {
    manager.closeActiveNativeNotifications();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for delivery and preserves a delayed native failure', async () => {
    const settled = vi.fn();
    const result = Promise.resolve(manager.sendTestNotification()).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    notification().emit('failed', {}, 'Application is not signed');
    await result;
    expect(settled).toHaveBeenCalledWith({ success: false, error: 'Application is not signed' });
    expect(manager.closeActiveNativeNotifications()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'click'])('retains a shown notification until %s', async (event) => {
    const result = manager.sendTestNotification();
    notification().emit('show');
    await expect(result).resolves.toEqual({ success: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.closeActiveNativeNotifications()).toBe(1);
    const second = manager.sendTestNotification();
    notification().emit('show');
    await second;
    notification().emit(event);
    expect(manager.closeActiveNativeNotifications()).toBe(0);
  });

  it('fails and closes an unconfirmed notification after five seconds', async () => {
    const result = manager.sendTestNotification();
    const active = notification();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toEqual({
      success: false,
      error: 'Native notification was not confirmed within 5 seconds',
    });
    expect(active.close).toHaveBeenCalledOnce();
    expect(manager.closeActiveNativeNotifications()).toBe(0);
    active.emit('show');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a synchronous show exception and clears pending state', async () => {
    native.show.mockImplementation(() => {
      throw new Error('Native show exploded');
    });
    await expect(manager.sendTestNotification()).resolves.toEqual({
      success: false,
      error: 'Native show exploded',
    });
    expect(manager.closeActiveNativeNotifications()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles on an early close without waiting for a later show', async () => {
    const result = manager.sendTestNotification();
    notification().emit('close');
    notification().emit('show');
    await expect(result).resolves.toEqual({
      success: false,
      error: 'Native notification closed before it was shown',
    });
    expect(manager.closeActiveNativeNotifications()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles synchronous show and settles only once across events', async () => {
    native.show.mockImplementation((active: EventEmitter) => active.emit('show'));
    const result = manager.sendTestNotification();
    notification().emit('failed', {}, 'Late failure');
    notification().emit('close');
    await expect(result).resolves.toEqual({ success: true });
    expect(manager.closeActiveNativeNotifications()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits the IPC result and converts a rejected delivery to a safe failure', async () => {
    const handle = vi.fn();
    registerNotificationHandlers({ handle } as unknown as IpcMain);
    const handler = handle.mock.calls.find(
      ([channel]) => channel === 'notifications:testNotification'
    )![1] as (event: IpcMainInvokeEvent) => Promise<{ success: boolean; error?: string }>;
    vi.spyOn(NotificationManager, 'getInstance').mockReturnValue(manager);
    vi.spyOn(manager, 'sendTestNotification').mockRejectedValue(new Error('Delivery rejected'));
    await expect(handler({} as IpcMainInvokeEvent)).resolves.toEqual({
      success: false,
      error: 'Delivery rejected',
    });
  });
});
