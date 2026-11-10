import type { DashboardProviderId } from '@features/recent-projects/contracts';

const PROVIDER_ORDER: DashboardProviderId[] = ['anthropic', 'codex', 'gemini'];

export function sortDashboardProviderIds(
  providerIds: readonly DashboardProviderId[]
): DashboardProviderId[] {
  return [...providerIds].sort(
    (left, right) => PROVIDER_ORDER.indexOf(left) - PROVIDER_ORDER.indexOf(right)
  );
}
