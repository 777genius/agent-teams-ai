import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSavedRequest = vi.hoisted(() => vi.fn());
const getData = vi.hoisted(() => vi.fn());
const aliveList = vi.hoisted(() => vi.fn());
const preparePreview = vi.hoisted(() => vi.fn());
const saveTemplate = vi.hoisted(() => vi.fn());
const recheckSave = vi.hoisted(() => vi.fn());
const listTemplates = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => {
  const noop = (): void => undefined;
  return {
    teams: [
      {
        teamName: 'alpha',
        displayName: 'Alpha',
        description: 'First team',
        memberCount: 1,
        taskCount: 0,
        lastActivity: null,
        projectPath: '/opt/acme/project',
        projectContextMode: undefined as 'shared' | 'per_project' | undefined,
      },
      {
        teamName: 'draft',
        displayName: 'Draft',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
        pendingCreate: true,
      },
    ],
    teamManagementNoticeByTeam: {} as Record<string, unknown>,
    paneLayout: {
      panes: [
        {
          id: 'test-pane',
          activeTabId: 'templates-integration-test',
          tabs: [{ id: 'templates-integration-test', type: 'teams' }],
        },
      ],
    },
    getAllPaneTabs: vi.fn(),
    openTeamsCreationPage: vi.fn(),
    closeTeamsCreationPage: noop,
    teamsLoading: false,
    teamsError: null as string | null,
    fetchTeams: noop,
    openTab: noop,
    openTeamTab: vi.fn(),
    deleteTeam: noop,
    restoreTeam: noop,
    permanentlyDeleteTeam: noop,
    projects: [],
    globalTasks: [],
    fetchAllTasks: noop,
    repositoryGroups: [],
    selectedRepositoryId: null,
    selectedWorktreeId: null,
    selectedProjectId: null,
    activeProjectId: null,
    teamsProjectNavigationIntent: null,
    branchByPath: {},
    connectionMode: 'local',
    createTeam: noop,
    launchTeam: noop,
    provisioningErrorByTeam: {},
    clearProvisioningError: noop,
    provisioningRuns: {},
    provisioningSnapshotByTeam: {},
    currentProvisioningRunIdByTeam: {},
    leadActivityByTeam: {},
    openSettingsTab: noop,
  };
});

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: {
    teams: { getSavedRequest, getData, aliveList },
    customTeamTemplates: { preparePreview, saveTemplate, recheckSave, listTemplates },
  },
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      typeof selector === 'function' ? selector(storeState) : storeState,
    { getState: () => storeState }
  ),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
  }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/hooks/useBranchSync', () => ({ useBranchSync: () => undefined }));
vi.mock('@renderer/analytics/productAnalytics', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, classifyAnalyticsError: () => 'unknown', recordTeamStop: vi.fn() };
});
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: vi.fn() }));
vi.mock('@features/recent-projects/renderer', () => ({
  recordRecentProjectOpenPaths: vi.fn(),
}));
vi.mock('@features/external-agent-connection/renderer', () => ({
  ExternalAgentPromptAction: () => null,
}));
vi.mock('@renderer/components/team/useTeamStopControl', () => ({
  useTeamStopControl: () => ({ isStopping: () => false, stopTeam: vi.fn() }),
}));
vi.mock('@renderer/components/team/dialogs/teamRelaunchFlow', () => ({
  executeTeamRelaunch: vi.fn(),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({
    children,
    // Stripped before the rest-spread so the dialog-only prop never reaches the
    // DOM element as an unknown attribute.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- retaining the destructuring is the prop-safety behavior under test
    closeDisabled: _closeDisabled,
    ...props
  }: {
    children: React.ReactNode;
    closeDisabled?: boolean;
    [key: string]: unknown;
  }) => React.createElement('div', { role: 'dialog', ...props }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

import { TeamListView } from '@renderer/components/team/TeamListView';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const preview = {
  sourceTeamName: 'alpha',
  name: 'Alpha',
  teamPrompt: 'Lead the work.',
  members: [{ name: 'ann', role: 'Developer' }],
  warnings: [{ code: 'noRecordedRoster' as const }],
  canonicalContent: 'canonical',
  previewToken: 'token-1',
};

function buttonByLabel(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === label
  );
  if (!found) throw new Error(`button not found: ${label}\n${scope.textContent}`);
  return found;
}

function buttonByText(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!found) throw new Error(`button not found: ${label}\n${scope.textContent}`);
  return found;
}

/** The alpha row card (a config-only card has no Copy action). */
function alphaCard(): Element {
  const cards = Array.from(host.querySelectorAll('[role="button"]'));
  const card = cards.find((candidate) => candidate.textContent?.includes('Alpha'));
  if (!card) throw new Error(`alpha card not found\n${host.textContent}`);
  return card;
}

async function renderView(): Promise<void> {
  await act(async () => {
    root.render(<TeamListView tabId="templates-integration-test" isActive />);
    await Promise.resolve();
  });
}

/** Resolves every lazy dialog chunk inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.all([
      import('@features/custom-team-templates/renderer/ui/SaveAsTemplateDialog'),
      import('@features/custom-team-templates/renderer/ui/MyTemplatesDialog'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getSavedRequest.mockReset();
  getData.mockReset();
  aliveList.mockReset();
  preparePreview.mockReset();
  saveTemplate.mockReset();
  recheckSave.mockReset();
  listTemplates.mockReset();
  aliveList.mockResolvedValue([]);
  getSavedRequest.mockResolvedValue({
    runtimeSelectionVersion: 1,
    description: 'First team',
    cwd: '/opt/acme/project',
    prompt: 'Lead the work.',
    members: [{ name: 'ann' }],
  });
  getData.mockResolvedValue({ config: {}, members: [] });
  preparePreview.mockResolvedValue({ status: 'previewReady', preview });
  saveTemplate.mockResolvedValue({
    status: 'created',
    template: {
      templateId: 'template-1',
      name: 'Alpha',
      schemaVersion: 1,
      teamPrompt: 'Lead the work.',
      members: preview.members,
    },
  });
  listTemplates.mockResolvedValue({ status: 'empty' });
  storeState.getAllPaneTabs.mockReset();
  storeState.getAllPaneTabs.mockReturnValue(
    storeState.paneLayout.panes.flatMap((pane) => pane.tabs)
  );
  storeState.openTeamsCreationPage.mockReset();
  storeState.teams[0].projectContextMode = undefined;
  storeState.openTeamTab = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('TeamListView custom team template actions', () => {
  it('renders Save as Template beside Copy team without changing Copy team behavior', async () => {
    await renderView();
    const card = alphaCard();
    const labels = Array.from(card.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label')
    );
    expect(labels).toContain('list.actions.copyTeam');
    expect(labels).toContain('customTemplates.actions.saveAsTemplate');
    expect(labels.indexOf('customTemplates.actions.saveAsTemplate')).toBeGreaterThan(
      labels.indexOf('list.actions.copyTeam')
    );

    // Save as Template prepares a preview and never triggers the copy flow.
    await act(async () => {
      buttonByLabel('customTemplates.actions.saveAsTemplate', card).click();
      await Promise.resolve();
    });
    await flush();
    expect(preparePreview).toHaveBeenCalledWith({
      sourceTeamName: 'alpha',
      name: 'Alpha',
      description: '',
    });
    expect(getSavedRequest).not.toHaveBeenCalled();
    expect(storeState.openTeamsCreationPage).not.toHaveBeenCalled();
    expect(storeState.openTeamTab).not.toHaveBeenCalled();

    await act(async () => buttonByText('actions.close').click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();

    // Copy team reads the saved request and seeds the shared creation page.
    await act(async () => {
      buttonByLabel('list.actions.copyTeam', card).click();
      await Promise.resolve();
    });
    await flush();
    expect(getSavedRequest).toHaveBeenCalledWith('alpha');
    expect(storeState.openTeamsCreationPage).toHaveBeenCalledTimes(1);
    expect(storeState.openTeamsCreationPage).toHaveBeenCalledWith(
      {
        copyData: expect.objectContaining({
          teamName: 'alpha-1',
          projectContextMode: 'shared',
          runtimeSelectionVersion: 1,
          description: 'First team',
          cwd: '/opt/acme/project',
          prompt: 'Lead the work.',
          members: [expect.objectContaining({ name: 'ann' })],
        }),
      },
      true
    );
    expect(preparePreview).toHaveBeenCalledTimes(1);
    expect(saveTemplate).not.toHaveBeenCalled();
    expect(storeState.openTeamTab).not.toHaveBeenCalled();
  });

  it.each(['shared', 'per_project'] as const)(
    'preserves explicit %s history in the real Copy action',
    async (projectContextMode) => {
      getSavedRequest.mockResolvedValue({
        teamName: 'alpha',
        description: 'First team',
        members: [],
        projectContextMode,
      });
      await renderView();
      await act(async () => buttonByLabel('list.actions.copyTeam', alphaCard()).click());
      await flush();
      expect(storeState.openTeamsCreationPage).toHaveBeenCalledExactlyOnceWith(
        { copyData: expect.objectContaining({ teamName: 'alpha-1', projectContextMode }) },
        true
      );
      expect(getData).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 'shared', 'per_project'] as const)(
    'uses the available summary history %s when Copy has no saved request',
    async (projectContextMode) => {
      getSavedRequest.mockResolvedValue(null);
      storeState.teams[0].projectContextMode = projectContextMode;
      await renderView();
      await act(async () => buttonByLabel('list.actions.copyTeam', alphaCard()).click());
      await flush();
      expect(storeState.openTeamsCreationPage).toHaveBeenCalledExactlyOnceWith(
        {
          copyData: expect.objectContaining({
            teamName: 'alpha-1',
            projectContextMode: projectContextMode ?? 'shared',
          }),
        },
        true
      );
      expect(getData).toHaveBeenCalledExactlyOnceWith('alpha', { includeMemberBranches: false });
    }
  );

  it('keeps Save as Template available for config-only teams without offering Copy', async () => {
    await renderView();
    const draftCard = Array.from(host.querySelectorAll('[role="button"]')).find((candidate) =>
      candidate.textContent?.includes('Draft')
    );
    if (!draftCard) throw new Error('draft card not found');
    const labels = Array.from(draftCard.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label')
    );
    expect(labels).not.toContain('list.actions.copyTeam');
    expect(labels).toContain('customTemplates.actions.saveAsTemplate');
    await act(async () => {
      buttonByLabel('customTemplates.actions.saveAsTemplate', draftCard).click();
      await Promise.resolve();
    });
    await flush();
    expect(preparePreview).toHaveBeenCalledWith({
      sourceTeamName: 'draft',
      name: 'Draft',
      description: '',
    });
    expect(storeState.openTeamTab).not.toHaveBeenCalled();
  });

  it('keeps row navigation out of the save dialog it opened', async () => {
    await renderView();
    const card = alphaCard();

    await act(async () => {
      buttonByLabel('customTemplates.actions.saveAsTemplate', card).click();
      await Promise.resolve();
    });
    await flush();
    expect(storeState.openTeamTab).not.toHaveBeenCalled();

    // The dialog is portaled for layout but stays a React descendant of the row,
    // so inner clicks and Enter/Space presses must not reach the row handler.
    const nameField = host.querySelector('#custom-template-name');
    expect(nameField).not.toBeNull();
    act(() => {
      nameField?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      nameField?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      nameField?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(storeState.openTeamTab).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // A real row click still opens the team, so the guard is not swallowing it.
    act(() => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(storeState.openTeamTab).toHaveBeenCalledWith('alpha', '/opt/acme/project');
  });

  it('opens the Templates dialog from the list header', async () => {
    await renderView();
    const headerButton = buttonByText('customTemplates.actions.templates');
    expect(listTemplates).not.toHaveBeenCalled();
    await act(async () => {
      headerButton.click();
      await Promise.resolve();
    });
    await flush();
    expect(listTemplates).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('customTemplates.library.title');
    expect(preparePreview).not.toHaveBeenCalled();
  });
});
