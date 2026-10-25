import {
  getRuntimeProviderOnboardingPlanProviderIds,
  OPENCODE_V2_ROUTE_INTEGRATIONS_SERVED,
  resolveRuntimeProviderOnboardingRouteGeneration,
} from '../../core/domain';

import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';
import type {
  OpenCodeGeneration,
  RuntimeProviderOnboardingPlan,
  RuntimeProviderOnboardingPlanId,
} from '../../core/domain';
import type { RuntimeProviderManagementState } from './useRuntimeProviderManagement';

export const DEFAULT_WIZARD_PLAN_IDS: readonly RuntimeProviderOnboardingPlanId[] = [
  'supergrok',
  'zai-coding-plan',
  'minimax-token-plan',
  'github-copilot',
  'kimi-code-membership',
];

export function getAutomaticModelProbeLimit(plan: RuntimeProviderOnboardingPlan): number {
  // Unsupported Copilot routes fail before generation. Walk the current live
  // catalog until one works, while the probe loop below stops on any other
  // failure so it cannot burn through quota after a real request starts.
  return plan.id === 'github-copilot' ? Number.POSITIVE_INFINITY : 1;
}

export function isCopilotExplicitModelUnsupported(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('requested model is not supported') ||
    normalized.includes('selected model is not supported') ||
    normalized.includes('model is unsupported for this copilot account') ||
    normalized.includes('model is not supported for this copilot account') ||
    normalized.includes('model is not available for integrator')
  );
}

export function findDirectoryEntry(
  state: RuntimeProviderManagementState,
  providerId: string
): RuntimeProviderDirectoryEntryDto | null {
  return (
    state.directoryEntries.find(
      (entry) => entry.providerId.toLowerCase() === providerId.toLowerCase()
    ) ?? null
  );
}

/**
 * The generation a plan's routes use (the runtime must list a route integration, see
 * resolveRuntimeProviderOnboardingRouteGeneration) and the route already connected, which is
 * the account region in use.
 */
export function getOnboardingRouteState(
  plan: RuntimeProviderOnboardingPlan | null,
  generation: OpenCodeGeneration,
  state: RuntimeProviderManagementState
): { routeGeneration: OpenCodeGeneration; connectedRouteProviderId: string | null } {
  if (!plan) return { routeGeneration: 'v1', connectedRouteProviderId: null };
  const routeGeneration = resolveRuntimeProviderOnboardingRouteGeneration(
    plan,
    generation,
    state.directoryEntries,
    OPENCODE_V2_ROUTE_INTEGRATIONS_SERVED
  );
  const connectedRouteProviderId =
    getRuntimeProviderOnboardingPlanProviderIds(plan, routeGeneration).find(
      (id) => findDirectoryEntry(state, id)?.state === 'connected'
    ) ?? null;
  return { routeGeneration, connectedRouteProviderId };
}
