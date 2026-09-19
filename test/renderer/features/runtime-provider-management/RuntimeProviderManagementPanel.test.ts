import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProjectPathProjects: vi.fn(),
  useRuntimeProviderManagement: vi.fn(),
  viewProps: [] as Array<{
    disabled?: boolean;
    projectContextLoading?: boolean;
    projectPath?: string | null;
  }>,
}));

vi.mock('@renderer/components/team/dialogs/projectPathProjects', () => ({
  loadProjectPathProjects: mocks.loadProjectPathProjects,
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { repositoryGroups: never[] }) => unknown) =>
    selector({ repositoryGroups: [] }),
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
    }) => {
      mocks.viewProps.push(props);
      return null;
    },
  })
);

import { RuntimeProviderManagementPanel } from '../../../../src/features/runtime-provider-management/renderer/RuntimeProviderManagementPanel';

describe('RuntimeProviderManagementPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.viewProps.length = 0;
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
