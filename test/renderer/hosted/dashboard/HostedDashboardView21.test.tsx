import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DashboardScreen } from '@features/dashboard/renderer';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { HostedDashboardRecent } from '@renderer/hosted/dashboard/HostedDashboardRecent';
import { parseBootId, parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedRecentProjectDto, HostedRecentProjectsResult } from '@features/recent-projects/contracts';
import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';
import type { WorkspaceId } from '@shared/contracts/hosted';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const bootId = parseBootId(`boot_${'b'.repeat(32)}`);
const deploymentId = parseDeploymentId(`deployment_${'d'.repeat(32)}`);
const workspaceId = (number: number): WorkspaceId =>
  parseWorkspaceId(`workspace_${number.toString(16).padStart(32, '0')}`);
const workspaces: HostedWorkspaceDto[] = Array.from({ length: 21 }, (_, offset) => ({
  workspaceId: workspaceId(offset + 1),
  label: `Workspace ${offset + 1}`,
  registrationRevision: 1,
  mount: { bootId, mountGeneration: 1, observedAt: 1, health: 'healthy', capabilities: [] },
}));
const projects: HostedRecentProjectDto[] = workspaces.map((workspace, offset) => ({
  workspaceId: workspace.workspaceId,
  label: workspace.label,
  registrationRevision: 1,
  mountGeneration: 1,
  sources: [{ provider: 'anthropic', observedAt: 100 + offset, confirmedAt: 121, freshness: 'fresh' }],
  openAvailability: 'available',
}));
const response: HostedRecentProjectsResult = {
  schemaVersion: 1,
  kind: 'recent-projects',
  bootId,
  deploymentId,
  readAt: 121,
  completeness: 'complete',
  projects,
};

let host: HTMLDivElement;
let root: Root;

function projectCards(): NodeListOf<HTMLElement> {
  return host.querySelectorAll<HTMLElement>('[data-recent-project-cell="project"]');
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  expect(found, `button ${name}`).toBeDefined();
  return found!;
}

async function search(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search workspaces"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Hosted Dashboard 21-workspace view', () => {
  it('paginates 11 to 19 to 21, searches the full collection, and opens the admitted identity', async () => {
    const openWorkspace = vi.fn().mockResolvedValue({ kind: 'opened' });
    const transport = { recent: vi.fn().mockResolvedValue(response), access: vi.fn() };
    const openHistory = new Map<WorkspaceId, number>();
    const RecentProjects = ({ searchQuery }: { searchQuery: string }) => (
      <HostedDashboardRecent
        runtimeIdentity={{ bootId, deploymentId }}
        workspaces={workspaces}
        transport={transport}
        authAvailable
        isActive
        onAuthFailure={vi.fn()}
        onOpenWorkspace={openWorkspace}
        onShowChooser={vi.fn()}
        openHistory={openHistory}
        searchQuery={searchQuery}
      />
    );
    await act(async () => {
      root.render(
        <TooltipProvider>
          <DashboardScreen
            scopeKey="authorized-view-21"
            runningTeams={{ title: 'Running teams', rows: [], onOpen: vi.fn() }}
            RecentProjects={RecentProjects}
            onSelectTeam={vi.fn()}
            onOpenPalette={vi.fn()}
            labels={{
              selectTeam: 'Select team', or: 'or', searchPlaceholder: 'Search workspaces',
              palette: 'Open palette', paletteShortcut: 'Ctrl K', recentTitle: 'Recent',
              searchResults: 'Results', clearSearch: 'Clear search', noRunningMatches: 'No teams',
            }}
          />
        </TooltipProvider>
      );
    });
    expect(transport.recent).toHaveBeenCalledOnce();
    expect(projectCards()).toHaveLength(11);
    await act(async () => button('recentProjects.loadMore').click());
    expect(projectCards()).toHaveLength(19);
    await act(async () => button('recentProjects.loadMore').click());
    expect(projectCards()).toHaveLength(21);
    expect(host.textContent).not.toContain('recentProjects.loadMore');

    await search('Workspace 1');
    expect(projectCards()).toHaveLength(11);
    await search('Workspace 2');
    expect(projectCards()).toHaveLength(3); // 2, 20, 21 - includes rows beyond the first page.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="actions.open Workspace 21"]')!.click();
    });
    expect(openWorkspace).toHaveBeenCalledOnce();
    expect(openWorkspace.mock.calls[0]?.[0]).toBe(workspaceId(21));
    expect(openWorkspace.mock.calls[0]?.[1]).toMatchObject({ workspaceId: workspaceId(21) });

    await act(async () => button('Clear search').click());
    expect(projectCards()).toHaveLength(11);
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="Search workspaces"]'));
    expect(transport.recent).toHaveBeenCalledOnce(); // Local filtering must not start another read.
  });
});
