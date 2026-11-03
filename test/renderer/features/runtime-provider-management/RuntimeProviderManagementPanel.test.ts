import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProjectPathProjects: vi.fn(),
  useRuntimeProviderManagement: vi.fn(),
  nativeRuntimeStatus: null as { installed: boolean; version: string; state: string } | null,
  fetchOpenCodeRuntimeStatus: vi.fn(async () => undefined),
  invalidateOpenCodeRuntimeStatus: vi.fn(async () => undefined),
  generationProps: [] as Array<'v1' | 'v2' | null>,
  viewProps: [] as Array<{
    disabled?: boolean;
    projectContextLoading?: boolean;
    projectPath?: string | null;
    actions?: {
      startConnect: (providerId: string) => void;
      startReconnect: (providerId: string) => void;
    };
  }>,
}));

vi.mock('@renderer/components/team/dialogs/projectPathProjects', () => ({
  loadProjectPathProjects: mocks.loadProjectPathProjects,
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { repositoryGroups: never[] }) => unknown) => {
    const state = {
      repositoryGroups: [] as never[],
      openCodeRuntimeStatus: mocks.nativeRuntimeStatus,
      fetchOpenCodeRuntimeStatus: mocks.fetchOpenCodeRuntimeStatus,
      invalidateOpenCodeRuntimeStatus: mocks.invalidateOpenCodeRuntimeStatus,
    };
    return selector(state);
  },
}));

vi.mock(
  '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement',
  () => ({
    useRuntimeProviderManagement: mocks.useRuntimeProviderManagement,
  })
);

vi.mock(
  '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderManagementPanelView',
  () => ({
    RuntimeProviderManagementPanelView: (props: {
      disabled?: boolean;
      projectContextLoading?: boolean;
      projectPath?: string | null;
      actions?: {
        startConnect: (providerId: string) => void;
        startReconnect: (providerId: string) => void;
      };
    }) => {
      mocks.viewProps.push(props);
      return null;
    },
  })
);

vi.mock(
  '../../../../src/features/runtime-provider-management/renderer/ui/OpenCodeProviderCompatibilityStatus',
  () => ({
    OpenCodeProviderCompatibilityScope: ({
      generation,
      children,
    }: { generation: 'v1' | 'v2' | null; children: React.ReactNode }) => {
      mocks.generationProps.push(generation);
      return children;
    },
  })
);

import { RuntimeProviderManagementPanel } from '../../../../src/features/runtime-provider-management/renderer/RuntimeProviderManagementPanel';

describe('RuntimeProviderManagementPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.viewProps.length = 0;
    mocks.generationProps.length = 0;
    mocks.nativeRuntimeStatus = null;
    mocks.fetchOpenCodeRuntimeStatus.mockClear();
    mocks.invalidateOpenCodeRuntimeStatus.mockClear();
    mocks.loadProjectPathProjects.mockReset();
    mocks.useRuntimeProviderManagement.mockReset();
    mocks.useRuntimeProviderManagement.mockReturnValue([
      {
        setupForm: null,
        selectedAuthOptionId: null,
        savingProviderId: null,
        directoryLoaded: false,
        directorySummary: false,
        directoryRefreshing: false,
      },
      {
        cancelConnect: vi.fn(),
        refreshDirectory: vi.fn(),
        hydrateDirectory: vi.fn(),
      },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('loads global provider rows before project discovery settles', async () => {
    let resolveProjects: ((projects: unknown[]) => void) | undefined;
    mocks.loadProjectPathProjects.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        resolveProjects = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(RuntimeProviderManagementPanel, {
        runtimeId: 'opencode',
        open: true,
        projectPath: null,
      }));
      await Promise.resolve();
    });

    expect(mocks.loadProjectPathProjects).toHaveBeenCalledTimes(1);
    expect(mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]).toMatchObject({
      enabled: true,
      projectPath: null,
      preserveViewRequestOnDisable: false,
    });
    expect(mocks.viewProps.at(-1)?.disabled).toBe(false);
    expect(mocks.viewProps.at(-1)?.projectContextLoading).toBe(true);

    await act(async () => {
      resolveProjects?.([]);
      await Promise.resolve();
    });
    expect(mocks.viewProps.at(-1)?.projectContextLoading).toBe(false);
    expect(mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]?.enabled).toBe(true);
    await act(async () => root.unmount());
  });

  it('does not paint old credentials while a new project is still resolving', async () => {
    mocks.loadProjectPathProjects.mockReturnValue(new Promise(() => undefined));
    mocks.useRuntimeProviderManagement.mockReturnValue([
      {
        view: { projectPath: '/tmp/previous-project' },
        providers: [{ providerId: 'previous-project-only' }],
        directoryEntries: [{ providerId: 'previous-project-only' }],
        directoryLoaded: true,
        selectedProviderId: 'previous-project-only',
        apiKeyValue: 'unused-credential-state',
      },
      { cancelConnect: vi.fn(), refreshDirectory: vi.fn(), hydrateDirectory: vi.fn() },
    ]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(RuntimeProviderManagementPanel, {
        runtimeId: 'opencode',
        open: true,
        projectPath: '/tmp/project-b',
      }));
      await Promise.resolve();
    });
    const snapshot = (mocks.viewProps.at(-1) as unknown as {
      state: {
        view: unknown;
        providers: unknown[];
        directoryEntries: unknown[];
        selectedProviderId: string | null;
        apiKeyValue: string;
      };
    }).state;
    expect(snapshot.view).toBeNull();
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.directoryEntries).toEqual([]);
    expect(snapshot.selectedProviderId).toBeNull();
    expect(snapshot.apiKeyValue).toBe('');
    await act(async () => root.unmount());
  });

  it('fences the first render after the requested project changes', async () => {
    mocks.loadProjectPathProjects.mockResolvedValue([]);
    mocks.useRuntimeProviderManagement.mockReturnValue([
      {
        view: { projectPath: '/tmp/project-a' },
        providers: [{ providerId: 'project-a-only' }],
        directoryEntries: [{ providerId: 'project-a-only' }],
        directoryLoaded: true,
        directorySummary: false,
        selectedProviderId: 'project-a-only',
      },
      { cancelConnect: vi.fn(), refreshDirectory: vi.fn(), hydrateDirectory: vi.fn() },
    ]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (projectPath: string) =>
      root.render(React.createElement(RuntimeProviderManagementPanel, {
        runtimeId: 'opencode', open: true, projectPath,
      }));
    await act(async () => render('/tmp/project-a'));
    expect(mocks.viewProps.at(-1)?.projectPath).toBe('/tmp/project-a');

    mocks.loadProjectPathProjects.mockReturnValue(new Promise(() => undefined));
    mocks.viewProps.length = 0;
    mocks.useRuntimeProviderManagement.mockClear();
    await act(async () => render('/tmp/project-b'));

    expect(mocks.viewProps.length).toBeGreaterThan(0);
    expect(mocks.viewProps.every((props) => props.disabled && props.projectPath === null)).toBe(true);
    expect(mocks.useRuntimeProviderManagement.mock.calls.every(
      ([options]) => !options.enabled && options.projectPath === null
    )).toBe(true);
    await act(async () => root.unmount());
  });

  it('defers an explicit project directory until its canonical scope is known', async () => {
    let resolveProjects: ((projects: unknown[]) => void) | undefined;
    mocks.loadProjectPathProjects.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        resolveProjects = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(RuntimeProviderManagementPanel, {
        runtimeId: 'opencode',
        open: true,
        projectPath: '/tmp/project-a',
      }));
      await Promise.resolve();
    });
    expect(mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]).toMatchObject({
      enabled: false,
      projectPath: null,
    });
    expect(mocks.viewProps.at(-1)?.disabled).toBe(true);

    await act(async () => {
      resolveProjects?.([{
        id: 'project-a',
        path: '/tmp/project-a',
        name: 'Project A',
        sessions: [],
        totalSessions: 0,
        createdAt: 0,
      }]);
      await Promise.resolve();
    });
    expect(mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]).toMatchObject({
      enabled: true,
      projectPath: '/tmp/project-a',
    });
    expect(mocks.viewProps.at(-1)?.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it.each(['/tmp/project-a', null])(
    'preserves the requested scope %s when project discovery fails',
    async (projectPath) => {
      mocks.loadProjectPathProjects.mockRejectedValue(new Error('Project discovery unavailable'));
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);

      await act(async () => {
        root.render(
          React.createElement(RuntimeProviderManagementPanel, {
            runtimeId: 'opencode',
            open: true,
            projectPath,
          })
        );
      });

      expect(mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]).toMatchObject({
        enabled: true,
        projectPath,
      });
      expect(
        mocks.useRuntimeProviderManagement.mock.calls
          .filter(([options]) => options.enabled)
          .every(([options]) => options.projectPath === projectPath)
      ).toBe(true);
      expect(mocks.viewProps.at(-1)?.projectPath).toBe(projectPath);
      expect(mocks.viewProps.at(-1)?.disabled).toBe(false);
      expect(mocks.viewProps.at(-1)?.projectContextLoading).toBe(false);
      await act(async () => root.unmount());
    }
  );

  it('rejects unknown installed generations and always refreshes cached status on open', async () => {
    mocks.loadProjectPathProjects.mockResolvedValue([]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (version: string) => {
      mocks.nativeRuntimeStatus = { installed: true, version, state: 'ready' };
      await act(async () => {
        root.render(React.createElement(RuntimeProviderManagementPanel, {
          runtimeId: 'opencode', open: true,
        }));
        await Promise.resolve();
      });
    };
    await render('3.0.0');
    expect(mocks.generationProps.at(-1)).toBeNull();
    expect(mocks.invalidateOpenCodeRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(mocks.fetchOpenCodeRuntimeStatus).toHaveBeenCalledTimes(1);
    await render('2.1.4');
    expect(mocks.generationProps.at(-1)).toBe('v2');
    await render('1.19.5');
    expect(mocks.generationProps.at(-1)).toBe('v1');
    await act(async () => root.unmount());
  });

  it('gates V2 xAI OAuth and preserves API-key connect/reconnect plus V1', async () => {
    const startConnect = vi.fn();
    const startReconnect = vi.fn();
    let authMethods: readonly string[] = ['oauth'];
    let connectedAuthHint: string | null = 'oauth';
    let providerAuthHint: string | null = 'oauth';
    const actions = {
      cancelConnect: vi.fn(),
      refreshDirectory: vi.fn(),
      hydrateDirectory: vi.fn(),
      startConnect,
      startReconnect,
    };
    mocks.loadProjectPathProjects.mockResolvedValue([]);
    mocks.useRuntimeProviderManagement.mockImplementation(() => [
      {
        setupForm: null,
        selectedAuthOptionId: null,
        savingProviderId: null,
        directoryLoaded: true,
        directorySummary: false,
        directoryRefreshing: false,
        providers: [{ providerId: 'xai', connectedAuthHint: providerAuthHint }],
        directoryEntries: [{
          providerId: 'xai',
          authMethods,
          connectedAuthHint,
        }],
      },
      actions,
    ]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (version: string | null) => {
      mocks.nativeRuntimeStatus = version === null
        ? null
        : { installed: true, version, state: 'ready' };
      await act(async () => {
        root.render(React.createElement(RuntimeProviderManagementPanel, {
          runtimeId: 'opencode', open: true,
        }));
        await Promise.resolve();
      });
      const actions = mocks.viewProps.at(-1)?.actions;
      expect(actions).toBeDefined();
      actions?.startConnect('xai');
      actions?.startReconnect('xai');
    };

    await render('2.1.4');
    expect(startConnect).not.toHaveBeenCalled();
    expect(startReconnect).not.toHaveBeenCalled();

    await render(null);
    expect(startConnect).not.toHaveBeenCalled();
    expect(startReconnect).not.toHaveBeenCalled();

    await render('1.19.5');
    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(startReconnect).toHaveBeenCalledTimes(1);

    // V2 API-key routes must not be blocked just because OAuth is unavailable.
    authMethods = ['api'];
    connectedAuthHint = null;
    providerAuthHint = null;
    await render('2.1.4');
    expect(startConnect).toHaveBeenCalledTimes(2);
    expect(startReconnect).toHaveBeenCalledTimes(2);

    // A fresh API-key Connect stays selectable with both offered methods,
    // but an existing OAuth credential cannot be reconnected on V2.
    authMethods = ['oauth', 'api'];
    connectedAuthHint = 'oauth';
    providerAuthHint = 'oauth';
    await render('2.1.4');
    expect(startConnect).toHaveBeenCalledTimes(3);
    expect(startReconnect).toHaveBeenCalledTimes(2);

    // The saved connection's auth method has precedence over the directory hint.
    connectedAuthHint = 'api';
    await render('2.1.4');
    expect(startConnect).toHaveBeenCalledTimes(4);
    expect(startReconnect).toHaveBeenCalledTimes(2);

    // When the provider's saved hint is missing, the directory OAuth hint still
    // prevents reconnecting an unsupported V2 subscription route.
    connectedAuthHint = 'oauth';
    providerAuthHint = null;
    await render('2.1.4');
    expect(startConnect).toHaveBeenCalledTimes(5);
    expect(startReconnect).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it('clears a deleted Windows path alias before provider-management IPC can use it', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let resolveProjects: ((projects: unknown[]) => void) | undefined;
    mocks.loadProjectPathProjects.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        resolveProjects = resolve;
      })
    );

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanel, {
          runtimeId: 'opencode',
          open: true,
          projectPath: 'c:/workspace/deleted-project/',
        })
      );
      await Promise.resolve();
    });

    expect(
      mocks.useRuntimeProviderManagement.mock.calls.every(
        ([options]) => options.enabled === false && options.projectPath === null
      )
    ).toBe(true);
    expect(mocks.viewProps.at(-1)?.disabled).toBe(true);
    expect(mocks.viewProps.at(-1)?.projectContextLoading).toBe(true);
    expect(
      mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]?.preserveViewRequestOnDisable
    ).toBe(true);

    await act(async () => {
      resolveProjects?.([
        {
          id: 'deleted-project',
          path: 'C:\\Workspace\\Deleted-Project',
          name: 'Deleted Project',
          sessions: [],
          totalSessions: 0,
          createdAt: 0,
          filesystemState: 'deleted',
        },
      ]);
      await Promise.resolve();
    });

    const latestManagementOptions = mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0];
    expect(
      mocks.useRuntimeProviderManagement.mock.calls.every(
        ([options]) => options.projectPath === null
      )
    ).toBe(true);
    expect(latestManagementOptions?.enabled).toBe(true);
    expect(latestManagementOptions?.preserveViewRequestOnDisable).toBe(false);
    expect(latestManagementOptions?.directorySummaryOnEnable).toBe(true);
    expect(latestManagementOptions?.reuseCachedFullDirectory).toBe(true);
    expect(latestManagementOptions?.projectPath).toBeNull();
    expect(mocks.viewProps.at(-1)?.disabled).toBe(false);
    expect(mocks.viewProps.at(-1)?.projectContextLoading).toBe(false);
    expect(mocks.viewProps.at(-1)?.projectPath).toBeNull();

    await act(async () => root.unmount());
  });

  it('hydrates the live catalog after the browse-all summary without a refresh', async () => {
    const hydrateDirectory = vi.fn(async () => true);
    const refreshDirectory = vi.fn(async () => undefined);
    mocks.useRuntimeProviderManagement.mockImplementation((options: { enabled?: boolean }) => [
      {
        setupForm: null,
        selectedAuthOptionId: null,
        savingProviderId: null,
        directoryLoaded: options.enabled === true,
        directorySummary: options.enabled === true,
        directoryLoading: false,
        directoryRefreshing: false,
        directoryError: null,
      },
      {
        cancelConnect: vi.fn(),
        refreshDirectory,
        hydrateDirectory,
      },
    ]);
    mocks.loadProjectPathProjects.mockResolvedValue([]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(RuntimeProviderManagementPanel, {
            runtimeId: 'opencode',
            open: true,
          })
        )
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(hydrateDirectory).toHaveBeenCalledTimes(1));
    });

    const latestManagementOptions = mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0];
    expect(latestManagementOptions?.directorySummaryOnEnable).toBe(true);
    expect(latestManagementOptions?.reuseCachedFullDirectory).toBe(true);
    expect(latestManagementOptions?.searchDirectoryOnQueryChange).toBe(false);
    expect(refreshDirectory).not.toHaveBeenCalled();

    // Native identity can settle after the first summary has hydrated. A new
    // runtime must be allowed a new full-catalog hydration in the same panel.
    mocks.nativeRuntimeStatus = { installed: true, version: '1.19.4', state: 'ready' };
    await act(async () => {
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(RuntimeProviderManagementPanel, {
            runtimeId: 'opencode',
            open: true,
          })
        )
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(hydrateDirectory).toHaveBeenCalledTimes(2));
    });
    expect(mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]?.runtimeRevision)
      .toContain('1.19.4');
    await act(async () => root.unmount());
  });

  it('skips the summary catalog for OpenRouter deep links', async () => {
    mocks.loadProjectPathProjects.mockResolvedValue([]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanel, {
          runtimeId: 'opencode',
          open: true,
          initialProviderId: 'openrouter',
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(
        () => mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]?.enabled === true
      );
    });

    const latestManagementOptions = mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0];
    expect(latestManagementOptions?.directorySummaryOnEnable).toBe(false);
    expect(latestManagementOptions?.reuseCachedFullDirectory).toBe(false);
    expect(latestManagementOptions?.searchDirectoryOnQueryChange).toBe(true);

    await act(async () => root.unmount());
  });

  it('skips the summary catalog for Vercel deep links', async () => {
    mocks.loadProjectPathProjects.mockResolvedValue([]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanel, {
          runtimeId: 'opencode',
          open: true,
          initialProviderId: 'vercel',
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(
        () => mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0]?.enabled === true
      );
    });

    const latestManagementOptions = mocks.useRuntimeProviderManagement.mock.calls.at(-1)?.[0];
    expect(latestManagementOptions?.directorySummaryOnEnable).toBe(false);
    expect(latestManagementOptions?.reuseCachedFullDirectory).toBe(false);
    expect(latestManagementOptions?.searchDirectoryOnQueryChange).toBe(true);

    await act(async () => root.unmount());
  });
});
