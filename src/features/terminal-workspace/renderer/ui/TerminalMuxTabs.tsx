import { useAppTranslation } from '@features/localization/renderer';

import { type TerminalMuxCommands } from '../hooks/useTerminalMuxTabLifecycle';
import { useTerminalMuxTabsController } from '../hooks/useTerminalMuxTabsController';
import {
  getTerminalTabColorLabelKey,
  type TerminalWorkspaceSnapshot,
} from '../model/terminalTabPreferences';

import { TerminalMuxTabsView } from './TerminalMuxTabsView';

export interface TerminalMuxTabsProps {
  commands: TerminalMuxCommands;
  settingsOpen?: boolean;
  snapshot: TerminalWorkspaceSnapshot;
  teamName: string;
  onSettingsOpenChange?: (open: boolean) => void;
  onTabContentPendingChange?: (pending: boolean) => void;
  placement?: 'console' | 'sheet-header';
}

export const TerminalMuxTabs = ({
  commands,
  settingsOpen = false,
  snapshot,
  teamName,
  onSettingsOpenChange,
  onTabContentPendingChange,
  placement = 'console',
}: TerminalMuxTabsProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const controller = useTerminalMuxTabsController({
    commands,
    placement,
    settingsOpen,
    snapshot,
    teamName,
    onSettingsOpenChange,
    onTabContentPendingChange,
  });

  return (
    <TerminalMuxTabsView
      controller={controller}
      copy={{
        cancel: t('terminalWorkspace.cancel'),
        chooseColor: t('terminalWorkspace.chooseColor'),
        closeSettings: t('terminalWorkspace.closeTerminalSettings'),
        closeSettingsTab: t('terminalWorkspace.closeTerminalSettingsTab'),
        closeTab: t('terminalWorkspace.closeTab'),
        closeTabDialogDescription: t('terminalWorkspace.closeTerminalTabDialogDescription'),
        closeTabDialogTitle: t('terminalWorkspace.closeTerminalTabDialogTitle'),
        createTab: t('terminalWorkspace.createTerminalTab'),
        editTabTitle: t('terminalWorkspace.editTerminalTabTitle'),
        noTabs: t('terminalWorkspace.noTerminalTabs'),
        renameTab: t('terminalWorkspace.renameTab'),
        settingsTab: t('terminalWorkspace.settingsTab'),
        tabColor: t('terminalWorkspace.tabColor'),
        tabs: t('terminalWorkspace.terminalTabs'),
        tabsUnavailable: t('terminalWorkspace.terminalTabsUnavailable'),
        closeTabLabel: (tabLabel) => t('terminalWorkspace.closeTerminalTab', { tab: tabLabel }),
        colorLabel: (colorId) => t(getTerminalTabColorLabelKey(colorId)),
        unavailableCloseTabLabel: () => t('terminalWorkspace.createAnotherTabBeforeClosing'),
      }}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={onSettingsOpenChange}
    />
  );
};
