import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DEFAULT_TERMINAL_APPEARANCE_SETTINGS } from '@features/terminal-workspace/renderer/model/terminalAppearanceSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalWorkspaceSettingsViewProps } from '@features/terminal-workspace/renderer/ui/TerminalWorkspaceSettingsView';
import type { Mock } from 'vitest';

const settingsFixture = vi.hoisted(() => ({
  props: null as TerminalWorkspaceSettingsViewProps | null,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@terminal-platform/design-tokens', () => ({
  terminalPlatformThemeManifests: [
    { displayName: 'Terminal Platform Dark', id: 'terminal-platform-default' },
    { displayName: 'Terminal Platform Light', id: 'terminal-platform-light' },
  ],
}));

vi.mock('@terminal-platform/workspace-core', () => ({
  terminalPlatformTerminalFontScales: ['compact', 'default', 'large'],
}));

vi.mock('@features/terminal-workspace/renderer/ui/TerminalWorkspaceSettingsView', async () => {
  const ReactModule = await import('react');
  return {
    TerminalWorkspaceSettingsView: (props: TerminalWorkspaceSettingsViewProps) => {
      settingsFixture.props = props;
      return ReactModule.createElement('div', {
        'data-testid': 'mock-terminal-workspace-settings-view',
      });
    },
  };
});

import { TerminalWorkspaceSettingsPage } from '@features/terminal-workspace/renderer/ui/TerminalWorkspaceSettingsPage';

describe('TerminalWorkspaceSettingsPage', () => {
  let host: HTMLDivElement;
  let root: Root;
  let operations: {
    reconnect: Mock<() => Promise<void>>;
    refreshSessions: Mock<() => Promise<void>>;
    stopRuntime: Mock<() => Promise<void>>;
    setFontScale: Mock<(fontScale: string) => void>;
    setLineWrap: Mock<(lineWrap: boolean) => void>;
    setTheme: Mock<(themeId: string) => void>;
  };
  let onAppearanceSettingsChange: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let onReload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settingsFixture.props = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    operations = {
      reconnect: vi.fn().mockResolvedValue(undefined),
      refreshSessions: vi.fn().mockResolvedValue(undefined),
      stopRuntime: vi.fn().mockResolvedValue(undefined),
      setFontScale: vi.fn(),
      setLineWrap: vi.fn(),
      setTheme: vi.fn(),
    };
    onAppearanceSettingsChange = vi.fn();
    onClose = vi.fn();
    onReload = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it('routes every setting through the narrow operations port and page callbacks', async () => {
    await renderPage();
    const props = currentViewProps();

    props.onFontScaleChange('large');
    props.onLineWrapChange(true);
    props.onThemeChange('terminal-platform-light');
    props.onAppearanceSettingsChange({ fontSizePx: 18 });
    props.onResetAppearance();
    props.onClose();
    props.onReload();
    await runAsyncAction(props.onReconnect);
    await runAsyncAction(currentViewProps().onRefreshSessions);
    await runAsyncAction(currentViewProps().onStopRuntime);

    expect(operations.setFontScale).toHaveBeenCalledWith('large');
    expect(operations.setLineWrap).toHaveBeenCalledWith(true);
    expect(operations.setTheme).toHaveBeenCalledWith('terminal-platform-light');
    expect(operations.reconnect).toHaveBeenCalledOnce();
    expect(operations.refreshSessions).toHaveBeenCalledOnce();
    expect(operations.stopRuntime).toHaveBeenCalledOnce();
    expect(onAppearanceSettingsChange).toHaveBeenNthCalledWith(1, { fontSizePx: 18 });
    expect(onAppearanceSettingsChange).toHaveBeenNthCalledWith(
      2,
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
    expect(currentViewProps().pendingAction).toBeNull();
  });

  it('clears the pending action when an operation rejects', async () => {
    const reconnect = createDeferred<void>();
    operations.reconnect.mockReturnValueOnce(reconnect.promise);
    await renderPage();

    act(() => {
      currentViewProps().onReconnect();
    });
    expect(currentViewProps().pendingAction).toBe('bootstrap');

    reconnect.reject(new Error('transport unavailable'));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(currentViewProps().pendingAction).toBeNull();
  });

  async function renderPage(): Promise<void> {
    await act(async () => {
      root.render(
        <TerminalWorkspaceSettingsPage
          appearanceSettings={DEFAULT_TERMINAL_APPEARANCE_SETTINGS}
          display={{
            fontScale: 'default',
            lineWrap: false,
            themeId: 'terminal-platform-default',
          }}
          operations={operations}
          onAppearanceSettingsChange={onAppearanceSettingsChange}
          onClose={onClose}
          onReload={onReload}
        />
      );
      await flushMicrotasks();
    });
  }
});

function currentViewProps(): TerminalWorkspaceSettingsViewProps {
  if (!settingsFixture.props) {
    throw new Error('TerminalWorkspaceSettingsView props were not captured');
  }
  return settingsFixture.props;
}

async function runAsyncAction(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
