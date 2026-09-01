/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type -- Legacy dialog mocks use broad DTO shapes. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openDashboard = vi.fn();
const openTeamTab = vi.fn();
const fetchCliStatus = vi.fn();
const fetchCliProviderStatus = vi.fn<
  (
    providerId: string,
    options?: { projectPath?: string | null; silent?: boolean; checkReason?: string }
  ) => Promise<boolean>
>(async () => true);
const createSchedule = vi.fn();
const updateSchedule = vi.fn();
const teamRosterEditorSectionMock = vi.hoisted(() => ({ lastProps: null as any }));
type TestCliStatus = Pick<CliInstallationStatus, 'providers'> &
  Partial<Pick<CliInstallationStatus, 'flavor'>>;
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
    cwdMode: 'project' as 'project' | 'custom',
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
  cliStatus: { providers: [] } as TestCliStatus,
  cliStatusLoading: false,
  cliProviderStatusLoading: {},
  cliProviderStatusByScope: {} as Record<string, any>,
  fetchCliStatus,
  fetchCliProviderStatus,
  createSchedule,
  updateSchedule,
  repositoryGroups: [],
  branchByPath: { '/tmp/project': 'main', '/tmp/project/.worktrees/jack': 'feature/current-work' },
  fetchBranches: vi.fn(async () => {}),
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
    organizations: {
      getOrganizationStructure: vi.fn(() =>
        Promise.resolve({
          organizations: [],
          units: [],
          relations: [],
        })
      ),
    },
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
    'aria-describedby': ariaDescribedBy,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    className?: string;
    'aria-describedby'?: string;
  }) =>
    React.createElement(
      'button',
      {
        type: type ?? 'button',
        onClick,
        disabled,
        className,
        'aria-describedby': ariaDescribedBy,
      },
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
      clearDraft: vi.fn(),
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
  filterMainScreenCliProviders: <T>(providers: readonly T[]) => [...providers],
  isGeminiUiFrozen: () => false,
  normalizeCreateLaunchProviderForUi: (providerId: unknown) => providerId ?? 'anthropic',
}));

vi.mock('@renderer/utils/teamModelAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/utils/teamModelAvailability')>()),
  getTeamModelSelectionError: vi.fn(() => null),
  isTeamModelAvailableForUi: vi.fn(() => true),
  isTeamProviderModelVerificationPending: vi.fn(() => false),
  isTeamProviderRuntimeStatusLoading: vi.fn(() => false),
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
  ProvisioningProviderStatusList: ({
    checks,
  }: {
    checks: Array<{ providerId: string; details: string[] }>;
  }) =>
    React.createElement(
      'div',
      null,
      'provider-status-list ',
      checks.flatMap((check) => check.details).join(' ')
    ),
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
  getProvisioningProviderProgressMessage: () => 'Checking selected providers in parallel...',
  getProvisioningProviderBackendSummary: () => null,
  getProvisioningProviderReadyById: () => ({}),
  shouldHideProvisioningProviderStatusList: () => false,
  updateProviderCheck: (
    checks: {
      providerId: string;
      status: string;
      details: string[];
      backendSummary?: string | null;
    }[],
    providerId: string,
    patch: { status: string; details: string[]; backendSummary?: string | null }
  ) =>
    checks.map((check) =>
      check.providerId === providerId
        ? {
            ...check,
            ...patch,
          }
        : check
    ),
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
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { isTeamModelAvailableForUi } from '@renderer/utils/teamModelAvailability';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createAuthoritativeProviderStatus(
  providerId: CliProviderId,
  models: string[]
): CliProviderStatus {
  return {
    providerId,
    displayName: providerId,
    supported: true,
    authenticated: true,
    authMethod: 'test',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    models,
    modelAvailability: [],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId,
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-07-20T00:00:00.000Z',
      staleAt: '2099-07-20T00:10:00.000Z',
      defaultModelId: models[0] ?? null,
      defaultLaunchModel: models[0] ?? null,
      models: models.map((model) => ({
        id: model,
        launchModel: model,
        displayName: model,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'app-server',
      })),
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
  };
}

describe('LaunchTeamDialog', () => {
  beforeEach(() => {
    vi.mocked(runProviderPrepareDiagnostics).mockReset();
    vi.mocked(runProviderPrepareDiagnostics).mockResolvedValue({
      status: 'ready',
      warnings: [],
      details: [],
      modelResultsById: {},
    });
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        createAuthoritativeProviderStatus('anthropic', ['opus', 'sonnet']),
        createAuthoritativeProviderStatus('codex', ['gpt-5.4']),
        createAuthoritativeProviderStatus('opencode', ['opencode/big-pickle']),
      ],
    };
    fetchCliProviderStatus.mockReset();
    fetchCliProviderStatus.mockImplementation(async (providerId, options) => {
      if (providerId !== 'opencode' || !options?.projectPath) {
        return true;
      }

      const globalProvider = (storeState.cliStatus as any)?.providers?.find(
        (provider: { providerId?: string }) => provider.providerId === 'opencode'
      );
      const models =
        globalProvider?.models?.length > 0
          ? globalProvider.models
          : createTeamDraftMock.state.members
              .filter((member) => member.providerId === 'opencode')
              .map((member) => member.model)
              .filter(Boolean);
      storeState.cliProviderStatusByScope = {
        ...storeState.cliProviderStatusByScope,
        [getCliProviderStatusScopeKey('opencode', options.projectPath)]: {
          ...(globalProvider ?? {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            verificationState: 'verified',
            capabilities: { teamLaunch: true, oneShot: false },
          }),
          authenticated: true,
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
          statusCheckErrorCode: undefined,
          capabilities: { teamLaunch: true, oneShot: true },
          models,
          modelCatalogRefreshState: 'ready',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-07-20T00:00:00.000Z',
            staleAt: '2099-07-20T00:10:00.000Z',
            defaultModelId: models[0] ?? null,
            defaultLaunchModel: models[0] ?? null,
            models: models.map((model: string) => ({
              id: model,
              launchModel: model,
              displayName: model,
            })),
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        },
      };
      return true;
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    storeState.cliStatus = { providers: [] };
    storeState.cliProviderStatusByScope = {};
    storeState.launchParamsByTeam = {};
    createTeamDraftMock.state.members[0].model = 'opencode/big-pickle';
    createTeamDraftMock.state.cwdMode = 'project';
    createTeamDraftMock.state.selectedProjectPath = '/tmp/project';
    createTeamDraftMock.state.customCwd = '';
    createTeamDraftMock.state.soloTeam = false;
    vi.mocked(isTeamModelAvailableForUi).mockImplementation(() => true);
    teamRosterEditorSectionMock.lastProps = null;
  });

  it('fail-closes both real launch submit paths when Anthropic authority expires', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const baseTime = Date.parse('2026-08-29T00:00:00.000Z');
    vi.setSystemTime(baseTime);
    localStorage.setItem('team:lastSelectedProvider', 'anthropic');
    localStorage.setItem('team:lastSelectedModel:anthropic', 'opus');
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'api_key',
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
          models: ['opus'],
          modelAvailability: [{ modelId: 'opus', status: 'available' }],
          modelCatalogRefreshState: 'ready',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-models-api',
            status: 'ready',
            fetchedAt: new Date(baseTime).toISOString(),
            staleAt: new Date(baseTime + 100).toISOString(),
            defaultModelId: 'opus',
            defaultLaunchModel: 'opus',
            models: [
              {
                id: 'opus',
                launchModel: 'opus',
                displayName: 'Opus',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'anthropic-models-api',
              },
            ],
            diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
          },
          canLoginFromUi: false,
          capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
        },
      ],
    } as any;

    const launchHost = document.createElement('div');
    document.body.appendChild(launchHost);
    const launchDialogRoot = createRoot(launchHost);
    const onLaunch = vi.fn(async () => {});
    await act(async () => {
      launchDialogRoot.render(
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
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
    });
    const launchButton = Array.from(launchHost.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(launchButton?.disabled).toBe(false);

    vi.setSystemTime(baseTime + 100);
    await act(async () => {
      launchButton?.click();
      await flush();
    });
    expect(onLaunch).not.toHaveBeenCalled();
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(launchButton?.disabled).toBe(true);
    expect(launchHost.textContent).not.toContain('All selected providers are ready.');
    expect(launchHost.textContent).toContain('Runtime environment is not available');
    expect(launchHost.textContent).toContain('verified model catalog is unavailable or stale');
    expect(launchButton?.getAttribute('aria-describedby')).toBe(
      'launch-team-launch-authority-blocker'
    );
    await act(async () => launchDialogRoot.unmount());

    vi.setSystemTime(baseTime);
    createTeamDraftMock.state.soloTeam = true;
    const createHost = document.createElement('div');
    document.body.appendChild(createHost);
    const createDialogRoot = createRoot(createHost);
    const onCreate = vi.fn(async () => {});
    await act(async () => {
      createDialogRoot.render(
        React.createElement(CreateTeamDialog, {
          open: true,
          canCreate: true,
          provisioningErrorsByTeam: {},
          existingTeamNames: [],
          activeTeams: [],
          defaultProjectPath: '/tmp/project',
          onClose: vi.fn(),
          onCreate,
          onOpenTeam: vi.fn(),
        })
      );
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
    });
    const createButton = Array.from(createHost.querySelectorAll('button')).find((button) =>
      button.textContent?.toLowerCase().includes('create')
    );
    expect(createButton?.disabled).toBe(false);

    vi.setSystemTime(baseTime + 100);
    await act(async () => {
      createButton?.click();
      await flush();
    });
    expect(onCreate).not.toHaveBeenCalled();
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(createButton?.disabled).toBe(true);
    await act(async () => createDialogRoot.unmount());
  });

  it('shows the Codex account/runtime launch mismatch when Create is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('team:lastSelectedProvider', 'codex');
    localStorage.setItem('team:lastSelectedModel:codex', 'gpt-5.5');
    createTeamDraftMock.state.soloTeam = true;
    const readyCodex = createAuthoritativeProviderStatus('codex', ['gpt-5.5']);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          ...readyCodex,
          authenticated: false,
          authMethod: null,
          statusMessage: 'Codex native runtime unavailable',
          detailMessage: 'Codex native runtime requires CODEX_API_KEY or OPENAI_API_KEY.',
          capabilities: { ...readyCodex.capabilities, teamLaunch: false },
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
        React.createElement(CreateTeamDialog, {
          open: true,
          canCreate: true,
          provisioningErrorsByTeam: {},
          existingTeamNames: [],
          activeTeams: [],
          defaultProjectPath: '/tmp/project',
          onClose: vi.fn(),
          onCreate: vi.fn(async () => {}),
          onOpenTeam: vi.fn(),
        })
      );
      await flush();
    });
    for (
      let attempt = 0;
      attempt < 10 && !host.textContent?.includes('runtime has not confirmed launch readiness');
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();
      });
    }

    const createButton = host.querySelector<HTMLButtonElement>(
      'button[aria-describedby="create-team-launch-authority-blocker"]'
    );
    expect(createButton?.disabled).toBe(true);
    expect(host.textContent).toContain('Runtime environment is not available - launch is blocked');
    expect(host.textContent).toContain(
      'ChatGPT account is connected, but the Codex runtime has not confirmed launch readiness'
    );
    expect(host.textContent).not.toContain('All selected providers are ready.');
    expect(host.textContent).not.toContain('CODEX_API_KEY');

    await act(async () => root.unmount());
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
        'Worktree branch: feature/current-work\nLast workspace: /tmp/project/.worktrees/jack. Managed worktree reused if available; otherwise created on launch.',
    });

    const isolatedMembers = teamRosterEditorSectionMock.lastProps.members;
    await act(async () => {
      teamRosterEditorSectionMock.lastProps.onMembersChange(
        isolatedMembers.map((member: any) => ({ ...member, isolation: undefined }))
      );
      await flush();
    });
    expect(teamRosterEditorSectionMock.lastProps.memberInfoById).toEqual({});
    await act(async () => {
      teamRosterEditorSectionMock.lastProps.onMembersChange(isolatedMembers);
      await flush();
    });
    expect(teamRosterEditorSectionMock.lastProps.memberInfoById['draft-0']).toContain(
      'Worktree branch: feature/current-work'
    );

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('hydrates existing teammate models before a slow saved-request lookup completes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(new Promise(() => {}));
    const localModel = 'ollama/qwen2.5-coder:0.5b';
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
          modelVerificationState: 'idle',
          modelCatalogRefreshState: 'ready',
          statusMessage: null,
          models: ['opencode/big-pickle'],
          modelAvailability: [],
          capabilities: { teamLaunch: true, oneShot: false },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        },
      ],
    } as any;
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', '/tmp/project')]: {
        ...(storeState.cliStatus as any).providers[0],
        models: [localModel],
        modelCatalogRefreshState: 'ready',
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'opencode',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-07-20T00:00:00.000Z',
          staleAt: '2099-07-20T00:10:00.000Z',
          defaultModelId: localModel,
          defaultLaunchModel: localModel,
          models: [],
          diagnostics: {
            configReadState: 'ready',
            appServerState: 'healthy',
          },
        },
      },
    };

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
              name: 'alice',
              role: 'reviewer',
              providerId: 'opencode',
              model: localModel,
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

    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({
        name: 'alice',
        providerId: 'opencode',
        model: localModel,
      }),
    ]);
    expect(
      vi
        .mocked(runProviderPrepareDiagnostics)
        .mock.calls.find((call) => call[0]?.providerId === 'opencode')?.[0]?.selectedModelChecks
    ).toEqual([
      expect.objectContaining({
        providerId: 'opencode',
        model: localModel,
      }),
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps a programmatic effort reset from cancelling saved-request hydration', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('team:lastSelectedEffort', 'xhigh');
    let resolveSavedRequest: (value: unknown) => void = () => {};
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      }) as any
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
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    // EffortLevelSelector clears an effort the selected model cannot run through the
    // dedicated auto-reset callback. That is not a user edit.
    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onEffortAutoReset();
      await flush();
    });

    await act(async () => {
      resolveSavedRequest({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'codex',
        model: 'gpt-5.5',
        members: [{ name: 'jack', role: 'developer' }],
      });
      await flush();
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);
    // The auto reset kept the form pristine, so the saved request fields still hydrate.
    expect(teamRosterEditorSectionMock.lastProps?.providerId).toBe('codex');

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('still lets a user effort choice during hydration win over the saved request fields', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSavedRequest: (value: unknown) => void = () => {};
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      }) as any
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
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onEffortChange('high');
      await flush();
    });

    const providerBeforeSavedRequest = teamRosterEditorSectionMock.lastProps?.providerId;

    await act(async () => {
      resolveSavedRequest({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'codex',
        model: 'gpt-5.5',
        members: [{ name: 'jack', role: 'developer' }],
      });
      await flush();
      await flush();
    });

    // The controls the user touched keep their values...
    expect(providerBeforeSavedRequest).not.toBe('codex');
    expect(teamRosterEditorSectionMock.lastProps?.providerId).toBe(providerBeforeSavedRequest);
    // ...while the roster the user never touched still hydrates from the saved request.
    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('lets an explicit Default effort choice during hydration win over the saved request', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSavedRequest: (value: unknown) => void = () => {};
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      }) as any
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
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    // The user explicitly picks Default (''), which is indistinguishable from the
    // programmatic clear by value alone — but it arrives through onEffortChange.
    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onEffortChange('');
      await flush();
    });

    const providerBeforeSavedRequest = teamRosterEditorSectionMock.lastProps?.providerId;

    await act(async () => {
      resolveSavedRequest({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'codex',
        model: 'gpt-5.5',
        members: [{ name: 'jack', role: 'developer' }],
      });
      await flush();
      await flush();
    });

    expect(providerBeforeSavedRequest).not.toBe('codex');
    expect(teamRosterEditorSectionMock.lastProps?.providerId).toBe(providerBeforeSavedRequest);
    expect(teamRosterEditorSectionMock.lastProps?.effort).toBeUndefined();
    // The roster the user never touched still hydrates from the saved request.
    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps a sync-models toggle made during hydration from being overwritten', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSavedRequest: (value: unknown) => void = () => {};
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      }) as any
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
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.syncModelsWithTeammates).toBe(false);

    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onSyncModelsWithTeammatesChange(true);
      await flush();
    });

    // The saved roster members carry their own models, so re-deriving the toggle from
    // them would flip it back to false.
    await act(async () => {
      resolveSavedRequest({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'codex',
        model: 'gpt-5.5',
        members: [{ name: 'jack', role: 'developer', model: 'gpt-5.5' }],
      });
      await flush();
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.syncModelsWithTeammates).toBe(true);
    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('restores an explicit sync-off preference for teammates using provider defaults', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'codex',
      model: 'gpt-5.5',
      syncModelsWithLead: false,
      members: [{ name: 'jack', role: 'developer' }],
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

    expect(teamRosterEditorSectionMock.lastProps?.syncModelsWithTeammates).toBe(false);
    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps a teammate worktree toggle made during hydration from being overwritten', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSavedRequest: (value: unknown) => void = () => {};
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      }) as any
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
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.teammateWorktreeDefault).toBe(false);

    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onTeammateWorktreeDefaultChange(true);
      await flush();
    });

    // The saved roster members have no worktree settings, so re-deriving the toggle
    // from them would flip it back to false.
    await act(async () => {
      resolveSavedRequest({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'codex',
        model: 'gpt-5.5',
        members: [{ name: 'jack', role: 'developer' }],
      });
      await flush();
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.teammateWorktreeDefault).toBe(true);
    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('fills the saved roster when an unrelated control is toggled during hydration', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSavedRequest: (value: unknown) => void = () => {};
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      }) as any
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
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    // A draft team has no live members, so the saved request is the only roster source.
    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onLimitContextChange(true);
      await flush();
    });

    await act(async () => {
      resolveSavedRequest({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'codex',
        model: 'gpt-5.5',
        members: [{ name: 'jack', role: 'developer' }],
      });
      await flush();
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);
    expect(teamRosterEditorSectionMock.lastProps?.limitContext).toBe(true);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps a roster edit made during hydration from being overwritten', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSavedRequest: (value: unknown) => void = () => {};
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      }) as any
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
          onLaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onMembersChange([
        {
          id: 'draft-0',
          name: 'nina',
          roleSelection: '',
          customRole: 'Developer',
          workflow: '',
        },
      ]);
      await flush();
    });

    await act(async () => {
      resolveSavedRequest({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'codex',
        model: 'gpt-5.5',
        members: [{ name: 'jack', role: 'developer' }],
      });
      await flush();
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'nina' }),
    ]);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('completes hydration when the saved request carries a malformed backend id', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'codex',
      // Legacy/hand-edited persisted config: not a string.
      providerBackendId: 42,
      model: 'gpt-5.5',
      members: [{ name: 'jack', role: 'developer' }],
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

    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({ name: 'jack' }),
    ]);
    expect(teamRosterEditorSectionMock.lastProps?.providerId).toBe('codex');

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('uses the project-scoped OpenCode teammate model in Create preflight', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const localModel = 'ollama/qwen2.5-coder:0.5b';
    const originalModel = createTeamDraftMock.state.members[0].model;
    createTeamDraftMock.state.members[0].model = localModel;
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
          modelVerificationState: 'idle',
          modelCatalogRefreshState: 'ready',
          statusMessage: null,
          models: ['opencode/big-pickle'],
          modelAvailability: [],
          capabilities: { teamLaunch: true, oneShot: false },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        },
        {
          providerId: 'codex',
          supported: true,
          authenticated: true,
          authMethod: 'oauth',
          verificationState: 'verified',
          modelVerificationState: 'idle',
          modelCatalogRefreshState: 'ready',
          statusMessage: null,
          models: ['gpt-5.5'],
          modelAvailability: [],
          capabilities: { teamLaunch: true, oneShot: true },
          backend: { kind: 'codex-native', label: 'Codex native' },
        },
      ],
    } as any;
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', '/tmp/project')]: {
        ...(storeState.cliStatus as any).providers[0],
        models: [localModel],
        modelCatalogRefreshState: 'ready',
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'opencode',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-07-20T00:00:00.000Z',
          staleAt: '2099-07-20T00:10:00.000Z',
          defaultModelId: localModel,
          defaultLaunchModel: localModel,
          models: [],
          diagnostics: {
            configReadState: 'ready',
            appServerState: 'healthy',
          },
        },
      },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
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
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
    });

    expect(
      vi
        .mocked(runProviderPrepareDiagnostics)
        .mock.calls.find((call) => call[0]?.providerId === 'opencode')?.[0]?.selectedModelChecks
    ).toEqual([
      expect.objectContaining({
        providerId: 'opencode',
        model: localModel,
      }),
    ]);

    createTeamDraftMock.state.members[0].model = originalModel;
    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('uses one custom cwd for the scoped OpenCode catalog and Create preflight', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const customCwd = '/tmp/custom-catalog-project';
    const localModel = 'ollama/qwen2.5-coder:0.5b';
    createTeamDraftMock.state.cwdMode = 'custom';
    createTeamDraftMock.state.customCwd = customCwd;
    createTeamDraftMock.state.members[0].model = localModel;
    vi.mocked(isTeamModelAvailableForUi).mockImplementation(
      (_providerId, model, providerStatus) => providerStatus?.models?.includes(model ?? '') ?? false
    );
    const globalProvider = {
      providerId: 'opencode',
      supported: true,
      authenticated: true,
      authMethod: 'opencode_managed',
      verificationState: 'verified',
      modelVerificationState: 'idle',
      modelCatalogRefreshState: 'ready',
      statusMessage: null,
      models: ['opencode/big-pickle'],
      modelAvailability: [],
      capabilities: { teamLaunch: true, oneShot: false },
      backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
    };
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [globalProvider],
    } as any;
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', customCwd)]: {
        ...globalProvider,
        models: [localModel],
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'opencode',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-07-20T00:00:00.000Z',
          staleAt: '2099-07-20T00:10:00.000Z',
          defaultModelId: localModel,
          defaultLaunchModel: localModel,
          models: [],
          diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
        },
      },
    } as any;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
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
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'opencode', model: localModel }),
      ])
    );
    expect(
      vi
        .mocked(runProviderPrepareDiagnostics)
        .mock.calls.find((call) => call[0]?.providerId === 'opencode')?.[0]
    ).toMatchObject({
      cwd: customCwd,
      selectedModelChecks: [expect.objectContaining({ model: localModel })],
    });

    await act(async () => root.unmount());
  });

  it('opens a brand-new team with the lead only and no pre-stuffed teammates', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const savedMembers = createTeamDraftMock.state.members;
    createTeamDraftMock.state.members = [];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
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
      });

      // The open effect must not invent teammates (previously alice/tom/bob/jack).
      const rosterWrites = createTeamDraftMock.state.setMembers.mock.calls.map(([next]: any[]) =>
        typeof next === 'function' ? next([]) : next
      );
      expect(rosterWrites.flatMap((roster: any[]) => roster.map((member) => member.name))).toEqual(
        []
      );
      expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([]);
    } finally {
      await act(async () => {
        root.unmount();
        await flush();
      });
      createTeamDraftMock.state.members = savedMembers;
    }
  });

  it('forces navigation project mode once and then allows a custom path', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    createTeamDraftMock.state.cwdMode = 'custom';
    createTeamDraftMock.state.selectedProjectPath = '';

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const props = {
      open: true,
      canCreate: true,
      provisioningErrorsByTeam: {},
      existingTeamNames: [],
      activeTeams: [],
      defaultProjectPath: '/tmp/project',
      forceDefaultProjectSelection: true,
      onClose: vi.fn(),
      onCreate: vi.fn(async () => {}),
      onOpenTeam: vi.fn(),
    };

    await act(async () => {
      root.render(React.createElement(CreateTeamDialog, props));
      await flush();
    });

    expect(createTeamDraftMock.state.setCwdMode).toHaveBeenCalledWith('project');
    expect(createTeamDraftMock.state.setSelectedProjectPath).not.toHaveBeenCalled();

    createTeamDraftMock.state.cwdMode = 'project';
    await act(async () => {
      root.render(React.createElement(CreateTeamDialog, props));
      await flush();
    });

    expect(createTeamDraftMock.state.setSelectedProjectPath).toHaveBeenCalledWith('/tmp/project');

    createTeamDraftMock.state.setCwdMode.mockClear();
    createTeamDraftMock.state.cwdMode = 'custom';
    await act(async () => {
      root.render(React.createElement(CreateTeamDialog, props));
      await flush();
    });

    expect(createTeamDraftMock.state.setCwdMode).not.toHaveBeenCalled();

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
        'Worktree branch: feature/current-work\nLast workspace: /tmp/project/.worktrees/jack. Managed worktree reused if available; otherwise created on launch.',
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
          ...createAuthoritativeProviderStatus('codex', ['gpt-5.4']),
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
          ...createAuthoritativeProviderStatus('anthropic', ['sonnet']),
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

  it('clears stale lead effort immediately when selecting an Anthropic model without effort support', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('team:lastSelectedProvider', 'anthropic');
    localStorage.setItem('team:lastSelectedEffort', 'medium');
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'anthropic',
          supported: true,
          authenticated: true,
          verificationState: 'verified',
          models: ['claude-haiku-4-5-20251001'],
          capabilities: { teamLaunch: true, oneShot: true },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-models-api',
            status: 'ready',
            fetchedAt: '2026-07-04T00:00:00.000Z',
            staleAt: '2026-07-04T00:10:00.000Z',
            defaultModelId: 'claude-haiku-4-5-20251001',
            defaultLaunchModel: 'claude-haiku-4-5-20251001',
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
            models: [
              {
                id: 'claude-haiku-4-5-20251001',
                launchModel: 'claude-haiku-4-5-20251001',
                displayName: 'Haiku 4.5',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text', 'image'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'anthropic-models-api',
              },
            ],
          },
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'anthropic-models-api',
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

    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onModelChange('claude-haiku-4-5-20251001');
      await flush();
    });

    expect(teamRosterEditorSectionMock.lastProps?.model).toBe('claude-haiku-4-5-20251001');
    expect(teamRosterEditorSectionMock.lastProps?.effort).toBeUndefined();
    expect(localStorage.getItem('team:lastSelectedEffort')).toBe('');

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
      {
        teamName: string;
        cwd: string;
        providerId?: string;
        model?: string;
        syncModelsWithLead?: boolean;
      },
      Array<{ name: string; providerId?: string; model?: string }>,
    ];

    expect(request.teamName).toBe('team-alpha');
    expect(request.cwd).toBe('/tmp/project');
    expect(request.providerId).toBe('anthropic');
    expect(request.model).toBe('opus');
    expect(request.syncModelsWithLead).toBe(false);
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();
      });
    }

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

  it('allows OpenCode lead launch with the runtime default model', async () => {
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();
      });
    }

    expect(host.textContent).not.toContain('OpenCode lead requires a selected model.');
    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton?.hasAttribute('disabled')).toBe(false);
    expect(onLaunch).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('allows OpenCode lead launch without teammates for solo runtime teams', async () => {
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();
      });
    }

    expect(host.textContent).not.toContain(
      'OpenCode lead requires at least one OpenCode teammate.'
    );
    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(submitButton).toBeTruthy();
    expect(submitButton?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });

    expect(onLaunch).toHaveBeenCalledTimes(1);

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

  it('does not reset Codex Fast mode while the account snapshot is still pending', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.getCodexAccountSnapshot).mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          supported: true,
          authenticated: false,
          verificationState: 'error',
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          models: ['gpt-5.4'],
          modelCatalogRefreshState: 'ready',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'codex',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-07-21T00:00:00.000Z',
            defaultModelId: 'gpt-5.4',
            defaultLaunchModel: 'gpt-5.4',
            models: [],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'runtime-missing',
            },
          },
          connection: {
            codex: {
              effectiveAuthMode: null,
              launchAllowed: false,
              launchIssueMessage: 'Codex CLI not found',
              launchReadinessState: 'runtime_missing',
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
            id: 'schedule-pending-codex',
            teamName: 'team-alpha',
            label: 'Codex pending account',
            cronExpression: '0 10 * * 1-5',
            timezone: 'UTC',
            status: 'active',
            warmUpMinutes: 15,
            maxConsecutiveFailures: 3,
            consecutiveFailures: 0,
            maxTurns: 50,
            createdAt: '2026-07-21T00:00:00.000Z',
            updatedAt: '2026-07-21T00:00:00.000Z',
            launchConfig: {
              cwd: '/tmp/project',
              prompt: 'Run Codex scheduled check',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model: 'gpt-5.4',
              effort: 'xhigh',
              fastMode: 'on',
              resolvedFastMode: true,
              skipPermissions: true,
            },
          } as any,
        })
      );
      await flush();
    });

    expect(host.querySelector('[data-testid="codex-fast-mode-selector"]')?.textContent).toContain(
      'codex-fast:on'
    );

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

  it('refreshes OpenCode preflight when a checking catalog becomes authoritative', async () => {
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
          statusCheckOutcome: 'authoritative',
          modelVerificationState: 'verified',
          statusMessage: 'warming up',
          detailMessage: 'catalog still loading',
          models: ['opencode/minimax-m2.5-free'],
          modelCatalogRefreshState: 'loading',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'checking',
            fetchedAt: '2026-07-20T00:00:00.000Z',
            staleAt: '2099-07-20T00:10:00.000Z',
            defaultModelId: 'opencode/minimax-m2.5-free',
            defaultLaunchModel: 'opencode/minimax-m2.5-free',
            models: [],
            diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
        createAuthoritativeProviderStatus('anthropic', ['opus']),
      ],
    } as any;
    const projectScopeKey = getCliProviderStatusScopeKey('opencode', '/tmp/project');
    storeState.cliProviderStatusByScope[projectScopeKey] = (
      storeState.cliStatus as any
    ).providers[0];
    fetchCliProviderStatus.mockResolvedValue(true);

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

    const launchButtonWhileChecking = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(launchButtonWhileChecking?.hasAttribute('disabled')).toBe(true);

    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
          modelVerificationState: 'verified',
          statusMessage: 'healthy',
          detailMessage: 'catalog ready',
          models: [
            'opencode/minimax-m2.5-free',
            'opencode/qwen3.6-plus-free',
            'openrouter/google/gemma-4-26b-a4b-it',
          ],
          modelCatalogRefreshState: 'ready',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-07-20T00:00:00.000Z',
            staleAt: '2099-07-20T00:10:00.000Z',
            defaultModelId: 'opencode/minimax-m2.5-free',
            defaultLaunchModel: 'opencode/minimax-m2.5-free',
            models: [
              {
                id: 'opencode/minimax-m2.5-free',
                launchModel: 'opencode/minimax-m2.5-free',
                displayName: 'minimax-m2.5-free',
              },
              {
                id: 'opencode/qwen3.6-plus-free',
                launchModel: 'opencode/qwen3.6-plus-free',
                displayName: 'qwen3.6-plus-free',
              },
              {
                id: 'openrouter/google/gemma-4-26b-a4b-it',
                launchModel: 'openrouter/google/gemma-4-26b-a4b-it',
                displayName: 'gemma-4-26b-a4b-it',
              },
            ],
            diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
        createAuthoritativeProviderStatus('anthropic', ['opus']),
      ],
    } as any;
    storeState.cliProviderStatusByScope[projectScopeKey] = (
      storeState.cliStatus as any
    ).providers[0];

    await act(async () => {
      await renderDialog();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
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
    expect(inFlightOpencodePrepareCalls).toHaveLength(2);
    expect(host.textContent).toContain('All selected providers are ready.');

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('keeps launch disabled when selected model preflight fails', async () => {
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
          statusCheckOutcome: 'authoritative',
          modelVerificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          models: ['ollama/llama3.2:latest', 'ollama/qwen2.5:latest'],
          modelCatalogRefreshState: 'ready',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-07-20T00:00:00.000Z',
            staleAt: '2099-07-20T00:10:00.000Z',
            defaultModelId: 'ollama/llama3.2:latest',
            defaultLaunchModel: 'ollama/llama3.2:latest',
            models: [
              {
                id: 'ollama/llama3.2:latest',
                launchModel: 'ollama/llama3.2:latest',
                displayName: 'llama3.2:latest',
              },
              {
                id: 'ollama/qwen2.5:latest',
                launchModel: 'ollama/qwen2.5:latest',
                displayName: 'qwen2.5:latest',
              },
            ],
            diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
          },
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
        },
        createAuthoritativeProviderStatus('anthropic', ['sonnet']),
      ],
    } as any;
    storeState.cliProviderStatusByScope[getCliProviderStatusScopeKey('opencode', '/tmp/project')] =
      (storeState.cliStatus as any).providers[0];
    fetchCliProviderStatus.mockResolvedValue(true);
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      providerId: 'anthropic',
      model: 'sonnet',
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'ollama/llama3.2:latest',
        },
      ],
    } as any);
    vi.mocked(runProviderPrepareDiagnostics).mockImplementation(async (input) =>
      input.providerId === 'opencode'
        ? ({
            status: 'failed',
            warnings: [],
            details: [
              'llama3.2:latest returned plain text instead of the required Agent Teams response.',
            ],
            modelResultsById: {},
          } as any)
        : ({
            status: 'ready',
            warnings: [],
            details: [],
            modelResultsById: {},
          } as any)
    );
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
      await flush();
    });
    for (
      let attempt = 0;
      attempt < 10 && !host.textContent?.includes('Runtime environment is not available');
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();
      });
    }

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    expect(host.textContent).toContain('Runtime environment is not available');
    expect(submitButton?.hasAttribute('disabled')).toBe(true);

    submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await act(async () => {
      await flush();
    });
    expect(api.teams.replaceMembers).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();

    vi.mocked(runProviderPrepareDiagnostics).mockResolvedValue({
      status: 'ready',
      warnings: [],
      details: [],
      modelResultsById: {},
    } as any);
    await act(async () => {
      teamRosterEditorSectionMock.lastProps?.onMembersChange(
        teamRosterEditorSectionMock.lastProps.members.map((member: any) => ({
          ...member,
          model: 'ollama/qwen2.5:latest',
        }))
      );
      await flush();
      await flush();
    });
    expect(teamRosterEditorSectionMock.lastProps.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: 'ollama/qwen2.5:latest',
        }),
      ])
    );
    expect(
      vi
        .mocked(runProviderPrepareDiagnostics)
        .mock.calls.some(
          ([input]) =>
            input.providerId === 'opencode' &&
            input.selectedModelIds.includes('ollama/qwen2.5:latest')
        )
    ).toBe(true);
    for (
      let attempt = 0;
      attempt < 10 && !host.textContent?.includes('All selected providers are ready.');
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();
      });
    }

    expect(host.textContent).toContain('All selected providers are ready.');
    expect(submitButton?.hasAttribute('disabled')).toBe(false);

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
          ...createAuthoritativeProviderStatus('anthropic', ['haiku']),
          modelVerificationState: 'verified',
        },
        {
          ...createAuthoritativeProviderStatus('codex', ['gpt-5.5']),
          authMethod: 'chatgpt',
          modelVerificationState: 'verified',
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
        },
        {
          ...createAuthoritativeProviderStatus('opencode', ['opencode/big-pickle']),
          authMethod: 'opencode_managed',
          modelVerificationState: 'verified',
          statusMessage: 'warming up',
          detailMessage: 'first render',
          capabilities: {
            teamLaunch: true,
            oneShot: false,
            extensions: createDefaultCliExtensionCapabilities(),
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
    await act(async () => {
      vi.runOnlyPendingTimers();
      await flush();
    });

    expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalled();

    await act(async () => {
      await renderDialog();
      await flush();
    });

    const callsAfterSameSignatureRerender = vi.mocked(runProviderPrepareDiagnostics).mock.calls
      .length;

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
    expect(host.textContent).not.toContain('All selected providers are ready.');
    expect(host.textContent).toContain('Runtime environment is not available');
    const authorityBlockedCreateButton = host.querySelector<HTMLButtonElement>(
      'button[aria-describedby="create-team-launch-authority-blocker"]'
    );
    expect(authorityBlockedCreateButton?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('does not report the submitted team name as a duplicate while creation is in flight', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    let resolveCreate!: () => void;
    const createPromise = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const onCreate = vi.fn(() => createPromise);
    const onClose = vi.fn();
    const onOpenTeam = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderDialog = async (
      existingTeamNames: string[],
      provisioningTeamNames: string[]
    ): Promise<void> => {
      root.render(
        React.createElement(CreateTeamDialog, {
          open: true,
          canCreate: true,
          provisioningErrorsByTeam: {},
          clearProvisioningError: vi.fn(),
          existingTeamNames,
          provisioningTeamNames,
          activeTeams: [],
          defaultProjectPath: '/tmp/project',
          onClose,
          onCreate,
          onOpenTeam,
        })
      );
      await flush();
    };

    await act(async () => {
      await renderDialog([], []);
    });

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) =>
        button.textContent === 'Create' || button.textContent === 'Skip preflight and create'
    );
    expect(submitButton?.disabled).toBe(false);

    await act(async () => {
      submitButton?.click();
      await flush();
    });
    expect(onCreate).toHaveBeenCalledOnce();

    await act(async () => {
      await renderDialog(['team-alpha'], ['team-alpha']);
    });

    expect(host.textContent).toContain('Creating...');
    expect(host.textContent).not.toContain('Team name already exists');
    expect(host.textContent).not.toContain('A team with this name is currently launching');

    await act(async () => {
      resolveCreate();
      await createPromise;
      await flush();
    });
    expect(onOpenTeam).toHaveBeenCalledWith('team-alpha', '/tmp/project');
    expect(onClose).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
      await flush();
    });
  });
});
