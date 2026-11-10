import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adapterFixture = vi.hoisted(() => ({
  bottomSheetProps: [] as Array<Record<string, unknown>>,
  getBootstrap: vi.fn(),
  panelProps: [] as Array<Record<string, unknown>>,
  stopTeamRuntime: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    terminalWorkspace: {
      getBootstrap: adapterFixture.getBootstrap,
      stopTeamRuntime: adapterFixture.stopTeamRuntime,
    },
  },
}));

vi.mock('@features/terminal-workspace/renderer/ui/TerminalWorkspaceBottomSheet', async () => {
  const ReactModule = await import('react');
  const React = ReactModule.default;
  return {
    TerminalWorkspaceBottomSheet: (props: Record<string, unknown>) => {
      adapterFixture.bottomSheetProps.push(props);
      return React.createElement('div', {
        'data-open': String(props.open),
        'data-team-name': String(props.teamName),
        'data-testid': 'mock-terminal-bottom-sheet',
      });
    },
  };
});

vi.mock('@features/terminal-workspace/renderer/ui/TerminalWorkspacePanel', async () => {
  const ReactModule = await import('react');
  const React = ReactModule.default;
  return {
    TerminalWorkspacePanel: (props: Record<string, unknown>) => {
      adapterFixture.panelProps.push(props);
      return React.createElement('div', {
        'data-surface': String(props.surface),
        'data-team-name': String(props.teamName),
        'data-testid': 'mock-terminal-panel',
      });
    },
  };
});

import { TerminalWorkspaceBottomSheetAdapter } from '@features/terminal-workspace/renderer/adapters/TerminalWorkspaceBottomSheetAdapter';
import { TerminalWorkspacePanelAdapter } from '@features/terminal-workspace/renderer/adapters/TerminalWorkspacePanelAdapter';

describe('terminal workspace renderer adapters fixture-e2e', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    adapterFixture.bottomSheetProps.length = 0;
    adapterFixture.panelProps.length = 0;
    adapterFixture.getBootstrap.mockResolvedValue(createBootstrap());
    adapterFixture.stopTeamRuntime.mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('wires the bottom sheet adapter to the shared terminal workspace API', async () => {
    const mountPoint = document.createElement('div');
    document.body.appendChild(mountPoint);

    await act(async () => {
      root.render(
        React.createElement(TerminalWorkspaceBottomSheetAdapter, {
          gitBranch: 'main',
          isTeamAlive: true,
          mountPoint,
          onOpenChange: vi.fn(),
          open: true,
          projectPath: '/tmp/terminal-fixture',
          teamDisplayName: 'Terminal Fixture',
          teamName: 'terminal-fixture',
        })
      );
      await flushMicrotasks();
    });

    const props = adapterFixture.bottomSheetProps.at(-1);
    expect(getRequiredElement('mock-terminal-bottom-sheet').getAttribute('data-team-name')).toBe(
      'terminal-fixture'
    );
    expect(props).toMatchObject({
      gitBranch: 'main',
      isTeamAlive: true,
      open: true,
      projectPath: '/tmp/terminal-fixture',
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });
    expect(props?.getBootstrap).toBe(adapterFixture.getBootstrap);
    expect(props?.stopTeamRuntime).toBe(adapterFixture.stopTeamRuntime);
  });

  it('wires the embedded panel adapter to the same terminal workspace API', async () => {
    await act(async () => {
      root.render(
        React.createElement(TerminalWorkspacePanelAdapter, {
          gitBranch: 'feature/terminal',
          isTeamAlive: false,
          projectPath: '/tmp/terminal-fixture',
          surface: 'card',
          teamDisplayName: 'Terminal Fixture',
          teamName: 'terminal-fixture',
        })
      );
      await flushMicrotasks();
    });

    const props = adapterFixture.panelProps.at(-1);
    expect(getRequiredElement('mock-terminal-panel').getAttribute('data-surface')).toBe('card');
    expect(props).toMatchObject({
      gitBranch: 'feature/terminal',
      isTeamAlive: false,
      projectPath: '/tmp/terminal-fixture',
      surface: 'card',
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });
    expect(props?.getBootstrap).toBe(adapterFixture.getBootstrap);
    expect(props?.stopTeamRuntime).toBe(adapterFixture.stopTeamRuntime);
  });
});

function createBootstrap() {
  return {
    controlPlaneUrl: 'ws://fixture-control',
    defaultShell: '/bin/zsh',
    projectPath: '/tmp/terminal-fixture',
    runtimeSlug: 'terminal-fixture-runtime',
    sessionStreamUrl: 'ws://fixture-stream',
    teamName: 'terminal-fixture',
  };
}

function getRequiredElement(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing test element: ${testId}`);
  }
  return element;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
