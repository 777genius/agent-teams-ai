import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProjectPathSelector } from '@renderer/components/team/dialogs/ProjectPathSelector';
import {
  OpenCodeCatalogRefreshErrorCard,
  ProviderStatusPanel,
} from '@renderer/components/team/dialogs/TeamModelSelectorStatusNotices';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectPathProject } from '@renderer/components/team/dialogs/projectPathOptions';

vi.mock('@renderer/api', () => ({
  api: { config: { selectFolders: vi.fn().mockResolvedValue([]) } },
}));

function project(path: string, filesystemState: ProjectPathProject['filesystemState']) {
  return {
    id: path,
    path,
    name: path.split('/').pop() ?? path,
    sessions: [],
    totalSessions: 0,
    createdAt: 1,
    filesystemState,
  } satisfies ProjectPathProject;
}

async function render(element: React.ReactElement): Promise<{
  host: HTMLDivElement;
  unmount: () => Promise<void>;
}> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    },
  };
}

describe('ProjectPathSelector deleted projects', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('marks a selected deleted project on the trigger and explains the missing folder', async () => {
    const deletedPath = '/tmp/deleted-project';
    const { host, unmount } = await render(
      <ProjectPathSelector
        cwdMode="project"
        onCwdModeChange={vi.fn()}
        selectedProjectPath={deletedPath}
        onSelectedProjectPathChange={vi.fn()}
        customCwd=""
        onCustomCwdChange={vi.fn()}
        projects={[project(deletedPath, 'deleted'), project('/tmp/live-project', 'available')]}
        projectsLoading={false}
        projectsError={null}
      />
    );

    expect(host.textContent).toContain('Deleted');
    const error = host.querySelector('[data-testid="project-path-selected-deleted-error"]');
    expect(error?.textContent).toBe(
      `Project folder not found: ${deletedPath}. Choose another project or create the folder.`
    );

    await unmount();
  });

  it('matches a deleted selection by normalized path like the dialog blocker does', async () => {
    const { host, unmount } = await render(
      <ProjectPathSelector
        cwdMode="project"
        onCwdModeChange={vi.fn()}
        selectedProjectPath="/tmp/deleted-project/"
        onSelectedProjectPathChange={vi.fn()}
        customCwd=""
        onCustomCwdChange={vi.fn()}
        projects={[project('/tmp/deleted-project', 'deleted')]}
        projectsLoading={false}
        projectsError={null}
      />
    );

    expect(
      host.querySelector('[data-testid="project-path-selected-deleted-error"]')
    ).not.toBeNull();

    await unmount();
  });

  it('shows no folder error for an available selection', async () => {
    const { host, unmount } = await render(
      <ProjectPathSelector
        cwdMode="project"
        onCwdModeChange={vi.fn()}
        selectedProjectPath="/tmp/live-project"
        onSelectedProjectPathChange={vi.fn()}
        customCwd=""
        onCustomCwdChange={vi.fn()}
        projects={[project('/tmp/live-project', 'available')]}
        projectsLoading={false}
        projectsError={null}
      />
    );

    expect(host.querySelector('[data-testid="project-path-selected-deleted-error"]')).toBeNull();
    expect(host.textContent).not.toContain('Deleted');

    await unmount();
  });
});

describe('model selector status notices', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses light-first tones with dark variants and wires the retry action', async () => {
    const onAction = vi.fn();
    const { host, unmount } = await render(
      <ProviderStatusPanel
        panel={{
          tone: 'warning',
          title: 'OpenCode is not ready for team launch',
          summary: 'OpenCode status: project folder not found',
          message: 'Project folder not found: /tmp/deleted-project.',
          reason: null,
          actionLabel: 'Retry',
        }}
        retryAction
        onAction={onAction}
      />
    );

    const panel = host.querySelector<HTMLElement>(
      '[data-testid="team-model-selector-provider-status"]'
    );
    expect(panel?.className).toContain('text-amber-900');
    expect(panel?.className).toContain('dark:text-amber-100');
    const retry = host.querySelector<HTMLButtonElement>(
      '[data-testid="team-model-selector-opencode-runtime-retry"]'
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it('renders the catalog refresh card readable in the light theme', async () => {
    const { host, unmount } = await render(
      <OpenCodeCatalogRefreshErrorCard
        hasProviderDirectoryCache={false}
        hasProviderTabs
        onRetry={vi.fn()}
      />
    );

    const card = host.querySelector<HTMLElement>(
      '[data-testid="team-model-selector-opencode-catalog-refresh-error"]'
    );
    expect(card?.className).toContain('text-amber-900');
    expect(card?.className).toContain('dark:text-amber-100');
    expect(card?.className).not.toMatch(/(^|\s)text-amber-100(\s|$)/);

    await unmount();
  });
});
