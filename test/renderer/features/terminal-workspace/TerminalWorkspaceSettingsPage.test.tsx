import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DEFAULT_TERMINAL_APPEARANCE_SETTINGS } from '@features/terminal-workspace/renderer/model/terminalAppearanceSettings';
import { createTerminalAppearanceStyle } from '@features/terminal-workspace/renderer/view-models/terminalAppearanceStyle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalWorkspaceSettingsViewProps } from '@features/terminal-workspace/renderer/ui/TerminalWorkspaceSettingsView';

const fixture = vi.hoisted(() => ({ props: null as TerminalWorkspaceSettingsViewProps | null }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
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
  const actual = await vi.importActual<
    typeof import('@features/terminal-workspace/renderer/ui/TerminalWorkspaceSettingsView')
  >('@features/terminal-workspace/renderer/ui/TerminalWorkspaceSettingsView');
  const ReactModule = await import('react');
  return {
    ...actual,
    TerminalWorkspaceSettingsView: (props: TerminalWorkspaceSettingsViewProps) => {
      fixture.props = props;
      return ReactModule.createElement(actual.TerminalWorkspaceSettingsView, props);
    },
  };
});

import { TerminalWorkspaceSettingsPage } from '@features/terminal-workspace/renderer/ui/TerminalWorkspaceSettingsPage';

describe('extracted settings page with the actual view', () => {
  let host: HTMLDivElement;
  let root: Root;
  let operations: ReturnType<typeof createOperations>;
  let onAppearanceSettingsChange: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let onReload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.props = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    operations = createOperations();
    onAppearanceSettingsChange = vi.fn();
    onClose = vi.fn();
    onReload = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('preserves displayed values and routes settings and runtime callbacks', async () => {
    await renderPage();
    expect(host.querySelector<HTMLInputElement>('#terminal-settings-font-size')?.value).toBe('15');
    expect(
      host.querySelector('[aria-label="terminalWorkspace.settingsThemeAria"]')?.textContent
    ).toContain('terminalWorkspace.themeLight');
    expect(
      host.querySelector('[aria-label="terminalWorkspace.settingsFontPresetAria"]')?.textContent
    ).toContain('terminalWorkspace.fontScaleLarge');
    const wrap = host.querySelector<HTMLElement>('[role="checkbox"]');
    expect(wrap?.getAttribute('aria-checked')).toBe('true');

    props().onFontScaleChange('compact');
    props().onThemeChange('terminal-platform-default');
    await actAndFlush(() => {
      wrap?.click();
      const input = host.querySelector<HTMLInputElement>('#terminal-settings-font-size');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '18');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(operations.setFontScale).toHaveBeenCalledWith('compact');
    expect(operations.setTheme).toHaveBeenCalledWith('terminal-platform-default');
    expect(operations.setLineWrap).toHaveBeenCalledWith(false);
    expect(onAppearanceSettingsChange).toHaveBeenCalledWith({ fontSizePx: 18 });

    for (const key of ['settingsReconnect', 'settingsSessions', 'settingsStop', 'settingsReload']) {
      await actAndFlush(() => button(key).click());
    }
    expect(operations.reconnect).toHaveBeenCalledOnce();
    expect(operations.refreshSessions).toHaveBeenCalledOnce();
    expect(operations.stopRuntime).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
    await actAndFlush(() => button('settingsResetAppearance').click());
    expect(onAppearanceSettingsChange).toHaveBeenLastCalledWith(
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS
    );
    await actAndFlush(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="terminalWorkspace.closeTerminalSettings"]')
        ?.click()
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks runtime controls while reconnecting and restores them after rejection', async () => {
    let reject!: (reason: Error) => void;
    operations.reconnect.mockReturnValueOnce(
      new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      })
    );
    await renderPage();
    await actAndFlush(() => button('settingsReconnect').click());
    for (const key of ['settingsReconnect', 'settingsSessions', 'settingsStop', 'settingsReload']) {
      expect(button(key).disabled).toBe(true);
    }
    await actAndFlush(() => button('settingsStop').click());
    expect(operations.stopRuntime).not.toHaveBeenCalled();
    await actAndFlush(() => reject(new Error('transport unavailable')));
    for (const key of ['settingsReconnect', 'settingsSessions', 'settingsStop', 'settingsReload']) {
      expect(button(key).disabled).toBe(false);
    }
    await actAndFlush(() => button('settingsStop').click());
    expect(operations.stopRuntime).toHaveBeenCalledOnce();
  });

  async function actAndFlush(callback: () => void): Promise<void> {
    await act(async () => {
      callback();
      await Promise.resolve();
    });
  }

  async function renderPage(): Promise<void> {
    await actAndFlush(() =>
      root.render(
        <TerminalWorkspaceSettingsPage
          appearanceSettings={DEFAULT_TERMINAL_APPEARANCE_SETTINGS}
          display={{ fontScale: 'large', lineWrap: true, themeId: 'terminal-platform-light' }}
          operations={operations}
          onAppearanceSettingsChange={onAppearanceSettingsChange}
          onClose={onClose}
          onReload={onReload}
        />
      )
    );
  }
  function button(key: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(`terminalWorkspace.${key}`)
    );
    if (!found) throw new Error(`Missing settings button: ${key}`);
    return found;
  }
});

it('preserves the main raw URL CSS contract including local images and literal spaces', () => {
  expect(
    createTerminalAppearanceStyle({
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      backgroundMode: 'image',
      backgroundImageUrl: '  file:///test fixtures/background image.png  ',
    })
  ).toMatchObject({
    '--agent-terminal-background-image': 'url("file:///test fixtures/background image.png")',
  });
});

function props(): TerminalWorkspaceSettingsViewProps {
  if (!fixture.props) throw new Error('Settings view was not rendered');
  return fixture.props;
}
function createOperations() {
  return {
    reconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refreshSessions: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopRuntime: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    setFontScale: vi.fn<(scale: string) => void>(),
    setLineWrap: vi.fn<(wrap: boolean) => void>(),
    setTheme: vi.fn<(theme: string) => void>(),
  };
}
