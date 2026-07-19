import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalWorkspaceBootstrap } from '@features/terminal-workspace/contracts';

const panelFixture = vi.hoisted(() => ({
  commandDockProps: [] as Array<Record<string, unknown>>,
  createWorkspaceKernel: vi.fn(),
  createWorkspaceWebSocketTransport: vi.fn(),
  kernels: [] as MockKernel[],
  requestUpdate: vi.fn(),
  screenProps: [] as Array<Record<string, unknown>>,
  scrollToLatestOutput: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'terminalWorkspace.currentWorkingDirectory': 'Current working directory',
        'terminalWorkspace.gitBranchTitle': 'Git branch: {{branch}}',
        'terminalWorkspace.openTerminalPlatformRepository': 'Open terminal-platform on GitHub',
        'terminalWorkspace.poweredByTerminalPlatform': 'powered by terminal-platform',
        'terminalWorkspace.shellDefaultDirectory': 'Default shell working directory',
        'terminalWorkspace.openTeamTerminal': 'Open {{team}} terminal',
        'terminalWorkspace.openTerminal': 'Open terminal',
        'terminalWorkspace.terminalSheetOpen': 'Terminal sheet is open',
        'terminalWorkspace.teamTerminalTitle': '{{team}} terminal',
        'terminalWorkspace.teamRuntime': 'Team runtime',
        'terminalWorkspace.teamRuntimeBadge': 'team runtime',
        'terminalWorkspace.localShell': 'Local shell',
        'terminalWorkspace.localShellBadge': 'local shell',
        'terminalWorkspace.reloadTerminalWorkspace': 'Reload terminal workspace',
        'terminalWorkspace.stopTerminalRuntime': 'Stop terminal runtime',
        'terminalWorkspace.startingRuntimeTitle': 'Starting terminal runtime',
        'terminalWorkspace.startingRuntimeDetail':
          'Preparing the team workspace and restoring persisted terminal state.',
        'terminalWorkspace.runtimeUnavailableTitle': 'Terminal runtime is unavailable',
        'terminalWorkspace.runtimeDisconnectedTitle': 'Terminal runtime is not connected',
        'terminalWorkspace.runtimeDisconnectedDetail': 'Reload the workspace to reconnect.',
        'terminalWorkspace.restoreHalfHeightSheet': 'Restore half-height sheet',
        'terminalWorkspace.expandTerminalSheet': 'Expand terminal sheet',
        'terminalWorkspace.openTerminalSettings': 'Open terminal settings',
        'terminalWorkspace.closeTerminalSettings': 'Close terminal settings',
        'terminalWorkspace.closeTerminalSheet': 'Close terminal sheet',
        'terminalWorkspace.loadingTerminalTab': 'Loading terminal tab',
        'terminalWorkspace.terminalCommandActions': 'Terminal command actions',
        'terminalWorkspace.copy': 'Copy',
        'terminalWorkspace.copyCommand': 'Copy command',
        'terminalWorkspace.copyOutput': 'Copy output',
        'terminalWorkspace.terminalTabs': 'Terminal tabs',
        'terminalWorkspace.noTerminalTabs': 'No terminal tabs',
        'terminalWorkspace.closeTerminalTab': 'Close terminal tab {{tab}}',
        'terminalWorkspace.createAnotherTabBeforeClosing':
          'Create another tab before closing this one',
        'terminalWorkspace.editTerminalTabTitle': 'Edit terminal tab title',
        'terminalWorkspace.renameTab': 'Rename tab',
        'terminalWorkspace.tabColor': 'Tab color',
        'terminalWorkspace.chooseColor': 'Choose color',
        'terminalWorkspace.settingsTab': 'Settings',
        'terminalWorkspace.closeTerminalSettingsTab': 'Close terminal settings tab',
        'terminalWorkspace.createTerminalTab': 'Create terminal tab',
        'terminalWorkspace.terminalTabsUnavailable': 'Terminal tabs are unavailable',
        'terminalWorkspace.closeTerminalTabDialogTitle': 'Close terminal tab?',
        'terminalWorkspace.closeTerminalTabDialogDescription':
          'This tab has terminal output history. Closing it will remove the tab and its visible output from this workspace.',
        'terminalWorkspace.cancel': 'Cancel',
        'terminalWorkspace.closeTab': 'Close tab',
        'terminalWorkspace.commandPlaceholder': 'Type a command...',
        'terminalWorkspace.commandRun': 'Run',
        'terminalWorkspace.commandRunTitle': 'Send command to the focused pane',
        'terminalWorkspace.commandInterrupt': 'Ctrl+C',
        'terminalWorkspace.commandInterruptTitle': 'Send Ctrl+C to the focused pane',
        'terminalWorkspace.settingsTitle': 'Terminal settings',
        'terminalWorkspace.settingsDescription': 'Appearance and runtime controls.',
        'terminalWorkspace.settingsThemeTitle': 'Theme',
        'terminalWorkspace.settingsThemeDescription': 'Choose the base terminal palette.',
        'terminalWorkspace.settingsThemeAria': 'Terminal theme',
        'terminalWorkspace.settingsThemePlaceholder': 'Select theme',
        'terminalWorkspace.settingsFontTitle': 'Font',
        'terminalWorkspace.settingsFontDescription': 'Tune text size and the SDK font preset.',
        'terminalWorkspace.settingsFontPreset': 'Preset',
        'terminalWorkspace.settingsFontPresetAria': 'Terminal font preset',
        'terminalWorkspace.settingsFontPresetPlaceholder': 'Font preset',
        'terminalWorkspace.settingsFontSize': 'Size',
        'terminalWorkspace.settingsBackgroundTitle': 'Background',
        'terminalWorkspace.settingsBackgroundDescription':
          'Control transparency, blur, color, and optional image.',
        'terminalWorkspace.settingsOpacity': 'Opacity',
        'terminalWorkspace.settingsOpacityAria': 'Terminal opacity',
        'terminalWorkspace.settingsBackgroundMode': 'Background',
        'terminalWorkspace.settingsBackgroundModeAria': 'Terminal background mode',
        'terminalWorkspace.settingsBackgroundColorAria': 'Terminal background color',
        'terminalWorkspace.settingsBackdropBlur': 'Backdrop blur',
        'terminalWorkspace.settingsImageUrl': 'Image URL',
        'terminalWorkspace.settingsImageFit': 'Image fit',
        'terminalWorkspace.settingsImageFitAria': 'Terminal background image fit',
        'terminalWorkspace.settingsImageBlur': 'Image blur',
        'terminalWorkspace.settingsDimImage': 'Dim image behind terminal text',
        'terminalWorkspace.settingsBehaviorTitle': 'Behavior',
        'terminalWorkspace.settingsBehaviorDescription':
          'Keep command output readable for long lines.',
        'terminalWorkspace.settingsWrapLongOutput': 'Wrap long command output',
        'terminalWorkspace.settingsRuntimeTitle': 'Runtime',
        'terminalWorkspace.settingsRuntimeDescription':
          'Use these only when the terminal transport looks stale.',
        'terminalWorkspace.settingsReconnect': 'Reconnect',
        'terminalWorkspace.settingsSessions': 'Sessions',
        'terminalWorkspace.settingsReload': 'Reload',
        'terminalWorkspace.settingsStop': 'Stop',
        'terminalWorkspace.settingsResetAppearance': 'Reset appearance',
        'terminalWorkspace.backgroundModeTransparent': 'Transparent',
        'terminalWorkspace.backgroundModeSolid': 'Solid color',
        'terminalWorkspace.backgroundModeImage': 'Image',
        'terminalWorkspace.imageFitCover': 'Cover',
        'terminalWorkspace.imageFitContain': 'Contain',
        'terminalWorkspace.imageFitStretch': 'Stretch',
        'terminalWorkspace.imageFitTile': 'Tile',
        'terminalWorkspace.imageFitCenter': 'Center',
        'terminalWorkspace.themeDark': 'Dark',
        'terminalWorkspace.themeLight': 'Light',
        'terminalWorkspace.fontScaleCompact': 'Compact',
        'terminalWorkspace.fontScaleDefault': 'Default',
        'terminalWorkspace.fontScaleLarge': 'Large',
        'terminalWorkspace.tabColorSlate': 'Slate',
        'terminalWorkspace.tabColorSky': 'Sky',
        'terminalWorkspace.tabColorBlue': 'Blue',
        'terminalWorkspace.tabColorCyan': 'Cyan',
        'terminalWorkspace.tabColorTeal': 'Teal',
        'terminalWorkspace.tabColorEmerald': 'Emerald',
        'terminalWorkspace.tabColorLime': 'Lime',
        'terminalWorkspace.tabColorAmber': 'Amber',
        'terminalWorkspace.tabColorOrange': 'Orange',
        'terminalWorkspace.tabColorRose': 'Rose',
        'terminalWorkspace.tabColorViolet': 'Violet',
      };
      return interpolateFixtureTranslation(translations[key] ?? key, values);
    },
  }),
}));

function interpolateFixtureTranslation(value: string, values?: Record<string, string>): string {
  if (!values) {
    return value;
  }

  return Object.entries(values).reduce(
    (current, [key, replacement]) =>
      current.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'gu'), replacement),
    value
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

vi.mock('@terminal-platform/design-tokens', () => ({
  terminalPlatformThemeManifests: [
    { displayName: 'Terminal Platform Dark', id: 'terminal-platform-default' },
    { displayName: 'Terminal Platform Light', id: 'terminal-platform-light' },
  ],
}));

vi.mock('@terminal-platform/workspace-adapter-websocket', () => ({
  createWorkspaceWebSocketTransport: (...args: unknown[]) =>
    panelFixture.createWorkspaceWebSocketTransport(...args),
}));

vi.mock('@terminal-platform/workspace-core', () => ({
  createWorkspaceKernel: (...args: unknown[]) => panelFixture.createWorkspaceKernel(...args),
  terminalPlatformTerminalFontScales: ['compact', 'default', 'large'],
}));

vi.mock('@terminal-platform/workspace-react', async () => {
  const ReactModule = await import('react');
  const React = ReactModule.default;

  const TerminalWorkspace = ({
    children,
    kernel,
  }: {
    children?: React.ReactNode;
    kernel: MockKernel;
  }): React.ReactElement =>
    React.createElement(
      'div',
      {
        'data-kernel-id': kernel.id,
        'data-testid': 'mock-terminal-workspace',
      },
      children
    );

  const TerminalScreen = React.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    const elementRef = React.useRef<HTMLDivElement | null>(null);
    const fallbackElementRef = React.useRef<HTMLDivElement | null>(null);
    if (!fallbackElementRef.current && typeof document !== 'undefined') {
      fallbackElementRef.current = document.createElement('div');
    }

    panelFixture.screenProps.push(props);

    React.useImperativeHandle(ref, () => {
      const element = elementRef.current ?? fallbackElementRef.current;
      if (!element) {
        throw new Error('Terminal screen test element was not created');
      }
      Object.assign(element, {
        requestUpdate: panelFixture.requestUpdate,
        scrollToLatestOutput: panelFixture.scrollToLatestOutput,
      });
      return element;
    });

    const metadata = props.commandPresentationMetadata;
    const serializedMetadata = JSON.stringify(Array.isArray(metadata) ? metadata : []);
    const snapshot = (props.kernel as MockKernel | undefined)?.__snapshot;
    const content =
      snapshot?.attachedSession.focused_screen === null
        ? 'select a pane first'
        : serializedMetadata;

    return React.createElement(
      'div',
      {
        'data-command-metadata': serializedMetadata,
        'data-prompt-label': String(props.terminalPromptLabel ?? ''),
        'data-testid': 'mock-terminal-screen',
        ref: elementRef,
      },
      content
    );
  });
  TerminalScreen.displayName = 'MockTerminalScreen';

  const TerminalCommandDock = React.forwardRef<HTMLDivElement, Record<string, unknown>>(
    (props, ref) => {
      panelFixture.commandDockProps.push(props);
      return React.createElement('div', {
        'data-testid': 'mock-terminal-command-dock',
        ref,
      });
    }
  );
  TerminalCommandDock.displayName = 'MockTerminalCommandDock';

  return {
    TerminalCommandDock,
    TerminalScreen,
    TerminalWorkspace,
    resolveTerminalTopologyControlState: (snapshot: MockWorkspaceSnapshot) => snapshot.__controls,
    useWorkspaceSnapshot: (kernel: MockKernel) => kernel.__snapshot,
  };
});

import { TerminalWorkspacePanel } from '@features/terminal-workspace/renderer/ui/TerminalWorkspacePanel';

const TEAM_NAME = 'terminal-fixture-team';
const PROJECT_PATH =
  '/Users/belief/dev/projects/claude/.terminal-platform-sandbox/terminal-ui-smoke';
const TERMINAL_PLATFORM_REPOSITORY_URL = 'https://github.com/777genius/terminal-platform';

describe('terminal workspace panel fixture-e2e', () => {
  let host: HTMLDivElement;
  let root: Root;
  let getBootstrap: ReturnType<typeof vi.fn<() => Promise<TerminalWorkspaceBootstrap>>>;
  let stopTeamRuntime: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  let nextSnapshot: MockWorkspaceSnapshot;
  let kernelCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    panelFixture.commandDockProps.length = 0;
    panelFixture.kernels.length = 0;
    panelFixture.screenProps.length = 0;
    window.localStorage.clear();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    nextSnapshot = createWorkspaceSnapshot();
    getBootstrap = vi.fn().mockResolvedValue(createBootstrap());
    stopTeamRuntime = vi.fn().mockResolvedValue(undefined);
    openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openExternal,
      },
    });

    panelFixture.createWorkspaceWebSocketTransport.mockImplementation((options: unknown) => ({
      kind: 'fixture-transport',
      options,
    }));
    panelFixture.createWorkspaceKernel.mockImplementation((options: unknown) => {
      const kernel = createMockKernel(`kernel-${(kernelCounter += 1)}`, nextSnapshot, options);
      panelFixture.kernels.push(kernel);
      return kernel;
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.unstubAllGlobals();
  });

  it('bootstraps the local SDK contract without launching a real terminal runtime', async () => {
    window.localStorage.setItem(storageKey('theme'), 'terminal-platform-light');
    window.localStorage.setItem(storageKey('font-scale'), 'large');
    window.localStorage.setItem(storageKey('line-wrap'), 'true');
    window.localStorage.setItem(
      storageKey('command-history'),
      JSON.stringify([
        '   ',
        '(venv312) (base) belief@MacBook-Pro-belief terminal-ui-smoke % git status',
        '(env) C:\\Users\\belief\\project $ pnpm test',
        'echo clean',
      ])
    );

    await renderPanel();

    expect(getBootstrap).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      teamDisplayName: 'Terminal Fixture',
      teamName: TEAM_NAME,
    });
    expect(panelFixture.createWorkspaceWebSocketTransport).toHaveBeenCalledWith({
      controlUrl: 'ws://fixture-control',
      streamUrl: 'ws://fixture-stream',
    });
    expect(panelFixture.createWorkspaceKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        commandHistoryLimit: 80,
        initialCommandHistoryEntries: ['git status', 'pnpm test', 'echo clean'],
        initialTerminalFontScale: 'large',
        initialTerminalLineWrap: true,
        initialThemeId: 'terminal-platform-light',
        transport: expect.objectContaining({ kind: 'fixture-transport' }),
      })
    );
    expect(currentKernel().bootstrap).toHaveBeenCalledOnce();
  });

  it('keeps terminal storage isolated per team when another team has persisted state', async () => {
    window.localStorage.setItem(
      'agent-teams:terminal-workspace:other-team:command-history',
      JSON.stringify(['pnpm test --filter other-team'])
    );
    window.localStorage.setItem(
      'agent-teams:terminal-workspace:other-team:theme',
      'terminal-platform-light'
    );
    window.localStorage.setItem('agent-teams:terminal-workspace:other-team:font-scale', 'large');
    window.localStorage.setItem('agent-teams:terminal-workspace:other-team:line-wrap', 'true');

    await renderPanel();

    expect(panelFixture.createWorkspaceKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        initialCommandHistoryEntries: null,
        initialTerminalFontScale: null,
        initialTerminalLineWrap: null,
        initialThemeId: null,
      })
    );
  });

  it('ignores corrupt terminal storage without blocking workspace bootstrap', async () => {
    window.localStorage.setItem(storageKey('command-history'), '{not-json');
    window.localStorage.setItem(storageKey('tab-preferences'), '{not-json');

    await renderPanel();

    expect(panelFixture.createWorkspaceKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        initialCommandHistoryEntries: null,
      })
    );
    expect(getVisibleTabLabels()).toEqual(['Terminal UI Smoke']);
  });

  it('persists terminal display settings and command history from the workspace snapshot', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      commandHistoryEntries: ['pnpm typecheck', 'git status'],
      fontScale: 'compact',
      lineWrap: true,
      themeId: 'terminal-platform-light',
    });

    await renderPanel();

    expect(window.localStorage.getItem(storageKey('theme'))).toBe('terminal-platform-light');
    expect(window.localStorage.getItem(storageKey('font-scale'))).toBe('compact');
    expect(window.localStorage.getItem(storageKey('line-wrap'))).toBe('true');
    expect(JSON.parse(window.localStorage.getItem(storageKey('command-history')) ?? '[]')).toEqual([
      'pnpm typecheck',
      'git status',
    ]);
  });

  it('preserves and restores long command history across empty startup snapshots and remounts', async () => {
    const restoredHistory = Array.from({ length: 96 }, (_, index) =>
      index % 2 === 0
        ? `(venv312) (base) belief@MacBook-Pro-belief terminal-ui-smoke % echo restored-${index}`
        : `pnpm test restored-${index}`
    );
    const expectedRestoredHistory = Array.from({ length: 96 }, (_, index) =>
      index % 2 === 0 ? `echo restored-${index}` : `pnpm test restored-${index}`
    ).slice(-80);
    window.localStorage.setItem(storageKey('command-history'), JSON.stringify(restoredHistory));

    await renderPanel();

    expect(panelFixture.createWorkspaceKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        initialCommandHistoryEntries: expectedRestoredHistory,
      })
    );
    expect(JSON.parse(window.localStorage.getItem(storageKey('command-history')) ?? '[]')).toEqual(
      restoredHistory
    );

    const longRuntimeHistory = Array.from(
      { length: 101 },
      (_, index) => `printf LONG_HISTORY_${index}\\n`
    );
    currentKernel().__snapshot = createWorkspaceSnapshot({
      commandHistoryEntries: longRuntimeHistory,
    });
    await renderPanel();

    const cappedRuntimeHistory = longRuntimeHistory.slice(-80);
    expect(JSON.parse(window.localStorage.getItem(storageKey('command-history')) ?? '[]')).toEqual(
      cappedRuntimeHistory
    );

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    root = createRoot(host);
    panelFixture.createWorkspaceKernel.mockClear();
    nextSnapshot = createWorkspaceSnapshot();

    await renderPanel();

    expect(panelFixture.createWorkspaceKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        initialCommandHistoryEntries: cappedRuntimeHistory,
      })
    );
  });

  it('passes local command-history autocomplete suggestions to the terminal command dock', async () => {
    vi.useFakeTimers();
    nextSnapshot = createWorkspaceSnapshot({
      commandHistoryEntries: ['git status', 'pnpm typecheck', 'pnpm test'],
    });

    try {
      await renderPanel();

      await act(async () => {
        getRequiredElement('mock-terminal-command-dock').dispatchEvent(
          new CustomEvent('tp-terminal-command-draft-change', {
            bubbles: true,
            detail: {
              value: 'pnpm t',
            },
          })
        );
        await flushMicrotasks();
      });

      await act(async () => {
        vi.advanceTimersByTime(80);
        await flushMicrotasks();
      });

      expect(panelFixture.commandDockProps.at(-1)?.autocompleteSuggestion).toBe('pnpm test');

      await act(async () => {
        getRequiredElement('mock-terminal-command-dock').dispatchEvent(
          new CustomEvent('tp-terminal-command-autocomplete-dismiss', {
            bubbles: true,
            detail: {
              draft: 'pnpm t',
            },
          })
        );
        await flushMicrotasks();
      });

      expect(panelFixture.commandDockProps.at(-1)?.autocompleteSuggestion).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows cwd, git branch, prompt label, and powered-by GitHub link in the command area', async () => {
    await renderPanel();

    const workingDirectory = getRequiredElement('agent-team-terminal-working-directory');
    const screen = getRequiredElement('mock-terminal-screen');
    expect(workingDirectory.textContent).toContain(
      '~/dev/projects/claude/.terminal-platform-sandbox/terminal-ui-smoke'
    );
    expect(workingDirectory.textContent).toContain('main');
    expect(workingDirectory.textContent).toContain('powered by terminal-platform');
    expect(screen.getAttribute('data-prompt-label')).toBe(
      '~/dev/projects/claude/.terminal-platform-sandbox/terminal-ui-smoke'
    );

    await clickButton('Open terminal-platform on GitHub');
    expect(openExternal).toHaveBeenCalledWith(TERMINAL_PLATFORM_REPOSITORY_URL);
  });

  it('auto-attaches the selected session and prewarms one hidden shell tab', async () => {
    await renderPanel();

    const kernel = currentKernel();
    expect(kernel.commands.setActiveSession).not.toHaveBeenCalled();
    expect(kernel.commands.attachSession).toHaveBeenCalledWith('session-1');
    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'new_tab',
      title: '__tp_prewarmed_shell__',
    });
    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'focus_tab',
      tab_id: 'tab-1',
    });
  });

  it('activates the prewarmed shell instantly when users create a new tab', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();
    kernel.commands.attachSession.mockClear();

    await clickButton('Create terminal tab');

    expect(kernel.commands.dispatchMuxCommand.mock.calls.map(([, command]) => command)).toEqual([
      {
        kind: 'rename_tab',
        tab_id: 'tab-prewarmed',
        title: 'Tab 2',
      },
      {
        kind: 'focus_tab',
        tab_id: 'tab-prewarmed',
      },
    ]);
    expect(kernel.commands.attachSession).toHaveBeenCalledWith('session-1');
  });

  it('falls back to creating a cold tab when prewarm/focus support is unavailable', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      controls: {
        canFocusTab: false,
      },
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();

    await clickButton('Create terminal tab');

    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'new_tab',
      title: 'Tab 2',
    });
  });

  it('surfaces mux command failures and allows tab actions to be retried', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockReset();
    kernel.commands.dispatchMuxCommand.mockRejectedValueOnce(new Error('mux gateway unavailable'));

    await clickButton('Create terminal tab');

    expect(document.body.textContent).toContain('mux gateway unavailable');
    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledTimes(1);

    kernel.commands.dispatchMuxCommand.mockResolvedValue(undefined);
    await clickButton('Create terminal tab');

    expect(
      kernel.commands.dispatchMuxCommand.mock.calls.slice(-2).map(([, command]) => command)
    ).toEqual([
      {
        kind: 'rename_tab',
        tab_id: 'tab-prewarmed',
        title: 'Tab 2',
      },
      {
        kind: 'focus_tab',
        tab_id: 'tab-prewarmed',
      },
    ]);
  });

  it('keeps mux controls inert when the backend reports tab actions unavailable', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      controls: {
        canCloseTab: false,
        canCreateTab: false,
        canFocusTab: false,
        canRenameTab: false,
      },
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();

    const newTabButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="agent-team-terminal-new-mux-tab"]'
    );
    expect(newTabButton?.disabled).toBe(true);
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-testid="agent-team-terminal-close-mux-tab"]'
        )
      ).map((button) => button.disabled)
    ).toEqual([true, true]);

    await clickButton('Create terminal tab');
    await clickButton('Close terminal tab Logs');
    await act(async () => {
      getTabButton('Logs').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      getTabButton('Terminal UI Smoke').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      );
      await flushMicrotasks();
    });

    expect(kernel.commands.dispatchMuxCommand).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="agent-team-terminal-tab-title-input"]')
    ).toBeNull();
  });

  it('supports double-click tab rename and dispatches the mux rename command', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();

    const tabButton = getTabButton('Terminal UI Smoke');
    await act(async () => {
      tabButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    const input = getRequiredElement('agent-team-terminal-tab-title-input') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'Logs');
      await flushMicrotasks();
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        })
      );
      await flushMicrotasks();
    });

    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'rename_tab',
      tab_id: 'tab-1',
      title: 'Logs',
    });
  });

  it('closes empty tabs immediately and asks for confirmation before dropping tab history', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      historicalPanes: {
        'pane-2': {
          lines: ['old command output'],
        },
      },
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();

    await clickButton('Close terminal tab Logs');
    expect(kernel.commands.dispatchMuxCommand).not.toHaveBeenCalledWith('session-1', {
      kind: 'close_tab',
      tab_id: 'tab-2',
    });
    expect(document.body.textContent).toContain('Close terminal tab?');

    await clickTextButton('Close tab');
    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'close_tab',
      tab_id: 'tab-2',
    });

    kernel.commands.dispatchMuxCommand.mockClear();
    await clickButton('Close terminal tab Terminal UI Smoke');
    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'close_tab',
      tab_id: 'tab-1',
    });
  });

  it('focuses the visible tab on the left after closing the active terminal tab', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      focusedTabId: 'tab-3',
      tabs: [
        createTab('tab-1', 'Build', 'pane-build'),
        createTab('tab-2', 'Tests', 'pane-tests'),
        createTab('tab-3', 'Deploy', 'pane-deploy'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();

    await clickButton('Close terminal tab Deploy');

    expect(kernel.commands.dispatchMuxCommand.mock.calls.map(([, command]) => command)).toEqual([
      {
        kind: 'close_tab',
        tab_id: 'tab-3',
      },
      {
        kind: 'focus_tab',
        tab_id: 'tab-2',
      },
    ]);
  });

  it('restores user tab order preferences and strips the hidden prewarmed tab from visible UI', async () => {
    window.localStorage.setItem(
      storageKey('tab-preferences'),
      JSON.stringify({
        colors: {},
        order: ['tab-2', 'tab-1', 'tab-prewarmed'],
        version: 1,
      })
    );
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();

    expect(getVisibleTabLabels()).toEqual(['Logs', 'Terminal UI Smoke']);
    expect(document.body.textContent).not.toContain('__tp_prewarmed_shell__');
  });

  it('keeps terminal tab close buttons hover-only and avoids mixed border style shorthands', async () => {
    window.localStorage.setItem(
      storageKey('tab-preferences'),
      JSON.stringify({
        colors: {
          'tab-2': 'sky',
        },
        order: ['tab-1', 'tab-2'],
        version: 1,
      })
    );
    nextSnapshot = createWorkspaceSnapshot({
      focusedTabId: 'tab-2',
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();

    const closeButton = getTabCloseButton('Logs');
    const closeButtonClass = closeButton.getAttribute('class') ?? '';
    const tabElement = getTabDragElement('Logs');

    expect(closeButtonClass).toContain('opacity-0');
    expect(closeButtonClass).toContain('group-hover:opacity-100');
    expect(closeButtonClass).not.toContain('border-l');
    expect(tabElement.getAttribute('style')).not.toContain('border-color:');
    expect(tabElement.style.getPropertyValue('--tp-tab-border')).not.toBe('');
    expect(tabElement.style.getPropertyValue('--tp-tab-border-bottom')).toBe('transparent');
  });

  it('reorders terminal tabs from a horizontal pointer drag and shows a precise drop indicator', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();

    const sourceButton = getTabButton('Terminal UI Smoke');
    const source = getTabDragElement('Terminal UI Smoke');
    const target = getTabDragElement('Logs');
    setElementRect(source, { left: 0, width: 120 });
    setElementRect(target, { left: 128, width: 120 });

    await act(async () => {
      dispatchMockPointerEvent(sourceButton, 'pointerdown', { clientX: 24, clientY: 10 });
      dispatchMockPointerEvent(sourceButton, 'pointermove', { clientX: 240, clientY: 12 });
      await flushMicrotasks();
    });

    expect(getVisibleTabLabels()).toEqual(['Logs', 'Terminal UI Smoke']);
    expect(getRequiredElement('agent-team-terminal-tab-drop-indicator')).toBeTruthy();
    expect(getTabDragElement('Logs').dataset.dropPlacement).toBe('after');
    expect(JSON.parse(window.localStorage.getItem(storageKey('tab-preferences')) ?? '{}')).toEqual(
      expect.objectContaining({
        order: ['tab-2', 'tab-1'],
      })
    );

    await act(async () => {
      dispatchMockPointerEvent(getTabDragElement('Terminal UI Smoke'), 'pointerup', {
        clientX: 240,
        clientY: 12,
      });
      await flushMicrotasks();
    });

    expect(
      document.querySelector('[data-testid="agent-team-terminal-tab-drop-indicator"]')
    ).toBeNull();
    expect(getVisibleTabLabels()).toEqual(['Logs', 'Terminal UI Smoke']);
  });

  it('selects a terminal tab from the pointer interaction path without requiring a synthetic click', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();

    const targetButton = getTabButton('Logs');
    const targetTab = getTabDragElement('Logs');

    await act(async () => {
      dispatchMockPointerEvent(targetButton, 'pointerdown', { clientX: 144, clientY: 10 });
      dispatchMockPointerEvent(targetTab, 'pointerup', { clientX: 144, clientY: 10 });
      await flushMicrotasks();
    });

    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'focus_tab',
      tab_id: 'tab-2',
    });
  });

  it('keeps the close hit target out of tab dragging while closing the tab', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();
    const kernel = currentKernel();
    kernel.commands.dispatchMuxCommand.mockClear();

    const source = getTabDragElement('Logs');
    const target = getTabDragElement('Terminal UI Smoke');
    const closeButton = getTabCloseButton('Logs');
    setElementRect(source, { left: 128, width: 120 });
    setElementRect(target, { left: 0, width: 120 });

    await act(async () => {
      dispatchMockPointerEvent(closeButton, 'pointerdown', { clientX: 235, clientY: 10 });
      dispatchMockPointerEvent(closeButton, 'pointermove', { clientX: 16, clientY: 11 });
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    expect(getVisibleTabLabels()).toEqual(['Terminal UI Smoke', 'Logs']);
    expect(document.querySelector('[data-testid="agent-team-terminal-tab-drop-indicator"]')).toBe(
      null
    );
    expect(kernel.commands.dispatchMuxCommand).toHaveBeenCalledWith('session-1', {
      kind: 'close_tab',
      tab_id: 'tab-2',
    });
  });

  it('shows tab switching progress in the terminal history area instead of the tab label', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-2', 'Logs', 'pane-2'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });

    await renderPanel();

    const kernel = currentKernel();
    const pendingFocus = createDeferred<void>();
    kernel.commands.dispatchMuxCommand.mockImplementationOnce(() => pendingFocus.promise);

    await act(async () => {
      getTabButton('Logs').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(getRequiredElement('agent-team-terminal-content-skeleton')).toBeTruthy();
    expect(getTabButton('Logs').querySelector('.animate-spin')).toBeNull();

    await act(async () => {
      pendingFocus.resolve();
      await flushMicrotasks();
    });

    expect(
      document.querySelector('[data-testid="agent-team-terminal-content-skeleton"]')
    ).toBeNull();
  });

  it('keeps startup pane fallback covered until a focused terminal screen arrives', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      focusedScreenReady: false,
    });

    await renderPanel();

    expect(getRequiredElement('mock-terminal-screen').textContent).toContain('select a pane first');
    expect(getRequiredElement('agent-team-terminal-content-skeleton')).toBeTruthy();

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedScreenReady: true,
    });
    await renderPanel();

    expect(
      document.querySelector('[data-testid="agent-team-terminal-content-skeleton"]')
    ).toBeNull();
  });

  it('forwards command lifecycle metadata into terminal screen presentations and scrolls down', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });
    await renderPanel();

    const dock = getRequiredElement('mock-terminal-command-dock');
    await act(async () => {
      dock.dispatchEvent(
        new CustomEvent('tp-terminal-command-submitted', {
          bubbles: true,
          detail: {
            clientEventId: 'command-1',
            command: 'git status',
            paneId: 'pane-1',
            sessionId: 'session-1',
            startedAtMs: 1000,
          },
        })
      );
      await flushMicrotasks();
    });

    let metadata = getLatestScreenCommandMetadata();
    expect(metadata).toEqual([
      expect.objectContaining({
        clientEventId: 'command-1',
        command: 'git status',
        status: 'running',
      }),
    ]);
    expect(panelFixture.scrollToLatestOutput).toHaveBeenCalled();

    await act(async () => {
      dock.dispatchEvent(
        new CustomEvent('tp-terminal-command-failed', {
          bubbles: true,
          detail: {
            clientEventId: 'command-1',
            command: 'git status',
            paneId: 'pane-1',
            sessionId: 'session-1',
            startedAtMs: Date.now() - 230,
          },
        })
      );
      await flushMicrotasks();
    });

    metadata = getLatestScreenCommandMetadata();
    expect(metadata[0]).toMatchObject({
      clientEventId: 'command-1',
      command: 'git status',
      status: 'failed',
    });
    expect(metadata[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('settles completed shell output with duration and failure state in the rendered screen metadata', async () => {
    const tabs = [
      createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
      createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
    ];
    nextSnapshot = createWorkspaceSnapshot({
      tabs,
    });
    await renderPanel();

    const dock = getRequiredElement('mock-terminal-command-dock');
    await act(async () => {
      dock.dispatchEvent(
        new CustomEvent('tp-terminal-command-started', {
          bubbles: true,
          detail: {
            clientEventId: 'command-2',
            command: 'git status',
            paneId: 'pane-1',
            sessionId: 'session-1',
            startedAtMs: Date.now() - 294,
          },
        })
      );
      await flushMicrotasks();
    });

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: [
        { text: 'shell % git status' },
        { text: 'fatal: not a git repository (or any of the parent directories): .git' },
        { text: 'shell %' },
      ],
      sequence: 42,
      tabs,
    });
    await renderPanel();

    const metadata = getLatestScreenCommandMetadata();
    expect(metadata[0]).toMatchObject({
      clientEventId: 'command-2',
      command: 'git status',
      status: 'failed',
    });
    expect(metadata[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('settles plain command echoes instead of leaving their timer running', async () => {
    const tabs = [
      createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
      createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
    ];
    nextSnapshot = createWorkspaceSnapshot({ tabs });
    await renderPanel();

    await dispatchCommandDockEvent('tp-terminal-command-started', {
      clientEventId: 'plain-command',
      command: "print 'fdfd'",
      paneId: 'pane-1',
      sessionId: 'session-1',
      startedAtMs: Date.now() - 120,
    });

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: [
        { text: "print 'fdfd'" },
        { text: 'fdfd' },
        { text: '~/dev/projects/claude/claude_team %' },
      ],
      sequence: 43,
      tabs,
    });
    await renderPanel();

    expect(getLatestScreenCommandMetadata()[0]).toMatchObject({
      clientEventId: 'plain-command',
      command: "print 'fdfd'",
      status: 'succeeded',
    });
    expect(getLatestScreenCommandMetadata()[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps a fast command settled when transport acknowledgement arrives after completion', async () => {
    const tabs = [
      createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
      createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
    ];
    nextSnapshot = createWorkspaceSnapshot({ tabs });
    await renderPanel();

    const eventDetail = {
      clientEventId: 'fast-command',
      command: "print 'hello world'",
      paneId: 'pane-1',
      sessionId: 'session-1',
      startedAtMs: Date.now() - 120,
    };
    await dispatchCommandDockEvent('tp-terminal-command-started', eventDetail);

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: [
        { text: "print 'hello world'" },
        { text: 'hello world' },
        { text: '~/dev/projects/claude/claude_team %' },
      ],
      sequence: 44,
      tabs,
    });
    await renderPanel();

    const settledDuration = getLatestScreenCommandMetadata()[0]?.durationMs;
    expect(getLatestScreenCommandMetadata()[0]).toMatchObject({ status: 'succeeded' });

    await dispatchCommandDockEvent('tp-terminal-command-submitted', eventDetail);

    expect(getLatestScreenCommandMetadata()[0]).toMatchObject({
      durationMs: settledDuration,
      status: 'succeeded',
    });
  });

  it('settles from restored history when the focused screen is stale', async () => {
    const tabs = [
      createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
      createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
    ];
    nextSnapshot = createWorkspaceSnapshot({ tabs });
    await renderPanel();
    const startedAtMs = Date.now() - 220;

    await dispatchCommandDockEvent('tp-terminal-command-started', {
      clientEventId: 'stale-live-command',
      command: 'not_a_real_command',
      paneId: 'pane-1',
      sessionId: 'session-1',
      startedAtMs,
    });

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: [{ text: 'shell % not_a_real_command' }],
      historicalPanes: {
        'pane-1': {
          capturedAtMs: BigInt(startedAtMs + 100),
          lines: [
            'shell % nnot_a_real_command',
            'zsh: command not found: not_a_real_command',
            'shell %',
          ],
        },
      },
      sequence: 44,
      tabs,
    });
    await renderPanel();

    expect(getLatestScreenCommandMetadata()[0]).toMatchObject({
      clientEventId: 'stale-live-command',
      command: 'not_a_real_command',
      status: 'failed',
    });
    expect(getLatestScreenCommandMetadata()[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('opens a command history context menu and copies command block text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await renderPanel();

    const screen = getRequiredElement('mock-terminal-screen');
    const historyEntry = document.createElement('section');
    historyEntry.className = 'history-entry';
    historyEntry.setAttribute('part', 'history-entry');
    historyEntry.innerHTML = `
      <div class="history-entry-command" part="history-entry-command">
        <span class="history-entry-text" part="history-entry-command-text">echo TP_CONTEXT</span>
      </div>
      <div class="history-entry-output" part="history-entry-output">
        <span class="history-entry-text" part="history-entry-output-text">TP_CONTEXT_OUTPUT</span>
      </div>
    `;
    screen.appendChild(historyEntry);

    await act(async () => {
      historyEntry.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 140,
        })
      );
      await flushMicrotasks();
    });

    const menu = getRequiredElement('agent-team-terminal-command-context-menu');
    expect(menu.textContent).toContain('Copy');
    expect(menu.textContent).toContain('Copy command');
    expect(menu.textContent).toContain('Copy output');

    await act(async () => {
      getRequiredElement('agent-team-terminal-command-context-copy-output').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      );
      await flushMicrotasks();
    });
    expect(writeText).toHaveBeenLastCalledWith('TP_CONTEXT_OUTPUT');

    await act(async () => {
      historyEntry.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 150,
          clientY: 160,
        })
      );
      await flushMicrotasks();
    });
    await act(async () => {
      getRequiredElement('agent-team-terminal-command-context-copy-command').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      );
      await flushMicrotasks();
    });
    expect(writeText).toHaveBeenLastCalledWith('echo TP_CONTEXT');
  });

  it('keeps command lifecycle metadata scoped to the active tab during rapid tab switching', async () => {
    const tabs = [
      createTab('tab-1', 'Build', 'pane-build'),
      createTab('tab-2', 'Tests', 'pane-tests'),
      createTab('tab-3', 'Logs', 'pane-logs'),
      createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
    ];
    nextSnapshot = createWorkspaceSnapshot({
      focusedTabId: 'tab-1',
      tabs,
    });
    await renderPanel();

    await dispatchCommandDockEvent('tp-terminal-command-started', {
      clientEventId: 'build-command',
      command: 'pnpm build',
      paneId: 'pane-build',
      sessionId: 'session-1',
      startedAtMs: Date.now() - 500,
    });
    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'build-command',
        command: 'pnpm build',
        status: 'running',
      }),
    ]);

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedTabId: 'tab-2',
      tabs,
    });
    await renderPanel();
    expect(getLatestScreenCommandMetadata()).toEqual([]);

    await dispatchCommandDockEvent('tp-terminal-command-started', {
      clientEventId: 'test-command',
      command: 'pnpm test -- --runInBand',
      paneId: 'pane-tests',
      sessionId: 'session-1',
      startedAtMs: Date.now() - 250,
    });
    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'test-command',
        command: 'pnpm test -- --runInBand',
        status: 'running',
      }),
    ]);

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: [
        { text: 'shell % pnpm build' },
        { text: 'Build completed' },
        { text: 'shell %' },
      ],
      focusedTabId: 'tab-1',
      sequence: 11,
      tabs,
    });
    await renderPanel();
    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'build-command',
        command: 'pnpm build',
        status: 'succeeded',
      }),
    ]);

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: [
        { text: 'shell % pnpm test -- --runInBand' },
        { text: 'pnpm ERR! fixture test failed' },
        { text: 'shell %' },
      ],
      focusedTabId: 'tab-2',
      sequence: 12,
      tabs,
    });
    await renderPanel();
    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'test-command',
        command: 'pnpm test -- --runInBand',
        status: 'failed',
      }),
    ]);
  });

  it('caps command presentation metadata during long active terminal sessions', async () => {
    nextSnapshot = createWorkspaceSnapshot({
      tabs: [
        createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
        createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
      ],
    });
    await renderPanel();

    await act(async () => {
      const dock = getRequiredElement('mock-terminal-command-dock');
      for (let index = 0; index < 95; index += 1) {
        dock.dispatchEvent(
          new CustomEvent('tp-terminal-command-started', {
            bubbles: true,
            detail: {
              clientEventId: `long-command-${index}`,
              command: `printf LONG_${index}\\n`,
              paneId: 'pane-1',
              sessionId: 'session-1',
              startedAtMs: 10_000 + index,
            },
          })
        );
      }
      await flushMicrotasks();
    });

    const metadata = getLatestScreenCommandMetadata();
    expect(metadata).toHaveLength(80);
    expect(metadata[0]).toMatchObject({
      clientEventId: 'long-command-15',
      command: 'printf LONG_15\\n',
      status: 'unknown',
    });
    expect(metadata.at(-1)).toMatchObject({
      clientEventId: 'long-command-94',
      command: 'printf LONG_94\\n',
      status: 'running',
    });
  });

  it('keeps metadata for quiet tabs while another tab is used heavily', async () => {
    const tabs = [
      createTab('tab-1', 'Build', 'pane-build'),
      createTab('tab-2', 'Tests', 'pane-tests'),
      createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
    ];
    nextSnapshot = createWorkspaceSnapshot({
      focusedTabId: 'tab-1',
      tabs,
    });
    await renderPanel();

    await dispatchCommandDockEvent('tp-terminal-command-started', {
      clientEventId: 'build-command',
      command: 'pnpm build',
      paneId: 'pane-build',
      sessionId: 'session-1',
      startedAtMs: Date.now() - 750,
    });

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedTabId: 'tab-2',
      tabs,
    });
    await renderPanel();

    await act(async () => {
      const dock = getRequiredElement('mock-terminal-command-dock');
      for (let index = 0; index < 96; index += 1) {
        dock.dispatchEvent(
          new CustomEvent('tp-terminal-command-started', {
            bubbles: true,
            detail: {
              clientEventId: `test-command-${index}`,
              command: `printf TEST_${index}\\n`,
              paneId: 'pane-tests',
              sessionId: 'session-1',
              startedAtMs: 20_000 + index,
            },
          })
        );
      }
      await flushMicrotasks();
    });

    expect(getLatestScreenCommandMetadata()).toHaveLength(80);
    expect(getLatestScreenCommandMetadata().at(0)).toMatchObject({
      clientEventId: 'test-command-16',
      command: 'printf TEST_16\\n',
    });

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: [
        { text: 'shell % pnpm build' },
        { text: 'build completed' },
        { text: 'shell %' },
      ],
      focusedTabId: 'tab-1',
      sequence: 21,
      tabs,
    });
    await renderPanel();

    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'build-command',
        command: 'pnpm build',
        paneId: 'pane-build',
        status: 'succeeded',
      }),
    ]);
  });

  it('rehydrates interrupted running metadata as unknown instead of restarting its timer', async () => {
    window.localStorage.setItem(
      storageKey('command-runs'),
      JSON.stringify([
        {
          clientEventId: 'interrupted-command',
          command: 'sleep 30',
          paneId: 'pane-1',
          sessionId: 'session-1',
          startedAtMs: Date.now() - 60_000,
          status: 'running',
        },
      ])
    );

    await renderPanel();

    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'interrupted-command',
        command: 'sleep 30',
        status: 'unknown',
      }),
    ]);
    expect(getLatestScreenCommandMetadata()[0]?.durationMs).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(storageKey('command-runs')) ?? '[]')).toEqual([
      expect.objectContaining({
        clientEventId: 'interrupted-command',
        status: 'unknown',
      }),
    ]);
  });

  it('restores command presentation metadata across remounts for recovered history', async () => {
    const tabs = [
      createTab('tab-1', 'Terminal UI Smoke', 'pane-1'),
      createTab('tab-prewarmed', '__tp_prewarmed_shell__', 'pane-prewarmed'),
    ];
    const restoredLines = [
      { text: 'shell % printf TP_RESTORE_OK\\n' },
      { text: 'TP_RESTORE_OK' },
      { text: 'shell % ls __tp_restore_missing__' },
      { text: 'ls: __tp_restore_missing__: No such file or directory' },
      { text: 'shell %' },
    ];
    nextSnapshot = createWorkspaceSnapshot({
      focusedLines: restoredLines,
      tabs,
    });
    await renderPanel();

    await dispatchCommandDockEvent('tp-terminal-command-started', {
      clientEventId: 'restore-ok',
      command: 'printf TP_RESTORE_OK\\n',
      paneId: 'pane-1',
      sessionId: 'session-1',
      startedAtMs: Date.now() - 345,
    });
    await dispatchCommandDockEvent('tp-terminal-command-started', {
      clientEventId: 'restore-missing',
      command: 'ls __tp_restore_missing__',
      paneId: 'pane-1',
      sessionId: 'session-1',
      startedAtMs: Date.now() - 220,
    });

    currentKernel().__snapshot = createWorkspaceSnapshot({
      focusedLines: restoredLines,
      sequence: 9,
      tabs,
    });
    await renderPanel();

    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'restore-ok',
        command: 'printf TP_RESTORE_OK\\n',
        status: 'succeeded',
      }),
      expect.objectContaining({
        clientEventId: 'restore-missing',
        command: 'ls __tp_restore_missing__',
        status: 'failed',
      }),
    ]);
    expect(
      getLatestScreenCommandMetadata().every((metadata) => typeof metadata.durationMs === 'number')
    ).toBe(true);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    root = createRoot(host);
    panelFixture.createWorkspaceKernel.mockClear();
    nextSnapshot = createWorkspaceSnapshot({
      focusedLines: restoredLines,
      sequence: 10,
      tabs,
    });

    await renderPanel();

    expect(getLatestScreenCommandMetadata()).toEqual([
      expect.objectContaining({
        clientEventId: 'restore-ok',
        command: 'printf TP_RESTORE_OK\\n',
        status: 'succeeded',
      }),
      expect.objectContaining({
        clientEventId: 'restore-missing',
        command: 'ls __tp_restore_missing__',
        status: 'failed',
      }),
    ]);
    expect(JSON.parse(window.localStorage.getItem(storageKey('command-runs')) ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientEventId: 'restore-ok',
          status: 'succeeded',
        }),
        expect.objectContaining({
          clientEventId: 'restore-missing',
          status: 'failed',
        }),
      ])
    );
  });

  it('renders settings as a tab page and routes appearance, behavior, and runtime actions', async () => {
    await renderPanel({ settingsOpen: true });
    const kernel = currentKernel();

    expect(
      document.querySelector('[data-testid="agent-team-terminal-settings-tab"]')
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="agent-team-terminal-settings"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="mock-terminal-command-dock"]')).toBeNull();
    expect(document.querySelector('[aria-label="Terminal theme"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Terminal font preset"]')).not.toBeNull();
    expect(document.querySelector('#terminal-settings-background-image')).toBeNull();

    await updateInputValue('#terminal-settings-font-size', '18');
    await updateInputValue('#terminal-settings-opacity', '63');
    await clickCheckboxLabel('Wrap long command output');
    await clickTextButton('Reconnect');
    await clickTextButton('Sessions');
    await clickTextButton('Stop');

    const consoleElement = document.querySelector<HTMLElement>('.agent-team-terminal-console');
    expect(consoleElement?.style.getPropertyValue('--agent-terminal-font-size')).toBe('18px');
    expect(consoleElement?.style.getPropertyValue('--agent-terminal-panel-opacity')).toBe('0.63');
    expect(
      JSON.parse(window.localStorage.getItem(storageKey('appearance-settings')) ?? '{}')
    ).toEqual(
      expect.objectContaining({
        fontSizePx: 18,
        opacityPercent: 63,
      })
    );
    expect(kernel.commands.setTerminalLineWrap).toHaveBeenCalledWith(true);
    expect(kernel.commands.bootstrap).toHaveBeenCalled();
    expect(kernel.commands.refreshSessions).toHaveBeenCalled();
    expect(stopTeamRuntime).toHaveBeenCalledWith(TEAM_NAME);
  });

  it('shows image-only background controls and applies image blur when image mode is selected', async () => {
    window.localStorage.setItem(
      storageKey('appearance-settings'),
      JSON.stringify({
        backgroundColor: '#080c14',
        backgroundImageFit: 'cover',
        backgroundImageUrl: 'https://example.test/background.jpg',
        backgroundMode: 'image',
        backdropBlurPx: 4,
        dimBackgroundImage: true,
        fontSizePx: 15,
        opacityPercent: 74,
        version: 1,
      })
    );

    await renderPanel({ settingsOpen: true });

    expect(document.querySelector('#terminal-settings-background-image')).not.toBeNull();
    expect(document.querySelector('#terminal-settings-blur')).not.toBeNull();

    await updateInputValue('#terminal-settings-blur', '22');

    const consoleElement = document.querySelector<HTMLElement>('.agent-team-terminal-console');
    expect(consoleElement?.style.getPropertyValue('--agent-terminal-background-image-blur')).toBe(
      '22px'
    );
  });

  it('reattaches sessions after connection loss and recovery without duplicating stable attaches', async () => {
    const controls = {
      canCreateTab: false,
      canFocusTab: false,
    };
    nextSnapshot = createWorkspaceSnapshot({
      connectionState: 'disposed',
      controls,
    });
    await renderPanel();
    const kernel = currentKernel();

    expect(kernel.commands.attachSession).not.toHaveBeenCalled();

    currentKernel().__snapshot = createWorkspaceSnapshot({
      connectionState: 'ready',
      controls,
    });
    await renderPanel();
    expect(kernel.commands.attachSession).toHaveBeenCalledTimes(1);
    expect(kernel.commands.attachSession).toHaveBeenLastCalledWith('session-1');

    await renderPanel();
    expect(kernel.commands.attachSession).toHaveBeenCalledTimes(1);

    currentKernel().__snapshot = createWorkspaceSnapshot({
      connectionState: 'disposed',
      controls,
    });
    await renderPanel();
    currentKernel().__snapshot = createWorkspaceSnapshot({
      connectionState: 'ready',
      controls,
    });
    await renderPanel();

    expect(kernel.commands.attachSession).toHaveBeenCalledTimes(2);
    expect(kernel.commands.attachSession).toHaveBeenLastCalledWith('session-1');
  });

  it('renders bootstrap failures without constructing a workspace kernel', async () => {
    getBootstrap.mockRejectedValueOnce(new Error('sandbox terminal runtime unavailable'));

    await renderPanel();

    expect(document.body.textContent).toContain('Terminal runtime is unavailable');
    expect(document.body.textContent).toContain('sandbox terminal runtime unavailable');
    expect(panelFixture.createWorkspaceKernel).not.toHaveBeenCalled();
  });

  it('disposes the kernel when the panel unmounts', async () => {
    await renderPanel();
    const kernel = currentKernel();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });

    expect(kernel.dispose).toHaveBeenCalledOnce();
  });

  async function renderPanel({
    settingsOpen = false,
  }: {
    settingsOpen?: boolean;
  } = {}): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TerminalWorkspacePanel, {
            getBootstrap,
            gitBranch: 'main',
            isTeamAlive: true,
            projectPath: PROJECT_PATH,
            settingsOpen,
            stopTeamRuntime,
            surface: 'sheet',
            teamDisplayName: 'Terminal Fixture',
            teamName: TEAM_NAME,
          })
        )
      );
      await flushMicrotasks();
    });
  }
});

interface MockKernel {
  __options: unknown;
  __snapshot: MockWorkspaceSnapshot;
  bootstrap: ReturnType<typeof vi.fn<() => Promise<void>>>;
  commands: {
    attachSession: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
    bootstrap: ReturnType<typeof vi.fn<() => Promise<void>>>;
    dispatchMuxCommand: ReturnType<
      typeof vi.fn<(sessionId: string, command: MockMuxCommand) => Promise<void>>
    >;
    refreshSessions: ReturnType<typeof vi.fn<() => Promise<void>>>;
    setActiveSession: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
    setTerminalFontScale: ReturnType<typeof vi.fn<(fontScale: string) => void>>;
    setTerminalLineWrap: ReturnType<typeof vi.fn<(lineWrap: boolean) => void>>;
    setTheme: ReturnType<typeof vi.fn<(themeId: string) => void>>;
  };
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  id: string;
}

interface MockWorkspaceSnapshot {
  __controls: MockTopologyControls;
  attachedSession: {
    focused_screen: {
      pane_id: string;
      sequence: number;
      surface: {
        cursor: { col: number; row: number } | null;
        lines: Array<{ text: string }>;
      };
    } | null;
    session_id: string;
    topology: {
      focused_tab: string;
      tabs: MockTab[];
    };
  };
  catalog: {
    sessions: Array<{ session_id: string; title: string }>;
  };
  commandHistory: {
    entries: string[];
  };
  connection: {
    state: 'idle' | 'bootstrapping' | 'ready' | 'error' | 'disposed';
  };
  historicalPanes: Record<string, { capturedAtMs?: bigint; lines: string[] }>;
  selection: {
    activeSessionId: string | null;
  };
  terminalDisplay: {
    fontScale: string;
    lineWrap: boolean;
  };
  theme: {
    themeId: string;
  };
}

interface MockTopologyControls {
  activeSessionId: string;
  activeTab: MockTab | null;
  canCloseTab: boolean;
  canCreateTab: boolean;
  canFocusTab: boolean;
  canRenameTab: boolean;
}

interface MockTab {
  root: {
    kind: 'leaf';
    pane_id: string;
  };
  tab_id: string;
  title: string;
}

type MockMuxCommand =
  | {
      kind: 'close_tab' | 'focus_tab';
      tab_id: string;
    }
  | {
      kind: 'new_tab';
      title: string;
    }
  | {
      kind: 'rename_tab';
      tab_id: string;
      title: string;
    };

function createBootstrap(): TerminalWorkspaceBootstrap {
  return {
    controlPlaneUrl: 'ws://fixture-control',
    defaultShell: '/bin/zsh',
    projectPath: PROJECT_PATH,
    runtimeSlug: 'terminal-fixture-runtime',
    sessionStreamUrl: 'ws://fixture-stream',
    teamName: TEAM_NAME,
  };
}

function createMockKernel(
  id: string,
  snapshot: MockWorkspaceSnapshot,
  options: unknown
): MockKernel {
  return {
    __options: options,
    __snapshot: snapshot,
    bootstrap: vi.fn().mockResolvedValue(undefined),
    commands: {
      attachSession: vi.fn().mockResolvedValue(undefined),
      bootstrap: vi.fn().mockResolvedValue(undefined),
      dispatchMuxCommand: vi.fn().mockResolvedValue(undefined),
      refreshSessions: vi.fn().mockResolvedValue(undefined),
      setActiveSession: vi.fn(),
      setTerminalFontScale: vi.fn(),
      setTerminalLineWrap: vi.fn(),
      setTheme: vi.fn(),
    },
    dispose: vi.fn().mockResolvedValue(undefined),
    id,
  };
}

function createWorkspaceSnapshot({
  commandHistoryEntries = [],
  connectionState = 'ready',
  controls = {},
  focusedTabId = 'tab-1',
  focusedScreenReady = true,
  fontScale = 'default',
  focusedLines = [],
  cursorRow = focusedLines.length > 0 ? focusedLines.length - 1 : null,
  historicalPanes = {},
  lineWrap = false,
  sequence = 1,
  tabs = [createTab('tab-1', 'Terminal UI Smoke', 'pane-1')],
  themeId = 'terminal-platform-default',
}: {
  commandHistoryEntries?: string[];
  connectionState?: MockWorkspaceSnapshot['connection']['state'];
  controls?: Partial<
    Omit<MockTopologyControls, 'activeSessionId' | 'activeTab'> & {
      activeSessionId: string;
      activeTab: MockTab | null;
    }
  >;
  cursorRow?: number | null;
  focusedTabId?: string;
  focusedScreenReady?: boolean;
  fontScale?: string;
  focusedLines?: Array<{ text: string }>;
  historicalPanes?: Record<string, { capturedAtMs?: bigint; lines: string[] }>;
  lineWrap?: boolean;
  sequence?: number;
  tabs?: MockTab[];
  themeId?: string;
} = {}): MockWorkspaceSnapshot {
  const activeTab = tabs.find((tab) => tab.tab_id === focusedTabId) ?? tabs[0] ?? null;
  const activePaneId = activeTab?.root.pane_id ?? 'pane-1';
  const activeSessionId = controls.activeSessionId ?? 'session-1';

  return {
    __controls: {
      activeSessionId,
      activeTab,
      canCloseTab: controls.canCloseTab ?? true,
      canCreateTab: controls.canCreateTab ?? true,
      canFocusTab: controls.canFocusTab ?? true,
      canRenameTab: controls.canRenameTab ?? true,
    },
    attachedSession: {
      focused_screen: focusedScreenReady
        ? {
            pane_id: activePaneId,
            sequence,
            surface: {
              cursor:
                cursorRow === null
                  ? null
                  : {
                      col: focusedLines[cursorRow]?.text.length ?? 0,
                      row: cursorRow,
                    },
              lines: focusedLines,
            },
          }
        : null,
      session_id: activeSessionId,
      topology: {
        focused_tab: activeTab?.tab_id ?? focusedTabId,
        tabs,
      },
    },
    catalog: {
      sessions: [{ session_id: activeSessionId, title: 'Fixture Session' }],
    },
    commandHistory: {
      entries: commandHistoryEntries,
    },
    connection: {
      state: connectionState,
    },
    historicalPanes,
    selection: {
      activeSessionId,
    },
    terminalDisplay: {
      fontScale,
      lineWrap,
    },
    theme: {
      themeId,
    },
  };
}

function createTab(tabId: string, title: string, paneId: string): MockTab {
  return {
    root: {
      kind: 'leaf',
      pane_id: paneId,
    },
    tab_id: tabId,
    title,
  };
}

function storageKey(key: string): string {
  return `agent-teams:terminal-workspace:${TEAM_NAME}:${key}`;
}

function currentKernel(): MockKernel {
  const kernel = panelFixture.kernels.at(-1);
  if (!kernel) {
    throw new Error('Expected a workspace kernel to be created');
  }
  return kernel;
}

function getRequiredElement(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing test element: ${testId}`);
  }
  return element;
}

function getVisibleTabLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-team-terminal-mux-tab"]')
  ).map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

function getTabButton(label: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-team-terminal-mux-tab"]')
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!button) {
    throw new Error(`Missing tab button: ${label}`);
  }
  return button;
}

function getTabDragElement(label: string): HTMLDivElement {
  const element = getTabButton(label).closest<HTMLDivElement>('[data-terminal-tab-id]');
  if (!element) {
    throw new Error(`Missing draggable tab element: ${label}`);
  }
  return element;
}

function getTabCloseButton(label: string): HTMLButtonElement {
  const closeButton = getTabDragElement(label).querySelector<HTMLButtonElement>(
    '[data-testid="agent-team-terminal-close-mux-tab"]'
  );
  if (!closeButton) {
    throw new Error(`Missing close button for tab: ${label}`);
  }
  return closeButton;
}

function setElementRect(element: HTMLElement, rect: { left: number; width: number }): void {
  element.getBoundingClientRect = vi.fn(
    () =>
      ({
        bottom: 27,
        height: 27,
        left: rect.left,
        right: rect.left + rect.width,
        top: 0,
        width: rect.width,
        x: rect.left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
  );
}

function dispatchMockPointerEvent(
  element: HTMLElement,
  type: string,
  options: { clientX?: number; clientY?: number; pointerId?: number }
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', {
    configurable: true,
    value: options.clientX ?? 0,
  });
  Object.defineProperty(event, 'clientY', {
    configurable: true,
    value: options.clientY ?? 0,
  });
  Object.defineProperty(event, 'button', {
    configurable: true,
    value: 0,
  });
  Object.defineProperty(event, 'buttons', {
    configurable: true,
    value: type === 'pointerup' ? 0 : 1,
  });
  Object.defineProperty(event, 'isPrimary', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(event, 'pointerId', {
    configurable: true,
    value: options.pointerId ?? 1,
  });
  element.dispatchEvent(event);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === label
  );
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }

  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}

async function clickTextButton(text: string): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) {
    throw new Error(`Missing text button: ${text}`);
  }

  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}

async function updateInputValue(selector: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) {
    throw new Error(`Missing input: ${selector}`);
  }

  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}

async function clickCheckboxLabel(labelText: string): Promise<void> {
  const checkbox = Array.from(document.querySelectorAll<HTMLElement>('[role="checkbox"]')).find(
    (candidate) => candidate.closest('label')?.textContent?.includes(labelText)
  );
  if (!checkbox) {
    throw new Error(`Missing checkbox: ${labelText}`);
  }

  await act(async () => {
    checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}

async function dispatchCommandDockEvent(
  type: string,
  detail: Record<string, unknown>
): Promise<void> {
  const dock = getRequiredElement('mock-terminal-command-dock');
  await act(async () => {
    dock.dispatchEvent(
      new CustomEvent(type, {
        bubbles: true,
        detail,
      })
    );
    await flushMicrotasks();
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
}

function getLatestScreenCommandMetadata(): Array<Record<string, unknown>> {
  const raw = getRequiredElement('mock-terminal-screen').getAttribute('data-command-metadata');
  return JSON.parse(raw ?? '[]') as Array<Record<string, unknown>>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
