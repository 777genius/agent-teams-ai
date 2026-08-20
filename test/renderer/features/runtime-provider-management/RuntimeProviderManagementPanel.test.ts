import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProjectPathProjects: vi.fn(),
  useRuntimeProviderManagement: vi.fn(),
  viewProps: [] as Array<{ projectPath?: string | null }>,
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
    RuntimeProviderManagementPanelView: (props: { projectPath?: string | null }) => {
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
    expect(latestManagementOptions?.projectPath).toBeNull();
    expect(mocks.viewProps.at(-1)?.projectPath).toBeNull();

    await act(async () => root.unmount());
  });
});
