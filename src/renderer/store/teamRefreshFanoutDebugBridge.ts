import {
  getTeamRefreshFanoutSnapshot,
  resetTeamRefreshFanoutDiagnostics,
  summarizeTeamRefreshFanout,
} from './teamRefreshFanoutDiagnostics';

declare global {
  interface Window {
    __TEAM_REFRESH_FANOUT__?: Readonly<{
      snapshot: typeof getTeamRefreshFanoutSnapshot;
      summary: typeof summarizeTeamRefreshFanout;
      reset: typeof resetTeamRefreshFanoutDiagnostics;
    }>;
  }
}

export const TEAM_REFRESH_FANOUT_DEBUG_STORAGE_KEY = 'debug:teamRefreshFanout';

function isDebugBridgeEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(TEAM_REFRESH_FANOUT_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function installTeamRefreshFanoutDebugBridge(): () => void {
  if (typeof window === 'undefined' || !isDebugBridgeEnabled()) {
    return () => undefined;
  }

  const bridge = Object.freeze({
    snapshot: getTeamRefreshFanoutSnapshot,
    summary: summarizeTeamRefreshFanout,
    reset: resetTeamRefreshFanoutDiagnostics,
  });

  window.__TEAM_REFRESH_FANOUT__ = bridge;

  return () => {
    if (window.__TEAM_REFRESH_FANOUT__ === bridge) {
      delete window.__TEAM_REFRESH_FANOUT__;
    }
  };
}
