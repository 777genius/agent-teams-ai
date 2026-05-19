/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type -- Legacy dialog mocks use broad DTO shapes. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const openDashboard = vi.fn();
const openTeamTab = vi.fn();
const fetchCliStatus = vi.fn();
const createSchedule = vi.fn();
const updateSchedule = vi.fn();
const teamRosterEditorSectionMock = vi.hoisted(() => ({ lastProps: null as any }));
const createTeamDraftMock = vi.hoisted(() => ({
  state: {
    teamName: 'team-alpha',
    setTeamName: vi.fn(),
    members: [
      {
        id: 'member-opencode',
        name: 'tom',
        roleSelection: '',
        customRole: 'Developer',
        workflow: '',
        providerId: 'opencode',
        model: 'opencode/big-pickle',
      },
      {
        id: 'member-codex',
        name: 'bob',
        roleSelection: '',
        customRole: 'Developer',
        workflow: '',
        providerId: 'codex',
        model: 'gpt-5.5',
      },
    ],
    setMembers: vi.fn(),
    syncModelsWithLead: false,
    setSyncModelsWithLead: vi.fn(),
    teammateWorktreeDefault: false,
    setTeammateWorktreeDefault: vi.fn(),
    cwdMode: 'project' as const,
    setCwdMode: vi.fn(),
    selectedProjectPath: '/tmp/project',
    setSelectedProjectPath: vi.fn(),
    customCwd: '',
    setCustomCwd: vi.fn(),
    soloTeam: false,
    setSoloTeam: vi.fn(),
    launchTeam: true,
    setLaunchTeam: vi.fn(),
    teamColor: 'slate',
    setTeamColor: vi.fn(),
    isLoaded: true,
    clearDraft: vi.fn(),
  },
}));

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
    getCodexAccountSnapshot: vi.fn(async () => null),
    refreshCodexAccountSnapshot: vi.fn(async () => null),
    onCodexAccountSnapshotChanged: vi.fn(() => () => {}),
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
    getDashboardRecentProjects: vi.fn(async () => ({ projects: [] })),
    teams: {
      getSavedRequest: vi.fn(async () => null),
      replaceMembers: vi.fn(async () => {}),
      prepareProvisioning: vi.fn(async () => ({})),
      getWorktreeGitStatus: vi.fn(async (projectPath: string) => ({
        projectPath,
        isGitRepo: true,
        hasHead: true,
        canUseWorktrees: true,
      })),
      initializeGitRepository: vi.fn(async (projectPath: string) => ({
        projectPath,
        isGitRepo: true,
        hasHead: false,
        canUseWorktrees: false,
        reason: 'missing_head',
      })),
      createInitialGitCommit: vi.fn(async (projectPath: string) => ({
        projectPath,
        isGitRepo: true,
        hasHead: true,
        canUseWorktrees: true,
      })),
    },
    tmux: {
      getStatus: vi.fn(() =>
        Promise.resolve({
          platform: 'win32',
          nativeSupported: false,
          checkedAt: '2026-04-25T00:00:00.000Z',
          host: {
            available: false,
            version: null,
            binaryPath: null,
            error: null,
          },
          effective: {
            available: true,
            location: 'wsl',
            version: '3.4',
            binaryPath: '/usr/bin/tmux',
            runtimeReady: true,
            detail: 'tmux is ready',
          },
          error: null,
          autoInstall: {
            supported: false,
            strategy: 'manual',
            packageManagerLabel: null,
            requiresTerminalInput: false,
            requiresAdmin: false,
            requiresRestart: false,
            mayOpenExternalWindow: false,
            reasonIfUnsupported: null,
            manualHints: [],
          },
          wsl: null,
          wslPreference: null,
        })
      ),
      onProgress: vi.fn(() => vi.fn()),
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
      providerBackendId?: string;
      model?: string;
      effort?: string;
      fastMode?: string;
    }>
  ) =>
    drafts.map((draft) => ({
      name: draft.name,
      role: draft.customRole || undefined,
      workflow: draft.workflow,
      providerId: draft.providerId as 'anthropic' | 'codex' | 'gemini' | 'opencode' | undefined,
      providerBackendId: draft.providerBackendId as 'codex-native' | undefined,
      model: draft.model,
      effort: draft.effort as 'low' | 'medium' | 'high' | undefined,
      fastMode: draft.fastMode as 'inherit' | 'on' | 'off' | undefined,
    })),
  createMemberDraft: (member: any = {}) => ({
    id: member.id ?? 'draft-member',
    name: member.name ?? '',
    originalName: member.originalName ?? member.name ?? '',
    roleSelection: member.roleSelection ?? '',
    customRole: member.customRole ?? '',
    workflow: member.workflow ?? '',
    isolation: member.isolation,
    providerId: member.providerId,
    providerBackendId: member.providerBackendId,
    model: member.model ?? '',
    effort: member.effort,
    fastMode: member.fastMode,
  }),
  clearMemberModelOverrides: (member: unknown) => member,
  createMemberDraftsFromInputs: (
    members: Array<{
      name: string;
      role?: string;
      workflow?: string;
      providerId?: string;
      providerBackendId?: string;
      model?: string;
      effort?: string;
      fastMode?: string;
      isolation?: 'worktree';
    }>
  ) =>
    members.map((member, index) => ({
      id: `draft-${index}`,
      name: member.name,
      originalName: member.name,
      roleSelection: '',
      customRole: member.role ?? '',
      workflow: member.workflow ?? '',
      isolation: member.isolation,
      providerId: member.providerId,
      providerBackendId: member.providerBackendId,
      model: member.model ?? '',
      effort: member.effort,
      fastMode: member.fastMode,
    })),
  filterEditableMemberInputs: (members: unknown) => members,
  normalizeLeadProviderForMode: (providerId: unknown) => providerId,
  normalizeMemberDraftForProviderMode: (member: unknown) => member,
  normalizeProviderForMode: (providerId: unknown) => providerId,
  validateMemberNameInline: () => null,
}));

vi.mock('@renderer/components/team/members/TeamRosterEditorSection', () => ({
  TeamRosterEditorSection: (props: any) => {
    teamRosterEditorSectionMock.lastProps = props;
    const leadProviderNotice = props.leadProviderNoticeById?.[props.providerId] ?? null;
    return React.createElement(
      'div',
      null,
      props.headerTop,
      leadProviderNotice
        ? React.createElement(
            'div',
            { 'data-testid': 'mock-lead-provider-notice' },
            leadProviderNotice
          )
        : null,
      'team-roster-editor',
      props.headerBottom
    );
  },
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
    React.createElement(
      'button',
      { type: type ?? 'button', onClick, disabled, className },
      children
    ),
}));

vi.mock('@renderer/components/ui/auto-resize-textarea', () => ({
  AutoResizeTextarea: (props: Record<string, unknown>) => React.createElement('textarea', props),
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
      onChange: (event: Event) => onCheckedChange?.((event.target as HTMLInputElement).checked),
    }),
}));

vi.mock('@renderer/components/ui/combobox', () => ({
  Combobox: () => React.createElement('div', null, 'combobox'),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
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

vi.mock('@renderer/hooks/useCreateTeamDraft', () => ({
  useCreateTeamDraft: () => createTeamDraftMock.state,
}));

vi.mock('@renderer/hooks/useDraftPersistence', () => ({
  useDraftPersistence: () => {
    const [value, setValue] = React.useState('');
    return {
      value,
      setValue,
      isSaved: false,
    };
  },
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
  normalizeCreateLaunchProviderForUi: (providerId: unknown) => providerId ?? 'anthropic',
}));

vi.mock('@renderer/utils/teamModelAvailability', () => ({
  getTeamModelSelectionError: vi.fn(() => null),
  isTeamModelAvailableForUi: vi.fn(() => true),
  normalizeExplicitTeamModelForUi: vi.fn((_providerId: string, model: string) => model),
}));

vi.mock('@renderer/components/team/dialogs/providerPrepareCacheKey', () => ({
  buildProviderPrepareModelCacheKey: () => 'prepare-cache-key',
}));

vi.mock('@renderer/components/team/dialogs/providerPrepareDiagnostics', () => ({
  buildReusableProviderPrepareModelResults: () => ({}),
  getProviderPrepareCachedSnapshot: () => ({ status: 'checking', details: [] }),
  mergeReusableProviderPrepareModelResults: (
    existing: Record<string, unknown> | null | undefined,
    next: Record<string, unknown>
  ) => ({ ...(existing ?? {}), ...next }),
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
  deriveEffectiveProvisioningPrepareState: ({
    state,
    message,
  }: {
    state: 'idle' | 'loading' | 'ready' | 'failed';
    message: string | null;
  }) => ({
    state,
    message,
  }),
  failIncompleteProviderChecks: (checks: unknown) => checks,
  getPrimaryProvisioningFailureDetail: () => null,
  getProvisioningFailureHint: () => 'hint',
  getProvisioningProviderBackendSummary: () => null,
  shouldHideProvisioningProviderStatusList: () => false,
  updateProviderCheck: (checks: unknown) => checks,
}));

vi.mock('@renderer/components/team/dialogs/TeamModelSelector', () => ({
  TeamModelSelector: ({ value }: { value: string }) =>
    React.createElement('div', { 'data-testid': 'team-model-selector' }, `model:${value}`),
  computeEffectiveTeamModel: (model: string) => model || undefined,
  formatTeamModelSummary: (providerId: string, model: string, effort?: string) =>
    [providerId, model, effort].filter(Boolean).join(' '),
  OPENCODE_ONE_SHOT_DISABLED_BADGE_LABEL: 'team only',
  OPENCODE_ONE_SHOT_DISABLED_REASON:
    'OpenCode team launch is available for normal teams, but scheduled one-shot prompts still run through claude -p. Choose Anthropic or Codex for one-shot schedules.',
}));

vi.mock('@renderer/components/team/dialogs/EffortLevelSelector', () => ({
  EffortLevelSelector: ({ value }: { value: string }) =>
    React.createElement('div', { 'data-testid': 'effort-selector' }, `effort:${value}`),
}));

vi.mock('@renderer/components/team/dialogs/AnthropicFastModeSelector', () => ({
  AnthropicFastModeSelector: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (value: 'inherit' | 'on' | 'off') => void;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'fast-mode-selector' },
      React.createElement('span', null, `fast:${value}`),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => onValueChange('on'),
        },
        'set fast on'
      )
    ),
}));

vi.mock('@renderer/components/team/dialogs/CodexFastModeSelector', () => ({
  CodexFastModeSelector: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (value: 'inherit' | 'on' | 'off') => void;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'codex-fast-mode-selector' },
      React.createElement('span', null, `codex-fast:${value}`),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => onValueChange('on'),
        },
        'set codex fast on'
      )
    ),
}));

import { api } from '@renderer/api';
import { CreateTeamDialog } from '@renderer/components/team/dialogs/CreateTeamDialog';
import { LaunchTeamDialog } from '@renderer/components/team/dialogs/LaunchTeamDialog';
import { runProviderPrepareDiagnostics } from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { isTeamModelAvailableForUi } from '@renderer/utils/teamModelAvailability';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('LaunchTeamDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    storeState.cliStatus = { providers: [] };
    storeState.launchParamsByTeam = {};
    teamRosterEditorSectionMock.lastProps = null;
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

  it('passes existing teammate worktree path info to the roster editor', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [
            {
              name: 'jack',
              role: 'developer',
              isolation: 'worktree',
              cwd: '/tmp/project/.worktrees/jack',
            },
          ] as any,
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.memberInfoById).toEqual({
      'draft-0':
        'This teammate will continue from its existing worktree: /tmp/project/.worktrees/jack',
    });

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('preserves existing teammate worktree path info from saved launch request fallback', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'codex',
      model: 'gpt-5.5',
      members: [
        {
          name: 'jack',
          role: 'developer',
          isolation: 'worktree',
          cwd: '/tmp/project/.worktrees/jack',
          providerId: 'opencode',
          model: 'openrouter/qwen/qwen3-coder',
        },
      ],
    } as any);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.memberInfoById).toEqual({
      'draft-0':
        'This teammate will continue from its existing worktree: /tmp/project/.worktrees/jack',
    });

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('preserves hidden teammate backend and fast mode metadata before draft launch', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'anthropic',
      model: 'opus',
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          fastMode: 'on',
        },
      ],
    } as any);
    const onLaunch = vi.fn(async () => {});

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch,
        })
      );
      await flush();
      await flush();
    });

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });

    expect(vi.mocked(api.teams.replaceMembers).mock.calls[0]?.[1]).toMatchObject({
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          fastMode: 'on',
        },
      ],
    });
    expect(onLaunch).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('does not submit a stale Anthropic context limit after the last Anthropic runtime is removed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(isTeamModelAvailableForUi).mockImplementation(() => true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          supported: true,
          authenticated: true,
          verificationState: 'verified',
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          models: ['gpt-5.4'],
          capabilities: { teamLaunch: true, oneShot: true },
        },
        {
          providerId: 'anthropic',
          supported: true,
          authenticated: true,
          verificationState: 'verified',
          models: ['sonnet'],
          capabilities: { teamLaunch: true, oneShot: true },
        },
      ],
    } as any;
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'codex',
      model: 'gpt-5.4',
      limitContext: true,
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'anthropic',
          model: 'sonnet',
        },
      ],
    } as any);
    const onLaunch = vi.fn<(request: { limitContext?: boolean }) => Promise<void>>(async () => {});

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch,
        })
      );
      await flush();
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.limitContext).toBe(true);

    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onMembersChange([
        {
          id: 'draft-0',
          name: 'alice',
          originalName: 'alice',
          roleSelection: '',
          customRole: 'Reviewer',
          workflow: '',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
        },
      ]);
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.limitContext).toBe(false);

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });

    expect(onLaunch).toHaveBeenCalledTimes(1);
    const launchRequest = onLaunch.mock.calls[0]?.[0] as { limitContext?: boolean } | undefined;
    expect(launchRequest?.limitContext).toBe(false);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('preserves the Anthropic context limit when the lead changes but Anthropic teammates remain', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(isTeamModelAvailableForUi).mockImplementation(() => true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          supported: true,
          authenticated: true,
          verificationState: 'verified',
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          models: ['gpt-5.4'],
          capabilities: { teamLaunch: true, oneShot: true },
        },
        {
          providerId: 'anthropic',
          supported: true,
          authenticated: true,
          verificationState: 'verified',
          models: ['sonnet'],
          capabilities: { teamLaunch: true, oneShot: true },
        },
      ],
    } as any;
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'anthropic',
      model: 'sonnet',
      limitContext: true,
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'anthropic',
          model: 'sonnet',
        },
      ],
    } as any);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.limitContext).toBe(true);

    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onProviderChange('codex');
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.limitContext).toBe(true);

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
      Array<{ name: string; providerId?: string; model?: string }>,
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

  it('launches a saved pure OpenCode team with OpenCode as the lead provider', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(isTeamModelAvailableForUi).mockImplementation(
      (_providerId, model, providerStatus) => providerStatus?.models?.includes(model ?? '') ?? false
    );
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          models: ['opencode/minimax-m2.5-free'],
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      providerId: 'opencode',
      model: 'opencode/minimax-m2.5-free',
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
      ],
    } as any);

    const onLaunch = vi.fn<(request: { providerId?: string; model?: string }) => Promise<void>>(
      async () => {}
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch,
        })
      );
      await flush();
      await flush();
      await flush();
    });

    const opencodePrepareCalls = vi
      .mocked(runProviderPrepareDiagnostics)
      .mock.calls.filter((call) => call[0]?.providerId === 'opencode');
    expect(opencodePrepareCalls.length).toBeGreaterThan(0);

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });

    expect(vi.mocked(api.teams.replaceMembers)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.teams.replaceMembers).mock.calls[0]?.[1]).toMatchObject({
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
      ],
    });
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const launchRequest = (
      onLaunch.mock.calls as Array<[{ providerId?: string; model?: string }]>
    )[0]?.[0] as { providerId?: string; model?: string } | undefined;
    expect(launchRequest).toMatchObject({
      providerId: 'opencode',
      model: 'opencode/minimax-m2.5-free',
    });

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('blocks OpenCode lead launch until a model is selected', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          models: ['opencode/minimax-m2.5-free'],
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      providerId: 'opencode',
      model: '',
      members: [{ name: 'alice', role: 'Reviewer', providerId: 'opencode' }],
    } as any);
    const onLaunch = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch,
        })
      );
      await flush();
      await flush();
    });

    expect(host.textContent).toContain('OpenCode lead requires a selected model.');
    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton?.hasAttribute('disabled')).toBe(true);
    expect(onLaunch).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('blocks OpenCode lead launch without an OpenCode teammate', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          models: ['opencode/minimax-m2.5-free'],
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      providerId: 'opencode',
      model: 'opencode/minimax-m2.5-free',
      members: [],
    } as any);
    const onLaunch = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch,
        })
      );
      await flush();
      await flush();
    });

    expect(host.textContent).toContain('OpenCode lead requires at least one OpenCode teammate.');
    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton?.hasAttribute('disabled')).toBe(true);
    expect(onLaunch).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps OpenCode lead mixed-provider launches blocked', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          models: ['opencode/minimax-m2.5-free'],
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
        {
          providerId: 'codex',
          supported: true,
          authenticated: true,
          authMethod: 'codex_api_key',
          verificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          models: ['gpt-5.4'],
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      providerId: 'opencode',
      model: 'opencode/minimax-m2.5-free',
      members: [{ name: 'alice', role: 'Reviewer', providerId: 'codex', model: 'gpt-5.4' }],
    } as any);
    const onLaunch = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch,
        })
      );
      await flush();
      await flush();
    });

    expect(host.textContent).toContain('OpenCode cannot lead mixed-provider teams');
    const providerNotice = host.querySelector('[data-testid="mock-lead-provider-notice"]');
    expect(providerNotice?.textContent).toContain('OpenCode cannot lead mixed-provider teams');
    expect(providerNotice?.textContent).toContain(
      'OpenCode can be added as a teammate under an Anthropic or Codex lead'
    );
    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton?.hasAttribute('disabled')).toBe(true);
    expect(onLaunch).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('prefills and saves Anthropic schedule runtime contract including max effort and fast mode', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'anthropic',
          status: 'ready',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-models-api',
            status: 'ready',
            fetchedAt: '2026-04-21T00:00:00.000Z',
            defaultLaunchModel: 'claude-opus-4-6',
            models: [
              {
                id: 'claude-opus-4-6',
                launchModel: 'claude-opus-4-6',
                displayName: 'Opus 4.6',
                hidden: false,
                supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
                defaultReasoningEffort: 'high',
                supportsFastMode: true,
                source: 'anthropic-models-api',
              },
            ],
          },
          runtimeCapabilities: {
            fastMode: {
              supported: true,
              available: true,
              reason: null,
              source: 'runtime',
            },
          },
        },
      ],
    } as any;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'schedule',
          open: true,
          teamName: 'team-alpha',
          onClose: vi.fn(),
          schedule: {
            id: 'schedule-1',
            teamName: 'team-alpha',
            label: 'Nightly',
            cronExpression: '0 9 * * 1-5',
            timezone: 'UTC',
            status: 'active',
            warmUpMinutes: 15,
            maxConsecutiveFailures: 3,
            consecutiveFailures: 0,
            maxTurns: 50,
            createdAt: '2026-04-21T00:00:00.000Z',
            updatedAt: '2026-04-21T00:00:00.000Z',
            launchConfig: {
              cwd: '/tmp/project',
              prompt: 'Run the scheduled check',
              providerId: 'anthropic',
              model: 'claude-opus-4-6',
              effort: 'max',
              fastMode: 'on',
              resolvedFastMode: true,
              skipPermissions: true,
            },
          } as any,
        })
      );
      await flush();
    });

    expect(host.textContent).toContain('model:claude-opus-4-6');
    expect(host.textContent).toContain('effort:max');
    expect(host.textContent).toContain('fast:on');
    expect(host.textContent).toContain('monthly Agent SDK credit');
    expect(
      host.querySelector(
        'a[href="https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan"]'
      )
    ).toBeTruthy();

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save Changes'
    );
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(updateSchedule).toHaveBeenCalledTimes(1);
    expect(updateSchedule.mock.calls[0]?.[1]).toMatchObject({
      launchConfig: {
        cwd: '/tmp/project',
        prompt: 'Run the scheduled check',
        providerId: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'max',
        fastMode: 'on',
        resolvedFastMode: true,
        skipPermissions: true,
      },
    });

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('preserves Codex schedule backend lane and effort in edit saves', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          status: 'ready',
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
        },
      ],
    } as any;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'schedule',
          open: true,
          teamName: 'team-alpha',
          onClose: vi.fn(),
          schedule: {
            id: 'schedule-2',
            teamName: 'team-alpha',
            label: 'Codex job',
            cronExpression: '0 10 * * 1-5',
            timezone: 'UTC',
            status: 'active',
            warmUpMinutes: 15,
            maxConsecutiveFailures: 3,
            consecutiveFailures: 0,
            maxTurns: 50,
            createdAt: '2026-04-21T00:00:00.000Z',
            updatedAt: '2026-04-21T00:00:00.000Z',
            launchConfig: {
              cwd: '/tmp/project',
              prompt: 'Run Codex scheduled check',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model: 'gpt-5.4',
              effort: 'xhigh',
              skipPermissions: true,
            },
          } as any,
        })
      );
      await flush();
    });

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save Changes'
    );
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(updateSchedule).toHaveBeenCalledTimes(1);
    expect(updateSchedule.mock.calls[0]?.[1]).toMatchObject({
      launchConfig: {
        cwd: '/tmp/project',
        prompt: 'Run Codex scheduled check',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'xhigh',
        fastMode: 'inherit',
        resolvedFastMode: false,
        skipPermissions: true,
      },
    });

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('saves Codex schedule Fast mode when GPT-5.4 ChatGPT eligibility is available', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          status: 'ready',
          authenticated: true,
          authMethod: 'chatgpt',
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'codex',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-04-21T00:00:00.000Z',
            defaultModelId: 'gpt-5.4',
            defaultLaunchModel: 'gpt-5.4',
            models: [
              {
                id: 'gpt-5.4',
                launchModel: 'gpt-5.4',
                displayName: 'GPT-5.4',
                hidden: false,
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                defaultReasoningEffort: 'medium',
                source: 'app-server',
              },
            ],
          },
          connection: {
            codex: {
              effectiveAuthMode: 'chatgpt',
              launchAllowed: true,
              launchIssueMessage: null,
              launchReadinessState: 'ready_chatgpt',
            },
          },
        },
      ],
    } as any;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'schedule',
          open: true,
          teamName: 'team-alpha',
          onClose: vi.fn(),
          schedule: {
            id: 'schedule-3',
            teamName: 'team-alpha',
            label: 'Codex fast job',
            cronExpression: '0 10 * * 1-5',
            timezone: 'UTC',
            status: 'active',
            warmUpMinutes: 15,
            maxConsecutiveFailures: 3,
            consecutiveFailures: 0,
            maxTurns: 50,
            createdAt: '2026-04-21T00:00:00.000Z',
            updatedAt: '2026-04-21T00:00:00.000Z',
            launchConfig: {
              cwd: '/tmp/project',
              prompt: 'Run Codex scheduled check',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model: 'gpt-5.4',
              effort: 'xhigh',
              fastMode: 'inherit',
              resolvedFastMode: false,
              skipPermissions: true,
            },
          } as any,
        })
      );
      await flush();
    });

    const fastButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'set codex fast on'
    );
    expect(fastButton).toBeTruthy();
    await act(async () => {
      fastButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save Changes'
    );
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(updateSchedule).toHaveBeenCalledTimes(1);
    expect(updateSchedule.mock.calls[0]?.[1]).toMatchObject({
      launchConfig: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'xhigh',
        fastMode: 'on',
        resolvedFastMode: true,
      },
    });

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('does not restart provider preflight when cli status refresh keeps the same semantic inputs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          supported: true,
          authenticated: true,
          authMethod: 'chatgpt',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          models: ['gpt-5.4'],
          modelCatalog: {
            source: 'app-server',
            status: 'ready',
            models: [{ id: 'gpt-5.4' }],
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderDialog = async (): Promise<void> => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [],
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
      await flush();
    };

    await act(async () => {
      await renderDialog();
    });

    expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalledTimes(1);

    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          supported: true,
          authenticated: true,
          authMethod: 'chatgpt',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          models: ['gpt-5.4'],
          modelCatalog: {
            source: 'app-server',
            status: 'ready',
            models: [{ id: 'gpt-5.4' }],
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;

    await act(async () => {
      await renderDialog();
    });

    expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps the in-flight OpenCode preflight result when live catalog expands during rerender', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: 'warming up',
          detailMessage: 'catalog still loading',
          models: ['opencode/minimax-m2.5-free'],
          modelCatalog: {
            source: 'live',
            status: 'checking',
            models: [{ id: 'opencode/minimax-m2.5-free' }],
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;

    let resolvePrepare!: (value: {
      status: 'ready';
      warnings: [];
      details: [];
      modelResultsById: {};
    }) => void;
    const preparePromise = new Promise<{
      status: 'ready';
      warnings: [];
      details: [];
      modelResultsById: {};
    }>((resolve) => {
      resolvePrepare = resolve;
    });
    vi.mocked(runProviderPrepareDiagnostics).mockReturnValueOnce(preparePromise as any);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderDialog = async (): Promise<void> => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'launch',
          open: true,
          teamName: 'team-alpha',
          members: [
            {
              name: 'alice',
              role: 'Reviewer',
              providerId: 'opencode',
              model: 'opencode/minimax-m2.5-free',
            },
          ] as any,
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    };

    await act(async () => {
      await renderDialog();
    });

    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: 'healthy',
          detailMessage: 'catalog ready',
          models: [
            'opencode/minimax-m2.5-free',
            'opencode/qwen3.6-plus-free',
            'openrouter/google/gemma-4-26b-a4b-it',
          ],
          modelCatalog: {
            source: 'live',
            status: 'ready',
            models: [
              { id: 'opencode/minimax-m2.5-free' },
              { id: 'opencode/qwen3.6-plus-free' },
              { id: 'openrouter/google/gemma-4-26b-a4b-it' },
            ],
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;

    await act(async () => {
      await renderDialog();
    });

    await act(async () => {
      resolvePrepare({
        status: 'ready',
        warnings: [],
        details: [],
        modelResultsById: {},
      });
      await flush();
      await flush();
    });

    const inFlightOpencodePrepareCalls = vi
      .mocked(runProviderPrepareDiagnostics)
      .mock.calls.filter((call) => call[0]?.providerId === 'opencode');
    expect(inFlightOpencodePrepareCalls).toHaveLength(1);
    expect(host.textContent).toContain('Selected providers are ready.');

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps create-team preflight alive across same-signature rerenders', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'api_key',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          models: ['haiku'],
          modelCatalog: {
            source: 'live',
            status: 'ready',
            models: [{ id: 'haiku' }],
          },
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
        },
        {
          providerId: 'codex',
          supported: true,
          authenticated: true,
          authMethod: 'chatgpt',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          models: ['gpt-5.5'],
          modelCatalog: {
            source: 'app-server',
            status: 'ready',
            models: [{ id: 'gpt-5.5' }],
          },
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
        },
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: 'warming up',
          detailMessage: 'first render',
          models: ['opencode/big-pickle'],
          modelCatalog: {
            source: 'app-server',
            status: 'ready',
            models: [{ id: 'opencode/big-pickle' }],
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
      ],
    } as any;

    let resolvePrepare!: (value: {
      status: 'ready';
      warnings: [];
      details: [];
      modelResultsById: {};
    }) => void;
    const preparePromise = new Promise<{
      status: 'ready';
      warnings: [];
      details: [];
      modelResultsById: {};
    }>((resolve) => {
      resolvePrepare = resolve;
    });
    vi.mocked(runProviderPrepareDiagnostics).mockReturnValue(preparePromise as any);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderDialog = async (): Promise<void> => {
      root.render(
        React.createElement(CreateTeamDialog, {
          open: true,
          canCreate: true,
          provisioningErrorsByTeam: {},
          clearProvisioningError: vi.fn(),
          existingTeamNames: [],
          provisioningTeamNames: [],
          activeTeams: [],
          defaultProjectPath: '/tmp/project',
          onClose: vi.fn(),
          onCreate: vi.fn(async () => {}),
          onOpenTeam: vi.fn(),
        })
      );
      await flush();
    };

    await act(async () => {
      await renderDialog();
      await flush();
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
      await flush();
    });

    expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalled();

    await act(async () => {
      await renderDialog();
      await flush();
    });

    const callsAfterSameSignatureRerender = vi.mocked(runProviderPrepareDiagnostics).mock.calls.length;

    await act(async () => {
      resolvePrepare({
        status: 'ready',
        warnings: [],
        details: [],
        modelResultsById: {},
      });
      await flush();
      await flush();
    });

    expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalledTimes(
      callsAfterSameSignatureRerender
    );
    expect(host.textContent).toContain('Selected providers are ready.');

    await act(async () => {
      root.unmount();
      await flush();
    });
  });
});
