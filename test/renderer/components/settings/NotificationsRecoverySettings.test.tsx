import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SafeConfig } from '@renderer/components/settings/hooks/useSettingsConfig';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@renderer/api', () => ({
  api: {
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

import { NotificationsSection } from '@renderer/components/settings/sections/NotificationsSection';

function makeSafeConfig(): SafeConfig {
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
});
