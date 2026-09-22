import { useCallback } from 'react';

import { useStore } from '@renderer/store';

export function useOpenTokenUsageNotificationSettings(): () => void {
  const openSettingsTab = useStore((state) => state.openSettingsTab);
  return useCallback(() => {
    openSettingsTab('notifications#usage-budget-notifications');
  }, [openSettingsTab]);
}
