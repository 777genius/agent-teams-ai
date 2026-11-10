import { useCallback, useEffect, useState } from 'react';

import { useStore } from '@renderer/store';

const GRAPH_SIDEBAR_VISIBILITY_STORAGE_KEY = 'team-graph-sidebar-visible';

function readInitialVisibility(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    return window.localStorage.getItem(GRAPH_SIDEBAR_VISIBILITY_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function useGraphSidebarVisibility(): {
  sidebarVisible: boolean;
  toggleSidebarVisible: () => void;
} {
  const [sidebarEnabled, setSidebarEnabled] = useState<boolean>(readInitialVisibility);
  const messagesPanelMode = useStore((state) => state.messagesPanelMode);
  const setMessagesPanelMode = useStore((state) => state.setMessagesPanelMode);
  const sidebarVisible = sidebarEnabled && messagesPanelMode === 'sidebar';

  useEffect(() => {
    try {
      window.localStorage.setItem(GRAPH_SIDEBAR_VISIBILITY_STORAGE_KEY, String(sidebarEnabled));
    } catch {
      // Ignore storage failures and keep UI responsive.
    }
  }, [sidebarEnabled]);

  const toggleSidebarVisible = useCallback(() => {
    if (sidebarVisible) {
      setSidebarEnabled(false);
      return;
    }

    setSidebarEnabled(true);
    if (messagesPanelMode !== 'sidebar') {
      setMessagesPanelMode('sidebar');
    }
  }, [messagesPanelMode, setMessagesPanelMode, sidebarVisible]);

  return {
    sidebarVisible,
    toggleSidebarVisible,
  };
}
