import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { terminalPlatformThemeManifests } from '@terminal-platform/design-tokens';
import { terminalPlatformTerminalFontScales } from '@terminal-platform/workspace-core';

import {
  DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
  type TerminalAppearanceSettings,
} from '../model/terminalAppearanceSettings';

import {
  type TerminalWorkspaceSettingsActionId,
  TerminalWorkspaceSettingsView,
} from './TerminalWorkspaceSettingsView';

type TeamTFunction = ReturnType<typeof useAppTranslation>['t'];

export interface TerminalWorkspaceSettingsOperations {
  readonly reconnect: () => Promise<void>;
  readonly refreshSessions: () => Promise<void>;
  readonly stopRuntime: () => Promise<void>;
  readonly setFontScale: (fontScale: string) => void;
  readonly setLineWrap: (lineWrap: boolean) => void;
  readonly setTheme: (themeId: string) => void;
}

export interface TerminalWorkspaceSettingsPageProps {
  appearanceSettings: TerminalAppearanceSettings;
  display: {
    fontScale: string;
    lineWrap: boolean;
    themeId: string;
  };
  operations: TerminalWorkspaceSettingsOperations;
  onAppearanceSettingsChange: (updates: Partial<TerminalAppearanceSettings>) => void;
  onClose: () => void;
  onReload: () => void;
}

export const TerminalWorkspaceSettingsPage = ({
  appearanceSettings,
  display,
  operations,
  onAppearanceSettingsChange,
  onClose,
  onReload,
}: TerminalWorkspaceSettingsPageProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [pendingAction, setPendingAction] = useState<TerminalWorkspaceSettingsActionId | null>(
    null
  );

  const runAction = async (
    actionId: TerminalWorkspaceSettingsActionId,
    action: () => Promise<void>
  ): Promise<void> => {
    setPendingAction(actionId);
    try {
      await action();
    } catch {
      // Kernel diagnostics already surface command failures in the terminal workspace.
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <TerminalWorkspaceSettingsView
      appearanceSettings={appearanceSettings}
      display={display}
      fontScaleOptions={terminalPlatformTerminalFontScales.map((fontScale) => ({
        id: fontScale,
        label: formatFontScaleLabel(t, fontScale),
      }))}
      onAppearanceSettingsChange={onAppearanceSettingsChange}
      onClose={onClose}
      onFontScaleChange={operations.setFontScale}
      onLineWrapChange={operations.setLineWrap}
      onReconnect={() => void runAction('bootstrap', operations.reconnect)}
      onRefreshSessions={() => void runAction('refresh-sessions', operations.refreshSessions)}
      onReload={onReload}
      onResetAppearance={() => onAppearanceSettingsChange(DEFAULT_TERMINAL_APPEARANCE_SETTINGS)}
      onStopRuntime={() => void runAction('stop-runtime', operations.stopRuntime)}
      onThemeChange={operations.setTheme}
      pendingAction={pendingAction}
      themeOptions={terminalPlatformThemeManifests.map((theme) => ({
        id: theme.id,
        label: formatThemeLabel(t, theme.displayName, theme.id),
      }))}
    />
  );
};

function formatThemeLabel(t: TeamTFunction, displayName: string, themeId: string): string {
  if (themeId === 'terminal-platform-default') return t('terminalWorkspace.themeDark');
  if (themeId === 'terminal-platform-light') return t('terminalWorkspace.themeLight');
  return displayName.replace(/^Terminal Platform\s*/i, '').trim() || displayName;
}

function formatFontScaleLabel(t: TeamTFunction, fontScale: string): string {
  if (fontScale === 'compact') return t('terminalWorkspace.fontScaleCompact');
  if (fontScale === 'large') return t('terminalWorkspace.fontScaleLarge');
  return t('terminalWorkspace.fontScaleDefault');
}
