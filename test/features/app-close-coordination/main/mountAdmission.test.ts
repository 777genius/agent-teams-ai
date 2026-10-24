import { EventEmitter } from 'node:events';

import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_UI_MOUNT_REQUEST,
} from '@features/app-close-coordination/contracts';
import { RendererCloseReadinessCoordinator } from '@features/app-close-coordination/main';
import { createAppCloseCoordinationBridge } from '@features/app-close-coordination/preload';
import {
  initializeAppCloseCoordination,
  registerAppCloseParticipant,
} from '@features/app-close-coordination/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserWindow, IpcMain, IpcRenderer } from 'electron';

function harness() {
  const main = new EventEmitter();
  const renderer = new EventEmitter();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const frame = {};
  const contents = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => renderer.emit(channel, {}, payload),
  };
  const event = { sender: contents, senderFrame: frame };
  const mainPort = Object.assign(main, {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  });
  const rendererPort = Object.assign(renderer, {
    invoke: async (channel: string) => handlers.get(channel)?.(event),
    send: (channel: string, payload: unknown) => main.emit(channel, event, payload),
  });
  const window = { isDestroyed: () => false, webContents: contents };
  const coordinator = new RendererCloseReadinessCoordinator(mainPort as unknown as IpcMain);
  const bridge = createAppCloseCoordinationBridge(rendererPort as unknown as IpcRenderer);
  return {
    main,
    renderer,
    handlers,
    contents,
    frame,
    event,
    coordinator,
    bridge,
    rendererPort: rendererPort as unknown as IpcRenderer,
    window: window as unknown as BrowserWindow,
  };
}

describe('existing close coordinator with real preload bridge and pre-mount admission', () => {
  it('accepts untouched startup/error splash and permanently denies later mount', async () => {
    const h = harness();
    await expect(h.coordinator.request(h.window, 'app-quit')).resolves.toMatchObject({ ok: true });
    await expect(h.bridge.requestUiMount()).resolves.toBe(false);
    h.coordinator.dispose();
  });
  it('mount-first ordering preserves actual registered dirty participant refusal', async () => {
    const h = harness();
    expect(await h.bridge.requestUiMount()).toBe(true);
    const dirty = vi.fn(async () => ({ ok: false, blocker: 'unsaved draft' }));
    const removeParticipant = registerAppCloseParticipant('changes', dirty);
    const removeListener = initializeAppCloseCoordination(h.bridge);
    await expect(h.coordinator.request(h.window, 'app-quit')).resolves.toMatchObject({
      ok: false,
      blockers: ['unsaved draft'],
    });
    expect(dirty).toHaveBeenCalledOnce();
    removeListener();
    removeParticipant();
    h.coordinator.dispose();
  });
  it('close-first ordering refuses a mount already awaiting its IPC response', async () => {
    const h = harness();
    const quit = h.coordinator.request(h.window, 'app-quit');
    const permit = h.bridge.requestUiMount();
    await expect(quit).resolves.toMatchObject({ ok: true });
    await expect(permit).resolves.toBe(false);
    h.coordinator.dispose();
  });
  it('holds the admitted mount gap until its real UI readiness handler exists', async () => {
    const h = harness();
    const permit = h.bridge.requestUiMount();
    const quit = h.coordinator.request(h.window, 'app-quit');
    await expect(permit).resolves.toBe(true);
    await expect(quit).resolves.toMatchObject({
      ok: false,
      blockers: [expect.stringContaining('not initialized')],
    });
    h.coordinator.dispose();
  });
  it('never downgrades previously mounted renderer loss to safe startup', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      expect(await h.bridge.requestUiMount()).toBe(true);
      h.renderer.removeAllListeners(APP_CLOSE_READINESS_REQUEST);
      const quit = h.coordinator.request(h.window, 'app-quit', 20);
      await vi.advanceTimersByTimeAsync(20);
      await expect(quit).resolves.toMatchObject({
        ok: false,
        blockers: [expect.stringContaining('timeout')],
      });
      h.coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('holds prior mounted state when reload installs a fresh preload before UI initialization', async () => {
    const h = harness();
    try {
      expect(await h.bridge.requestUiMount()).toBe(true);
      h.renderer.removeAllListeners(APP_CLOSE_READINESS_REQUEST);
      createAppCloseCoordinationBridge(h.rendererPort);
      await expect(h.coordinator.request(h.window, 'app-quit')).resolves.toMatchObject({
        ok: false,
        blockers: [expect.stringContaining('not initialized')],
      });
    } finally {
      h.coordinator.dispose();
    }
  });

  it('does not let child-frame or malformed admission authorize UI state', () => {
    const h = harness();
    const admit = h.handlers.get(APP_CLOSE_UI_MOUNT_REQUEST)!;
    expect(admit({ ...h.event, senderFrame: {} })).toBe(false);
    expect(admit({ ...h.event, senderFrame: null })).toBe(false);
    expect(admit(h.event, { fake: true })).toBe(false);
    h.coordinator.dispose();
  });
  it('isolates a startup close from another mounted window', async () => {
    const h = harness();
    expect(await h.bridge.requestUiMount()).toBe(true);
    h.bridge.onReadinessRequest(async () => ({ ok: false, blockers: ['save pending'] }));
    const otherContents = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    await expect(
      h.coordinator.request(
        { isDestroyed: () => false, webContents: otherContents } as unknown as BrowserWindow,
        'app-quit'
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(h.coordinator.request(h.window, 'app-quit')).resolves.toMatchObject({ ok: false });
    h.coordinator.dispose();
  });
  it('preserves delayed real participant completion instead of auto-closing mounted UI', async () => {
    const h = harness();
    expect(await h.bridge.requestUiMount()).toBe(true);
    let release!: (v: { ok: boolean; blockers: string[] }) => void;
    const removeParticipant = registerAppCloseParticipant(
      'changes',
      () =>
        new Promise((resolve) => {
          release = (value) => resolve({ ok: value.ok, blocker: value.blockers[0] });
        })
    );
    const removeListener = initializeAppCloseCoordination(h.bridge);
    const quit = h.coordinator.request(h.window, 'app-quit');
    let settled = false;
    void quit.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ ok: true, blockers: [] });
    await expect(quit).resolves.toMatchObject({ ok: true });
    removeListener();
    removeParticipant();
    h.coordinator.dispose();
  });
});
