import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SafeConfig } from '@renderer/components/settings/hooks/useSettingsConfig';
import type { AppConfig } from '@renderer/types/data';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@renderer/api', () => ({
  api: {
    config: {
      getClaudeRootInfo: vi.fn(),
      update: vi.fn(),
    },
    notifications: {
      testNotification: vi.fn(async () => ({ success: true })),
    },
  },
}));

vi.mock('@renderer/components/common/RepositoryDropdown', () => ({
  RepositoryDropdown: () => React.createElement('div'),
  SelectedRepositoryItem: () => React.createElement('div'),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => React.createElement('input', { ...props, ref })
  ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/components/settings/components', () => ({
  SettingRow: ({
    label,
    children,
  }: React.PropsWithChildren<{ label: string; description?: string; icon?: React.ReactNode }>) =>
    React.createElement('div', { 'data-setting-label': label }, children),
  SettingsSectionHeader: ({ title }: { title: string; icon?: React.ReactNode }) =>
    React.createElement('h2', null, title),
  SettingsSelect: () => React.createElement('select'),
  SettingsToggle: ({
    enabled,
    disabled,
    onChange,
  }: {
    enabled: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        disabled,
        'data-enabled': String(enabled),
        onClick: () => onChange(!enabled),
      },
      'toggle'
    ),
}));

vi.mock('@renderer/components/settings/NotificationTriggerSettings', () => ({
  NotificationTriggerSettings: () => React.createElement('div'),
}));

import { api } from '@renderer/api';
import { useSettingsHandlers } from '@renderer/components/settings/hooks/useSettingsHandlers';
import { useStore } from '@renderer/store';
import { captureContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';

import { NotificationsSection } from '@renderer/components/settings/sections/NotificationsSection';

function makeSafeConfig(): SafeConfig & AppConfig {
  return {
    general: {
      launchAtLogin: false,
      showDockIcon: true,
      theme: 'system',
      defaultTab: 'dashboard',
      multimodelEnabled: true,
      claudeRootPath: null,
      agentLanguage: 'system',
      appLocale: 'system',
      autoExpandAIGroups: false,
      useNativeTitleBar: false,
      telemetryEnabled: false,
      externalAgentCdpEnabled: false,
    },
    notifications: {
      enabled: false,
      soundEnabled: false,
      ignoredRegex: [],
      ignoredRepositories: [],
      snoozedUntil: null,
      snoozeMinutes: 60,
      includeSubagentErrors: false,
      notifyOnLeadInbox: false,
      notifyOnUserInbox: false,
      notifyOnClarifications: false,
      notifyOnStatusChange: false,
      notifyOnTaskComments: false,
      notifyOnTaskCreated: false,
      notifyOnAllTasksCompleted: false,
      notifyOnCrossTeamMessage: false,
      notifyOnTeamLaunched: false,
      notifyOnToolApproval: false,
      notifyOnUsageBudgetAlerts: false,
      notifyOnUsageBudgetWarning: false,
      notifyOnUsageBudgetCritical: false,
      notifyOnUsageBudgetNativeToast: false,
      autoResumeOnRateLimit: false,
      statusChangeOnlySolo: false,
      statusChangeStatuses: [],
      triggers: [],
    },
    teamRuntimeRecovery: {
      transientErrorsEnabled: false,
      rateLimitsEnabled: false,
      initialDelaySeconds: 60,
      maxAttempts: 2,
    },
    providerConnections: {
      anthropic: {
        authMode: 'auto',
        fastModeDefault: false,
        compatibleEndpoint: {
          enabled: false,
          baseUrl: '',
        },
      },
      codex: {
        preferredAuthMode: 'auto',
        customProvider: {
          enabled: false,
          baseUrl: '',
          model: '',
        },
      },
    },
    runtime: {
      providerBackends: {
        gemini: 'auto',
        codex: 'codex-native',
      },
    },
    sessions: {
      pinnedSessions: {},
      hiddenSessions: {},
    },
    display: {
      showTimestamps: true,
      compactMode: false,
      syntaxHighlighting: true,
    },
  };
}

function changeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('NotificationsSection recovery settings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('updates recovery toggles and limits independently from the notification master switch', async () => {
    const onTeamRuntimeRecoveryUpdate = vi.fn();
    await act(async () => {
      root.render(
        <NotificationsSection
          safeConfig={makeSafeConfig()}
          saving={false}
          isSnoozed={false}
          ignoredRepositoryItems={[]}
          excludedRepositoryIds={[]}
          onNotificationToggle={vi.fn()}
          onTeamRuntimeRecoveryUpdate={onTeamRuntimeRecoveryUpdate}
          onStatusChangeStatusesUpdate={vi.fn()}
          onSnooze={vi.fn()}
          onClearSnooze={vi.fn()}
          onAddIgnoredRepository={vi.fn()}
          onRemoveIgnoredRepository={vi.fn()}
          onAddTrigger={vi.fn()}
          onUpdateTrigger={vi.fn()}
          onRemoveTrigger={vi.fn()}
        />
      );
    });

    const transientRow = container.querySelector(
      '[data-setting-label="notifications.recovery.transient.label"]'
    );
    const rateLimitRow = container.querySelector(
      '[data-setting-label="notifications.recovery.rateLimits.label"]'
    );
    const transientToggle = transientRow?.querySelector('button');
    const rateLimitToggle = rateLimitRow?.querySelector('button');
    const delayInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="notifications.recovery.delay.label"]'
    );
    const attemptsInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="notifications.recovery.attempts.label"]'
    );

    expect(transientToggle?.disabled).toBe(false);
    expect(rateLimitToggle?.disabled).toBe(false);
    expect(delayInput?.disabled).toBe(false);
    expect(attemptsInput?.disabled).toBe(false);

    await act(async () => {
      transientToggle?.click();
      rateLimitToggle?.click();
      if (delayInput) changeInputValue(delayInput, '120');
      if (attemptsInput) changeInputValue(attemptsInput, '4');
    });

    expect(onTeamRuntimeRecoveryUpdate).toHaveBeenCalledWith({ transientErrorsEnabled: true });
    expect(onTeamRuntimeRecoveryUpdate).toHaveBeenCalledWith({ rateLimitsEnabled: true });
    expect(onTeamRuntimeRecoveryUpdate).toHaveBeenCalledWith({ initialDelaySeconds: 120 });
    expect(onTeamRuntimeRecoveryUpdate).toHaveBeenCalledWith({ maxAttempts: 4 });
  });
  it('invalidates a changed root before later reset writes fail and preserves an unchanged root', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const originalState = useStore.getState();
    const config = makeSafeConfig();
    const setError = vi.fn();
    const setConfig = vi.fn();
    const setOptimisticConfig = vi.fn();
    const setSaving = vi.fn();
    let reset: () => Promise<void> = () => Promise.resolve();

    function ResetHarness(): null {
      reset = useSettingsHandlers({
        config,
        setError,
        setConfig,
        setOptimisticConfig,
        setSaving,
        updateConfig: vi.fn(),
      }).handleResetToDefaults;
      return null;
    }

    act(() => root.render(<ResetHarness />));
    try {
      for (const rootChanges of [false, true]) {
        const fetchProjects = vi.fn(() => Promise.resolve());
        const fetchRepositoryGroups = vi.fn(() => Promise.resolve());
        const tabs = [
          {
            id: 'old-team-tab',
            type: 'team' as const,
            teamName: 'old-team',
            label: 'Old team',
            createdAt: 1,
          },
        ];
        useStore.setState({
          connectionMode: 'local',
          activeContextId: 'local',
          selectedProjectId: 'old-project',
          selectedSessionId: 'old-session',
          selectedTeamName: 'old-team',
          openTabs: tabs,
          activeTabId: 'old-team-tab',
          fetchProjects,
          fetchRepositoryGroups,
        });
        const epoch = captureContextScopedRequestEpoch();
        vi.mocked(api.config.getClaudeRootInfo).mockResolvedValue({
          resolvedPath: rootChanges ? '/sandbox/root-a' : '/sandbox/root-b',
          defaultPath: '/sandbox/root-b',
          customPath: rootChanges ? '/sandbox/root-a' : null,
        });
        let stateAtLaterWrite = originalState;
        let epochAtLaterWrite = epoch;
        vi.mocked(api.config.update).mockImplementation((section) => {
          if (section === 'providerConnections') {
            stateAtLaterWrite = useStore.getState();
            epochAtLaterWrite = captureContextScopedRequestEpoch();
            return Promise.reject(new Error('Later provider settings write failed'));
          }
          return Promise.resolve(config);
        });

        await act(async () => reset());

        const observation = {
          epoch: epochAtLaterWrite,
          activeContextId: stateAtLaterWrite.activeContextId,
          selectedProjectId: stateAtLaterWrite.selectedProjectId,
          selectedSessionId: stateAtLaterWrite.selectedSessionId,
          selectedTeamName: stateAtLaterWrite.selectedTeamName,
          openTabs: stateAtLaterWrite.openTabs,
          activeTabId: stateAtLaterWrite.activeTabId,
          projectRefreshes: fetchProjects.mock.calls.length,
          repositoryRefreshes: fetchRepositoryGroups.mock.calls.length,
        };
        expect(observation).toEqual(
          rootChanges
            ? {
                epoch: epoch + 1,
                activeContextId: 'local',
                selectedProjectId: null,
                selectedSessionId: null,
                selectedTeamName: null,
                openTabs: [],
                activeTabId: null,
                projectRefreshes: 1,
                repositoryRefreshes: 1,
              }
            : {
                epoch,
                activeContextId: 'local',
                selectedProjectId: 'old-project',
                selectedSessionId: 'old-session',
                selectedTeamName: 'old-team',
                openTabs: tabs,
                activeTabId: 'old-team-tab',
                projectRefreshes: 0,
                repositoryRefreshes: 0,
              }
        );
        expect(setError).toHaveBeenLastCalledWith('Later provider settings write failed');
        expect(setSaving).toHaveBeenLastCalledWith(false);
        expect(setConfig).not.toHaveBeenCalled();
        expect(setOptimisticConfig).not.toHaveBeenCalled();
      }
    } finally {
      useStore.setState(originalState, true);
    }
  });
  it('invalidates an imported root before a later display failure but preserves omitted or unchanged roots', async () => {
    const originalState = useStore.getState();
    const config = makeSafeConfig();
    const setError = vi.fn();
    const selection: { input?: HTMLInputElement } = {};
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement
    ) {
      selection.input = this;
    });
    let importConfig: () => void = () => undefined;
    let finishImport = (): void => undefined;

    function ImportHarness(): null {
      importConfig = useSettingsHandlers({
        config,
        setError,
        setConfig: vi.fn(),
        setOptimisticConfig: vi.fn(),
        setSaving: (saving) => {
          if (!saving) finishImport();
        },
        updateConfig: vi.fn(),
      }).handleImportConfig;
      return null;
    }

    act(() => root.render(<ImportHarness />));
    try {
      for (const scenario of [
        { general: { claudeRootPath: '/sandbox/root-b' }, changesRoot: true },
        { general: { theme: 'light' }, changesRoot: false },
        { general: { claudeRootPath: '/sandbox/root-a' }, changesRoot: false },
      ]) {
        const fetchProjects = vi.fn(() => Promise.resolve());
        const fetchRepositoryGroups = vi.fn(() => Promise.resolve());
        useStore.setState({
          connectionMode: 'local',
          activeContextId: 'local',
          selectedProjectId: 'old-project',
          selectedTeamName: 'old-team',
          activeTabId: 'old-tab',
          fetchProjects,
          fetchRepositoryGroups,
        });
        vi.mocked(api.config.getClaudeRootInfo).mockResolvedValue({
          resolvedPath: '/sandbox/root-a',
          defaultPath: '/sandbox/root-b',
          customPath: '/sandbox/root-a',
        });
        const epoch = captureContextScopedRequestEpoch();
        let stateAtDisplayWrite = originalState;
        let epochAtDisplayWrite = epoch;
        vi.mocked(api.config.update).mockImplementation((section) => {
          if (section === 'display') {
            stateAtDisplayWrite = useStore.getState();
            epochAtDisplayWrite = captureContextScopedRequestEpoch();
            return Promise.reject(new Error('Imported display settings write failed'));
          }
          return Promise.resolve(config);
        });

        act(() => importConfig());
        const input = selection.input;
        if (!input) throw new Error('Import did not request a settings file');
        Object.defineProperty(input, 'files', {
          value: [
            new File(
              [JSON.stringify({ general: scenario.general, display: { compactMode: true } })],
              'settings.json',
              { type: 'application/json' }
            ),
          ],
        });
        const completed = new Promise<void>((resolve) => {
          finishImport = resolve;
        });
        await act(async () => {
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await completed;
        });

        expect({
          epoch: epochAtDisplayWrite,
          selectedProjectId: stateAtDisplayWrite.selectedProjectId,
          selectedTeamName: stateAtDisplayWrite.selectedTeamName,
          activeTabId: stateAtDisplayWrite.activeTabId,
          projectRefreshes: fetchProjects.mock.calls.length,
          repositoryRefreshes: fetchRepositoryGroups.mock.calls.length,
        }).toEqual(
          scenario.changesRoot
            ? {
                epoch: epoch + 1,
                selectedProjectId: null,
                selectedTeamName: null,
                activeTabId: null,
                projectRefreshes: 1,
                repositoryRefreshes: 1,
              }
            : {
                epoch,
                selectedProjectId: 'old-project',
                selectedTeamName: 'old-team',
                activeTabId: 'old-tab',
                projectRefreshes: 0,
                repositoryRefreshes: 0,
              }
        );
        expect(stateAtDisplayWrite.activeContextId).toBe('local');
        expect(setError).toHaveBeenLastCalledWith('Imported display settings write failed');
      }
    } finally {
      useStore.setState(originalState, true);
    }
  });
});
