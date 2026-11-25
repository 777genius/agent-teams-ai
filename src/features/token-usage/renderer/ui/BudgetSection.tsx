import { useState } from 'react';

import { namedTeamId } from '../../contracts';
import { useStore } from '@renderer/store';

import { useOpenTokenUsageNotificationSettings } from '../hooks/useOpenTokenUsageNotificationSettings';
import { useTokenUsageBudgetSettings } from '../hooks/useTokenUsageBudgetSettings';

import { BudgetAlertsPanel } from './BudgetAlertsPanel';

import type { BudgetT } from './BudgetEditorDialog';
import type React from 'react';

/** Owns Budget independently from analytics filters and cache display preferences. */
export const BudgetSection = ({ t }: { t: BudgetT }): React.JSX.Element => {
  const [selected, setSelected] = useState('global:global');
  const teams = useStore((state) => state.teams);
  const openNotificationSettings = useOpenTokenUsageNotificationSettings();
  const budget = useTokenUsageBudgetSettings({
    loadErrorMessage: t('tokenUsage.budgets.loadFailed'),
    saveErrorMessage: t('tokenUsage.budgets.saveFailed'),
  });
  return (
    <BudgetAlertsPanel
      status={budget.budgetStatus}
      knownTeams={teams.filter((team) => !team.deletedAt).map((team) => ({
        scope: 'team' as const,
        id: namedTeamId(team.teamName),
        label: team.displayName,
      }))}
      budgetConfig={budget.budgetConfig}
      budgetTargetKey={selected}
      error={budget.budgetConfigError}
      loaded={budget.loaded}
      onBudgetTargetKeyChange={setSelected}
      onSave={budget.saveBudgetConfig}
      onReload={budget.reloadBudgetConfig}
      onOpenNotificationSettings={openNotificationSettings}
      t={t}
    />
  );
};
