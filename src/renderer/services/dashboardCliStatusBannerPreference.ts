const DASHBOARD_CLI_STATUS_BANNER_COLLAPSED_KEY = 'dashboard:cli-status-banner-collapsed';

export function loadDashboardCliStatusBannerCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DASHBOARD_CLI_STATUS_BANNER_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveDashboardCliStatusBannerCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      DASHBOARD_CLI_STATUS_BANNER_COLLAPSED_KEY,
      collapsed ? 'true' : 'false'
    );
  } catch {
    // Ignore storage failures and keep the dashboard responsive.
  }
}
