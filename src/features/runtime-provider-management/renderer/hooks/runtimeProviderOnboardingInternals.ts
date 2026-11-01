import {
  getOpenCodeV2PlanLimitation,
  getRuntimeProviderOnboardingPlanProviderIds,
  isRuntimeProviderOnboardingPlanRoutable,
  OPENCODE_V2_ROUTE_INTEGRATIONS_SERVED,
  resolveRuntimeProviderOnboardingRouteGeneration,
  RUNTIME_PROVIDER_ONBOARDING_PLANS,
} from '../../core/domain';

import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';
import type {
  OpenCodeGeneration,
  RuntimeProviderOnboardingPlan,
  RuntimeProviderOnboardingPlanId,
  RuntimeProviderOnboardingProgress,
} from '../../core/domain';
import type { RuntimeProviderManagementState } from './useRuntimeProviderManagement';
import type { RuntimeProviderOnboardingPlanStatus } from './useRuntimeProviderOnboarding';

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
 * The generation a plan's routes use (see resolveRuntimeProviderOnboardingRouteGeneration) and
 * the route already connected, which is the account region in use.
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
    OPENCODE_V2_ROUTE_INTEGRATIONS_SERVED
  );
  const connectedRouteProviderId =
    getRuntimeProviderOnboardingPlanProviderIds(plan, routeGeneration).find(
      (id) => findDirectoryEntry(state, id)?.state === 'connected'
    ) ?? null;
  return { routeGeneration, connectedRouteProviderId };
}

export function getOnboardingV2ConnectionMessage(
  plan: RuntimeProviderOnboardingPlan | null,
  generation: OpenCodeGeneration
): string | null {
  return plan && getOpenCodeV2PlanLimitation(plan.id, generation)
    ? `${plan.displayName} cannot be connected through Agent Teams on OpenCode V2 yet. Use OpenCode V1 for this plan; the existing V2 installation is unchanged.`
    : null;
}

export function getOnboardingPlanStatuses(
  activePlan: RuntimeProviderOnboardingPlan | null,
  progress: RuntimeProviderOnboardingProgress | null,
  wizardStarted: boolean,
  generation: OpenCodeGeneration,
  management: RuntimeProviderManagementState
): readonly RuntimeProviderOnboardingPlanStatus[] {
  return RUNTIME_PROVIDER_ONBOARDING_PLANS.map((plan) => {
    if (getOpenCodeV2PlanLimitation(plan.id, generation)) return { plan, state: 'pending' };
    if (progress?.completedPlanIds.includes(plan.id)) return { plan, state: 'ready' };
    if (activePlan?.id === plan.id && wizardStarted) return { plan, state: 'active' };
    const entry = findDirectoryEntry(management, plan.providerId);
    return {
      plan,
      state: isRuntimeProviderOnboardingPlanRoutable(plan, entry) ? 'connected' : 'pending',
    };
  });
}

/** Wizard selections are capabilities, not evidence that an account is connected. */
export function getSupportedWizardPlanIds(
  ids: readonly RuntimeProviderOnboardingPlanId[],
  generation: OpenCodeGeneration
): RuntimeProviderOnboardingPlanId[] {
  return ids.filter((id) => !getOpenCodeV2PlanLimitation(id, generation));
}

export function getSupportedWizardProgress(
  progress: RuntimeProviderOnboardingProgress | null,
  generation: OpenCodeGeneration
): RuntimeProviderOnboardingProgress | null {
  if (!progress) return null;
  const selectedPlanIds = getSupportedWizardPlanIds(progress.selectedPlanIds, generation);
  if (!selectedPlanIds.length) return null;
  const completedPlanIds = progress.completedPlanIds.filter((id) => selectedPlanIds.includes(id));
  const currentPlanId =
    progress.currentPlanId && selectedPlanIds.includes(progress.currentPlanId) &&
    !completedPlanIds.includes(progress.currentPlanId)
      ? progress.currentPlanId
      : (selectedPlanIds.find((id) => !completedPlanIds.includes(id)) ?? null);
  const selectedModels = Object.fromEntries(
    Object.entries(progress.selectedModels).filter(([id]) =>
      selectedPlanIds.includes(id as RuntimeProviderOnboardingPlanId)
    )
  ) as RuntimeProviderOnboardingProgress['selectedModels'];
  return { ...progress, selectedPlanIds, completedPlanIds, currentPlanId, selectedModels };
}

export function toggleSupportedWizardPlan(
  current: readonly RuntimeProviderOnboardingPlanId[],
  planId: RuntimeProviderOnboardingPlanId,
  generation: OpenCodeGeneration
): readonly RuntimeProviderOnboardingPlanId[] {
  if (getOpenCodeV2PlanLimitation(planId, generation)) return getSupportedWizardPlanIds(current, generation);
  const toggled = current.includes(planId)
    ? current.filter((id) => id !== planId)
    : RUNTIME_PROVIDER_ONBOARDING_PLANS.filter(
        (plan) => current.includes(plan.id) || plan.id === planId
      ).map((plan) => plan.id);
  return getSupportedWizardPlanIds(toggled, generation);
}
