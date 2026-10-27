/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type -- Legacy dialog mocks use broad DTO shapes. */
import { webcrypto } from 'node:crypto';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { __resetRetainedCreateSubmissionForTests } from '@renderer/components/team/dialogs/retainedCreateSubmission';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
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
const projectPathSelectorMock = vi.hoisted(() => ({
  onSelect: (_path: string) => {},
  lastProps: null as any,
}));
const advancedCliMock = vi.hoisted(() => ({ lastProps: null as any }));
const runtimeSettingsMock = vi.hoisted(() => ({ lastProps: null as any }));
const draftLoadMock = vi.hoisted(() => ({ complete: (_value: string) => {} }));
const prepareHelperFixture = vi.hoisted(() => ({
  real: false,
  onLayout: null as (() => void) | null,
}));
type TestCliStatus = Pick<CliInstallationStatus, 'providers'> &
  Partial<Pick<CliInstallationStatus, 'flavor'>>;
const createTeamDraftMock = vi.hoisted(() => ({
  state: {
    runtimeSelectionVersion: undefined as 1 | undefined,
    runtimeProviderId: undefined as TeamProviderId | undefined,
    runtimeModel: undefined as string | undefined,
    setRuntimeSelection: vi.fn(),
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
  activeContextId: 'TEST-local',
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
  refreshTeamData: vi.fn(async () => {}),
};

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: {
    agentBackend: {
      getConnections: vi.fn(async () => ({ state: 'unconfigured', bindings: [] })),
      invoke: vi.fn(async () => ({ ok: false, code: 'unavailable', outcome: 'not-dispatched' })),
    },
    workspaceTrust: { getLaunchStatus: vi.fn(), getProjectStatus: vi.fn() },
    gatewayProvider: {
      listGatewayBindings: vi.fn(async () => []),
      unbindGatewayMember: vi.fn(async () => {}),
    },
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
      createConfig: vi.fn(async () => {}),
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
    projectFolder: {
      getState: vi.fn(async () => ({ state: 'exists' as const })),
      create: vi.fn(async () => ({ state: 'exists' as const })),
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
  useStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  ),
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
  clearMemberModelOverrides: (member: any) => ({
    ...member,
    providerId: undefined,
    providerBackendId: undefined,
    model: '',
    effort: undefined,
    fastMode: undefined,
  }),
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
    React.useLayoutEffect(() => {
      prepareHelperFixture.onLayout?.();
    });
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

vi.mock('@renderer/components/team/dialogs/ProvisioningProviderRuntimeSettingsDialog', () => ({
  ProvisioningProviderRuntimeSettingsDialog: (props: any) => {
    runtimeSettingsMock.lastProps = props;
    return props.openProviderId
      ? React.createElement('div', { 'data-testid': 'provider-settings' }, props.openProviderId)
      : null;
  },
}));

vi.mock('@renderer/components/team/dialogs/SkipPermissionsCheckbox', () => ({
  SkipPermissionsCheckbox: () => React.createElement('div', null, 'skip-permissions'),
}));

vi.mock('@renderer/components/team/dialogs/AdvancedCliSection', () => ({
  AdvancedCliSection: (props: any) => {
    advancedCliMock.lastProps = props;
    return React.createElement('div', null, 'advanced-cli');
  },
}));

vi.mock('@renderer/components/team/dialogs/OptionalSettingsSection', () => ({
  OptionalSettingsSection: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/team/dialogs/ProjectPathSelector', () => ({
  ProjectPathSelector: ({
    selectedProjectPath,
    onSelectedProjectPathChange,
    ...rest
  }: {
    selectedProjectPath: string;
    onSelectedProjectPathChange: (path: string) => void;
    [key: string]: any;
  }) => {
    projectPathSelectorMock.lastProps = { selectedProjectPath, ...rest };
    projectPathSelectorMock.onSelect = onSelectedProjectPathChange;
    return React.createElement('div', { 'data-testid': 'project-path' }, selectedProjectPath);
  },
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
  Combobox: (props: any) =>
    props.id === 'launch-continuation-mode' || props.id?.startsWith('resume-checkpoint-')
      ? React.createElement(
          'select',
          {
            id: props.id,
            value: props.value,
            disabled: props.disabled,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              props.onValueChange(event.target.value),
          },
          React.createElement('option', { value: '' }, props.placeholder ?? 'Select'),
          props.options.map((option: any) =>
            React.createElement(
              'option',
              { key: option.value, value: option.value, disabled: option.disabled },
              option.label
            )
          )
        )
      : React.createElement('div', null, 'combobox'),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
    onOpenChange,
  }: {
    open: boolean;
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open
      ? React.createElement(
          'div',
          null,
          children,
          React.createElement(
            'button',
            { 'data-testid': 'dismiss-dialog', onClick: () => onOpenChange?.(false) },
            'Close'
          )
        )
      : null,
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
    draftLoadMock.complete = setValue;
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
  normalizeExplicitTeamModelForUi: vi.fn((_providerId: string, model: string) => model),
}));

vi.mock('@renderer/utils/teamProviderRuntimeStatusLoading', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/utils/teamProviderRuntimeStatusLoading')>()),
  getOpenCodeScopedPreparationFailure: vi.fn(() => null),
  hasSettledOpenCodeScopedPreparation: vi.fn(() => false),
  isTeamProviderRuntimeStatusLoading: vi.fn(() => false),
}));

vi.mock('@renderer/components/team/dialogs/providerPrepareCacheKey', () => ({
  buildProviderPrepareModelCacheKey: () => 'prepare-cache-key',
}));

vi.mock('@renderer/components/team/dialogs/providerPrepareDiagnostics', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@renderer/components/team/dialogs/providerPrepareDiagnostics')
    >();
  return {
    buildReusableProviderPrepareModelResults: () => ({}),
    getProviderPrepareCachedSnapshot: (
      input: Parameters<typeof actual.getProviderPrepareCachedSnapshot>[0]
    ) =>
      prepareHelperFixture.real
        ? actual.getProviderPrepareCachedSnapshot(input)
        : { status: 'checking', details: [] },
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
  };
});

vi.mock('@renderer/components/team/dialogs/provisioningModelIssues', () => ({
  getProvisioningModelIssue: () => null,
}));

vi.mock(
  '@renderer/components/team/dialogs/ProvisioningProviderStatusList',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@renderer/components/team/dialogs/ProvisioningProviderStatusList')
      >();
    return {
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
      deriveEffectiveProvisioningPrepareState: (
        input: Parameters<typeof actual.deriveEffectiveProvisioningPrepareState>[0]
      ) =>
        prepareHelperFixture.real
          ? actual.deriveEffectiveProvisioningPrepareState(input)
          : { state: input.state, message: input.message },
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
        prepareHelperFixture.real
          ? actual.updateProviderCheck(
              checks as Parameters<typeof actual.updateProviderCheck>[0],
              providerId as Parameters<typeof actual.updateProviderCheck>[1],
              patch as Parameters<typeof actual.updateProviderCheck>[2]
            )
          : checks.map((check) =>
              check.providerId === providerId
                ? {
                    ...check,
                    ...patch,
                  }
                : check
            ),
    };
  }
);

vi.mock('@renderer/components/team/dialogs/TeamModelSelector', () => ({
  TeamModelSelector: ({ value }: { value: string }) =>
    React.createElement('div', { 'data-testid': 'team-model-selector' }, `model:${value}`),
  computeEffectiveTeamModel: vi.fn((...args: Parameters<typeof computeEffectiveTeamModel>) =>
    prepareHelperFixture.real ? computeEffectiveTeamModel(...args) : args[0] || undefined
  ),
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

import { sanitizeProviderStatusAuthority } from '@main/services/runtime/providerStatusCheckContract';
import { api } from '@renderer/api';
import { CreateTeamDialog } from '@renderer/components/team/dialogs/CreateTeamDialog';
import { LaunchTeamDialog } from '@renderer/components/team/dialogs/LaunchTeamDialog';
import { runProviderPrepareDiagnostics } from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { computeEffectiveTeamModel as computeModelMock } from '@renderer/components/team/dialogs/TeamModelSelector';
import { computeEffectiveTeamModel } from '@renderer/components/team/dialogs/teamModelSummary';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { reconcileCliProviderSnapshot } from '@renderer/store/slices/cliInstallerStatusReconciliation';
import {
  getTeamModelSelectionError,
  isTeamModelAvailableForUi,
  isTeamProviderModelVerificationPending,
} from '@renderer/utils/teamModelAvailability';
import { isTeamProviderRuntimeStatusLoading } from '@renderer/utils/teamProviderRuntimeStatusLoading';
import { createdTeamSelectionSignature } from '@shared/utils/createdTeamReadiness';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import { ForegroundModelChecks } from '../../../../../src/features/agent-backend/main/application/ForegroundModelChecks';

import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  TeamCreateRequest,
  TeamProviderId,
} from '@shared/types';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushCustomFolderProbe(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
  });
}

async function confirmLaunchPreflight(
  host: HTMLElement,
  label: 'Launch team' | 'Relaunch team' = 'Launch team'
): Promise<HTMLButtonElement> {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  ) as HTMLButtonElement | undefined;
  if (!button) {
    throw new Error(`Expected "${label}" button.`);
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
    });
  }
  return button;
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
  it.each([
    'all-ready',
    'close',
    'staggered',
    'new-draft',
    'unmount-reopen',
    'close-unmount-reopen',
  ] as const)(
    'serializes captured Host checks across effect batches and supersedes only a new draft (%s)',
    async (mode) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('crypto', webcrypto);
      const key = 'host-team:TEST-owner';
      vi.mocked(api.teams.getSavedRequest).mockResolvedValue({
        teamName: key,
        savedSettingsFingerprint: 'b'.repeat(64),
        cwd: '/tmp/project',
        providerId: 'anthropic',
        model: 'opus',
        syncModelsWithLead: false,
        members: [
          { name: 'bob', providerId: 'codex', model: 'gpt-5.4' },
          {
            name: 'carol',
            providerId: 'opencode',
            model: 'opencode/big-pickle',
          },
        ],
      });
      if (mode === 'staggered') {
        // Keep the independent account lookup settled; stagger only provider-loading observations.
        vi.mocked(api.getCodexAccountSnapshot).mockResolvedValueOnce({
          preferredAuthMode: 'api_key',
          effectiveAuthMode: 'api_key',
          launchAllowed: true,
          launchIssueMessage: null,
          launchReadinessState: 'ready_api_key',
          appServerState: 'healthy',
          appServerStatusMessage: null,
          managedAccount: null,
          apiKey: {
            available: true,
            source: 'environment',
            sourceLabel: 'TEST account fixture',
          },
          requiresOpenaiAuth: false,
          login: { status: 'idle', error: null, startedAt: null },
          rateLimits: null,
          updatedAt: new Date().toISOString(),
        });
        vi.mocked(isTeamProviderRuntimeStatusLoading).mockImplementation(
          (_provider, _status, loading) => loading === true
        );
        storeState.cliProviderStatusLoading = { codex: true, opencode: true };
      }
      // Main includes preparationId, so a fresh dialog has a distinct check identity.
      let dialogLifetime = 0;
      const foreground = new ForegroundModelChecks();
      const pending: (() => void)[] = [],
        effects: string[] = [];
      vi.mocked(runProviderPrepareDiagnostics).mockImplementation(async (input) => {
        const result = await foreground.run(
          JSON.stringify([
            dialogLifetime,
            key,
            input.providerId,
            input.selectedModelIds,
            input.selectedModelChecks,
          ]),
          async (current) => {
            effects.push('start:' + input.providerId);
            await new Promise<void>((resolve) => pending.push(resolve));
            const ready = current();
            effects.push((ready ? 'finish:' : 'superseded:') + input.providerId);
            return { ready, message: 'TEST exact member check' };
          }
        );
        return {
          status: result.ready ? 'ready' : 'failed',
          warnings: [],
          details: [result.message ?? ''],
          modelResultsById: {},
        };
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const render = (open = true) =>
        root.render(
          React.createElement(LaunchTeamDialog, {
            mode: 'launch',
            open,
            teamName: key,
            members: [],
            defaultProjectPath: '/tmp/project',
            provisioningError: null,
            clearProvisioningError: vi.fn(),
            activeTeams: [],
            onClose: () => {
              root.render(null);
            },
            onLaunch: vi.fn(async () => {}),
          })
        );
      const settle = async () => {
        for (let i = 0; i < 4; i++)
          await act(async () => {
            await flush();
          });
      };
      const finish = async () => {
        expect(pending).toHaveLength(1);
        await act(async () => {
          pending.shift()!();
          await flush();
        });
        await settle();
      };
      try {
        await act(async () => {
          render();
          await flush();
        });
        await settle();
        expect(vi.mocked(runProviderPrepareDiagnostics).mock.calls).toHaveLength(1);
        expect(effects).toEqual(['start:anthropic']);
        if (mode === 'staggered') {
          for (const loading of [{ opencode: true }, {}]) {
            await act(async () => {
              storeState.cliProviderStatusLoading = loading;
              render();
              await flush();
            });
            await settle();
            expect(vi.mocked(runProviderPrepareDiagnostics).mock.calls).toHaveLength(1);
            expect(effects).toEqual(['start:anthropic']);
          }
        }
        if (mode === 'close')
          await act(async () => {
            render(false);
            await flush();
          });
        if (mode === 'unmount-reopen' || mode === 'close-unmount-reopen') {
          await act(async () => {
            if (mode === 'close-unmount-reopen')
              host.querySelector<HTMLButtonElement>('[data-testid="dismiss-dialog"]')!.click();
            else root.render(null);
            await flush();
          });
          dialogLifetime += 1;
          await act(async () => {
            render();
            await flush();
          });
          await settle();
          expect(vi.mocked(runProviderPrepareDiagnostics).mock.calls).toHaveLength(2);
          expect(effects).toEqual(['start:anthropic']);
          await finish();
          expect(effects).toEqual(['start:anthropic', 'superseded:anthropic', 'start:anthropic']);
        }
        if (mode === 'new-draft') {
          await act(async () => {
            teamRosterEditorSectionMock.lastProps.onModelChange('sonnet');
            await flush();
          });
          await settle();
          expect(vi.mocked(runProviderPrepareDiagnostics).mock.calls).toHaveLength(2);
          expect(effects).toEqual(['start:anthropic']); // New admission awaits original Main cleanup.
          await finish();
          expect(effects).toEqual(['start:anthropic', 'superseded:anthropic', 'start:anthropic']);
          expect(
            vi.mocked(runProviderPrepareDiagnostics).mock.calls.at(-1)![0].selectedModelIds
          ).toContain('sonnet');
        }
        for (const provider of mode === 'close'
          ? ['anthropic']
          : ['anthropic', 'codex', 'opencode']) {
          await finish();
          expect(
            effects,
            JSON.stringify({
              effects,
              dispatched: vi
                .mocked(runProviderPrepareDiagnostics)
                .mock.calls.map(([input]) => input.providerId),
            })
          ).toContain('finish:' + provider);
        }
        const current = [
          'start:anthropic',
          'finish:anthropic',
          'start:codex',
          'finish:codex',
          'start:opencode',
          'finish:opencode',
        ];
        expect(effects).toEqual(
          mode === 'close'
            ? current.slice(0, 2)
            : mode === 'new-draft' || mode === 'unmount-reopen' || mode === 'close-unmount-reopen'
              ? ['start:anthropic', 'superseded:anthropic', ...current]
              : current
        );
        expect(vi.mocked(runProviderPrepareDiagnostics).mock.calls).toHaveLength(
          mode === 'close'
            ? 1
            : mode === 'new-draft' || mode === 'unmount-reopen' || mode === 'close-unmount-reopen'
              ? 4
              : 3
        );
        if (mode !== 'close')
          expect(host.textContent).toContain('All selected providers are ready.');
      } finally {
        await act(async () => {
          root.unmount();
          await flush();
        });
        for (let i = 0; i < 4; i++)
          await act(async () => {
            for (const done of pending.splice(0)) done();
            await flush();
          });
        host.remove();
      }
    }
  );
  it.each(['unknown', 'edited', 'ready'] as const)(
    'uses explicit Resume in the existing dialog without fresh fallback (%s)',
    async (outcome) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('crypto', webcrypto);
      const key = 'host-team:TEST-resume-dialog';
      const reference = `cp1-${'c'.repeat(64)}`;
      const saved: TeamCreateRequest = {
        teamName: key,
        savedSettingsFingerprint: 'a'.repeat(64),
        cwd: '/tmp/project',
        providerId: 'anthropic',
        providerBackendId: 'cli-sdk',
        model: 'sonnet',
        fastMode: 'off',
        skipPermissions: false,
        members: [],
      };
      const launch = {
        launchId: 'TEST-original-launch',
        rosterRevision: 'TEST-original-roster',
        status: 'failed',
        ready: 0,
        expected: 1,
        retryCapability: 'same-binding-no-allocation-only',
        members: [
          {
            memberId: 'TEST-lead',
            generation: 'TEST-source-generation',
            attemptId: 'TEST-attempt',
            status: 'failed',
            nativeReady: false,
            usable: false,
            controlAvailable: false,
            noAllocation: false,
            reason: 'TEST stopped',
          },
        ],
      };
      const ledger: any = {
        launchId: launch.launchId,
        rosterRevision: launch.rosterRevision,
        preparations: [],
        restorations: [],
      };
      vi.mocked(api.teams.getSavedRequest).mockResolvedValue(saved);
      vi.mocked(api.agentBackend.getConnections).mockResolvedValue({
        state: 'ready',
        bindings: [
          {
            handle: { handleId: 'TEST-resume-dialog' },
            label: 'TEST Resume',
            members: [{ memberId: 'TEST-lead', label: 'TEST lead' }],
          },
        ],
      });
      vi.mocked(api.agentBackend.invoke).mockImplementation(async (request): Promise<any> => {
        if (request.operation === 'team.launch.configuration.read')
          return {
            ok: true,
            value: {
              launch: structuredClone(launch),
              members: [
                { memberId: 'TEST-lead', label: 'TEST lead', role: 'lead', selected: null },
              ],
            },
          };
        if (request.operation === 'team.launch.read')
          return { ok: true, value: structuredClone(launch) };
        if (request.operation === 'runtime.checkpoints.read')
          return {
            ok: true,
            value: {
              memberId: 'TEST-lead',
              sourceGeneration: 'TEST-source-generation',
              status: 'owner-eligible',
              reason: 'native-backing-unverified',
              nativeBacking: 'unverified',
              checkpoints: [
                {
                  checkpointId: 'TEST-checkpoint',
                  reference,
                  status: 'owner-eligible',
                  reason: 'native-backing-unverified',
                },
              ],
            },
          };
        if (request.operation === 'team.launch.restorations.read')
          return { ok: true, value: structuredClone(ledger) };
        if (request.operation === 'team.launch.resume.prepare') {
          const prepared = {
            resumeId: request.payload.resumeId,
            rosterRevision: request.payload.rosterRevision,
            members: request.payload.members.map((member) => ({ ...member, requested: false })),
          };
          ledger.preparations.push(prepared);
          return { ok: true, value: structuredClone(prepared) };
        }
        if (request.operation === 'runtime.restore') {
          ledger.preparations[0].members[0].requested = true;
          if (outcome !== 'ready')
            throw new Error('TEST original restore ACK unknown before selection');
          launch.rosterRevision = 'TEST-live-restored-roster';
          ledger.rosterRevision = launch.rosterRevision;
          Object.assign(launch.members[0], {
            generation: 'TEST-restored-generation',
            status: 'ready',
            nativeReady: true,
            usable: true,
          });
          ledger.restorations.push({
            ...ledger.preparations[0].members[0],
            selectedGeneration: 'TEST-restored-generation',
            current: true,
            phase: 'allocated',
            custody: 'owned',
            attached: true,
          });
          return {
            ok: true,
            value: {
              memberId: 'TEST-lead',
              generation: 'TEST-restored-generation',
              phase: 'allocated',
              sealed: false,
              custody: 'owned',
              nativeReady: true,
              attached: true,
              inputs: [],
              interactions: [],
            },
          };
        }
        throw new Error(`Unexpected TEST operation ${request.operation}`);
      });
      const onLaunch = vi.fn(async () => {});
      const onClose = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const render = (open = true) =>
        root.render(
          React.createElement(LaunchTeamDialog, {
            mode: 'launch',
            open,
            teamName: key,
            members: [],
            defaultProjectPath: '/tmp/project',
            provisioningError: null,
            onClose,
            onLaunch,
          })
        );
      const settle = async () => {
        for (let i = 0; i < 5; i++)
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await flush();
          });
      };
      const choose = async (id: string, value: string) =>
        act(async () => {
          const select = host.querySelector<HTMLSelectElement>(`#${id}`)!;
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          await flush();
        });
      const button = (label: string) =>
        Array.from(host.querySelectorAll('button')).find((row) => row.textContent === label)!;
      try {
        await act(async () => {
          render();
          await flush();
        });
        await settle();
        expect(host.querySelector<HTMLSelectElement>('#launch-continuation-mode')?.value).toBe(
          'fresh'
        );
        await choose('launch-continuation-mode', 'resume');
        await settle();
        expect(button('Resume selected checkpoints').disabled).toBe(true);
        expect(host.textContent).toContain('Saved history is checked when resuming');
        await choose('resume-checkpoint-TEST-lead', reference);
        await settle();
        expect(button('Resume selected checkpoints').disabled).toBe(false);
        if (outcome === 'edited') {
          await act(async () => {
            teamRosterEditorSectionMock.lastProps.onProviderChange('codex');
            await flush();
          });
          expect(button('Resume selected checkpoints').disabled).toBe(true);
          expect(host.textContent).toContain('Settings changed. Use Fresh Launch');
        } else {
          await act(async () => {
            button('Resume selected checkpoints').click();
            await flush();
          });
          await settle();
          if (outcome === 'ready') {
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(openTeamTab).toHaveBeenCalledWith(key, '/tmp/project');
            expect(ledger.preparations[0].rosterRevision).toBe('TEST-original-roster');
          } else {
            expect(button('Check Resume status').disabled).toBe(false);
            expect(api.agentBackend.invoke).toHaveBeenCalledWith(
              expect.objectContaining({
                operation: 'runtime.restore',
                payload: expect.objectContaining({
                  resumeId: ledger.preparations[0].resumeId,
                  reference,
                  expectedGeneration: 'TEST-source-generation',
                }),
              })
            );
            const freshChecks = vi.mocked(runProviderPrepareDiagnostics).mock.calls.length;
            await act(async () => {
              render(false);
              await flush();
            });
            await act(async () => {
              render();
              await flush();
            });
            await settle();
            expect(host.querySelector<HTMLSelectElement>('#launch-continuation-mode')?.value).toBe(
              'resume'
            );
            await act(async () => {
              button('Check Resume status').click();
              await flush();
            });
            await settle();
            expect(vi.mocked(runProviderPrepareDiagnostics).mock.calls).toHaveLength(freshChecks);
            expect(
              vi
                .mocked(api.agentBackend.invoke)
                .mock.calls.filter(([request]) => request.operation === 'runtime.restore')
            ).toHaveLength(1);
          }
        }
        expect(api.teams.replaceMembers).not.toHaveBeenCalled();
        expect(onLaunch).not.toHaveBeenCalled();
        if (outcome !== 'ready') expect(onClose).not.toHaveBeenCalled();
        expect(
          vi
            .mocked(api.agentBackend.invoke)
            .mock.calls.some(
              ([request]) =>
                request.operation === 'team.launch.capture' ||
                request.operation === 'team.launch.start'
            )
        ).toBe(false);
      } finally {
        await act(async () => root.unmount());
        vi.mocked(api.teams.getSavedRequest).mockResolvedValue(null);
      }
    }
  );

  it('retains Host relaunch continuation and the original run across a changed progress render', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const key = 'host-team:TEST-relaunch';
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: key,
      savedSettingsFingerprint: 'b'.repeat(64),
      cwd: '/tmp/project',
      providerId: 'anthropic',
      model: 'sonnet',
      fastMode: 'off',
      skipPermissions: false,
      members: [],
    });
    const onRelaunch = vi
      .fn()
      .mockRejectedValueOnce(new Error('TEST launch ACK lost'))
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (runtimeRunId: string) =>
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'relaunch',
          open: true,
          teamName: key,
          runtimeRunId,
          members: [
            {
              name: 'alice',
              agentType: 'team-lead',
              providerId: 'anthropic',
              model: 'sonnet',
              configuredSettingsFingerprint: (runtimeRunId === 'TEST-original-run'
                ? 'a'
                : 'c'
              ).repeat(64),
            },
          ] as any,
          memberSettingsDraft: {
            teamName: key,
            memberName: 'alice',
            targetKind: 'lead',
            expectedFingerprint: 'a'.repeat(64),
            expectedTeamSettingsFingerprint: 'b'.repeat(64),
            settings: {
              role: null,
              workflow: null,
              isolation: null,
              providerId: 'anthropic',
              providerBackendId: null,
              model: 'sonnet',
              effort: null,
              fastMode: null,
              mcpPolicy: null,
            },
          },
          defaultProjectPath: '/tmp/project',
          provisioningError: null,
          activeTeams: [],
          onClose,
          onRelaunch,
        })
      );
    try {
      await act(async () => {
        render('TEST-original-run');
        await flush();
        await flush();
      });
      await flushCustomFolderProbe();
      const button = await confirmLaunchPreflight(host, 'Relaunch team');
      expect(button.disabled).toBe(false);
      await act(async () => {
        button.click();
        await flush();
        await flush();
      });
      expect(onRelaunch).toHaveBeenCalledTimes(1);
      const metadata = onRelaunch.mock.calls[0][3];
      expect(metadata.relaunch).toMatchObject({
        originalRunId: 'TEST-original-run',
        stopConfirmed: false,
      });
      // The existing relaunch use case confirms these steps before an uncertain launch ACK.
      metadata.relaunch.stopConfirmed = true;
      metadata.relaunch.replaceAttempted = true;
      metadata.relaunch.replaceConfirmed = true;
      await act(async () => {
        render('TEST-replacement-run');
        await flush();
      });
      const retry = await confirmLaunchPreflight(host, 'Relaunch team');
      await act(async () => {
        retry.click();
        await flush();
        await flush();
      });
      expect(onRelaunch).toHaveBeenCalledTimes(2);
      expect(onRelaunch.mock.calls[1][3].relaunch).toBe(metadata.relaunch);
      expect(onRelaunch.mock.calls[1][0]).toEqual(onRelaunch.mock.calls[0][0]);
      expect(onRelaunch.mock.calls[1][2]).toEqual(onRelaunch.mock.calls[0][2]);
      expect(onRelaunch.mock.calls[1][2].baseline).toEqual([
        { memberName: 'alice', expectedFingerprint: 'a'.repeat(64) },
      ]);
      expect(metadata.relaunch.originalRunId).toBe('TEST-original-run');
      expect(api.teams.replaceMembers).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([false, true])(
    'submits the original Host configuration and retains its intent after uncertainty (edit=%s)',
    async (edited) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const key = 'host-team:TEST-submit';
      vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
        teamName: key,
        savedSettingsFingerprint: 'b'.repeat(64),
        cwd: '/tmp/project',
        providerId: 'anthropic',
        model: 'sonnet',
        fastMode: 'off',
        skipPermissions: false,
        syncModelsWithLead: false,
        limitContext: false,
        displayName: 'TEST configured name',
        description: 'TEST configured description',
        members: [],
      });
      vi.mocked(api.teams.replaceMembers).mockRejectedValueOnce(new Error('TEST unknown save'));
      const onLaunch = vi.fn(async () => {});
      const onClose = vi.fn();
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(
            React.createElement(LaunchTeamDialog, {
              mode: 'launch',
              open: true,
              teamName: key,
              members: [],
              defaultProjectPath: '/tmp/project',
              provisioningError: null,
              clearProvisioningError: vi.fn(),
              activeTeams: [],
              onClose,
              onLaunch,
            })
          );
          await flush();
          await flush();
        });
        await flushCustomFolderProbe();
        let button = await confirmLaunchPreflight(host);
        expect(button.disabled).toBe(false);
        await act(async () => {
          button.click();
          await flush();
          await flush();
        });
        expect(api.teams.replaceMembers).toHaveBeenCalledTimes(1);
        const original = structuredClone(vi.mocked(api.teams.replaceMembers).mock.calls[0][1]);
        expect(original).toMatchObject({
          command: {
            commandId: expect.stringMatching(/^roster:/),
            idempotencyKey: expect.any(String),
          },
          configuration: {
            expectedRevision: 'b'.repeat(64),
            savedSettings: {
              cwd: '/tmp/project',
              model: 'sonnet',
              fastMode: 'off',
              skipPermissions: false,
              syncModelsWithLead: false,
              limitContext: false,
              allowExperimentalLocalModels: false,
              displayName: 'TEST configured name',
              description: 'TEST configured description',
            },
          },
          members: [],
        });
        expect(original.command!.idempotencyKey).toBe(original.command!.commandId);
        expect(onLaunch).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(host.textContent).toContain('TEST unknown save');
        // The original settings dialog refreshes model preflight; it must not replace the intent.
        await act(async () => {
          runtimeSettingsMock.lastProps.onProviderRuntimeChanged('anthropic');
          if (edited) advancedCliMock.lastProps.onCustomArgsChange('--TEST-changed');
          await flush();
        });
        button = await confirmLaunchPreflight(host);
        expect(button.disabled).toBe(false);
        await act(async () => {
          button.click();
          await flush();
          await flush();
        });
        if (edited) {
          expect(api.teams.replaceMembers).toHaveBeenCalledTimes(1);
          expect(onLaunch).not.toHaveBeenCalled();
          expect(host.textContent).toContain('previous launch intent changed');
        } else {
          expect(api.teams.replaceMembers).toHaveBeenCalledTimes(2);
          expect(vi.mocked(api.teams.replaceMembers).mock.calls[1]).toEqual([key, original]);
          expect(onLaunch).toHaveBeenCalledTimes(1);
          expect(onClose).toHaveBeenCalledTimes(1);
        }
      } finally {
        await act(async () => root.unmount());
      }
    }
  );

  it('holds Host prompt editing until saved settings load and preserves untouched model options through the original launch CAS', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSaved!: (value: TeamCreateRequest) => void;
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSaved = resolve;
      })
    );
    const key = 'host-team:TEST-hydration-race';
    const provider = createAuthoritativeProviderStatus('anthropic', ['claude-sonnet-4-6']);
    provider.modelCatalog!.models[0].supportedReasoningEfforts = ['low', 'medium', 'high'];
    provider.modelCatalog!.models[0].defaultReasoningEffort = 'medium';
    storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [provider] };
    vi.mocked(api.agentBackend.getConnections).mockResolvedValue({
      state: 'ready',
      bindings: [
        { handle: { handleId: 'TEST-hydration-race' }, label: 'TEST saved owner', members: [] },
      ],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host),
      onLaunch = vi.fn(async () => {});
    try {
      await act(async () => {
        root.render(
          React.createElement(LaunchTeamDialog, {
            mode: 'launch',
            open: true,
            teamName: key,
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
      const prompt = host.querySelector<HTMLTextAreaElement>('#dialog-prompt')!;
      expect(prompt.closest('fieldset')?.disabled).toBe(true);
      expect(runProviderPrepareDiagnostics).not.toHaveBeenCalled();
      await act(async () => {
        resolveSaved({
          teamName: key,
          savedSettingsFingerprint: 'b'.repeat(64),
          cwd: '/tmp/project',
          providerId: 'anthropic',
          model: 'claude-sonnet-4-6',
          effort: 'low',
          fastMode: 'off',
          limitContext: true,
          skipPermissions: true,
          members: [],
          prompt: '',
        });
        await flush();
        await flush();
      });
      await flushCustomFolderProbe();
      expect(prompt.closest('fieldset')?.disabled).toBe(false);
      expect(teamRosterEditorSectionMock.lastProps).toMatchObject({
        model: 'claude-sonnet-4-6',
        effort: 'low',
        limitContext: true,
      });
      expect(host.querySelector('[data-testid="fast-mode-selector"]')?.textContent).toContain(
        'fast:off'
      );
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          prompt,
          'TEST bootstrap only'
        );
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
      });
      const submit = await confirmLaunchPreflight(host);
      expect(submit.disabled).toBe(false);
      await act(async () => {
        submit.click();
        await flush();
        await flush();
      });
      expect(api.teams.replaceMembers).toHaveBeenCalledWith(
        key,
        expect.objectContaining({
          configuration: expect.objectContaining({
            expectedRevision: 'b'.repeat(64),
            savedSettings: expect.objectContaining({
              model: 'claude-sonnet-4-6',
              effort: 'low',
              fastMode: 'off',
              limitContext: true,
              prompt: 'TEST bootstrap only',
            }),
          }),
        })
      );
      expect(onLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          effort: 'low',
          fastMode: 'off',
          limitContext: true,
          prompt: 'TEST bootstrap only',
        })
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(['failed', 'timeout', 'malformed', 'absent'] as const)(
    'keeps an uncertain Host saved read held and distinguishes proven absence (%s)',
    async (mode) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.useFakeTimers();
      const read = vi.mocked(api.teams.getSavedRequest);
      if (mode === 'failed')
        read.mockRejectedValueOnce(new Error('TEST-private backend unavailable'));
      else if (mode === 'timeout') read.mockReturnValueOnce(new Promise(() => {}));
      else if (mode === 'malformed')
        read.mockResolvedValueOnce({
          teamName: 'host-team:TEST-owner',
          cwd: '/tmp/project',
          members: [],
        });
      else read.mockResolvedValueOnce(null);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host),
        onLaunch = vi.fn(async () => {});
      try {
        await act(async () => {
          root.render(
            React.createElement(LaunchTeamDialog, {
              mode: 'launch',
              open: true,
              teamName: 'host-team:TEST-owner',
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
        if (mode === 'timeout')
          await act(async () => {
            await vi.advanceTimersByTimeAsync(30_001);
            await flush();
          });
        const prompt = host.querySelector<HTMLTextAreaElement>('#dialog-prompt')!;
        expect(prompt.closest('fieldset')?.disabled).toBe(mode !== 'absent');
        if (mode !== 'absent') {
          expect(host.textContent).toContain('Saved Team configuration unavailable');
          expect(host.textContent).not.toContain('TEST-private');
          const submit = [...host.querySelectorAll('button')].find(
            (button) => button.textContent === 'Launch team'
          )!;
          expect(submit.disabled).toBe(true);
          expect(runProviderPrepareDiagnostics).not.toHaveBeenCalled();
        }
        expect(onLaunch).not.toHaveBeenCalled();
        expect(api.teams.replaceMembers).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    }
  );

  it.each(['reopen', 'context-aba'] as const)(
    'ignores obsolete Host saved replies across %s before enabling the existing form',
    async (transition) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const pending: ((value: TeamCreateRequest) => void)[] = [];
      vi.mocked(api.teams.getSavedRequest).mockImplementation(
        () => new Promise((resolve) => pending.push(resolve))
      );
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host),
        key = 'host-team:TEST-owner';
      const render = (open = true) =>
        root.render(
          React.createElement(LaunchTeamDialog, {
            mode: 'launch',
            open,
            teamName: key,
            members: [],
            defaultProjectPath: '/tmp/project',
            provisioningError: null,
            clearProvisioningError: vi.fn(),
            activeTeams: [],
            onClose: vi.fn(),
            onLaunch: vi.fn(async () => {}),
          })
        );
      const source = (prompt: string): TeamCreateRequest => ({
        teamName: key,
        cwd: '/tmp/project',
        savedSettingsFingerprint: 'b'.repeat(64),
        providerId: 'anthropic',
        model: 'sonnet',
        members: [],
        prompt,
      });
      try {
        await act(async () => {
          render();
          await flush();
        });
        if (transition === 'reopen') {
          await act(async () => {
            render(false);
            await flush();
          });
          await act(async () => {
            render();
            await flush();
          });
        } else {
          await act(async () => {
            storeState.activeContextId = 'TEST-other';
            invalidateContextScopedRequestEpoch();
            render();
            await flush();
          });
          await act(async () => {
            storeState.activeContextId = 'TEST-local';
            invalidateContextScopedRequestEpoch();
            render();
            await flush();
          });
        }
        expect(pending.length).toBeGreaterThan(1);
        await act(async () => {
          for (const resolve of pending.slice(0, -1)) resolve(source('TEST stale source'));
          await flush();
          await flush();
        });
        const prompt = host.querySelector<HTMLTextAreaElement>('#dialog-prompt')!;
        expect(prompt.closest('fieldset')?.disabled).toBe(true);
        expect(prompt.value).not.toBe('TEST stale source');
        await act(async () => {
          pending.at(-1)!(source('TEST current source'));
          await flush();
          await flush();
        });
        expect(prompt.closest('fieldset')?.disabled).toBe(false);
        expect(prompt.value).toBe('TEST current source');
        expect(api.teams.replaceMembers).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    }
  );

  it.each([false, true])(
    'hydrates owner launch fields without overwriting user edits (%s)',
    async (edited) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      let resolveSaved: (value: any) => void = () => {};
      vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSaved = resolve;
        })
      );
      const key = 'host-team:TEST-owner';
      localStorage.setItem(`team:lastCustomArgs:${key}`, 'WRONG-local-args');
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(
            React.createElement(LaunchTeamDialog, {
              mode: 'launch',
              open: true,
              teamName: key,
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
          resolveSaved({
            teamName: key,
            savedSettingsFingerprint: 'b'.repeat(64),
            cwd: '/tmp/TEST-owner',
            prompt: 'Owner prompt',
            worktree: 'TEST-owner-worktree',
            extraCliArgs: '--owner-args',
            allowExperimentalLocalModels: true,
            providerId: 'anthropic',
            members: [],
          });
          await flush();
          await flush();
        });
        if (edited)
          await act(async () => {
            advancedCliMock.lastProps.onCustomArgsChange('--user-args');
            await flush();
          });
        expect(advancedCliMock.lastProps.customArgs).toBe(edited ? '--user-args' : '--owner-args');
        if (!edited) {
          expect(advancedCliMock.lastProps.worktreeEnabled).toBe(true);
          expect(advancedCliMock.lastProps.worktreeName).toBe('TEST-owner-worktree');
          expect(projectPathSelectorMock.lastProps).toMatchObject({
            cwdMode: 'custom',
            customCwd: '/tmp/TEST-owner',
          });
          expect((host.querySelector('#dialog-prompt') as HTMLTextAreaElement).value).toBe(
            'Owner prompt'
          );
          await act(async () => {
            draftLoadMock.complete('WRONG-late-draft');
            await flush();
          });
          expect((host.querySelector('#dialog-prompt') as HTMLTextAreaElement).value).toBe(
            'Owner prompt'
          );
        }
      } finally {
        await act(async () => root.unmount());
      }
    }
  );

  it.each([
    'initial-loading',
    'pending',
    'failed',
    'unknown',
    'confirmed',
    'explicit',
    'legacy',
    'dropped-cwd',
    'unready',
    'unresolved',
  ] as const)(
    'saves config-only Anthropic Default safely with %s project evidence',
    async (phase) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.mocked(computeModelMock).mockImplementation(computeEffectiveTeamModel);
      const selected = phase === 'explicit' ? 'gateway/explicit' : '';
      const projectPath = createTeamDraftMock.state.selectedProjectPath;
      createTeamDraftMock.state.launchTeam = false;
      createTeamDraftMock.state.soloTeam = true;
      createTeamDraftMock.state.runtimeSelectionVersion = 1;
      createTeamDraftMock.state.runtimeProviderId =
        phase === 'unresolved' ? undefined : 'anthropic';
      createTeamDraftMock.state.runtimeModel = phase === 'unresolved' ? undefined : selected;
      localStorage.setItem('team:lastSelectedProvider', 'anthropic');
      localStorage.setItem('team:lastSelectedModel:anthropic', '');
      const global = createAuthoritativeProviderStatus('anthropic', [
        'catalog-fallback',
        'gateway/explicit',
        'gateway/project-default',
      ]);
      if (phase !== 'legacy')
        global.effectiveDefaultModel = phase === 'unknown' ? null : 'global/wrong';
      storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [global] };
      if (phase === 'initial-loading') {
        storeState.cliStatus = null as any;
        storeState.cliStatusLoading = true;
      }
      fetchCliProviderStatus.mockImplementation(async () => false);
      if (phase !== 'initial-loading' && phase !== 'pending' && phase !== 'unknown') {
        storeState.cliProviderStatusByScope[
          getCliProviderStatusScopeKey('anthropic', projectPath)
        ] = {
          ...global,
          effectiveDefaultModel: phase === 'legacy' ? undefined : 'gateway/project-default',
          statusCheckOutcome: phase === 'failed' ? 'transient_error' : 'authoritative',
        };
      }
      if (phase === 'dropped-cwd') {
        createTeamDraftMock.state.cwdMode = 'custom';
        createTeamDraftMock.state.customCwd = projectPath;
        vi.mocked(api.projectFolder!.getState).mockResolvedValue({ state: 'not_directory' } as any);
      }
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const onCreate = vi.fn(async () => {});
      try {
        await act(async () => {
          root.render(
            React.createElement(CreateTeamDialog, {
              open: true,
              canCreate: true,
              provisioningErrorsByTeam: {},
              existingTeamNames: [],
              activeTeams: [],
              defaultProjectPath: phase === 'unready' ? `${projectPath}-next` : projectPath,
              forceDefaultProjectSelection: phase === 'unready',
              onClose: vi.fn(),
              onCreate,
              onOpenTeam: vi.fn(),
            })
          );
          await flush();
        });
        await flushCustomFolderProbe();
        expect(teamRosterEditorSectionMock.lastProps.model).toBe(selected);
        const submit = Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Create'
        )!;
        expect(submit.disabled, host.textContent ?? '').toBe(false);
        await act(async () => {
          submit.click();
          await flush();
        });
        expect(api.teams.createConfig).toHaveBeenCalledTimes(1);
        const request = vi.mocked(api.teams.createConfig).mock.calls[0]?.[0];
        expect(request?.model).toBe(
          phase === 'confirmed'
            ? 'gateway/project-default'
            : phase === 'explicit'
              ? selected
              : phase === 'legacy'
                ? 'catalog-fallback'
                : undefined
        );
        expect(request?.cwd).toBe(phase === 'dropped-cwd' ? undefined : projectPath);
        expect(createTeamDraftMock.state.runtimeModel).toBe(
          phase === 'unresolved' ? undefined : selected
        );
        expect(onCreate).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        vi.mocked(api.projectFolder!.getState).mockResolvedValue({ state: 'exists' } as any);
      }
    }
  );

  it('does not persist a late project A default while saving config-only project B', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(computeModelMock).mockImplementation(computeEffectiveTeamModel);
    const projectA = createTeamDraftMock.state.selectedProjectPath;
    const projectB = `${projectA}-next`;
    createTeamDraftMock.state.launchTeam = false;
    createTeamDraftMock.state.soloTeam = true;
    createTeamDraftMock.state.runtimeSelectionVersion = 1;
    createTeamDraftMock.state.runtimeProviderId = 'anthropic';
    createTeamDraftMock.state.runtimeModel = '';
    const global = createAuthoritativeProviderStatus('anthropic', ['catalog-fallback']);
    global.effectiveDefaultModel = 'global/wrong';
    storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [global] };
    let finishProjectA: (() => void) | undefined;
    fetchCliProviderStatus.mockImplementation(async (_providerId, options) => {
      if (options?.projectPath !== projectA) return false;
      return new Promise<boolean>((resolve) => {
        finishProjectA = () => {
          storeState.cliProviderStatusByScope[getCliProviderStatusScopeKey('anthropic', projectA)] =
            {
              ...global,
              effectiveDefaultModel: 'gateway/project-a',
            };
          resolve(true);
        };
      });
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () =>
      root.render(
        React.createElement(CreateTeamDialog, {
          open: true,
          canCreate: true,
          provisioningErrorsByTeam: {},
          existingTeamNames: [],
          activeTeams: [],
          defaultProjectPath: projectA,
          onClose: vi.fn(),
          onCreate: vi.fn(),
          onOpenTeam: vi.fn(),
        })
      );
    try {
      await act(async () => {
        render();
        await flush();
      });
      await flushCustomFolderProbe();
      expect(finishProjectA).toBeDefined();
      createTeamDraftMock.state.cwdMode = 'custom';
      createTeamDraftMock.state.customCwd = projectB;
      await act(async () => {
        render();
        await flush();
      });
      await flushCustomFolderProbe();
      expect(fetchCliProviderStatus).toHaveBeenCalledWith(
        'anthropic',
        expect.objectContaining({ projectPath: projectB })
      );
      await act(async () => {
        finishProjectA?.();
        await flush();
        render();
        await flush();
      });
      const submit = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Create'
      )!;
      expect(submit.disabled, host.textContent ?? '').toBe(false);
      await act(async () => {
        submit.click();
        await flush();
      });
      const request = vi.mocked(api.teams.createConfig).mock.calls[0]?.[0];
      expect(request?.cwd).toBe(projectB);
      expect(request?.model).toBeUndefined();
      expect(createTeamDraftMock.state.runtimeModel).toBe('');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(['initial-loading', 'pending', 'failed', 'confirmed', 'explicit', 'legacy'] as const)(
    'saves an Anthropic schedule safely with %s project evidence',
    async (phase) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.mocked(computeModelMock).mockImplementation(computeEffectiveTeamModel);
      const projectPath = createTeamDraftMock.state.selectedProjectPath;
      const global = createAuthoritativeProviderStatus('anthropic', [
        'catalog-fallback',
        'gateway/explicit',
        'gateway/project-default',
      ]);
      if (phase !== 'legacy') global.effectiveDefaultModel = 'global/wrong';
      storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [global] };
      if (phase === 'initial-loading') {
        storeState.cliStatus = null as any;
        storeState.cliStatusLoading = true;
      }
      fetchCliProviderStatus.mockImplementation(async () => false);
      if (phase !== 'initial-loading' && phase !== 'pending') {
        storeState.cliProviderStatusByScope[
          getCliProviderStatusScopeKey('anthropic', projectPath)
        ] = {
          ...global,
          effectiveDefaultModel: phase === 'legacy' ? undefined : 'gateway/project-default',
          statusCheckOutcome: phase === 'failed' ? 'transient_error' : 'authoritative',
        };
      }
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(
            React.createElement(LaunchTeamDialog, {
              mode: 'schedule',
              open: true,
              teamName: 'team-alpha',
              onClose: vi.fn(),
              schedule: {
                id: 'default-model-schedule',
                teamName: 'team-alpha',
                label: 'Fixture',
                cronExpression: '0 9 * * 1-5',
                timezone: 'UTC',
                status: 'active',
                warmUpMinutes: 15,
                maxConsecutiveFailures: 3,
                consecutiveFailures: 0,
                maxTurns: 50,
                createdAt: '2026-10-20T00:00:00.000Z',
                updatedAt: '2026-10-20T00:00:00.000Z',
                launchConfig: {
                  cwd: projectPath,
                  prompt: 'Fixture schedule',
                  providerId: 'anthropic',
                  model: phase === 'explicit' ? 'gateway/explicit' : undefined,
                },
              } as any,
            })
          );
          await flush();
        });
        await flushCustomFolderProbe();
        const submit = Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Save Changes'
        )!;
        expect(submit.disabled, host.textContent ?? '').toBe(false);
        await act(async () => {
          submit.click();
          await flush();
        });
        expect(updateSchedule).toHaveBeenCalledTimes(1);
        const config = updateSchedule.mock.calls[0]?.[1]?.launchConfig;
        expect(config.model).toBe(
          phase === 'confirmed'
            ? 'gateway/project-default'
            : phase === 'explicit'
              ? 'gateway/explicit'
              : phase === 'legacy'
                ? 'catalog-fallback'
                : undefined
        );
        if (phase !== 'legacy' && phase !== 'initial-loading')
          expect(fetchCliProviderStatus).toHaveBeenCalledWith(
            'anthropic',
            expect.objectContaining({ projectPath })
          );
      } finally {
        await act(async () => root.unmount());
      }
    }
  );

  it.each(['create', 'launch'] as const)(
    'sends the confirmed Anthropic gateway default in the %s request while the draft stays Default',
    async (mode) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.mocked(computeModelMock).mockImplementation(computeEffectiveTeamModel);
      localStorage.setItem('team:lastSelectedProvider', 'anthropic');
      localStorage.setItem('team:lastSelectedModel:anthropic', '');
      createTeamDraftMock.state.runtimeSelectionVersion = 1;
      createTeamDraftMock.state.runtimeProviderId = 'anthropic';
      createTeamDraftMock.state.runtimeModel = '';
      createTeamDraftMock.state.soloTeam = true;
      const provider = createAuthoritativeProviderStatus('anthropic', ['catalog-fallback']);
      provider.effectiveDefaultModel = 'global/wrong-default';
      storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [provider] };
      const projectProvider = { ...provider, effectiveDefaultModel: 'gateway/qwen-default' };
      storeState.cliProviderStatusByScope[
        getCliProviderStatusScopeKey('anthropic', '/tmp/project')
      ] = projectProvider;
      fetchCliProviderStatus.mockImplementation(async (_providerId, options) => {
        if (options?.projectPath === '/tmp/project') {
          storeState.cliProviderStatusByScope[
            getCliProviderStatusScopeKey('anthropic', options.projectPath)
          ] = projectProvider;
        }
        return true;
      });
      const submit = vi.fn<(request: unknown) => Promise<void>>(async () => {});
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(
          mode === 'create'
            ? React.createElement(CreateTeamDialog, {
                open: true,
                canCreate: true,
                provisioningErrorsByTeam: {},
                existingTeamNames: [],
                activeTeams: [],
                defaultProjectPath: '/tmp/project',
                onClose: vi.fn(),
                onCreate: submit,
                onOpenTeam: vi.fn(),
              })
            : React.createElement(LaunchTeamDialog, {
                mode: 'launch',
                open: true,
                teamName: 'team-alpha',
                members: [],
                defaultProjectPath: '/tmp/project',
                provisioningError: null,
                clearProvisioningError: vi.fn(),
                activeTeams: [],
                onClose: vi.fn(),
                onLaunch: submit,
              })
        );
        await flush();
      });
      await flushCustomFolderProbe();
      expect(teamRosterEditorSectionMock.lastProps.model).toBe('');
      expect(createTeamDraftMock.state.runtimeModel).toBe('');
      expect(fetchCliProviderStatus).toHaveBeenCalledWith(
        'anthropic',
        expect.objectContaining({
          projectPath: '/tmp/project',
          checkReason: 'launch_preflight',
        })
      );
      const submitButton = Array.from(host.querySelectorAll('button')).find((button) =>
        mode === 'create'
          ? button.textContent?.trim() === 'Create'
          : button.textContent?.trim() === 'Launch team'
      );
      expect(submitButton, host.textContent ?? '').toBeDefined();
      expect(submitButton?.disabled).toBe(false);
      await act(async () => {
        submitButton?.click();
        await flush();
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.[0]).toMatchObject({
        providerId: 'anthropic',
        model: 'gateway/qwen-default',
      });
      expect(createTeamDraftMock.state.runtimeModel).toBe('');
      await act(async () => root.unmount());
    }
  );

  it('opens provider settings from the relaunch roster model picker', async () => {
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
          members: [],
          defaultProjectPath: '/safe-test/project',
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onRelaunch: vi.fn(async () => {}),
        })
      );
      await flush();
    });

    expect(document.querySelector('[data-testid="provider-settings"]')).toBeNull();
    await act(async () => {
      teamRosterEditorSectionMock.lastProps.onOpenProviderSettings('opencode');
      await flush();
    });
    expect(document.querySelector('[data-testid="provider-settings"]')?.textContent).toBe(
      'opencode'
    );

    await act(async () => root.unmount());
  });

  it.each([
    ['create', 'pending-codex'],
    ['launch', 'pending-codex'],
    ['create', 'refreshing-anthropic'],
    ['launch', 'refreshing-anthropic'],
    ['create', 'refreshing-codex'],
    ['launch', 'refreshing-codex'],
  ] as const)(
    'enables %s skip during %s without repeating completed deep checks',
    async (mode, scenario) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const modelAvailability = await vi.importActual<
        typeof import('@renderer/utils/teamModelAvailability')
      >('@renderer/utils/teamModelAvailability');
      const runtimeLoading = await vi.importActual<
        typeof import('@renderer/utils/teamProviderRuntimeStatusLoading')
      >('@renderer/utils/teamProviderRuntimeStatusLoading');
      vi.mocked(isTeamProviderModelVerificationPending).mockImplementation(
        modelAvailability.isTeamProviderModelVerificationPending
      );
      vi.mocked(isTeamProviderRuntimeStatusLoading).mockImplementation(
        runtimeLoading.isTeamProviderRuntimeStatusLoading
      );
      const refreshing = scenario !== 'pending-codex';
      const refreshProviderId = scenario === 'refreshing-anthropic' ? 'anthropic' : 'codex';
      if (scenario === 'refreshing-codex') {
        vi.mocked(api.getCodexAccountSnapshot).mockResolvedValueOnce({
          preferredAuthMode: 'chatgpt',
          effectiveAuthMode: 'chatgpt',
          launchAllowed: true,
          launchIssueMessage: null,
          launchReadinessState: 'ready_chatgpt',
          appServerState: 'healthy',
          appServerStatusMessage: null,
          managedAccount: { type: 'chatgpt', email: null, planType: 'pro' },
          apiKey: { available: false, source: null, sourceLabel: null },
          requiresOpenaiAuth: false,
          login: { status: 'idle', error: null, startedAt: null },
          rateLimits: null,
          updatedAt: new Date().toISOString(),
        });
      }
      localStorage.setItem('team:lastSelectedProvider', refreshProviderId);
      localStorage.setItem('team:lastSelectedModel:codex', 'gpt-5.4');
      localStorage.setItem('team:lastSelectedModel:anthropic', 'opus');
      createTeamDraftMock.state.soloTeam = true;
      const codex = storeState.cliStatus.providers.find(
        (provider) => provider.providerId === 'codex'
      )!;
      if (!refreshing)
        Object.assign(codex, {
          authenticated: false,
          verificationState: 'unknown',
          statusCheckOutcome: 'pending',
          statusCheckErrorCode: 'partial_response',
          modelCatalog: {
            ...codex.modelCatalog,
            source: 'static-fallback',
            status: 'stale',
            diagnostics: {
              appServerState: 'degraded',
              message: 'JSON-RPC request timed out: initialize',
            },
          },
          modelVerificationState: 'idle',
          modelCatalogRefreshState: 'loading',
        });
      const submit = vi.fn(async () => {});
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const renderDialog = () => {
        root.render(
          mode === 'create'
            ? React.createElement(CreateTeamDialog, {
                open: true,
                canCreate: true,
                provisioningErrorsByTeam: {},
                clearProvisioningError: vi.fn(),
                existingTeamNames: [],
                provisioningTeamNames: [],
                activeTeams: [],
                defaultProjectPath: '/tmp/project',
                onClose: vi.fn(),
                onCreate: submit,
                onOpenTeam: vi.fn(),
              })
            : React.createElement(LaunchTeamDialog, {
                mode: 'launch',
                open: true,
                teamName: 'team-alpha',
                members: [],
                defaultProjectPath: '/tmp/project',
                provisioningError: null,
                clearProvisioningError: vi.fn(),
                activeTeams: [],
                onClose: vi.fn(),
                onLaunch: submit,
              })
        );
      };
      await act(async () => {
        renderDialog();
        await flush();
      });
      const settle = async () => {
        for (let i = 0; i < 5; i++)
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            await flush();
          });
      };
      await settle();
      const completedChecks = vi.mocked(runProviderPrepareDiagnostics).mock.calls.length;
      if (refreshing) {
        expect(completedChecks).toBeGreaterThan(0);
        storeState.cliStatus = {
          ...storeState.cliStatus,
          providers: storeState.cliStatus.providers.map((provider) =>
            provider.providerId === refreshProviderId
              ? reconcileCliProviderSnapshot(
                  provider,
                  sanitizeProviderStatusAuthority({
                    ...provider,
                    modelCatalogRefreshState: 'loading',
                    modelCatalog: null,
                    runtimeCapabilities: { modelCatalog: { dynamic: true } },
                  })
                )
              : provider
          ),
        };
        expect(
          storeState.cliStatus.providers.find(
            (provider) => provider.providerId === refreshProviderId
          )
        ).toMatchObject({
          capabilities: { teamLaunch: false },
          teamLaunchAuthorityRestriction: 'catalog-refresh',
        });
        await act(async () => {
          renderDialog();
          await flush();
        });
        await settle();
        expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalledTimes(completedChecks);
      }
      const button = Array.from(host.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === `Skip preflight and ${mode}`
      );
      expect(button, host.textContent ?? '').toBeDefined();
      expect(button?.disabled).toBe(false);
      await act(async () => {
        button!.click();
        await flush();
      });
      expect(submit).toHaveBeenCalledOnce();
      await act(async () => root.unmount());
    }
  );

  it.each([
    ['create', 'anthropic', 'codex', false, ['anthropic', 'codex']],
    ['launch', 'anthropic', 'codex', false, ['anthropic', 'codex']],
    ['create', 'codex', 'anthropic', false, ['anthropic', 'codex']],
    ['launch', 'codex', 'anthropic', false, ['anthropic', 'codex']],
    ['create', 'codex', 'anthropic', true, ['codex']],
    ['launch', 'codex', 'anthropic', true, ['codex']],
    ['create', 'anthropic', 'codex', true, ['anthropic']],
    ['launch', 'anthropic', 'codex', true, ['anthropic']],
  ] as const)(
    'projects trust in mounted %s with %s lead, %s member (removed=%s)',
    async (mode, lead, memberProvider, removed, expectedProviders) => {
      storeState.activeContextId = 'local';
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.useFakeTimers();
      localStorage.setItem('team:lastSelectedProvider', lead);
      localStorage.setItem(`team:lastSelectedModel:${lead}`, lead === 'codex' ? 'gpt-5.4' : 'opus');
      for (const provider of storeState.cliStatus.providers ?? []) {
        storeState.cliProviderStatusByScope[
          getCliProviderStatusScopeKey(provider.providerId, '/tmp/project')
        ] = provider;
      }
      if (mode === 'create') {
        Object.assign(createTeamDraftMock.state.members[0], {
          providerId: lead,
          model: lead === 'codex' ? 'gpt-5.4' : 'opus',
        });
        Object.assign(createTeamDraftMock.state.members[1], {
          providerId: memberProvider,
          model: memberProvider === 'codex' ? 'gpt-5.4' : 'opus',
          removedAt: removed ? 1 : undefined,
        });
      }
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      let resolveTrust!: (value: any) => void;
      vi.mocked(api.workspaceTrust!.getLaunchStatus!).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTrust = resolve;
          })
      );
      await act(async () => {
        root.render(
          mode === 'create'
            ? React.createElement(CreateTeamDialog, {
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
            : React.createElement(LaunchTeamDialog, {
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
        teamRosterEditorSectionMock.lastProps.onProviderChange(lead);
        teamRosterEditorSectionMock.lastProps.onSyncModelsWithTeammatesChange(false);
        teamRosterEditorSectionMock.lastProps.onMembersChange([
          {
            id: 'trust-test-member',
            name: 'tester',
            originalName: 'tester',
            roleSelection: '',
            customRole: 'Developer',
            workflow: '',
            providerId: memberProvider,
            model: memberProvider === 'codex' ? 'gpt-5.4' : 'opus',
            removedAt: removed ? 1 : undefined,
          },
        ]);
        await flush();
      });
      expect(host.querySelectorAll('[role="note"]')).toHaveLength(0);
      // Readiness intentionally publishes its clock from a zero-delay timer.
      // Settle that independent gate without reaching the 120ms trust debounce.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      const submitLabel = mode === 'create' ? 'Create' : 'Launch team';
      const submit = () =>
        Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent === submitLabel
        );
      expect(submit()?.disabled, host.textContent ?? '').toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });
      expect(api.workspaceTrust!.getLaunchStatus).toHaveBeenLastCalledWith({
        projectPath: '/tmp/project',
        providerIds: expectedProviders,
      });
      expect(submit()?.disabled).toBe(false);
      await act(async () => {
        resolveTrust({
          providers: expectedProviders.map((providerId) => ({
            providerId,
            status: providerId === 'codex' ? 'launch_scoped' : 'trusted',
          })),
        });
      });
      expect(host.querySelectorAll('[role="note"]')).toHaveLength(0);
      expect(host.textContent).not.toContain('First launch');
      expect(host.textContent).not.toContain('Project status unknown');
      expect(submit()?.disabled).toBe(false);
      expect(
        new Set(
          vi.mocked(runProviderPrepareDiagnostics).mock.calls.map(([input]) => input.providerId)
        )
      ).toEqual(new Set(expectedProviders));
      await act(async () => root.unmount());
    }
  );

  it.each(['create-only', 'schedule', 'closed'] as const)(
    'does not read trust for mounted %s',
    async (mode) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.useFakeTimers();
      createTeamDraftMock.state.launchTeam = false;
      const root = createRoot(document.createElement('div'));
      await act(async () => {
        root.render(
          mode === 'create-only'
            ? React.createElement(CreateTeamDialog, {
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
            : mode === 'schedule'
              ? React.createElement(LaunchTeamDialog, {
                  mode: 'schedule',
                  open: true,
                  onClose: vi.fn(),
                })
              : React.createElement(LaunchTeamDialog, {
                  mode: 'launch',
                  open: mode !== 'closed',
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
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(api.workspaceTrust!.getLaunchStatus).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    }
  );

  it.each([
    ['create', 'failed', 'anthropic'],
    ['launch', 'failed', 'anthropic'],
    ['create', 'ready', 'anthropic'],
    ['launch', 'ready', 'anthropic'],
    ['create', 'ready', 'opencode'],
    ['launch', 'ready', 'opencode'],
  ] as const)(
    'optional skip %s with %s %s completion fences duplicates and resumes after rejection without repeating successful diagnostics',
    async (mode, completion, selectedProvider) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      localStorage.setItem('team:lastSelectedProvider', selectedProvider);
      localStorage.setItem(
        `team:lastSelectedModel:${selectedProvider}`,
        selectedProvider === 'opencode' ? 'opencode/big-pickle' : 'opus'
      );
      createTeamDraftMock.state.soloTeam = mode !== 'create';
      if (mode === 'create') createTeamDraftMock.state.members[1].providerId = selectedProvider;
      const pending: ((value: any) => void)[] = [];
      vi.mocked(runProviderPrepareDiagnostics).mockImplementation(({ providerId }) =>
        providerId === selectedProvider
          ? new Promise((resolve) => pending.push(resolve))
          : Promise.resolve({ status: 'ready', details: [], warnings: [], modelResultsById: {} })
      );
      let rejectSubmit!: (error: Error) => void;
      const submit = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSubmit = reject;
          })
      );
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(
          mode === 'create'
            ? React.createElement(CreateTeamDialog, {
                open: true,
                canCreate: true,
                provisioningErrorsByTeam: {},
                clearProvisioningError: vi.fn(),
                existingTeamNames: [],
                provisioningTeamNames: [],
                activeTeams: [],
                defaultProjectPath: '/tmp/project',
                onClose: vi.fn(),
                onCreate: submit,
                onOpenTeam: vi.fn(),
              })
            : React.createElement(LaunchTeamDialog, {
                mode: 'launch',
                open: true,
                teamName: 'team-alpha',
                members: [],
                defaultProjectPath: '/tmp/project',
                provisioningError: null,
                clearProvisioningError: vi.fn(),
                activeTeams: [],
                onClose: vi.fn(),
                onLaunch: submit,
              })
        );
        await flush();
      });
      const settle = async () => {
        for (let i = 0; i < 5; i++)
          await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
            await flush();
          });
      };
      await settle();
      const findButton = (label: string) =>
        Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === label
        )!;
      const skipLabel =
        mode === 'create' ? 'Skip preflight and create' : 'Skip preflight and launch';
      const skip = findButton(skipLabel);
      expect(skip, host.textContent ?? '').toBeDefined();
      expect(skip.disabled).toBe(false);
      expect(pending).toHaveLength(1);
      const base = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00.000Z'));
      await act(async () => {
        skip.click();
        await flush();
      });
      expect(submit).not.toHaveBeenCalled();
      now.mockReturnValue(base);
      const attempt = vi
        .mocked(runProviderPrepareDiagnostics)
        .mock.calls.find(([input]) => input.providerId === selectedProvider)![0];
      await act(async () => {
        attempt.onModelProgress?.({
          status: 'failed',
          details: ['REQUIRED FAILURE'],
          completedCount: 0,
          totalCount: 1,
        });
        skip.click();
        await flush();
      });
      expect(submit).not.toHaveBeenCalled();
      await act(async () => {
        attempt.onModelProgress?.({
          status: 'checking',
          details: [],
          completedCount: 0,
          totalCount: 1,
        });
        await flush();
      });
      await act(async () => {
        skip.click();
        skip.click();
        await flush();
      });
      expect(submit).toHaveBeenCalledTimes(1);
      await act(async () => {
        pending[0]({
          status: completion,
          details: ['FENCED OPTIONAL RESULT'],
          warnings: [],
          modelResultsById: {},
        });
        await flush();
      });
      expect(host.textContent).not.toContain('FENCED OPTIONAL RESULT');
      await act(async () => {
        rejectSubmit(new Error('submit rejected'));
        await flush();
      });
      await settle();
      expect(pending).toHaveLength(completion === 'ready' ? 1 : 2);
      expect(
        findButton(
          completion === 'ready' ? (mode === 'create' ? 'Create' : 'Launch team') : skipLabel
        ).disabled
      ).toBe(false);
      expect(submit).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    }
  );

  beforeEach(() => {
    // Each case creates a fresh mock application; actual dialog unmounts within a case retain intent.
    __resetRetainedCreateSubmissionForTests();
    vi.mocked(api.agentBackend.getConnections)
      .mockReset()
      .mockResolvedValue({
        state: 'ready',
        bindings: ['TEST-relaunch', 'TEST-submit', 'TEST-owner'].map((handleId) => ({
          handle: { handleId },
          label: 'TEST empty owner',
          members: [],
        })),
      });
    vi.mocked(api.agentBackend.invoke)
      .mockReset()
      .mockImplementation(async (request) =>
        request.operation === 'team.launch.configuration.read'
          ? { ok: true, value: null }
          : { ok: false, code: 'unavailable', outcome: 'not-dispatched' }
      );
    prepareHelperFixture.real = false;
    prepareHelperFixture.onLayout = null;
    storeState.activeContextId = 'TEST-local';
    vi.mocked(computeModelMock).mockImplementation((...args) =>
      prepareHelperFixture.real ? computeEffectiveTeamModel(...args) : args[0] || undefined
    );
    if (typeof localStorage?.getItem !== 'function' || typeof localStorage?.clear !== 'function') {
      const store = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(String(key), String(value));
        },
        removeItem: (key: string) => {
          store.delete(String(key));
        },
        clear: () => store.clear(),
      });
    }
    vi.mocked(isTeamProviderModelVerificationPending).mockImplementation(() => false);
    vi.mocked(isTeamProviderRuntimeStatusLoading).mockImplementation(() => false);
    vi.mocked(api.workspaceTrust!.getLaunchStatus!)
      .mockReset()
      .mockResolvedValue({ providers: [] });
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
    storeState.cliProviderStatusLoading = {};
    fetchCliProviderStatus.mockReset();
    fetchCliProviderStatus.mockImplementation(async (providerId, options) => {
      if (providerId === 'anthropic' && options?.projectPath) {
        const provider = storeState.cliStatus.providers.find(
          (entry) => entry.providerId === 'anthropic'
        );
        if (provider)
          storeState.cliProviderStatusByScope[
            getCliProviderStatusScopeKey('anthropic', options.projectPath)
          ] = provider;
        return true;
      }
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
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage?.clear?.();
    vi.useRealTimers();
    vi.clearAllMocks();
    createTeamDraftMock.state.setCwdMode.mockReset();
    createTeamDraftMock.state.runtimeSelectionVersion = undefined;
    createTeamDraftMock.state.runtimeProviderId = undefined;
    createTeamDraftMock.state.runtimeModel = undefined;
    createTeamDraftMock.state.setRuntimeSelection.mockReset();
    createTeamDraftMock.state.setMembers.mockReset();
    storeState.cliStatus = { providers: [] };
    storeState.cliStatusLoading = false;
    storeState.cliProviderStatusByScope = {};
    storeState.cliProviderStatusLoading = {};
    storeState.launchParamsByTeam = {};
    createTeamDraftMock.state.members[0].model = 'opencode/big-pickle';
    createTeamDraftMock.state.members[0].providerId = 'opencode';
    delete (createTeamDraftMock.state.members[0] as any).removedAt;
    createTeamDraftMock.state.members[1].providerId = 'codex';
    createTeamDraftMock.state.members[1].model = 'gpt-5.5';
    delete (createTeamDraftMock.state.members[1] as any).removedAt;
    createTeamDraftMock.state.cwdMode = 'project';
    createTeamDraftMock.state.selectedProjectPath = '/tmp/project';
    createTeamDraftMock.state.customCwd = '';
    createTeamDraftMock.state.soloTeam = false;
    createTeamDraftMock.state.launchTeam = true;
    vi.mocked(isTeamModelAvailableForUi).mockImplementation(() => true);
    vi.mocked(getTeamModelSelectionError).mockImplementation(() => null);
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
    let resolveSavedRequest!: (value: any) => void;
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSavedRequest = resolve;
      })
    );
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

    await confirmLaunchPreflight(host);

    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({
        name: 'alice',
        providerId: 'opencode',
        model: localModel,
      }),
    ]);
    expect(runProviderPrepareDiagnostics).not.toHaveBeenCalled();
    await act(async () => {
      resolveSavedRequest(null);
      await flush();
    });
    await confirmLaunchPreflight(host);
    expect(
      vi
        .mocked(runProviderPrepareDiagnostics)
        .mock.calls.find((call) => call[0]?.providerId === 'opencode')?.[0]?.selectedModelChecks
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'opencode',
          model: localModel,
        }),
      ])
    );

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('invalidates ready checks and blocks launch while project selection is unresolved', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
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
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await flush();
    });
    const submit = () =>
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Launch team'
      )!;
    expect(submit().disabled).toBe(false);
    expect(host.textContent).toContain('All selected providers are ready.');
    await act(async () => {
      projectPathSelectorMock.onSelect('/tmp/unresolved-project');
      await flush();
    });
    expect(submit().disabled).toBe(true);
    expect(host.textContent).not.toContain('All selected providers are ready.');
    await act(async () => {
      submit().click();
      await flush();
    });
    expect(onLaunch).not.toHaveBeenCalled();
    expect(api.teams.replaceMembers).not.toHaveBeenCalled();
    await act(async () => {
      projectPathSelectorMock.onSelect('/tmp/project');
      await flush();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(submit().disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it('starts preflight with user choices when a roster refresh cancels pending hydration', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.mocked(api.teams.getSavedRequest).mockReturnValueOnce(new Promise(() => {}));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () =>
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
    await act(async () => {
      render();
      await flush();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(runProviderPrepareDiagnostics).not.toHaveBeenCalled();
    await act(async () => {
      teamRosterEditorSectionMock.lastProps.onSyncModelsWithTeammatesChange(true);
      await flush();
    });
    await act(async () => {
      render();
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await flush();
    });
    expect(teamRosterEditorSectionMock.lastProps.syncModelsWithTeammates).toBe(true);
    expect(runProviderPrepareDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' })
    );
    const scopedPrepare = vi.mocked(runProviderPrepareDiagnostics).mock.calls.at(-1)![0]
      .prepareProvisioning;
    await scopedPrepare('/TEST/context', 'anthropic');
    expect(api.teams.prepareProvisioning).toHaveBeenLastCalledWith(
      '/TEST/context',
      'anthropic',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        kind: 'team',
        teamName: 'team-alpha',
        selectedModelChecks: expect.any(Array),
        preparationId: expect.any(String),
      })
    );
    expect(api.teams.getSavedRequest).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('keeps a programmatic effort reset from cancelling saved-request hydration', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
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
      await vi.advanceTimersByTimeAsync(250);
      await flush();
    });
    expect(runProviderPrepareDiagnostics).not.toHaveBeenCalled();

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
      await vi.advanceTimersByTimeAsync(250);
      await flush();
    });
    expect(runProviderPrepareDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        providerId: 'codex',
        selectedModelIds: expect.arrayContaining(['gpt-5.5']),
      })
    );

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

  it('uses effective synchronized teammates when selecting providers for prepare', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'anthropic',
      model: 'opus',
      syncModelsWithLead: true,
      members: [
        {
          name: 'jack',
          role: 'developer',
          providerId: 'opencode',
          model: 'openrouter/auto',
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
      await flush();
    });

    vi.mocked(runProviderPrepareDiagnostics).mockClear();
    await act(async () => {
      teamRosterEditorSectionMock.lastProps.onSyncModelsWithTeammatesChange(true);
      await flush();
    });
    await confirmLaunchPreflight(host);

    const preparedProviderIds = vi
      .mocked(runProviderPrepareDiagnostics)
      .mock.calls.map((call) => call[0].providerId);
    expect(preparedProviderIds).toContain('anthropic');
    expect(preparedProviderIds).not.toContain('opencode');
    expect(teamRosterEditorSectionMock.lastProps?.members).toEqual([
      expect.objectContaining({
        name: 'jack',
        providerId: 'opencode',
        model: 'openrouter/auto',
      }),
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

  it('infers legacy sync-off from teammate backend and fast-mode overrides', async () => {
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
          providerBackendId: 'codex-native',
          fastMode: 'on',
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

    expect(teamRosterEditorSectionMock.lastProps?.syncModelsWithTeammates).toBe(false);

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
    localStorage.setItem('team:lastSelectedProvider', 'opencode');
    localStorage.setItem('team:lastSelectedModel:opencode', 'opencode/big-pickle');
    const localModel = 'ollama/qwen2.5-coder:0.5b';
    const originalModel = createTeamDraftMock.state.members[0].model;
    createTeamDraftMock.state.members[0].model = localModel;
    createTeamDraftMock.state.members[1].providerId = 'opencode';
    createTeamDraftMock.state.members[1].model = 'opencode/big-pickle';
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
        createAuthoritativeProviderStatus('codex', ['gpt-5.5']),
      ],
    } as any;
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', '/tmp/project')]: {
        ...(storeState.cliStatus as any).providers[0],
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
        statusCheckOutcome: 'model_only',
        statusCheckErrorCode: 'partial_response',
        capabilities: { teamLaunch: false, oneShot: false },
        runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
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
          models: [
            {
              id: localModel,
              launchModel: localModel,
              displayName: localModel,
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              inputModalities: ['text'],
              supportsPersonality: false,
              isDefault: true,
              upgrade: false,
              source: 'app-server',
            },
          ],
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
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'opencode',
          model: localModel,
        }),
      ])
    );

    const createPrepare = vi.mocked(runProviderPrepareDiagnostics).mock.calls.at(-1)![0]
      .prepareProvisioning;
    await createPrepare('/TEST/context', 'anthropic');
    expect(api.teams.prepareProvisioning).toHaveBeenLastCalledWith(
      '/TEST/context',
      'anthropic',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        kind: 'create',
        preparationId: expect.any(String),
        draft: expect.objectContaining({
          teamName: 'team-alpha',
          providerId: 'opencode',
          members: expect.arrayContaining([
            expect.objectContaining({ name: 'tom', model: 'ollama/qwen2.5-coder:0.5b' }),
          ]),
        }),
      })
    );
    createTeamDraftMock.state.members[0].model = originalModel;
    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it('uses one custom cwd for the scoped OpenCode catalog and Create preflight', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    localStorage.setItem('team:lastSelectedProvider', 'opencode');
    localStorage.setItem('team:lastSelectedModel:opencode', 'opencode/big-pickle');
    const customCwd = '/tmp/custom-catalog-project';
    const localModel = 'ollama/qwen2.5-coder:0.5b';
    createTeamDraftMock.state.cwdMode = 'custom';
    createTeamDraftMock.state.customCwd = customCwd;
    createTeamDraftMock.state.members[0].model = localModel;
    createTeamDraftMock.state.members[1].providerId = 'opencode';
    createTeamDraftMock.state.members[1].model = 'opencode/big-pickle';
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
      providers: [globalProvider, createAuthoritativeProviderStatus('codex', ['gpt-5.5'])],
    } as any;
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', customCwd)]: {
        ...globalProvider,
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
        statusCheckOutcome: 'model_only',
        statusCheckErrorCode: 'partial_response',
        capabilities: { teamLaunch: false, oneShot: false },
        runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
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
          models: [
            {
              id: localModel,
              launchModel: localModel,
              displayName: localModel,
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              inputModalities: ['text'],
              supportsPersonality: false,
              isDefault: true,
              upgrade: false,
              source: 'app-server',
            },
          ],
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
      selectedModelChecks: expect.arrayContaining([expect.objectContaining({ model: localModel })]),
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

  it.each([
    { source: 'draft', version: 1, model: undefined, expected: '' },
    { source: 'draft', version: 1, model: 'gpt-5.4', expected: 'gpt-5.4' },
    { source: 'copy', version: 1, model: undefined, expected: '' },
    { source: 'copy', version: 1, model: 'gpt-5.4', expected: 'gpt-5.4' },
    { source: 'draft', version: undefined, model: undefined, expected: 'gpt-5.5' },
  ] as const)(
    'restores $source lead model $model with marker $version without importing another remembered choice',
    async ({ source, version, model, expected }) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      localStorage.setItem('team:lastSelectedProvider', 'codex');
      localStorage.setItem('team:lastSelectedModel:codex', 'gpt-5.5');
      createTeamDraftMock.state.launchTeam = false;
      createTeamDraftMock.state.runtimeSelectionVersion = version;
      createTeamDraftMock.state.runtimeProviderId = version === 1 ? 'codex' : undefined;
      createTeamDraftMock.state.runtimeModel = source === 'draft' ? model : undefined;
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const onCreate = vi.fn(async () => {});
      try {
        await act(async () => {
          root.render(
            React.createElement(CreateTeamDialog, {
              open: true,
              canCreate: true,
              provisioningErrorsByTeam: {},
              existingTeamNames: [],
              activeTeams: [],
              onClose: vi.fn(),
              onOpenTeam: vi.fn(),
              onCreate,
              initialData:
                source === 'copy'
                  ? {
                      teamName: 'team-alpha',
                      runtimeSelectionVersion: 1,
                      providerId: 'codex',
                      model,
                      syncModelsWithLead: false,
                      members: [],
                    }
                  : undefined,
            })
          );
          await flush();
        });
        expect(teamRosterEditorSectionMock.lastProps?.providerId).toBe('codex');
        expect(teamRosterEditorSectionMock.lastProps?.model ?? '').toBe(expected);
        const submit = Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Create'
        )!;
        expect(submit.disabled).toBe(false);
        await act(async () => {
          submit.click();
          await flush();
        });
        expect(api.teams.createConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            providerId: 'codex',
            model: expected || undefined,
          })
        );
        expect(onCreate).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    }
  );

  it('copies an unresolved draft without assigning a remembered OpenCode default to inheriting members', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('team:lastSelectedProvider', 'opencode');
    localStorage.setItem('team:lastSelectedModel:opencode', '');
    createTeamDraftMock.state.launchTeam = false;
    createTeamDraftMock.state.runtimeSelectionVersion = 1;
    const savedMembers = createTeamDraftMock.state.members;
    createTeamDraftMock.state.members = [
      {
        id: 'explicit',
        name: 'alice',
        roleSelection: '',
        customRole: 'Developer',
        workflow: '',
        providerId: 'opencode',
        model: 'opencode/big-pickle',
      },
      { id: 'inherit', name: 'bob', roleSelection: '', customRole: 'Developer', workflow: '' },
    ] as typeof savedMembers;
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', '/tmp/project')]: createAuthoritativeProviderStatus(
        'opencode',
        ['opencode/big-pickle']
      ),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onCreate = vi.fn(async () => {});
    try {
      await act(async () => {
        root.render(
          React.createElement(CreateTeamDialog, {
            open: true,
            canCreate: true,
            provisioningErrorsByTeam: {},
            existingTeamNames: [],
            activeTeams: [],
            onClose: vi.fn(),
            onOpenTeam: vi.fn(),
            onCreate,
            initialData: {
              teamName: 'team-alpha',
              runtimeSelectionVersion: 1,
              syncModelsWithLead: false,
              members: [
                {
                  name: 'alice',
                  role: 'Developer',
                  providerId: 'opencode',
                  model: 'opencode/big-pickle',
                },
                { name: 'bob', role: 'Developer' },
              ],
            },
          })
        );
        await flush();
      });
      const submit = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Create'
      )!;
      expect(submit.disabled).toBe(false);
      await act(async () => {
        submit.click();
        await flush();
      });
      const request = vi.mocked(api.teams.createConfig).mock.calls.at(-1)?.[0];
      expect(request).toEqual(expect.objectContaining({ runtimeSelectionVersion: 1 }));
      expect(request?.providerId).toBeUndefined();
      expect(request?.model).toBeUndefined();
      expect(request?.members).toEqual([
        expect.objectContaining({
          name: 'alice',
          providerId: 'opencode',
          model: 'opencode/big-pickle',
        }),
        expect.objectContaining({ name: 'bob' }),
      ]);
      expect(request?.members[1]?.providerId).toBeUndefined();
      expect(request?.members[1]?.model).toBeUndefined();
      expect(onCreate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
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

    await confirmLaunchPreflight(host);
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

    await confirmLaunchPreflight(host);
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

  it.each(['member', 'lead'] as const)(
    'carries a %s model draft into relaunch and discards it on cancel',
    async (targetKind) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const onRelaunch = vi.fn(async () => {});
      const onClose = vi.fn();
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const target = {
        name: targetKind === 'lead' ? 'team-lead' : 'alice',
        agentType: targetKind === 'lead' ? 'team-lead' : 'general-purpose',
        agentId: 'original',
        providerId: 'opencode',
        model: 'observed-runtime-model',
        configuredRuntimeSettings: { providerId: 'opencode', model: 'glm-5.3' },
      };
      const members = [
        target,
        {
          name: 'bob',
          providerId: 'opencode',
          model: 'observed-sibling-model',
          configuredRuntimeSettings: {},
        },
      ];
      const saved = {
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'opencode',
        model: 'glm-5.3',
        syncModelsWithLead: true,
        members: [],
      };
      const render = async (withDraft: boolean): Promise<void> => {
        vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce(saved as any);
        await act(async () => {
          root.render(
            React.createElement(LaunchTeamDialog, {
              mode: 'relaunch',
              open: true,
              teamName: 'team-alpha',
              members: members as any,
              defaultProjectPath: '/tmp/project',
              provisioningError: null,
              onClose,
              onRelaunch,
              memberSettingsDraft: withDraft
                ? {
                    teamName: 'team-alpha',
                    memberName: target.name,
                    targetKind,
                    expectedFingerprint: 'editor-fingerprint',
                    expectedTeamSettingsFingerprint: 'editor-team-baseline',
                    settings: {
                      role: null,
                      workflow: null,
                      isolation: null,
                      providerId: 'opencode',
                      providerBackendId: null,
                      model: 'glm-5.3-flash',
                      effort: null,
                      fastMode: null,
                      mcpPolicy: null,
                    },
                  }
                : undefined,
            })
          );
          await flush();
        });
      };
      await render(true);
      const editor = teamRosterEditorSectionMock.lastProps;
      if (targetKind === 'lead') expect(editor.model).toBe('glm-5.3-flash');
      else
        expect(editor.members.find((row: any) => row.name === 'alice').model).toBe('glm-5.3-flash');
      expect(editor.members.find((row: any) => row.name === 'bob').model).toBe('');
      expect(editor.syncModelsWithTeammates).toBe(false);
      expect(api.teams.replaceMembers).not.toHaveBeenCalled();
      expect(onRelaunch).not.toHaveBeenCalled();
      await act(async () => {
        const cancel = host.querySelector<HTMLButtonElement>('[data-testid="dismiss-dialog"]');
        expect(cancel).toBeTruthy();
        cancel?.click();
        await flush();
      });
      expect(onClose).toHaveBeenCalledOnce();
      expect(api.teams.replaceMembers).not.toHaveBeenCalled();
      expect(onRelaunch).not.toHaveBeenCalled();
      await act(async () => {
        root.render(null);
        await flush();
      });
      await render(false);
      expect(host.textContent).not.toContain('glm-5.3-flash');
      expect(target.configuredRuntimeSettings.model).toBe('glm-5.3');
      await act(async () => root.unmount());
    }
  );

  it('submits relaunch through onRelaunch without replacing members in-dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'anthropic',
      model: 'opus',
      syncModelsWithLead: true,
      members: [],
    });
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
              model: 'gpt-5.3',
              effort: 'medium',
            },
          ] as any,
          memberSettingsDraft: {
            teamName: 'team-alpha',
            memberName: 'alice',
            targetKind: 'member',
            expectedFingerprint: 'original',
            expectedTeamSettingsFingerprint: 'editor-team-baseline',
            settings: {
              role: 'Reviewer',
              workflow: null,
              isolation: null,
              providerId: 'codex',
              providerBackendId: null,
              model: 'gpt-5.4',
              effort: 'medium',
              fastMode: null,
              mcpPolicy: null,
            },
          },
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

    await confirmLaunchPreflight(host, 'Relaunch team');
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
    expect(request.syncModelsWithLead).toBe(true);
    expect((onRelaunch.mock.calls[0] as unknown[])[2]).toMatchObject({
      memberName: 'alice',
      targetKind: 'member',
      expectedFingerprint: 'original',
      expectedTeamSettingsFingerprint: 'editor-team-baseline',
      model: 'gpt-5.4',
      effort: 'medium',
      baseline: [{ memberName: 'alice', expectedFingerprint: expect.any(String) }],
    });
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

    await confirmLaunchPreflight(host);

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

  it('blocks launch for a saved teammate whose OpenCode route the fresh catalog no longer offers', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const availability = await vi.importActual<
      typeof import('@renderer/utils/teamModelAvailability')
    >('@renderer/utils/teamModelAvailability');
    vi.mocked(isTeamModelAvailableForUi).mockImplementation(availability.isTeamModelAvailableForUi);
    vi.mocked(getTeamModelSelectionError).mockImplementation(
      availability.getTeamModelSelectionError
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
          models: ['opencode/big-pickle'],
          capabilities: { teamLaunch: true, oneShot: false },
        },
      ],
    } as any;
    // The dialog only judges a qualified route once the local provider lookup
    // has answered; until then any route could be a local one.
    const previousElectronApi = (window as any).electronAPI;
    const previousRuntimeProviderManagement = (api as any).runtimeProviderManagement;
    (window as any).electronAPI = previousElectronApi ?? {};
    (api as any).runtimeProviderManagement = {
      listLocalProviders: vi.fn(async () => ({ providers: [] })),
    };
    const vanishedRoute = 'openrouter/moonshotai/kimi-k2';
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
      syncModelsWithLead: false,
      members: [{ name: 'bob', role: 'Reviewer', model: vanishedRoute }],
    } as any);
    const onLaunch = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
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

      const submitButton = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Launch team'
      );
      expect(host.textContent).toContain(`bob: Model "${vanishedRoute}" is not available`);
      expect(submitButton?.disabled).toBe(true);
      await act(async () => {
        submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();
      });
      expect(onLaunch).not.toHaveBeenCalled();
      expect(api.teams.replaceMembers).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
        await flush();
      });
      (window as any).electronAPI = previousElectronApi;
      (api as any).runtimeProviderManagement = previousRuntimeProviderManagement;
    }
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

    await confirmLaunchPreflight(host);
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
    const preflightError = host.querySelector('[data-testid="teammate-runtime-preflight-error"]');
    expect(preflightError?.getAttribute('role')).toBe('alert');
    expect(preflightError?.textContent).toContain(
      'alice uses Codex. OpenCode cannot be the team lead when mixing providers'
    );
    expect(host.textContent).not.toContain('All selected providers are ready.');
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

    await flushCustomFolderProbe();

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

  it('preserves Codex schedule backend lane and effort and defaults missing fast mode to off', async () => {
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

    await flushCustomFolderProbe();

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
        fastMode: 'off',
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

    await flushCustomFolderProbe();

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
    expect(fetchCliProviderStatus).not.toHaveBeenCalled();
    const initialLaunchButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
    });

    expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalledTimes(1);
    expect(initialLaunchButton?.hasAttribute('disabled')).toBe(true);

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

  it('keeps one OpenCode preflight when the same selected catalog becomes authoritative', async () => {
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
          statusMessage: 'healthy',
          detailMessage: 'catalog snapshot ready',
          models: ['opencode/minimax-m2.5-free'],
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

    const initialLaunchButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch team'
    );
    await act(async () => {
      initialLaunchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
    });

    const launchButtonWhileChecking = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Skip preflight and launch'
    );
    expect(launchButtonWhileChecking?.hasAttribute('disabled')).toBe(false);

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
    expect(inFlightOpencodePrepareCalls).toHaveLength(1);
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
    await confirmLaunchPreflight(host);
    for (
      let attempt = 0;
      attempt < 10 && !host.textContent?.includes('Runtime environment is not available');
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
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

  it('retains exact Create proof when deep completion arrives between ready progress render and passive checks effects', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    prepareHelperFixture.real = true;
    createTeamDraftMock.state.soloTeam = true;
    localStorage.setItem('team:lastSelectedProvider', 'anthropic');
    localStorage.setItem('team:lastSelectedModel:anthropic', 'claude-opus-4-6');
    const provider = createAuthoritativeProviderStatus('anthropic', ['claude-opus-4-6']);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          ...provider,
          authenticated: false,
          capabilities: { ...provider.capabilities, teamLaunch: false },
        },
      ],
    };
    vi.mocked(isTeamProviderRuntimeStatusLoading).mockImplementation(
      (_id, status) => status?.modelCatalogRefreshState === 'loading'
    );
    const diagnostics = await vi.importActual<
      typeof import('@renderer/components/team/dialogs/providerPrepareDiagnostics')
    >('@renderer/components/team/dialogs/providerPrepareDiagnostics');
    vi.mocked(runProviderPrepareDiagnostics).mockImplementation(
      diagnostics.runProviderPrepareDiagnostics
    );
    const originalPrepare = vi.mocked(api.teams.prepareProvisioning).getMockImplementation()!;
    const compatibility: (() => void)[] = [];
    const deep: (() => void)[] = [];
    let layoutCompletions = 0;
    vi.mocked(api.teams.prepareProvisioning).mockImplementation((...args) => {
      const context = args[7];
      if (context?.kind !== 'create' || !context.draft || !context.preparationId)
        throw new Error('Expected captured Create context');
      const result = {
        ready: true,
        message: 'TEST current exact Host ready',
        createdTeamReadiness: {
          preparationId: context.preparationId,
          selectionSignature: createdTeamSelectionSignature(context.draft),
          draftDigest: 'TEST-layout-proof',
          expiresAt: Date.now() + 60_000,
        },
      };
      return new Promise((resolve) =>
        (args[5] === 'deep' ? deep : compatibility).push(() => resolve(result))
      );
    });
    const onCreate = vi.fn(async (_request: TeamCreateRequest) => 'host-team:TEST-created');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () =>
      root.render(
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
    const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
    const submit = () => host.querySelector<HTMLButtonElement>('button.min-w-32')!;
    try {
      await act(async () => {
        render();
        await flush();
      });
      for (let attempt = 0; attempt < 20 && compatibility.length === 0; attempt++) await act(turn);
      expect(compatibility.length).toBeGreaterThan(0);
      prepareHelperFixture.onLayout = () => {
        if (deep.length) {
          layoutCompletions += deep.length;
          for (const finish of deep.splice(0)) finish();
        }
      };
      // Native replies arrive outside React act. A layout commit resolves the IPC promise
      // before this ready-progress render's passive effects, matching the desktop race.
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
      storeState.cliStatus = {
        ...storeState.cliStatus,
        providers: [
          {
            ...storeState.cliStatus.providers[0],
            modelCatalogRefreshState: 'loading',
            modelCatalog: null,
          },
        ],
      };
      render();
      await turn();
      for (const finish of compatibility.splice(0)) finish();
      for (let attempt = 0; attempt < 40 && layoutCompletions === 0; attempt++) await turn();
      for (let attempt = 0; attempt < 4; attempt++) await turn();
      expect(layoutCompletions).toBeGreaterThan(0);
      expect(submit().disabled, host.textContent ?? '').toBe(false);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      await act(async () => {
        submit().click();
        await flush();
      });
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          createdTeamReadiness: expect.objectContaining({ draftDigest: 'TEST-layout-proof' }),
        }),
        undefined
      );
    } finally {
      prepareHelperFixture.onLayout = null;
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.mocked(api.teams.prepareProvisioning).mockImplementation(originalPrepare);
      await act(async () => root.unmount());
    }
  });

  it('keeps actual Create draft and scoped proof stable through passive catalog refresh after model, effort and prompt edits', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    prepareHelperFixture.real = true;
    localStorage.setItem('team:lastSelectedProvider', 'anthropic');
    localStorage.setItem('team:lastSelectedModel:anthropic', 'sonnet');
    createTeamDraftMock.state.soloTeam = true;
    const originalName = createTeamDraftMock.state.teamName;
    const provider = createAuthoritativeProviderStatus('anthropic', ['sonnet', 'claude-opus-4-6']);
    provider.modelCatalog!.models.forEach((model) => {
      model.supportedReasoningEfforts = ['low', 'medium', 'high', 'max'];
    });
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          ...provider,
          authenticated: false,
          capabilities: { ...provider.capabilities, teamLaunch: false },
        },
      ],
    };
    vi.mocked(isTeamProviderRuntimeStatusLoading).mockImplementation(
      (_providerId, status) => status?.modelCatalogRefreshState === 'loading'
    );
    const diagnostics = await vi.importActual<
      typeof import('@renderer/components/team/dialogs/providerPrepareDiagnostics')
    >('@renderer/components/team/dialogs/providerPrepareDiagnostics');
    vi.mocked(runProviderPrepareDiagnostics).mockImplementation(
      diagnostics.runProviderPrepareDiagnostics
    );
    const originalPrepare = vi.mocked(api.teams.prepareProvisioning).getMockImplementation()!;
    const drafts: TeamCreateRequest[] = [];
    vi.mocked(api.teams.prepareProvisioning).mockImplementation(async (...args) => {
      const context = args[7];
      if (context?.kind !== 'create' || !context.draft || !context.preparationId)
        throw new Error('Expected complete Create context');
      drafts.push(structuredClone(context.draft));
      return {
        ready: true,
        message: 'TEST Host exact draft ready',
        createdTeamReadiness: {
          preparationId: context.preparationId,
          selectionSignature: createdTeamSelectionSignature(context.draft),
          draftDigest: 'TEST-captured-digest',
          expiresAt: Date.now() + 60_000,
        },
      };
    });
    const onCreate = vi.fn(async (_request: TeamCreateRequest) => 'host-team:TEST-created');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () =>
      root.render(
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
    const settle = async () => {
      for (let attempt = 0; attempt < 4; attempt++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
          await flush();
        });
    };
    const submit = () => host.querySelector<HTMLButtonElement>('button.min-w-32')!;
    try {
      await act(async () => {
        render();
        await flush();
      });
      await settle();
      await act(async () => {
        createTeamDraftMock.state.teamName = 'TEST-real-helper-flow';
        createTeamDraftMock.state.cwdMode = 'custom';
        createTeamDraftMock.state.customCwd = '/tmp/TEST-real-helper-flow';
        render();
        await flush();
      });
      await settle();
      await act(async () => {
        teamRosterEditorSectionMock.lastProps.onModelChange('claude-opus-4-6');
        teamRosterEditorSectionMock.lastProps.onEffortChange('medium');
        await flush();
      });
      await settle();
      await act(async () => {
        const textarea = host.querySelector<HTMLTextAreaElement>('#team-prompt')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          textarea,
          'TEST deliberate prompt'
        );
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
      });
      await settle();
      expect(drafts.at(-1)).toMatchObject({
        teamName: 'test-real-helper-flow',
        cwd: '/tmp/TEST-real-helper-flow',
        model: 'claude-opus-4-6',
        effort: 'medium',
        prompt: 'TEST deliberate prompt',
      });
      expect(submit().disabled, host.textContent ?? '').toBe(false);
      const checks = drafts.length;
      storeState.cliStatus = {
        ...storeState.cliStatus,
        providers: [
          {
            ...storeState.cliStatus.providers[0],
            modelCatalogRefreshState: 'loading',
            modelCatalog: null,
          },
        ],
      };
      await act(async () => {
        render();
        await flush();
      });
      await settle();
      expect(submit().disabled, host.textContent ?? '').toBe(false);
      expect(drafts).toHaveLength(checks);
      await act(async () => {
        submit().click();
        await flush();
      });
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-6',
          effort: 'medium',
          prompt: 'TEST deliberate prompt',
          createdTeamReadiness: expect.objectContaining({ draftDigest: 'TEST-captured-digest' }),
        }),
        undefined
      );
    } finally {
      createTeamDraftMock.state.teamName = originalName;
      vi.mocked(api.teams.prepareProvisioning).mockImplementation(originalPrepare);
      await act(async () => root.unmount());
    }
  });

  it.each(['expiry', 'draft', 'context'] as const)(
    'retains Create Host proof through same-attempt catalog refresh and still blocks on %s',
    async (invalidation) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.useFakeTimers();
      localStorage.setItem('team:lastSelectedProvider', 'anthropic');
      localStorage.setItem('team:lastSelectedModel:anthropic', 'sonnet');
      createTeamDraftMock.state.soloTeam = true;
      storeState.cliStatus = {
        flavor: 'agent_teams_orchestrator',
        providers: [
          {
            ...createAuthoritativeProviderStatus('anthropic', ['sonnet']),
            authenticated: false,
            capabilities: {
              teamLaunch: false,
              oneShot: false,
              extensions: createDefaultCliExtensionCapabilities(),
            },
          },
        ],
      };
      vi.mocked(isTeamProviderRuntimeStatusLoading).mockImplementation(
        (_providerId, provider) => provider?.modelCatalogRefreshState === 'loading'
      );
      const diagnostics = await vi.importActual<
        typeof import('@renderer/components/team/dialogs/providerPrepareDiagnostics')
      >('@renderer/components/team/dialogs/providerPrepareDiagnostics');
      vi.mocked(runProviderPrepareDiagnostics).mockImplementation(
        diagnostics.runProviderPrepareDiagnostics
      );
      const originalPrepare = vi.mocked(api.teams.prepareProvisioning).getMockImplementation()!;
      const expiresAt = Date.now() + 60_000;
      vi.mocked(api.teams.prepareProvisioning).mockImplementation(async (...args) => {
        const context = args[7];
        if (context?.kind !== 'create' || !context.draft || !context.preparationId)
          throw new Error('Expected complete Create preparation context');
        return {
          ready: true,
          message: 'TEST captured Host ready',
          createdTeamReadiness: {
            preparationId: context.preparationId,
            selectionSignature: createdTeamSelectionSignature(context.draft),
            draftDigest: 'TEST-captured-product-digest',
            expiresAt,
          },
        };
      });
      const onCreate = vi.fn(async () => 'host-team:TEST-created');
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const render = () =>
        root.render(
          React.createElement(CreateTeamDialog, {
            open: true,
            canCreate: true,
            provisioningErrorsByTeam: {},
            existingTeamNames: [],
            provisioningTeamNames: [],
            activeTeams: [],
            defaultProjectPath: '/tmp/project',
            onClose: vi.fn(),
            onCreate,
            onOpenTeam: vi.fn(),
          })
        );
      const settle = async () => {
        for (let attempt = 0; attempt < 4; attempt++)
          await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
            await flush();
          });
      };
      const submit = () => host.querySelector<HTMLButtonElement>('button.min-w-32')!;
      try {
        await act(async () => {
          render();
          await flush();
        });
        await settle();
        expect(submit().disabled, host.textContent ?? '').toBe(false);
        const observations = vi.mocked(api.teams.prepareProvisioning).mock.calls.length;
        const diagnosticRuns = vi.mocked(runProviderPrepareDiagnostics).mock.calls.length;
        expect(observations).toBeGreaterThan(0);
        expect(diagnosticRuns).toBe(1);
        storeState.cliStatus = {
          ...storeState.cliStatus,
          providers: storeState.cliStatus.providers.map((provider) => ({
            ...provider,
            modelCatalogRefreshState: 'loading',
            modelCatalog: null,
          })),
        };
        await act(async () => {
          render();
          await flush();
        });
        await settle();
        expect(submit().disabled, host.textContent ?? '').toBe(false);
        expect(api.teams.prepareProvisioning).toHaveBeenCalledTimes(observations);
        expect(runProviderPrepareDiagnostics).toHaveBeenCalledTimes(diagnosticRuns);
        await act(async () => {
          if (invalidation === 'expiry')
            await vi.advanceTimersByTimeAsync(expiresAt - Date.now() + 1);
          if (invalidation === 'draft')
            advancedCliMock.lastProps.onCustomArgsChange('--TEST-changed');
          if (invalidation === 'context') {
            storeState.activeContextId = 'TEST-other';
            render();
          }
          await flush();
        });
        expect(submit().disabled).toBe(true);
        expect(onCreate).not.toHaveBeenCalled();
        expect(api.teams.prepareProvisioning).toHaveBeenCalledTimes(observations);
      } finally {
        vi.mocked(api.teams.prepareProvisioning).mockImplementation(originalPrepare);
        await act(async () => root.unmount());
      }
    }
  );

  it('permits save-only after cancelling a pending create preflight with the same project', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    storeState.cliStatus.providers = storeState.cliStatus.providers?.map((provider) => ({
      ...provider,
      authenticated: false,
    }));
    vi.mocked(runProviderPrepareDiagnostics).mockReturnValue(new Promise(() => {}));
    const onCreate = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () =>
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
          onCreate,
          onOpenTeam: vi.fn(),
        })
      );
    await act(async () => {
      render();
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await flush();
    });
    expect(runProviderPrepareDiagnostics).toHaveBeenCalled();
    const submit = () => host.querySelector<HTMLButtonElement>('button.min-w-32')!;
    expect(submit().disabled).toBe(true);
    createTeamDraftMock.state.launchTeam = false;
    await act(async () => {
      render();
      await flush();
    });
    expect(submit().disabled, host.textContent ?? '').toBe(false);
    await act(async () => {
      submit().click();
      await flush();
    });
    expect(api.teams.createConfig).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' })
    );
    expect(onCreate).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('shows an OpenCode mixed-lead error in create preflight instead of a ready verdict', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
      teamRosterEditorSectionMock.lastProps.onProviderChange('opencode');
      await flush();
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();
      });
    }

    const error = 'bob uses Codex. OpenCode cannot be the team lead when mixing providers';
    expect(runProviderPrepareDiagnostics).toHaveBeenCalled();
    expect(teamRosterEditorSectionMock.lastProps.memberErrorById['member-codex']).toContain(error);
    expect(teamRosterEditorSectionMock.lastProps.memberWarningById['member-codex']).toBeUndefined();
    expect(
      host.querySelector('[data-testid="teammate-runtime-preflight-error"]')?.textContent
    ).toContain(error);
    expect(host.textContent).not.toContain('Selected providers ready');
    expect(host.textContent).not.toContain('All selected providers are ready.');
    expect(host.querySelector<HTMLButtonElement>('button.min-w-32')?.disabled).toBe(true);

    await act(async () => root.unmount());
  });

  it('permits saving a draft after opting out of a pending launch preflight and ignores its late failure', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    let finishPreflight!: (
      result: Awaited<ReturnType<typeof runProviderPrepareDiagnostics>>
    ) => void;
    const pendingPreflight = new Promise<Awaited<ReturnType<typeof runProviderPrepareDiagnostics>>>(
      (resolve) => {
        finishPreflight = resolve;
      }
    );
    vi.mocked(runProviderPrepareDiagnostics).mockReturnValue(pendingPreflight);
    const onCreate = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () =>
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
          onCreate,
          onOpenTeam: vi.fn(),
        })
      );
    const settle = async () => {
      for (let attempt = 0; attempt < 4; attempt++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
          await flush();
        });
    };
    const submit = () => host.querySelector<HTMLButtonElement>('button.min-w-32')!;
    try {
      await act(async () => {
        render();
        await flush();
      });
      await settle();
      expect(runProviderPrepareDiagnostics).toHaveBeenCalled();
      expect(submit().textContent).toBe('Skip preflight and create');
      expect(host.textContent).not.toContain('All selected providers are ready.');
      createTeamDraftMock.state.launchTeam = false;
      await act(async () => {
        render();
        await flush();
      });
      expect(submit().disabled).toBe(false);
      await act(async () => {
        finishPreflight({
          status: 'failed',
          warnings: [],
          details: ['Late cancelled failure'],
          modelResultsById: {},
        });
        await flush();
      });
      await settle();
      expect(submit().disabled).toBe(false);
      expect(host.textContent).not.toContain('Late cancelled failure');
      await act(async () => {
        submit().click();
        await flush();
      });
      expect(api.teams.createConfig).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/tmp/project' })
      );
      expect(onCreate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('clears completed create preflight while selection is unresolved but permits create without launch', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const onCreate = vi.fn(async () => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () =>
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
          onCreate,
          onOpenTeam: vi.fn(),
        })
      );
    const settle = async () => {
      for (let attempt = 0; attempt < 4; attempt++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
          await flush();
        });
    };
    const submit = () => host.querySelector<HTMLButtonElement>('button.min-w-32')!;
    await act(async () => {
      render();
      await flush();
    });
    await settle();
    expect(submit()).not.toBeNull();
    expect(submit().disabled).toBe(false);
    expect(host.textContent).toContain('All selected providers are ready.');
    createTeamDraftMock.state.selectedProjectPath = '/tmp/unresolved-project';
    await act(async () => {
      render();
      await flush();
    });
    expect(submit().disabled).toBe(true);
    expect(host.textContent).not.toContain('All selected providers are ready.');
    await act(async () => {
      submit().click();
      await flush();
    });
    expect(onCreate).not.toHaveBeenCalled();
    createTeamDraftMock.state.selectedProjectPath = '/tmp/project';
    await act(async () => {
      render();
      await flush();
    });
    await settle();
    expect(submit().disabled).toBe(false);
    expect(host.textContent).toContain('All selected providers are ready.');
    createTeamDraftMock.state.selectedProjectPath = '';
    createTeamDraftMock.state.launchTeam = false;
    await act(async () => {
      render();
      await flush();
    });
    expect(submit().disabled).toBe(false);
    await act(async () => {
      submit().click();
      await flush();
    });
    expect(api.teams.createConfig).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: undefined })
    );
    expect(onCreate).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it.each(['project', 'custom'] as const)(
    'starts detailed create-team preflight only after the current project selection settles from %s mode',
    async (initialCwdMode) => {
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
      await fetchCliProviderStatus('opencode', {
        silent: true,
        checkReason: 'launch_preflight',
        projectPath: '/tmp/project',
      });
      fetchCliProviderStatus.mockClear();
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

      createTeamDraftMock.state.selectedProjectPath = '/tmp/stale-real-project';
      createTeamDraftMock.state.cwdMode = initialCwdMode;
      createTeamDraftMock.state.customCwd = '/tmp/stale-custom-project';
      createTeamDraftMock.state.setCwdMode.mockImplementation((mode) => {
        createTeamDraftMock.state.cwdMode = mode;
      });
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
            forceDefaultProjectSelection: true,
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

      expect(vi.mocked(runProviderPrepareDiagnostics)).not.toHaveBeenCalled();
      expect(fetchCliProviderStatus).not.toHaveBeenCalled();

      createTeamDraftMock.state.selectedProjectPath = '/tmp/project';
      await act(async () => {
        await renderDialog();
        await flush();
      });

      await act(async () => {
        vi.runOnlyPendingTimers();
        await flush();
      });

      expect(
        new Set(
          vi.mocked(runProviderPrepareDiagnostics).mock.calls.map(([input]) => input.providerId)
        )
      ).toEqual(new Set(['anthropic', 'codex', 'opencode']));
      expect(
        vi
          .mocked(runProviderPrepareDiagnostics)
          .mock.calls.every(([input]) => input.cwd === '/tmp/project')
      ).toBe(true);
      expect(
        vi
          .mocked(runProviderPrepareDiagnostics)
          .mock.calls.flatMap(([input]) => input.selectedModelIds)
      ).toEqual(expect.arrayContaining(['gpt-5.5', 'opencode/big-pickle']));

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
      expect(vi.mocked(runProviderPrepareDiagnostics)).toHaveBeenCalledTimes(3);

      await act(async () => {
        root.unmount();
        await flush();
      });
    }
  );

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
    // The first click explicitly authorizes the bounded provider preflight when
    // the project-scoped OpenCode authority is still unresolved.
    if (!onCreate.mock.calls.length) {
      await act(async () => {
        await flush();
      });
      const retrySubmitButton = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Create'
      );
      retrySubmitButton?.click();
      await flush();
    }
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

  it('submits a role-only legacy lead separately from the settings teammate roster', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'anthropic',
      model: 'opus',
      members: [],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRelaunch = vi.fn(async () => {});
    await act(async () => {
      root.render(
        React.createElement(LaunchTeamDialog, {
          mode: 'relaunch',
          open: true,
          teamName: 'team-alpha',
          defaultProjectPath: '/tmp/project',
          members: [
            { name: 'lead', role: 'Lead', model: 'opus' },
            { name: 'alice', role: 'Reviewer' },
          ] as any,
          memberSettingsDraft: {
            teamName: 'team-alpha',
            memberName: 'lead',
            targetKind: 'lead',
            expectedFingerprint: 'legacy-lead',
            expectedTeamSettingsFingerprint: 'editor-defaults',
            settings: {
              role: 'Lead',
              workflow: null,
              isolation: null,
              providerId: null,
              providerBackendId: null,
              model: 'sonnet',
              effort: null,
              fastMode: null,
              mcpPolicy: null,
            },
          },
          provisioningError: null,
          clearProvisioningError: vi.fn(),
          activeTeams: [],
          onClose: vi.fn(),
          onRelaunch,
        })
      );
      await flush();
    });
    expect(teamRosterEditorSectionMock.lastProps.members.map((member: any) => member.name)).toEqual(
      ['alice']
    );
    await confirmLaunchPreflight(host, 'Relaunch team');
    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Relaunch team')!
        .click();
      await flush();
    });
    expect(onRelaunch).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'sonnet' }),
      [expect.objectContaining({ name: 'alice' })],
      expect.objectContaining({
        memberName: 'lead',
        targetKind: 'lead',
        expectedTeamSettingsFingerprint: 'editor-defaults',
      }),
      undefined,
      expect.any(Function)
    );
    await act(async () => root.unmount());
  });

  it.each([true, false])(
    'reopens configured member intent without promoting runtime models (sync %s)',
    async (syncModelsWithLead) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.mocked(api.teams.getSavedRequest).mockResolvedValueOnce({
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        providerId: 'anthropic',
        model: 'opus',
        syncModelsWithLead,
        members: [{ name: 'inherited' }, { name: 'explicit', model: 'opus' }],
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const onRelaunch = vi.fn(async () => {});
      try {
        await act(async () => {
          root.render(
            React.createElement(LaunchTeamDialog, {
              mode: 'relaunch',
              open: true,
              teamName: 'team-alpha',
              defaultProjectPath: '/tmp/project',
              members: [
                { name: 'inherited', model: 'sonnet', configuredRuntimeSettings: {} },
                { name: 'explicit', model: 'sonnet', configuredRuntimeSettings: { model: 'opus' } },
              ] as any,
              provisioningError: null,
              clearProvisioningError: vi.fn(),
              activeTeams: [],
              onClose: vi.fn(),
              onRelaunch,
            })
          );
          await flush();
        });
        const rows = teamRosterEditorSectionMock.lastProps.members;
        expect(
          rows.find((row: any) => row.name === 'inherited').model || undefined
        ).toBeUndefined();
        expect(rows.find((row: any) => row.name === 'explicit').model).toBe('opus');
        await confirmLaunchPreflight(host, 'Relaunch team');
        await act(async () => {
          Array.from(host.querySelectorAll('button'))
            .find((button) => button.textContent === 'Relaunch team')!
            .click();
          await flush();
        });
        expect(onRelaunch).toHaveBeenCalledWith(
          expect.objectContaining({ syncModelsWithLead }),
          [
            expect.objectContaining({ name: 'inherited', model: '' }),
            expect.objectContaining({ name: 'explicit', model: 'opus' }),
          ],
          undefined,
          undefined,
          expect.any(Function)
        );
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    }
  );
});
