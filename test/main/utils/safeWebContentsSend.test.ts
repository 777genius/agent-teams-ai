import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    warn,
  }),
}));

import {
  clearRendererAvailability,
  markRendererReady,
  markRendererUnavailable,
  safeSendToRenderer,
} from '../../../src/main/utils/safeWebContentsSend';

import type { BrowserWindow } from 'electron';

function createWindow(options?: {
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
  sendImpl?: (...args: unknown[]) => void;
}): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => options?.windowDestroyed ?? false),
    webContents: {
      isDestroyed: vi.fn(() => options?.contentsDestroyed ?? false),
      send: vi.fn(options?.sendImpl ?? (() => undefined)),
    },
  } as unknown as BrowserWindow;
}

describe('safeSendToRenderer', () => {
  beforeEach(() => {
    warn.mockReset();
  });

  it('sends IPC to a live renderer', () => {
    const window = createWindow();

    const result = safeSendToRenderer(window, 'test:channel', { ok: true });

    expect(result).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith('test:channel', { ok: true });
  });

  it('returns false when window is missing or destroyed', () => {
    expect(safeSendToRenderer(null, 'test:channel')).toBe(false);

    const destroyedWindow = createWindow({ windowDestroyed: true });
    expect(safeSendToRenderer(destroyedWindow, 'test:channel')).toBe(false);
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('returns false when webContents is destroyed', () => {
    const window = createWindow({ contentsDestroyed: true });

    const result = safeSendToRenderer(window, 'test:channel');

    expect(result).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('swallows renderer disposal errors and logs a warning', () => {
    const window = createWindow({
      sendImpl: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    });

    const result = safeSendToRenderer(window, 'test:channel', 123);

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('test:channel');
  });

  it('blocks sends while renderer is unavailable and resumes after ready', () => {
    const window = createWindow();

    markRendererUnavailable(window);
    expect(safeSendToRenderer(window, 'test:channel', 'first')).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();

    markRendererReady(window);
    expect(safeSendToRenderer(window, 'test:channel', 'second')).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith('test:channel', 'second');

    clearRendererAvailability(window);
  });
});
