import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { HEADER_ROW1_HEIGHT } from '@renderer/constants/layout';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { useStore } from '@renderer/store';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamViewSnapshot } from '@shared/types';

const sheetFixture = vi.hoisted(() => ({
  adapterProps: [] as Array<Record<string, unknown>>,
  panelProps: [] as Array<Record<string, unknown>>,
  snapTo: vi.fn(),
  ySet: vi.fn(),
}));

vi.mock('react-modal-sheet', async () => {
  const ReactModule = await import('react');
  const React = ReactModule.default;
  const { createPortal: portal } = await import('react-dom');
  const sheetContext = {
    snapTo: sheetFixture.snapTo,
    y: {
      set: sheetFixture.ySet,
    },
  };

  function SheetRoot({
    children,
    className,
    initialSnap,
    isOpen,
    mountPoint,
    onOpenEnd,
    snapPoints,
    style,
    ...props
  }: {
    children?: React.ReactNode;
    className?: string;
    initialSnap?: number;
    isOpen?: boolean;
    mountPoint?: HTMLElement | null;
    onOpenEnd?: () => void;
    snapPoints?: number[];
    style?: React.CSSProperties;
    [key: string]: unknown;
  }): React.ReactElement | null {
    React.useEffect(() => {
      if (isOpen) {
        onOpenEnd?.();
      }
    }, [isOpen, onOpenEnd]);

    if (!isOpen) {
      return null;
    }

    const element = React.createElement(
      'div',
      {
        className,
        'data-initial-snap': String(initialSnap),
        'data-snap-points': JSON.stringify(snapPoints ?? []),
        'data-terminal-sheet-settling': props['data-terminal-sheet-settling'],
        'data-terminal-sheet-snap': props['data-terminal-sheet-snap'],
        'data-testid': 'mock-terminal-sheet-root',
        style,
      },
      children
    );
    return mountPoint ? portal(element, mountPoint) : element;
  }

  const passthrough =
    (testId: string) =>
    ({
      children,
      className,
      style,
      ...props
    }: {
      children?: React.ReactNode;
      className?: string;
      style?: React.CSSProperties;
      [key: string]: unknown;
    }): React.ReactElement =>
      React.createElement(
        'div',
        {
          className,
          'data-testid': props['data-testid'] ?? testId,
          style,
        },
        children
      );

  const Sheet = Object.assign(SheetRoot, {
    Container: passthrough('mock-terminal-sheet-container'),
    Content: passthrough('mock-terminal-sheet-content'),
    DragIndicator: ({ className }: { className?: string }) =>
      React.createElement('div', {
        className,
        'data-testid': 'mock-terminal-sheet-drag-indicator',
      }),
    Header: passthrough('mock-terminal-sheet-header'),
    useContext: () => sheetContext,
  });

  return {
    Sheet,
  };
});

vi.mock('@features/terminal-workspace/renderer/ui/TerminalWorkspacePanel', async () => {
  const ReactModule = await import('react');
  const React = ReactModule.default;
  return {
    TerminalWorkspacePanel: (props: Record<string, unknown>) => {
      sheetFixture.panelProps.push(props);
      return React.createElement(
        'div',
        {
          'data-settings-open': String(props.settingsOpen),
          'data-surface': String(props.surface),
          'data-testid': 'mock-terminal-workspace-panel',
        },
        `${String(props.teamName)}:${String(props.projectPath)}:${String(props.gitBranch)}`
      );
    },
  };
});

vi.mock(
  '@features/terminal-workspace/renderer/adapters/TerminalWorkspaceBottomSheetAdapter',
  async () => {
    const ReactModule = await import('react');
    const React = ReactModule.default;
    return {
      TerminalWorkspaceBottomSheetAdapter: (props: Record<string, unknown>) => {
        sheetFixture.adapterProps.push(props);
        return React.createElement(
          'div',
          {
            'data-branch': String(props.gitBranch ?? ''),
            'data-open': String(props.open),
            'data-project-path': String(props.projectPath ?? ''),
            'data-testid': 'mock-terminal-bottom-sheet-adapter',
          },
          props.open ? 'sheet-open' : 'sheet-closed'
        );
      },
    };
  }
);

vi.mock('@renderer/hooks/useBranchSync', () => ({
  useBranchSync: vi.fn(),
}));

import { TerminalWorkspaceFloatingLauncher } from '@features/terminal-workspace/renderer/adapters/TerminalWorkspaceFloatingLauncher';
import { TerminalWorkspaceBottomSheet } from '@features/terminal-workspace/renderer/ui/TerminalWorkspaceBottomSheet';

const TEAM_NAME = 'terminal-ui-smoke-sandbox';
const PROJECT_PATH =
  '/Users/belief/dev/projects/claude/.terminal-platform-sandbox/terminal-ui-smoke';

describe('terminal workspace bottom sheet fixture-e2e', () => {
  let host: HTMLDivElement;
  let mountPoint: HTMLDivElement;
  let root: Root;
  let originalStoreState: ReturnType<typeof useStore.getState>;

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
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 900,
    });

    originalStoreState = useStore.getState();
    host = document.createElement('div');
    mountPoint = document.createElement('div');
    document.body.append(host, mountPoint);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    host.remove();
    mountPoint.remove();
    document.body.innerHTML = '';
    useStore.setState(originalStoreState, true);
    vi.unstubAllGlobals();
  });

  it('renders nothing until both open state and mount point are available', async () => {
    await renderBottomSheet({ open: false, mountPoint });
    expect(document.querySelector('[data-testid="mock-terminal-sheet-root"]')).toBeNull();

    await renderBottomSheet({ open: true, mountPoint: null });
    expect(document.querySelector('[data-testid="mock-terminal-sheet-root"]')).toBeNull();
  });

  it('opens at the half-height preview snap under the app header', async () => {
    await renderBottomSheet({ open: true, mountPoint });

    const rootElement = getRequiredElement('mock-terminal-sheet-root');
    const container = getRequiredElement('terminal-workspace-bottom-sheet');
    const panel = getRequiredElement('mock-terminal-workspace-panel');

    expect(rootElement.getAttribute('data-initial-snap')).toBe('2');
    expect(rootElement.getAttribute('data-snap-points')).toBe(JSON.stringify([0, 44, 430, 704, 1]));
    expect(rootElement.style.top).toBe(`${HEADER_ROW1_HEIGHT}px`);
    expect(rootElement.style.height).toBe(`calc(100% - ${HEADER_ROW1_HEIGHT}px)`);
    expect(container.style.height).toBe('860px');
    expect(panel.getAttribute('data-surface')).toBe('sheet');
    expect(panel.textContent).toContain(PROJECT_PATH);
    expect(sheetFixture.snapTo).toHaveBeenCalledWith(2);
  });

  it('recomputes snap points from the viewport and keeps full app width on resize', async () => {
    await renderBottomSheet({ open: true, mountPoint });

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 700,
    });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await flushMicrotasks();
    });

    const rootElement = getRequiredElement('mock-terminal-sheet-root');
    const container = getRequiredElement('terminal-workspace-bottom-sheet');
    expect(rootElement.getAttribute('data-snap-points')).toBe(JSON.stringify([0, 44, 330, 540, 1]));
    expect(rootElement.style.left).toBe('0px');
    expect(rootElement.style.right).toBe('0px');
    expect(rootElement.style.width).toBe('100%');
    expect(container.style.height).toBe('660px');
  });

  it('snaps from pointer drag gestures on the sheet handle', async () => {
    await renderBottomSheet({ open: true, mountPoint });
    const handle = getRequiredElement('terminal-workspace-sheet-drag-handle');

    sheetFixture.snapTo.mockClear();
    sheetFixture.ySet.mockClear();
    await act(async () => {
      handle.dispatchEvent(createPointerEvent('pointerdown', { button: 0, clientY: 500 }));
      window.dispatchEvent(createPointerEvent('pointermove', { clientY: 120 }));
      window.dispatchEvent(createPointerEvent('pointerup', { clientY: 120 }));
      await flushMicrotasks();
    });

    expect(sheetFixture.snapTo).toHaveBeenLastCalledWith(4);
    expect(sheetFixture.ySet).toHaveBeenCalledWith(0);

    sheetFixture.snapTo.mockClear();
    await act(async () => {
      handle.dispatchEvent(createPointerEvent('pointerdown', { button: 0, clientY: 120 }));
      window.dispatchEvent(createPointerEvent('pointermove', { clientY: 820 }));
      window.dispatchEvent(createPointerEvent('pointerup', { clientY: 820 }));
      await flushMicrotasks();
    });

    expect(sheetFixture.snapTo).toHaveBeenLastCalledWith(1);
  });

  it('toggles settings and forwards the state into the terminal panel', async () => {
    await renderBottomSheet({ open: true, mountPoint });

    expect(sheetFixture.panelProps.at(-1)?.settingsOpen).toBe(false);
    await clickButton('Open terminal settings');

    expect(sheetFixture.panelProps.at(-1)?.settingsOpen).toBe(true);
    expect(
      getRequiredElement('mock-terminal-workspace-panel').getAttribute('data-settings-open')
    ).toBe('true');
  });

  it('expands, restores, and closes through header controls', async () => {
    const onOpenChange = vi.fn();
    await renderBottomSheet({ open: true, mountPoint, onOpenChange });

    await clickButton('Expand terminal sheet');
    expect(sheetFixture.snapTo).toHaveBeenLastCalledWith(4);

    await clickButton('Restore half-height sheet');
    expect(sheetFixture.snapTo).toHaveBeenLastCalledWith(2);

    await clickButton('Close terminal sheet');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('floating launcher opens the terminal sheet and moves message bottom sheet out of the way', async () => {
    const setMessagesPanelMode = vi.fn((mode: string) => {
      useStore.setState({ messagesPanelMode: mode } as never);
    });
    useStore.setState({
      branchByPath: {
        [normalizePath(PROJECT_PATH)]: 'feature/terminal-ui',
      },
      messagesPanelMode: 'bottom-sheet',
      selectedTeamName: TEAM_NAME,
      selectedTeamData: createTeamSnapshot(),
      setMessagesPanelMode,
      teamDataCacheByName: {
        [TEAM_NAME]: createTeamSnapshot(),
      },
      teamByName: {
        [TEAM_NAME]: {
          teamName: TEAM_NAME,
          displayName: 'Terminal UI Smoke Sandbox',
          description: 'fixture',
          memberCount: 1,
          taskCount: 0,
          lastActivity: null,
          projectPath: PROJECT_PATH,
        },
      },
    } as never);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TerminalWorkspaceFloatingLauncher, {
            bottomOffset: 24,
            buttonTestId: 'open-terminal-floating-button-fixture',
            rightOffset: 350,
            teamName: TEAM_NAME,
          })
        )
      );
      await flushMicrotasks();
    });

    const button = getRequiredElement('open-terminal-floating-button-fixture');
    expect(button.getAttribute('aria-label')).toBe('Open Terminal UI Smoke Sandbox terminal');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.style.bottom).toBe('24px');
    expect(button.style.right).toBe('350px');
    expect(useBranchSync).toHaveBeenLastCalledWith([PROJECT_PATH], { live: true });

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    const adapter = getRequiredElement('mock-terminal-bottom-sheet-adapter');
    expect(setMessagesPanelMode).toHaveBeenCalledWith('inline');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(adapter.getAttribute('data-open')).toBe('true');
    expect(adapter.getAttribute('data-project-path')).toBe(PROJECT_PATH);
    expect(adapter.getAttribute('data-branch')).toBe('feature/terminal-ui');
    expect(sheetFixture.adapterProps.at(-1)).toMatchObject({
      gitBranch: 'feature/terminal-ui',
      isTeamAlive: true,
      projectPath: PROJECT_PATH,
      teamDisplayName: 'Terminal UI Smoke Sandbox',
      teamName: TEAM_NAME,
    });
  });

  it('floating launcher keeps inline messages in place and clamps unsafe offsets', async () => {
    const setMessagesPanelMode = vi.fn((mode: string) => {
      useStore.setState({ messagesPanelMode: mode } as never);
    });
    useStore.setState({
      branchByPath: {
        [normalizePath(PROJECT_PATH)]: 'feature/terminal-ui',
      },
      messagesPanelMode: 'inline',
      selectedTeamName: TEAM_NAME,
      selectedTeamData: createTeamSnapshot(),
      setMessagesPanelMode,
      teamDataCacheByName: {
        [TEAM_NAME]: createTeamSnapshot(),
      },
      teamByName: {
        [TEAM_NAME]: {
          teamName: TEAM_NAME,
          displayName: 'Terminal UI Smoke Sandbox',
          description: 'fixture',
          memberCount: 1,
          taskCount: 0,
          lastActivity: null,
          projectPath: PROJECT_PATH,
        },
      },
    } as never);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TerminalWorkspaceFloatingLauncher, {
            bottomOffset: -40,
            buttonTestId: 'open-terminal-floating-button-fixture',
            rightOffset: -40,
            teamName: TEAM_NAME,
          })
        )
      );
      await flushMicrotasks();
    });

    const button = getRequiredElement('open-terminal-floating-button-fixture');
    expect(button.style.bottom).toBe('10px');
    expect(button.style.right).toBe('10px');

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    expect(setMessagesPanelMode).not.toHaveBeenCalled();
    expect(getRequiredElement('mock-terminal-bottom-sheet-adapter').getAttribute('data-open')).toBe(
      'true'
    );
  });

  it('floating launcher tears down an open sheet when the terminal surface becomes disabled', async () => {
    useStore.setState({
      branchByPath: {
        [normalizePath(PROJECT_PATH)]: 'feature/terminal-ui',
      },
      messagesPanelMode: 'inline',
      selectedTeamName: TEAM_NAME,
      selectedTeamData: createTeamSnapshot(),
      teamDataCacheByName: {
        [TEAM_NAME]: createTeamSnapshot(),
      },
      teamByName: {
        [TEAM_NAME]: {
          teamName: TEAM_NAME,
          displayName: 'Terminal UI Smoke Sandbox',
          description: 'fixture',
          memberCount: 1,
          taskCount: 0,
          lastActivity: null,
          projectPath: PROJECT_PATH,
        },
      },
    } as never);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TerminalWorkspaceFloatingLauncher, {
            buttonTestId: 'open-terminal-floating-button-fixture',
            enabled: true,
            teamName: TEAM_NAME,
          })
        )
      );
      await flushMicrotasks();
    });

    const button = getRequiredElement('open-terminal-floating-button-fixture');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    expect(getRequiredElement('mock-terminal-bottom-sheet-adapter').getAttribute('data-open')).toBe(
      'true'
    );

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TerminalWorkspaceFloatingLauncher, {
            buttonTestId: 'open-terminal-floating-button-fixture',
            enabled: false,
            teamName: TEAM_NAME,
          })
        )
      );
      await flushMicrotasks();
    });

    expect(
      document.querySelector('[data-testid="open-terminal-floating-button-fixture"]')
    ).toBeNull();
    expect(document.querySelector('[data-testid="mock-terminal-bottom-sheet-adapter"]')).toBeNull();
    expect(useBranchSync).toHaveBeenLastCalledWith([], { live: true });
  });

  it('floating launcher stays fully disabled without mounting a stale sheet', async () => {
    useStore.setState({
      selectedTeamName: TEAM_NAME,
      selectedTeamData: createTeamSnapshot(),
      teamDataCacheByName: {
        [TEAM_NAME]: createTeamSnapshot(),
      },
    } as never);

    await act(async () => {
      root.render(
        React.createElement(TerminalWorkspaceFloatingLauncher, {
          enabled: false,
          teamName: TEAM_NAME,
        })
      );
      await flushMicrotasks();
    });

    expect(document.querySelector('[data-testid="open-terminal-floating-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="mock-terminal-bottom-sheet-adapter"]')).toBeNull();
    expect(useBranchSync).toHaveBeenLastCalledWith([], { live: true });
  });

  async function renderBottomSheet({
    mountPoint: nextMountPoint,
    onOpenChange = vi.fn(),
    open,
  }: {
    mountPoint: HTMLElement | null;
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TerminalWorkspaceBottomSheet, {
            getBootstrap: vi.fn(),
            gitBranch: 'main',
            isTeamAlive: true,
            mountPoint: nextMountPoint,
            onOpenChange,
            open,
            projectPath: PROJECT_PATH,
            stopTeamRuntime: vi.fn(),
            teamDisplayName: 'Terminal UI Smoke Sandbox',
            teamName: TEAM_NAME,
          })
        )
      );
      await flushMicrotasks();
    });
  }
});

function createTeamSnapshot(): TeamViewSnapshot {
  return {
    config: {
      description: 'fixture',
      members: [],
      name: 'Terminal UI Smoke Sandbox',
      projectPath: PROJECT_PATH,
    },
    isAlive: true,
    members: [],
    tasks: [],
  } as unknown as TeamViewSnapshot;
}

function getRequiredElement(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing test element: ${testId}`);
  }
  return element;
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

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function createPointerEvent(
  type: string,
  options: MouseEventInit & { button?: number; clientY?: number }
): Event {
  const PointerEventConstructor = window.PointerEvent ?? MouseEvent;
  return new PointerEventConstructor(type, {
    bubbles: true,
    cancelable: true,
    ...options,
  });
}
