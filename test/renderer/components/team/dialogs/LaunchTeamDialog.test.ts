import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openDashboard = vi.fn();
const openTeamTab = vi.fn();
const fetchCliStatus = vi.fn();
const createSchedule = vi.fn();
const updateSchedule = vi.fn();

const storeState = {
  appConfig: { general: { multimodelEnabled: true } },
  cliStatus: { providers: [] },
  cliStatusLoading: false,
  fetchCliStatus,
  createSchedule,
  updateSchedule,
  repositoryGroups: [],
  selectedTeamName: 'team-alpha',
  launchParamsByTeam: {},
  teamByName: {},
  openDashboard,
  openTeamTab,
};

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: {
    getProjects: vi.fn(async () => [
      {
        id: 'project-1',
        path: '/tmp/project',
        name: 'project',
        sessions: [],
        totalSessions: 0,
        createdAt: 1,
      },
    ]),
    teams: {
      getSavedRequest: vi.fn(async () => null),
      replaceMembers: vi.fn(async () => {}),
      prepareProvisioning: vi.fn(async () => ({})),
    },
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: () => false,
  selectResolvedMembersForTeamName: () => [],
}));

vi.mock('@renderer/components/team/members/MembersEditorSection', () => ({
  buildMemberDraftColorMap: () => new Map<string, string>(),
  buildMemberDraftSuggestions: () => [],
  buildMembersFromDrafts: (
    drafts: Array<{
      name: string;
      roleSelection?: string;
      customRole?: string;
      workflow?: string;
      providerId?: string;
      model?: string;
      effort?: string;
    }>
  ) =>
    drafts.map((draft) => ({
      name: draft.name,
      role: draft.customRole || undefined,
      workflow: draft.workflow,
      providerId: draft.providerId as 'anthropic' | 'codex' | 'gemini' | undefined,
      model: draft.model,
      effort: draft.effort as 'low' | 'medium' | 'high' | undefined,
    })),
  clearMemberModelOverrides: (member: unknown) => member,
  createMemberDraftsFromInputs: (
    members: Array<{
      name: string;
      role?: string;
      workflow?: string;
      providerId?: string;
      model?: string;
      effort?: string;
    }>
  ) =>
    members.map((member, index) => ({
      id: `draft-${index}`,
      name: member.name,
      originalName: member.name,
      roleSelection: '',
      customRole: member.role ?? '',
      workflow: member.workflow ?? '',
      providerId: member.providerId,
      model: member.model ?? '',
      effort: member.effort,
    })),
  filterEditableMemberInputs: (members: unknown) => members,
  normalizeMemberDraftForProviderMode: (member: unknown) => member,
  normalizeProviderForMode: (providerId: unknown) => providerId,
  validateMemberNameInline: () => null,
}));

vi.mock('@renderer/components/team/members/TeamRosterEditorSection', () => ({
  TeamRosterEditorSection: () => React.createElement('div', null, 'team-roster-editor'),
}));

vi.mock('@renderer/components/team/dialogs/SkipPermissionsCheckbox', () => ({
  SkipPermissionsCheckbox: () => React.createElement('div', null, 'skip-permissions'),
}));

vi.mock('@renderer/components/team/dialogs/AdvancedCliSection', () => ({
  AdvancedCliSection: () => React.createElement('div', null, 'advanced-cli'),
}));

vi.mock('@renderer/components/team/dialogs/OptionalSettingsSection', () => ({
  OptionalSettingsSection: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/team/dialogs/ProjectPathSelector', () => ({
  ProjectPathSelector: ({ selectedProjectPath }: { selectedProjectPath: string }) =>
    React.createElement('div', { 'data-testid': 'project-path' }, selectedProjectPath),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    className?: string;
  }) =>
    React.createElement('button', { type: type ?? 'button', onClick, disabled, className }, children),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    id?: string;
  }) =>
    React.createElement('input', {
      id,
      type: 'checkbox',
      checked,
      onChange: (event: Event) =>
        onCheckedChange?.((event.target as HTMLInputElement).checked),
    }),
}));

vi.mock('@renderer/components/ui/combobox', () => ({
  Combobox: () => React.createElement('div', null, 'combobox'),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? React.createElement('div', null, children) : null),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({
    children,
    htmlFor,
    className,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
    className?: string;
  }) => React.createElement('label', { htmlFor, className }, children),
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: ({
    value,
    onValueChange,
    id,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    id?: string;
  }) =>
    React.createElement('textarea', {
      id,
      value,
      onChange: (event: Event) => onValueChange((event.target as HTMLTextAreaElement).value),
    }),
}));

vi.mock('@renderer/hooks/useChipDraftPersistence', () => ({
  useChipDraftPersistence: () => ({
    chips: [],
    removeChip: vi.fn(),
    addChip: vi.fn(),
    clearChipDraft: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useDraftPersistence', () => ({
  useDraftPersistence: () => ({
    value: '',
    setValue: vi.fn(),
    isSaved: false,
  }),
}));

vi.mock('@renderer/hooks/useFileListCacheWarmer', () => ({
  useFileListCacheWarmer: () => undefined,
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/utils/geminiUiFreeze', () => ({
  isGeminiUiFrozen: () => false,
  normalizeCreateLaunchProviderForUi: (providerId: unknown) => providerId,
}));

vi.mock('@renderer/utils/teamModelAvailability', () => ({
  getTeamModelSelectionError: () => null,
  normalizeExplicitTeamModelForUi: (_providerId: string, model: string) => model,
}));

vi.mock('@renderer/components/team/dialogs/providerPrepareCacheKey', () => ({
  buildProviderPrepareModelCacheKey: () => 'prepare-cache-key',
}));

vi.mock('@renderer/components/team/dialogs/providerPrepareDiagnostics', () => ({
  buildReusableProviderPrepareModelResults: () => ({}),
  getProviderPrepareCachedSnapshot: () => ({ status: 'checking', details: [] }),
  runProviderPrepareDiagnostics: vi.fn(async () => ({
    status: 'ready',
    warnings: [],
    details: [],
    modelResultsById: {},
  })),
}));

vi.mock('@renderer/components/team/dialogs/provisioningModelIssues', () => ({
  getProvisioningModelIssue: () => null,
}));

vi.mock('@renderer/components/team/dialogs/ProvisioningProviderStatusList', () => ({
  ProvisioningProviderStatusList: () => React.createElement('div', null, 'provider-status-list'),
  failIncompleteProviderChecks: (checks: unknown) => checks,
  getPrimaryProvisioningFailureDetail: () => null,
  getProvisioningFailureHint: () => 'hint',
  getProvisioningProviderBackendSummary: () => null,
  shouldHideProvisioningProviderStatusList: () => false,
  updateProviderCheck: (checks: unknown) => checks,
}));

vi.mock('@renderer/components/team/dialogs/TeamModelSelector', () => ({
  TeamModelSelector: () => React.createElement('div', null, 'team-model-selector'),
  computeEffectiveTeamModel: (model: string) => model || undefined,
  formatTeamModelSummary: (providerId: string, model: string, effort?: string) =>
    [providerId, model, effort].filter(Boolean).join(' '),
}));

vi.mock('@renderer/components/team/dialogs/EffortLevelSelector', () => ({
  EffortLevelSelector: () => React.createElement('div', null, 'effort-selector'),
}));

import { api } from '@renderer/api';
import { LaunchTeamDialog } from '@renderer/components/team/dialogs/LaunchTeamDialog';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('LaunchTeamDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders relaunch-specific title, warning and submit label', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'relaunch',
          open: true,
          teamName: 'team-alpha',
          members: [{ name: 'alice', role: 'Reviewer' }] as any,
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onRelaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    expect(host.textContent).toContain('Relaunch Team');
    expect(host.textContent).toContain('Relaunch will restart the current team run');
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === 'Relaunch team'
      )
    ).toBe(true);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('submits relaunch through onRelaunch without replacing members in-dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const onRelaunch = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'relaunch',
          open: true,
          teamName: 'team-alpha',
          members: [
            {
              name: 'alice',
              role: 'Reviewer',
              providerId: 'codex',
              model: 'gpt-5.4',
              effort: 'medium',
            },
          ] as any,
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onRelaunch,
        })
      );
      await flush();
    });

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Relaunch team'
    );
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(onRelaunch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.teams.replaceMembers)).not.toHaveBeenCalled();

    const [request, members] = onRelaunch.mock.calls[0] as unknown as [
      { teamName: string; cwd: string; providerId?: string; model?: string },
      Array<{ name: string; providerId?: string; model?: string }>
    ];

    expect(request.teamName).toBe('team-alpha');
    expect(request.cwd).toBe('/tmp/project');
    expect(request.providerId).toBe('anthropic');
    expect(request.model).toBe('opus');
    expect(members).toEqual([
      {
        name: 'alice',
        role: 'Reviewer',
        workflow: '',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      },
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });
});
