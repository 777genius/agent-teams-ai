import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeAnnouncementsProfile } from '../../../src/main/announcementsProfileProbe';
import { announcementsSourcePolicy } from '../../../src/main/announcementsSourcePolicy';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  register: vi.fn(),
}));
vi.mock('@features/announcements/main', () => ({
  createAnnouncementsFeature: mocks.create,
  registerAnnouncementsIpc: mocks.register,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { powerMonitor: new EventEmitter() };
});
import { type BrowserWindow, type IpcMainInvokeEvent, powerMonitor } from 'electron';

import { AnnouncementsLifecycle } from '../../../src/main/announcementsLifecycle';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'announcements-shell-'));
  roots.push(root);
  return root;
}

describe('early profile evidence', () => {
  it('does not label an existing empty override or Chromium files fresh/legacy', () => {
    const root = fixture();
    expect(probeAnnouncementsProfile(root, join(root, 'claude')).origin).toBe('unknown');
    writeFileSync(join(root, 'Preferences'), '{}');
    expect(probeAnnouncementsProfile(root, join(root, 'claude')).origin).toBe('unknown');
  });
  it('recognizes bounded previous app config and genuine absence', () => {
    const root = fixture();
    expect(probeAnnouncementsProfile(join(root, 'absent'), root).origin).toBe('fresh');
    writeFileSync(join(root, 'agent-teams-config.json'), '{}');
    expect(probeAnnouncementsProfile(join(root, 'absent'), root).origin).toBe('legacy');
  });
  it('recognizes initialized app storage, not unrelated project data', () => {
    const root = fixture();
    mkdirSync(join(root, 'data', 'announcements'), { recursive: true });
    writeFileSync(join(root, 'data', 'announcements', 'initialized.json'), '{}');
    expect(probeAnnouncementsProfile(root, join(root, 'claude')).origin).toBe('legacy');
  });
});

describe('dev publisher override', () => {
  it('accepts only isolated loopback dev fixtures', () => {
    expect(
      announcementsSourcePolicy(false, true, 'http://127.0.0.1:8123/announcements/feed.v1.json')
    ).toContain(':8123');
    for (const url of [
      'https://evil.example/feed',
      'http://localhost.evil.example/feed',
      'http://user@localhost/feed',
      'file:///tmp/feed',
      'http://localhost/feed?profile=x',
    ]) {
      expect(announcementsSourcePolicy(false, true, url)).toBeUndefined();
    }
    expect(announcementsSourcePolicy(true, true, 'http://localhost/feed')).toBeUndefined();
    expect(announcementsSourcePolicy(false, false, 'http://localhost/feed')).toBeUndefined();
  });
});

function fakeWindow(id: number, visible = true) {
  const window = new EventEmitter();
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    send: vi.fn(),
    mainFrame: {},
  });
  return Object.assign(window, {
    id,
    webContents,
    isVisible: () => visible,
    isFocused: () => true,
    isDestroyed: () => false,
  });
}
function fakeFeature() {
  const feature = {
    initialize: vi.fn(async () => {}),
    registerWindow: vi.fn(),
    invalidateWindow: vi.fn(),
    unregisterWindow: vi.fn(async () => {}),
    foreground: vi.fn(),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(),
    dispose: vi.fn(async () => {}),
    subscribe: vi.fn(() => vi.fn()),
  };
  mocks.create.mockReturnValue(feature);
  mocks.register.mockReturnValue(vi.fn());
  return feature;
}
const options = {
  userDataPath: '/test-only',
  profile: { origin: 'unknown', reason: 'ambiguous-profile' } as const,
  production: false,
  isolatedProfile: true,
};

describe('main window lifecycle ownership', () => {
  it('invalidates auto claims on blur without revoking the open document', async () => {
    const feature = fakeFeature();
    const lifecycle = new AnnouncementsLifecycle();
    const main = fakeWindow(1);
    const hidden = fakeWindow(2, false);
    const helper = fakeWindow(3);
    lifecycle.registerMainWindow(main as unknown as BrowserWindow);
    lifecycle.registerMainWindow(hidden as unknown as BrowserWindow);
    await lifecycle.initialize(options);
    expect(mocks.create.mock.calls[0][0].firstOpenedAt).toMatch(/^\d{4}-/);
    expect(feature.registerWindow.mock.calls).toEqual([[1, expect.any(String)]]);
    const contextFor = mocks.register.mock.calls[0][1] as (event: IpcMainInvokeEvent) => {
      documentGeneration: number;
      isReady: () => boolean;
      isDocumentCurrent: () => boolean;
    } | null;
    const event = {
      sender: main.webContents,
      senderFrame: main.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const context = contextFor(event)!;
    expect(context.isReady()).toBe(true);
    expect(context.isDocumentCurrent()).toBe(true);
    main.emit('blur');
    expect(context.isReady()).toBe(false);
    expect(context.isDocumentCurrent()).toBe(true);
    main.emit('hide');
    expect(feature.invalidateWindow).not.toHaveBeenCalled();
    expect(contextFor(event)?.documentGeneration).toBe(0);
    main.webContents.emit('did-start-loading');
    expect(feature.invalidateWindow).toHaveBeenCalledWith(1);
    expect(context.isDocumentCurrent()).toBe(false);
    expect(contextFor(event)?.documentGeneration).toBe(1);
    expect(
      contextFor({ sender: main.webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent)
    ).toBeNull();
    expect(
      contextFor({
        sender: helper.webContents,
        senderFrame: helper.webContents.mainFrame,
      } as unknown as IpcMainInvokeEvent)
    ).toBeNull();
    main.emit('closed');
    expect(feature.invalidateWindow).toHaveBeenCalledTimes(2);
    expect(feature.unregisterWindow).toHaveBeenCalledWith(1);
    await lifecycle.dispose();
  });
  it('continues until accepted disposal and removes power listeners on shutdown', async () => {
    const feature = fakeFeature();
    const lifecycle = new AnnouncementsLifecycle();
    await lifecycle.initialize(options);
    powerMonitor.emit('suspend');
    powerMonitor.emit('resume');
    expect(feature.suspend).toHaveBeenCalledOnce();
    expect(feature.resume).toHaveBeenCalledOnce();
    await lifecycle.dispose();
    powerMonitor.emit('suspend');
    expect(feature.suspend).toHaveBeenCalledOnce();
    expect(feature.dispose).toHaveBeenCalledOnce();
  });
});
